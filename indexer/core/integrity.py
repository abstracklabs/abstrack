"""
Détection et correction des trous de données dans l'indexer.

Fonctionnement :
  1. Au démarrage, compare le checkpoint (last_block) avec les
     plages réellement indexées dans indexed_block_ranges.
  2. Si des trous sont trouvés, les ajoute à une file de resync.
  3. Un worker léger re-indexe les trous en arrière-plan,
     sans bloquer le listener principal.

Pourquoi des trous apparaissent :
  - Crash de l'indexer en plein catchup (checkpoint sauvegardé
    mais les blocs intermédiaires pas tous marqués)
  - Timeout eth_getLogs sur un bloc dense (skippé avec log WARNING)
  - Redémarrage rapide pendant une phase de catchup massive

Ce que ce module NE fait PAS :
  - Détecter les reorgs (trop complexe pour MVP)
  - Valider le contenu des blocs (on fait confiance au nœud RPC)
  - Tenir un historique des rescans
"""

import asyncio
import logging
from dataclasses import dataclass

from storage.db import Database

logger = logging.getLogger("indexer.integrity")


@dataclass
class BlockGap:
    gap_from: int
    gap_to:   int
    gap_size: int


class GapDetector:
    """
    Détecte les trous dans les blocs indexés et planifie leur resync.

    Usage :
        detector = GapDetector(db, listener)
        gaps = await detector.check(last_known_block=4_823_000)
        if gaps:
            await detector.fill(gaps)
    """

    # On ne cherche des trous que sur les N derniers blocs
    # (plus loin = déjà considéré comme "archivé", pas critique)
    LOOKBACK_BLOCKS = 10_000

    # Tous les trous sont traités, même les blocs individuels.
    # Un bloc skippé en live (timeout) crée un trou de taille 1 : on le remplit.
    MIN_GAP_SIZE = 1

    def __init__(self, db: Database, process_block_fn):
        """
        Args:
            db: instance Database
            process_block_fn: coroutine(w3, block_num) de LiveListener._process_block
                              — réutilise la même logique de traitement
        """
        self.db               = db
        self._process_block   = process_block_fn

    async def check(self, current_head: int) -> list[BlockGap]:
        """
        Cherche les trous dans la fenêtre [current_head - LOOKBACK, current_head].
        Retourne une liste de trous, vide si tout est cohérent.
        """
        from_block = max(0, current_head - self.LOOKBACK_BLOCKS)
        to_block   = current_head

        raw_gaps = await self.db.find_gaps(from_block, to_block)
        gaps = [
            BlockGap(**g)
            for g in raw_gaps
            if g["gap_size"] >= self.MIN_GAP_SIZE
        ]

        if gaps:
            total_missing = sum(g.gap_size for g in gaps)
            logger.warning(
                f"Found {len(gaps)} gap(s) — {total_missing} missing blocks "
                f"in range [{from_block}–{to_block}]",
                extra={"gaps": [{"from": g.gap_from, "to": g.gap_to, "size": g.gap_size} for g in gaps]},
            )
        else:
            logger.info(
                f"Integrity check OK — no gaps in [{from_block}–{to_block}]",
                extra={"lookback_blocks": self.LOOKBACK_BLOCKS},
            )

        return gaps

    async def fill(self, gaps: list[BlockGap], w3, max_concurrent: int = 3) -> dict:
        """
        Re-indexe les blocs manquants.
        Traite les trous séquentiellement, les blocs dans un trou en parallèle limité.

        Retourne un résumé {"filled": N, "failed": N, "total_blocks": N}.
        """
        if not gaps:
            return {"filled": 0, "failed": 0, "total_blocks": 0}

        total_blocks = sum(g.gap_size for g in gaps)
        logger.info(
            f"Starting gap fill — {len(gaps)} gap(s), {total_blocks} blocks to resync",
            extra={"gaps_count": len(gaps), "total_blocks": total_blocks},
        )

        filled = 0
        failed = 0

        for gap in gaps:
            gap_filled, gap_failed = await self._fill_gap(gap, w3, max_concurrent)
            filled += gap_filled
            failed += gap_failed

            if gap_filled > 0:
                logger.info(
                    f"Gap filled [{gap.gap_from}–{gap.gap_to}] "
                    f"— {gap_filled} OK, {gap_failed} failed"
                )
                if gap_failed == 0:
                    # Tous les blocs ont réussi → fusionne en une seule plage
                    # (les blocs individuels sont déjà marqués par _process_block)
                    await self.db.mark_range_processed(gap.gap_from, gap.gap_to)
                # Sinon : les blocs réussis sont déjà marqués individuellement
                # Les blocs échoués restent comme sous-trous → GapDetector les reprendra

        logger.info(
            f"Gap fill complete — {filled} blocks indexed, {failed} failed",
            extra={"filled": filled, "failed": failed},
        )
        return {"filled": filled, "failed": failed, "total_blocks": total_blocks}

    async def _fill_gap(self, gap: BlockGap, w3, max_concurrent: int) -> tuple[int, int]:
        """Traite un trou unique avec un semaphore pour limiter la concurrence."""
        sem    = asyncio.Semaphore(max_concurrent)
        filled = 0
        failed = 0

        async def _process_one(block_num: int):
            nonlocal filled, failed
            async with sem:
                try:
                    await self._process_block(w3, block_num)
                    filled += 1
                except Exception as e:
                    logger.error(
                        f"Gap fill failed at block {block_num}: {e!r}",
                        extra={"block": block_num, "gap_from": gap.gap_from, "gap_to": gap.gap_to},
                    )
                    failed += 1

        # Lance tous les blocs du trou en parallèle (limité par semaphore)
        tasks = [
            asyncio.create_task(_process_one(n))
            for n in range(gap.gap_from, gap.gap_to + 1)
        ]
        await asyncio.gather(*tasks, return_exceptions=True)
        return filled, failed
