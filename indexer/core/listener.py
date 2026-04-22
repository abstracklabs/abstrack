"""
LiveListener — HTTP polling blockchain → PostgreSQL.

Abstract produit un bloc toutes les ~2s : le polling est parfaitement adapté.

Modes de catchup :
  - NORMAL   : reprend depuis le dernier checkpoint
  - FULL     : INDEXER_START_BLOCK + INDEXER_FORCE_REINDEX=true → réindexe depuis le début

Variables d'environnement :
  INDEXER_START_BLOCK    (int,  défaut 0)     — bloc minimum de départ
  INDEXER_FORCE_REINDEX  (bool, défaut false) — réinitialise le checkpoint au 1er démarrage
  CATCHUP_BATCH_SLEEP_MS (int,  défaut 100)   — pause entre batches (throttle RPC)

Corrections critiques :
  - FORCE_REINDEX persisté en DB → résiste aux redémarrages container mid-catchup
  - _catchup boucle jusqu'à être à < 500 blocs de la tête → pas de gap post-catchup
  - Timestamp mis en cache par bloc dans un batch → pas de double fetch
  - price_usd = None pour les blocs historiques (pas de prix ETH historique)
  - Throttle configurable entre les batches
"""

import asyncio
import logging
import os
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

ETH_PRICE_URL      = "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd"
GET_LOGS_TIMEOUT   = 30.0    # secondes max pour un batch eth_getLogs
POLL_INTERVAL      = 2.0     # secondes entre chaque poll live
CATCHUP_BATCH_SIZE = 500     # blocs par requête eth_getLogs en catchup
LOG_PROGRESS_EVERY = 20      # log tous les N batches (~10 000 blocs)
CATCHUP_LAG_TARGET = 500     # blocs de tolérance avant de passer en live

# Configuration via env
START_BLOCK       = int(os.environ.get("INDEXER_START_BLOCK", "0"))
FORCE_REINDEX     = os.environ.get("INDEXER_FORCE_REINDEX", "false").lower() in ("1", "true", "yes")
BATCH_SLEEP_S     = float(os.environ.get("CATCHUP_BATCH_SLEEP_MS", "100")) / 1000.0

# Clé de session dans indexer_state — distingue un nouveau reindex d'une reprise
_REINDEX_SESSION_KEY = "reindex_session"


