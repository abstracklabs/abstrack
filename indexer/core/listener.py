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
from web3.providers import AsyncHTTPProvider, WebSocketProvider

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

    # ─── Connexion principale (catchup HTTP + live WebSocket) ────────────────

    async def _stream(self):
        # Catchup via HTTP — plus fiable pour les grandes plages
        w3_http = AsyncWeb3(AsyncHTTPProvider(self.rpc_http))
        logger.info("Connected to Abstract node (HTTP)")

        # Résout les noms des collections déjà dans la DB sans nom
        await self._backfill_collection_names(w3_http)

        await self._catchup(w3_http)

        # Live via WebSocket — push temps réel
        async with AsyncWeb3(WebSocketProvider(self.rpc_wss)) as w3:
            logger.info("Connected to Abstract node (WebSocket live)")

            # Détection des trous après le catchup
            current_head = await w3.eth.block_number
            detector     = GapDetector(self.db, self._process_block)
            gaps         = await detector.check(current_head)
            if gaps:
                await detector.fill(gaps, w3)

            await w3.eth.subscribe("newHeads")
            logger.info("Subscribed to newHeads — live indexing active")

            async for payload in w3.socket.process_subscriptions():
                if not self._running:
                    break
                header = payload.get("result", payload)
                raw_num = header.get("number", "0x0")
                block_num = int(raw_num, 16) if isinstance(raw_num, str) else int(raw_num)
                await self._process_block(w3, block_num)

    # ─── Résolution des noms au démarrage ────────────────────────────────────

    async def _backfill_collection_names(self, w3: AsyncWeb3) -> None:
        """Résout name/symbol pour les collections sans nom dans la DB."""
        try:
            unnamed = await self.db.get_unnamed_collections()
            if not unnamed:
                return
            logger.info(f"Resolving names for {len(unnamed)} collections without metadata")
            for addr in unnamed:
                await self._resolve_collection_meta(w3, addr)
                await asyncio.sleep(0.05)  # ~20 req/s max — évite de saturer le RPC
        except Exception as e:
            logger.warning(f"Backfill collection names failed: {e!r}")

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
                await self._handle_log(dict(log), block_num, block_ts, eth_usd, w3)

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

    async def _handle_log(self, log: dict, block_num: int, block_ts: datetime, eth_usd: float, w3_ref: AsyncWeb3 = None):
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
                is_new = await self.db.upsert_collection(result["collection_addr"])
                if is_new:
                    await self._resolve_collection_meta(w3_ref, result["collection_addr"])
                inserted = await self.db.insert_sale(result)
                if inserted:
                    logger.debug(f"Sale inserted: {result['tx_hash']} — {result['price_eth']:.3f} ETH")
            elif kind == "transfer":
                is_new = await self.db.upsert_collection(result["collection_addr"])
                if is_new:
                    await self._resolve_collection_meta(w3_ref, result["collection_addr"])
                await self.db.insert_transfer(result)
        except Exception as e:
            logger.error(
                f"DB insert error (block {block_num}, tx {log.get('transactionHash')}): {e!r}"
            )
            # On logue et on continue — un log raté ne doit pas bloquer le bloc

    # ─── Résolution nom/symbole ERC-721 ──────────────────────────────────────

    async def _resolve_collection_meta(self, w3: AsyncWeb3, address: str) -> None:
        """
        Appelle name() et symbol() sur le contrat ERC-721.
        Sélecteurs ABI : name()=0x06fdde03, symbol()=0x95d89b41
        Ne bloque jamais — toute erreur est ignorée silencieusement.
        """
        if not w3:
            return
        try:
            name   = await self._eth_call_string(w3, address, "0x06fdde03")
            symbol = await self._eth_call_string(w3, address, "0x95d89b41")
            if name or symbol:
                await self.db.update_collection_meta(address, name or "", symbol or "")
                logger.info(f"Collection meta resolved: {address} → {name!r} ({symbol!r})")
        except Exception as e:
            logger.debug(f"Could not resolve meta for {address}: {e!r}")

    async def _eth_call_string(self, w3: AsyncWeb3, address: str, selector: str) -> str:
        """Fait un eth_call et décode le retour comme une string ABI-encodée."""
        from eth_abi import decode as abi_decode
        try:
            result = await asyncio.wait_for(
                w3.eth.call({"to": address, "data": selector}),
                timeout=3.0,
            )
            if not result or result == b"":
                return ""
            # Decode ABI string (offset + length + data)
            decoded = abi_decode(["string"], result)
            return decoded[0][:128]  # max 128 chars
        except Exception:
            return ""

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
