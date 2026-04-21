"""
LiveListener — HTTP polling blockchain → PostgreSQL.

Abstract ne supporte pas WebSocket public — on utilise le polling HTTP.
Abstract produit un bloc toutes les ~2s : le polling est parfaitement adapté.

Robustesse production :
- session aiohttp persistante (réutilisée entre les blocs)
- checkpoint sauvegardé tous les N blocs pendant le catchup
- retry par log individuel (un log qui échoue ne bloque pas le bloc)
- timeout sur get_logs pour ne pas bloquer indéfiniment
- backoff exponentiel sur erreur RPC
"""

import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Optional

import aiohttp
from web3 import AsyncWeb3
from web3.providers import AsyncHTTPProvider

from core.integrity import GapDetector
from decoders.nft import decode_nft_log, TRACKED_TOPICS
from storage.db import Database

logger = logging.getLogger("indexer.listener")

ETH_PRICE_URL = "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd"
CATCHUP_CHECKPOINT_INTERVAL = 50   # sauvegarde le checkpoint tous les 50 blocs pendant le catchup
GET_LOGS_TIMEOUT = 10.0            # secondes max pour eth_getLogs
POLL_INTERVAL = 2.0                # secondes entre chaque poll (Abstract ~2s/bloc)


class LiveListener:
    _BACKOFF_BASE  = 2.0
    _BACKOFF_MAX   = 30.0

    def __init__(self, rpc_wss: str, rpc_http: str, db: Database):
        self.rpc_wss  = rpc_wss   # gardé pour compatibilité, non utilisé
        self.rpc_http = rpc_http
        self.db       = db
        self._running = False

        # Prix ETH/USD — cache avec session HTTP persistante
        self._eth_usd: float = 0.0
        self._eth_usd_ts: float = 0.0
        self._http_session: Optional[aiohttp.ClientSession] = None

    async def start(self):
        self._running = True
        self._http_session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=5)
        )
        delay = self._BACKOFF_BASE

        try:
            while self._running:
                try:
                    await self._stream()
                    delay = self._BACKOFF_BASE
                except asyncio.CancelledError:
                    break
                except Exception as e:
                    logger.error(f"Stream error: {e!r} — reconnect in {delay:.0f}s")
                    await asyncio.sleep(delay)
                    delay = min(delay * 2, self._BACKOFF_MAX)
        finally:
            if self._http_session:
                await self._http_session.close()
                self._http_session = None

    async def stop(self):
        self._running = False

    # ─── Connexion principale (HTTP polling) ──────────────────────────────────

    async def _stream(self):
        w3 = AsyncWeb3(AsyncHTTPProvider(self.rpc_http))
        logger.info("Connected to Abstract node (HTTP polling)")

        await self._catchup(w3)

        # Détection des trous après le catchup
        current_head = await w3.eth.block_number
        detector     = GapDetector(self.db, self._process_block)
        gaps         = await detector.check(current_head)
        if gaps:
            await detector.fill(gaps, w3)

        logger.info("Live polling started")
        last_seen = current_head

        while self._running:
            await asyncio.sleep(POLL_INTERVAL)
            try:
                current = await w3.eth.block_number
                if current > last_seen:
                    for block_num in range(last_seen + 1, current + 1):
                        if not self._running:
                            return
                        await self._process_block(w3, block_num)
                    last_seen = current
            except Exception as e:
                logger.warning(f"Poll error: {e!r}")
                raise  # déclenche le backoff dans start()

    # ─── Rattrapage ───────────────────────────────────────────────────────────

    async def _catchup(self, w3: AsyncWeb3):
        last    = await self.db.get_last_block()
        current = await w3.eth.block_number

        if last == 0 or current <= last:
            return

        gap = current - last
        logger.info(f"Catching up {gap} blocks ({last + 1} → {current})")

        for n in range(last + 1, current + 1):
            if not self._running:
                break
            await self._process_block(w3, n)

            # Sauvegarde intermédiaire pour éviter de tout re-rattraper après un crash
            if (n - last) % CATCHUP_CHECKPOINT_INTERVAL == 0:
                await self.db.save_checkpoint(n)
                logger.info(f"Catchup progress: block {n}/{current}")

    # ─── Nouveau bloc via subscription ───────────────────────────────────────

    # ─── Traitement d'un bloc ─────────────────────────────────────────────────

    async def _process_block(self, w3: AsyncWeb3, block_num: int):
        try:
            raw_logs = await asyncio.wait_for(
                w3.eth.get_logs({
                    "fromBlock": block_num,
                    "toBlock":   block_num,
                    "topics":    [list(TRACKED_TOPICS)],
                }),
                timeout=GET_LOGS_TIMEOUT,
            )
        except asyncio.TimeoutError:
            logger.warning(f"get_logs timeout at block {block_num} — skipping")
            await self.db.save_checkpoint(block_num)
            return
        except Exception as e:
            logger.warning(f"get_logs error at block {block_num}: {e!r} — skipping")
            await self.db.save_checkpoint(block_num)
            return

        if raw_logs:
            # Fetch le bloc une seule fois pour le timestamp (newHeads ne l'inclut pas toujours)
            block_ts = await self._get_block_timestamp(w3, block_num)
            eth_usd  = await self._get_eth_price()

            for log in raw_logs:
                await self._handle_log(dict(log), block_num, block_ts, eth_usd)

        await self.db.save_checkpoint(block_num)
        await self.db.mark_range_processed(block_num, block_num)

        if block_num % 100 == 0:
            logger.info(f"Block {block_num} — {len(raw_logs) if raw_logs else 0} relevant logs")

    async def _get_block_timestamp(self, w3: AsyncWeb3, block_num: int) -> datetime:
        try:
            block = await asyncio.wait_for(
                w3.eth.get_block(block_num),
                timeout=5.0,
            )
            ts = block["timestamp"]
            if isinstance(ts, str):
                ts = int(ts, 16)
            return datetime.fromtimestamp(ts, tz=timezone.utc)
        except Exception as e:
            logger.warning(f"get_block timestamp failed for {block_num}: {e!r} — using now()")
            return datetime.now(tz=timezone.utc)

    # ─── Traitement d'un log individuel ──────────────────────────────────────

    async def _handle_log(self, log: dict, block_num: int, block_ts: datetime, eth_usd: float):
        try:
            result = decode_nft_log(log, block_num, block_ts, eth_usd)
        except Exception as e:
            logger.warning(f"Decode error (block {block_num}, tx {log.get('transactionHash')}): {e!r}")
            return

        if not result:
            return

        try:
            kind = result["kind"]
            if kind == "sale":
                await self.db.upsert_collection(result["collection_addr"])
                inserted = await self.db.insert_sale(result)
                if inserted:
                    logger.debug(f"Sale inserted: {result['tx_hash']} — {result['price_eth']:.3f} ETH")
            elif kind == "transfer":
                await self.db.upsert_collection(result["collection_addr"])
                await self.db.insert_transfer(result)
        except Exception as e:
            logger.error(
                f"DB insert error (block {block_num}, tx {log.get('transactionHash')}): {e!r}"
            )
            # On logue et on continue — un log raté ne doit pas bloquer le bloc

    # ─── Prix ETH/USD ─────────────────────────────────────────────────────────

    async def _get_eth_price(self) -> float:
        """Cache 60s, session HTTP persistante — pas de reconnexion TCP à chaque bloc."""
        now = time.monotonic()
        if self._eth_usd > 0 and now - self._eth_usd_ts < 60:
            return self._eth_usd

        if not self._http_session or self._http_session.closed:
            return self._eth_usd  # session fermée (shutdown en cours)

        try:
            async with self._http_session.get(ETH_PRICE_URL) as r:
                if r.status == 200:
                    data = await r.json()
                    self._eth_usd    = float(data["ethereum"]["usd"])
                    self._eth_usd_ts = now
                    logger.debug(f"ETH price updated: ${self._eth_usd:.2f}")
        except Exception as e:
            logger.warning(f"ETH price fetch failed: {e!r} — using last known ${self._eth_usd:.2f}")

        return self._eth_usd