class LiveListener:
    _BACKOFF_BASE = 2.0
    _BACKOFF_MAX  = 30.0

    def __init__(self, rpc_wss: str, rpc_http: str, db: Database):
        self.rpc_wss  = rpc_wss
        self.rpc_http = rpc_http
        self.db       = db
        self._running = False

        self._eth_usd:    float = 0.0
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

    # ─── Connexion principale ──────────────────────────────────────────────────

    async def _stream(self):
        w3_http = AsyncWeb3(AsyncHTTPProvider(self.rpc_http))
        logger.info("Connected to Abstract node (HTTP)")

        # CRITIQUE 1 FIX : FORCE_REINDEX persisté en DB
        # On ne remet le checkpoint à 0 qu'à la PREMIÈRE exécution du reindex.
        # Les redémarrages container mid-catchup reprennent depuis le checkpoint.
        await self._maybe_force_reindex()

        # Backfill noms manquants
        await self._backfill_collection_names(w3_http)

        # CRITIQUE 2 FIX : boucle jusqu'à être à < CATCHUP_LAG_TARGET blocs de la tête
        await self._catchup_until_synced(w3_http)

        # Live via WebSocket
        async with AsyncWeb3(WebSocketProvider(self.rpc_wss)) as w3:
            logger.info("Connected to Abstract node (WebSocket live)")

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
                header    = payload.get("result", payload)
                raw_num   = header.get("number", "0x0")
                block_num = int(raw_num, 16) if isinstance(raw_num, str) else int(raw_num)
                await self._process_block(w3, block_num)

    # ─── CRITIQUE 1 : FORCE_REINDEX avec persistance DB ──────────────────────

    async def _maybe_force_reindex(self):
        """
        Réinitialise le checkpoint seulement si c'est un nouveau reindex,
        pas si on reprend après un redémarrage mid-catchup.
        """
        if not FORCE_REINDEX:
            return

        # Vérifie si un reindex est déjà en cours (session existante en DB)
        session_ts = await self.db.get_state(_REINDEX_SESSION_KEY)
        if session_ts:
            logger.info(f"FORCE_REINDEX: reindex already in progress (started {session_ts}) — resuming")
            return

        # Nouveau reindex : remet le checkpoint à START_BLOCK - 1
        reset_to = max(0, START_BLOCK - 1)
        await self.db.save_checkpoint(reset_to)
        await self.db.set_state(_REINDEX_SESSION_KEY, datetime.now(timezone.utc).isoformat())
        logger.info(f"FORCE_REINDEX: checkpoint reset to block {reset_to} — session started")

    async def _finish_reindex_session(self):
        """
        Tâches de finalisation après le catchup :
        1. Recalcule les stats 24h de toutes les collections (skippées pendant le catchup).
        2. Supprime la clé de session FORCE_REINDEX.
        """
        logger.info("Catchup complete — refreshing all collection stats…")
        try:
            await self.db.refresh_all_collection_stats()
        except Exception as e:
            logger.warning(f"refresh_all_collection_stats failed: {e!r}")

        if FORCE_REINDEX:
            await self.db.delete_state(_REINDEX_SESSION_KEY)
            logger.info("Reindex session complete — FORCE_REINDEX session cleared")

    # ─── CRITIQUE 2 : Catchup complet (boucle jusqu'à la tête) ──────────────

    async def _catchup_until_synced(self, w3: AsyncWeb3):
        """
        Boucle _catchup jusqu'à être à < CATCHUP_LAG_TARGET blocs de la tête.
        Garantit qu'aucun bloc n'est manqué entre la fin du catchup et le live.
        """
        pass_num = 1
        while self._running:
            last    = await self.db.get_last_block()
            current = await w3.eth.block_number
            lag     = current - last

            if lag <= CATCHUP_LAG_TARGET:
                logger.info(f"Fully synced: last_block={last:,}, head={current:,}, lag={lag}")
                break

            logger.info(f"Catchup pass #{pass_num}: {lag:,} blocks remaining (last={last:,}, head={current:,})")
            await self._catchup(w3)
            pass_num += 1

        await self._finish_reindex_session()

    # ─── Catchup batch ────────────────────────────────────────────────────────

    async def _catchup(self, w3: AsyncWeb3):
        last    = await self.db.get_last_block()
        current = await w3.eth.block_number

        if START_BLOCK > 0:
            start = max(last + 1, START_BLOCK)
        else:
            if last == 0:
                logger.info("No checkpoint and no START_BLOCK — starting from current block")
                await self.db.save_checkpoint(current)
                return
            start = last + 1

        # On ne va pas au-delà du bloc courant au moment où on commence
        # (les blocs suivants seront traités au prochain pass ou en live)
        target = current

        if start > target:
            return

        total  = target - start + 1
        logger.info(
            f"Catchup: {total:,} blocks ({start:,} → {target:,}, "
            f"batch={CATCHUP_BATCH_SIZE}, sleep={BATCH_SLEEP_S*1000:.0f}ms)"
        )

        n           = start
        batch_count = 0
        t0          = time.monotonic()

        while n <= target and self._running:
            batch_end = min(n + CATCHUP_BATCH_SIZE - 1, target)
            await self._process_block_range(w3, n, batch_end)
            await self.db.save_checkpoint(batch_end)

            batch_count += 1
            if batch_count % LOG_PROGRESS_EVERY == 0:
                done    = batch_end - start + 1
                pct     = 100.0 * done / total
                elapsed = time.monotonic() - t0
                rate    = done / elapsed if elapsed > 0 else 0
                eta_min = ((total - done) / rate / 60) if rate > 0 else 0
                logger.info(
                    f"Catchup: block {batch_end:,}/{target:,} "
                    f"({pct:.1f}%) — {rate:.0f} blk/s — ETA {eta_min:.0f} min"
                )

            n = batch_end + 1

            # SIGNIFICATIF 3 FIX : throttle RPC
            if BATCH_SLEEP_S > 0:
                await asyncio.sleep(BATCH_SLEEP_S)

        elapsed = time.monotonic() - t0
        if elapsed > 0:
            logger.info(
                f"Catchup pass done: {total:,} blocks in {elapsed:.0f}s "
                f"({total/elapsed:.0f} blk/s avg)"
            )

    # ─── Traitement d'un batch de blocs ──────────────────────────────────────

    async def _process_block_range(self, w3: AsyncWeb3, from_block: int, to_block: int):
        """
        eth_getLogs sur [from_block, to_block] avec topics trackés.
        Split récursif sur timeout/erreur.
        Cache des timestamps pour éviter les double-fetch (MINEUR 1 FIX).
        """
        try:
            raw_logs = await asyncio.wait_for(
                w3.eth.get_logs({
                    "fromBlock": from_block,
                    "toBlock":   to_block,
                    "topics":    [list(TRACKED_TOPICS)],
                }),
                timeout=GET_LOGS_TIMEOUT,
            )
        except Exception as e:
            if from_block == to_block:
                logger.warning(f"Block {from_block} get_logs failed: {e!r} — skipping")
                await self.db.save_checkpoint(from_block)
                return
            logger.debug(f"Batch {from_block}-{to_block} failed ({type(e).__name__}) — splitting")
            mid = (from_block + to_block) // 2
            await self._process_block_range(w3, from_block, mid)
            await self._process_block_range(w3, mid + 1, to_block)
            return

        if not raw_logs:
            await self.db.mark_range_processed(from_block, to_block)
            return

        # Groupe par bloc + cache timestamps (MINEUR 1 FIX)
        blocks_with_logs: dict[int, list] = {}
        for log in raw_logs:
            bn = log.get("blockNumber")
            bn = int(bn, 16) if isinstance(bn, str) else int(bn)
            blocks_with_logs.setdefault(bn, []).append(log)

        eth_usd        = await self._get_eth_price()
        ts_cache: dict[int, datetime] = {}  # cache local au batch

        for block_num, logs in sorted(blocks_with_logs.items()):
            if block_num not in ts_cache:
                ts_cache[block_num] = await self._get_block_timestamp(w3, block_num)
            block_ts = ts_cache[block_num]

            for log in logs:
                await self._handle_log(dict(log), block_num, block_ts, eth_usd, w3,
                                       historical=True)

        await self.db.mark_range_processed(from_block, to_block)

    # ─── Traitement d'un bloc individuel (live) ───────────────────────────────

    async def _process_block(self, w3: AsyncWeb3, block_num: int):
        try:
            raw_logs = await asyncio.wait_for(
                w3.eth.get_logs({
                    "fromBlock": block_num,
                    "toBlock":   block_num,
                    "topics":    [list(TRACKED_TOPICS)],
                }),
                timeout=10.0,
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
            block_ts = await self._get_block_timestamp(w3, block_num)
            eth_usd  = await self._get_eth_price()
            for log in raw_logs:
                await self._handle_log(dict(log), block_num, block_ts, eth_usd, w3,
                                       historical=False)

        await self.db.save_checkpoint(block_num)
        await self.db.mark_range_processed(block_num, block_num)

        if block_num % 100 == 0:
            logger.info(f"Block {block_num} — {len(raw_logs) if raw_logs else 0} relevant logs")

    async def _get_block_timestamp(self, w3: AsyncWeb3, block_num: int) -> datetime:
        """Fetch timestamp avec retry — ne tombe jamais en fallback now()."""
        for attempt in range(4):
            try:
                block = await asyncio.wait_for(w3.eth.get_block(block_num), timeout=15.0)
                ts = block["timestamp"]
                if isinstance(ts, str):
                    ts = int(ts, 16)
                return datetime.fromtimestamp(ts, tz=timezone.utc)
            except Exception as e:
                wait = 1.0 * (2 ** attempt)
                if attempt < 3:
                    logger.debug(f"get_block {block_num} attempt {attempt+1}: {e!r} — retry in {wait:.0f}s")
                    await asyncio.sleep(wait)
                else:
                    logger.error(f"get_block {block_num} failed after 4 attempts — raising")
                    raise

    # ─── Traitement d'un log individuel ──────────────────────────────────────

    async def _handle_log(self, log: dict, block_num: int, block_ts: datetime,
                          eth_usd: float, w3_ref: AsyncWeb3 = None,
                          historical: bool = False):
        try:
            # price_usd=None pour les blocs historiques : on n'a pas le prix ETH d'époque,
            # stocker le prix actuel fausserait toutes les stats USD historiques.
            effective_eth_usd = 0.0 if historical else eth_usd
            result = decode_nft_log(log, block_num, block_ts, effective_eth_usd)
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
                    # En mode historique on résout quand même le nom (appel unique par collection)
                    await self._resolve_collection_meta(w3_ref, result["collection_addr"])
                inserted = await self.db.insert_sale(result, skip_stats_refresh=historical)
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

    # ─── Backfill noms de collections ────────────────────────────────────────

    async def _backfill_collection_names(self, w3: AsyncWeb3) -> None:
        try:
            unnamed = await self.db.get_unnamed_collections()
            if not unnamed:
                return
            logger.info(f"Resolving names for {len(unnamed)} collections without metadata")
            for addr in unnamed:
                await self._resolve_collection_meta(w3, addr)
                await asyncio.sleep(0.05)
        except Exception as e:
            logger.warning(f"Backfill collection names failed: {e!r}")

    # ─── Résolution nom/symbole ERC-721 ──────────────────────────────────────

    async def _resolve_collection_meta(self, w3: AsyncWeb3, address: str) -> None:
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
        try:
            raw  = await asyncio.wait_for(
                w3.eth.call({"to": address, "data": selector}),
                timeout=3.0,
            )
            data = bytes(raw) if raw else b""
            if not data:
                return ""

            # ABI standard : data[0:32] = offset (en bytes) vers la longueur de la string.
            # L'offset minimum valide est 32 (une seule valeur dynamique).
            # Certains contrats non-standards retournent offset != 32 (ex : 0x40, 0x60).
            # On décode correctement quel que soit l'offset.
            if len(data) >= 64:
                offset = int.from_bytes(data[0:32], "big")
                if 32 <= offset < len(data) - 32:
                    str_len = int.from_bytes(data[offset:offset + 32], "big")
                    end = offset + 32 + str_len
                    if 0 < str_len <= 512 and end <= len(data):
                        return (
                            data[offset + 32: end]
                            .decode("utf-8", errors="replace")
                            .strip("\x00")
                            .strip()[:128]
                        )

            # Fallback : encodage bytes32 (contrats anciens qui retournent la string brute)
            if len(data) >= 32:
                return data[:32].rstrip(b"\x00").decode("utf-8", errors="ignore").strip()[:128]
            return ""
        except Exception as e:
            logger.debug(f"eth_call_string failed for {address} sel={selector}: {e!r}")
            return ""

    # ─── Prix ETH/USD ─────────────────────────────────────────────────────────

    async def _get_eth_price(self) -> float:
        now = time.monotonic()
        if self._eth_usd > 0 and now - self._eth_usd_ts < 60:
            return self._eth_usd
        if not self._http_session or self._http_session.closed:
            return self._eth_usd
        try:
            async with self._http_session.get(ETH_PRICE_URL) as r:
                if r.status == 200:
                    data = await r.json()
                    self._eth_usd    = float(data["ethereum"]["usd"])
                    self._eth_usd_ts = now
                    logger.debug(f"ETH price updated: ${self._eth_usd:.2f}")
        except Exception as e:
            logger.warning(f"ETH price fetch failed: {e!r} — using ${self._eth_usd:.2f}")
        return self._eth_usd
