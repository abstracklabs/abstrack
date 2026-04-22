"""
Stockage PostgreSQL — couche d'accès aux données de l'indexer.

Robustesse :
- retry exponentiel sur les erreurs transitoires (connexion perdue, deadlock)
- UPSERT sur le checkpoint (jamais de UPDATE silencieux)
- protection double-insert via ON CONFLICT DO NOTHING
- refresh_collection_stats conditionnel (seulement si une vente a été insérée)
"""

import asyncio
import asyncpg
import logging
from typing import Optional

logger = logging.getLogger("indexer.db")

# Erreurs asyncpg qui justifient un retry
_RETRYABLE = (
    asyncpg.TooManyConnectionsError,
    asyncpg.PostgresConnectionError,
    asyncpg.InterfaceError,
    OSError,
)


async def _with_retry(coro_fn, max_attempts: int = 3, base_delay: float = 0.5):
    """Retry exponentiel sur les erreurs transitoires de PG."""
    delay = base_delay
    for attempt in range(1, max_attempts + 1):
        try:
            return await coro_fn()
        except _RETRYABLE as e:
            if attempt == max_attempts:
                raise
            logger.warning(f"DB transient error (attempt {attempt}/{max_attempts}): {e!r} — retry in {delay:.1f}s")
            await asyncio.sleep(delay)
            delay *= 2
        except asyncpg.UniqueViolationError:
            # Double-insert déjà géré par ON CONFLICT — pas de retry
            return None


class Database:
    def __init__(self, dsn: str):
        self._dsn = dsn
        self._pool: Optional[asyncpg.Pool] = None

    async def connect(self, max_attempts: int = 5):
        """Connexion avec retry — essentiel au démarrage si PG n'est pas encore prêt."""
        delay = 1.0
        for attempt in range(1, max_attempts + 1):
            try:
                self._pool = await asyncpg.create_pool(
                    self._dsn,
                    min_size=2,
                    max_size=10,
                    command_timeout=30,
                    statement_cache_size=0,   # requis avec PgBouncer (Supabase pooler)
                    server_settings={"application_name": "abstrack-indexer"},
                )
                logger.info("PostgreSQL pool connected")
                return
            except Exception as e:
                if attempt == max_attempts:
                    raise RuntimeError(f"Cannot connect to PostgreSQL after {max_attempts} attempts") from e
                logger.warning(f"PG connection failed (attempt {attempt}): {e!r} — retry in {delay:.0f}s")
                await asyncio.sleep(delay)
                delay = min(delay * 2, 15)

    async def close(self):
        if self._pool:
            await self._pool.close()
            logger.info("PostgreSQL pool closed")

    # ─── Suivi des plages indexées ────────────────────────────────────────────
    #
    # On enregistre des plages [from_block, to_block] plutôt que des blocs
    # individuels pour rester compact. L'indexer appelle mark_range_processed()
    # à la fin de chaque session de traitement (catchup ou live par lot).

    async def mark_range_processed(self, from_block: int, to_block: int) -> None:
        """
        Enregistre une plage de blocs comme indexée.
        Fusionne automatiquement avec les plages adjacentes pour éviter
        la fragmentation de la table indexed_block_ranges.
        """
        if from_block > to_block:
            return

        async def _do():
            async with self._pool.acquire() as conn:
                async with conn.transaction():
                    # Cherche les plages adjacentes ou chevauchantes
                    rows = await conn.fetch(
                        """
                        SELECT id, from_block, to_block
                        FROM indexed_block_ranges
                        WHERE from_block <= $2 + 1
                          AND to_block   >= $1 - 1
                        ORDER BY from_block
                        """,
                        from_block, to_block,
                    )

                    if rows:
                        # Fusionne avec les plages existantes
                        merged_from = min(from_block, rows[0]["from_block"])
                        merged_to   = max(to_block,   rows[-1]["to_block"])
                        ids         = [r["id"] for r in rows]

                        # Supprime les anciennes plages
                        await conn.execute(
                            "DELETE FROM indexed_block_ranges WHERE id = ANY($1::bigint[])",
                            ids,
                        )
                        # Insère la plage fusionnée
                        await conn.execute(
                            "INSERT INTO indexed_block_ranges (from_block, to_block) VALUES ($1, $2)",
                            merged_from, merged_to,
                        )
                    else:
                        # Nouvelle plage sans voisin
                        await conn.execute(
                            "INSERT INTO indexed_block_ranges (from_block, to_block) VALUES ($1, $2)",
                            from_block, to_block,
                        )

        await _with_retry(_do)
        logger.debug(f"Range marked: [{from_block}–{to_block}]")

    async def find_gaps(self, from_block: int, to_block: int) -> list[dict]:
        """
        Retourne les trous de blocs entre from_block et to_block.
        Chaque trou : {"gap_from": int, "gap_to": int, "gap_size": int}
        """
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT gap_from, gap_to, gap_size FROM find_indexer_gaps($1, $2)",
                from_block, to_block,
            )
        return [dict(r) for r in rows]

    async def get_indexed_ranges(self) -> list[dict]:
        """Retourne toutes les plages indexées (pour diagnostic)."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT from_block, to_block, (to_block - from_block + 1) AS size "
                "FROM indexed_block_ranges ORDER BY from_block"
            )
        return [dict(r) for r in rows]

    # ─── Checkpoint ──────────────────────────────────────────────────────────
    # UPSERT au lieu de UPDATE pur — résiste si la row est absente

    async def get_last_block(self) -> int:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT value FROM indexer_state WHERE key = 'last_block'"
            )
            return int(row["value"]) if row else 0

    async def save_checkpoint(self, block_number: int) -> None:
        async def _do():
            async with self._pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO indexer_state (key, value)
                    VALUES ('last_block', $1)
                    ON CONFLICT (key) DO UPDATE
                      SET value = EXCLUDED.value, updated_at = now()
                    """,
                    str(block_number),
                )
        await _with_retry(_do)

    # ─── Generic state store ─────────────────────────────────────────────────
    # Utilisé pour persister l'état de réindexation à travers les redémarrages.

    async def get_state(self, key: str) -> Optional[str]:
        """Lit une valeur arbitraire depuis indexer_state. Retourne None si absente."""
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT value FROM indexer_state WHERE key = $1", key
            )
            return row["value"] if row else None

    async def set_state(self, key: str, value: str) -> None:
        """Écrit (upsert) une valeur dans indexer_state."""
        async def _do():
            async with self._pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO indexer_state (key, value)
                    VALUES ($1, $2)
                    ON CONFLICT (key) DO UPDATE
                      SET value = EXCLUDED.value, updated_at = now()
                    """,
                    key, value,
                )
        await _with_retry(_do)

    async def delete_state(self, key: str) -> None:
        """Supprime une clé de indexer_state (idempotent)."""
        async def _do():
            async with self._pool.acquire() as conn:
                await conn.execute(
                    "DELETE FROM indexer_state WHERE key = $1", key
                )
        await _with_retry(_do)

    # ─── Collections ─────────────────────────────────────────────────────────

    async def upsert_collection(self, address: str) -> bool:
        """Insère une collection. Retourne True si c'est une nouvelle collection."""
        async def _do():
            async with self._pool.acquire() as conn:
                result = await conn.execute(
                    """
                    INSERT INTO collections (address)
                    VALUES ($1)
                    ON CONFLICT (address) DO NOTHING
                    """,
                    address.lower(),
                )
                return result == "INSERT 0 1"
        return bool(await _with_retry(_do))

    async def get_unnamed_collections(self) -> list[str]:
        """Retourne les adresses des collections sans nom (pour backfill au démarrage).
        Inclut les lignes avec name='' (résolution précédente échouée silencieusement).
        """
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT address FROM collections WHERE name IS NULL OR trim(name) = '' LIMIT 200"
            )
        return [r["address"] for r in rows]

    async def update_collection_meta(self, address: str, name: str, symbol: str) -> None:
        """Met à jour le nom et symbole d'une collection."""
        async def _do():
            async with self._pool.acquire() as conn:
                await conn.execute(
                    """
                    UPDATE collections SET name = $2, symbol = $3
                    WHERE address = $1 AND (name IS NULL OR name = '')
                    """,
                    address.lower(), name, symbol,
                )
        try:
            await _with_retry(_do)
        except Exception as e:
            logger.warning(f"update_collection_meta failed for {address}: {e!r}")

    # ─── NFT Sales ───────────────────────────────────────────────────────────

    async def insert_sale(self, sale: dict, skip_stats_refresh: bool = False) -> bool:
        """
        Insère une vente. Retourne True si insérée, False si doublon.

        skip_stats_refresh=True durant le catchup historique :
          - évite de recalculer les stats 24h pour chaque vente historique
          - les ventes historiques ont block_ts << now()-24h → stats toujours à 0
          - empêche d'écraser les stats réelles des collections actives
        """
        async def _do():
            async with self._pool.acquire() as conn:
                result = await conn.execute(
                    """
                    INSERT INTO nft_sales
                      (tx_hash, log_index, block_number, block_ts, collection_addr,
                       token_id, seller, buyer, price_eth, price_usd, marketplace)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                    ON CONFLICT (tx_hash, log_index) DO NOTHING
                    """,
                    sale["tx_hash"],
                    sale.get("log_index", 0),
                    sale["block_number"],
                    sale["block_ts"],
                    sale["collection_addr"].lower(),
                    sale["token_id"],
                    sale["seller"].lower(),
                    sale["buyer"].lower(),
                    sale["price_eth"],
                    sale.get("price_usd"),
                    sale.get("marketplace", "unknown"),
                )
                return result == "INSERT 0 1"  # True = nouvelle ligne, False = conflit

        inserted = await _with_retry(_do)
        if inserted and not skip_stats_refresh:
            # Refresh stats seulement si insertion réelle ET pas en catchup historique
            await self._refresh_stats(sale["collection_addr"].lower())
        return bool(inserted)

    async def _refresh_stats(self, addr: str) -> None:
        async def _do():
            async with self._pool.acquire() as conn:
                await conn.execute("SELECT refresh_collection_stats($1)", addr)
        try:
            await _with_retry(_do)
        except Exception as e:
            # Non-critique : les stats seront correctes au prochain cycle
            logger.warning(f"refresh_collection_stats failed for {addr}: {e!r}")

    async def refresh_all_collection_stats(self) -> int:
        """
        Recalcule les stats 24h de toutes les collections.
        Appelé une seule fois après la fin du catchup historique
        (les stats ont été skippées pendant l'indexation pour éviter de les remettre à zéro).
        Retourne le nombre de collections mises à jour.
        """
        async def _do():
            async with self._pool.acquire() as conn:
                rows = await conn.fetch("SELECT address FROM collections")
                updated = 0
                for row in rows:
                    await conn.execute("SELECT refresh_collection_stats($1)", row["address"])
                    updated += 1
                return updated
        try:
            count = await _with_retry(_do)
            logger.info(f"refresh_all_collection_stats: {count} collections updated")
            return count or 0
        except Exception as e:
            logger.warning(f"refresh_all_collection_stats failed: {e!r}")
            return 0

    # ─── NFT Transfers ────────────────────────────────────────────────────────

    async def insert_transfer(self, transfer: dict) -> bool:
        async def _do():
            async with self._pool.acquire() as conn:
                result = await conn.execute(
                    """
                    INSERT INTO nft_transfers
                      (tx_hash, log_index, block_number, block_ts,
                       collection_addr, token_id, from_addr, to_addr, transfer_type)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                    ON CONFLICT (tx_hash, log_index) DO NOTHING
                    """,
                    transfer["tx_hash"],
                    transfer["log_index"],
                    transfer["block_number"],
                    transfer["block_ts"],
                    transfer["collection_addr"].lower(),
                    transfer["token_id"],
                    transfer["from_addr"].lower(),
                    transfer["to_addr"].lower(),
                    transfer.get("transfer_type", "transfer"),
                )
                return result == "INSERT 0 1"

        return bool(await _with_retry(_do))
