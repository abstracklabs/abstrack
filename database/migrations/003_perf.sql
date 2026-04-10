-- ═══════════════════════════════════════════════════════════════
-- Migration 003 — Optimisations performances
--
-- 1. Index keyset sur nft_sales pour pagination curseur
-- 2. Index couvrant sur nft_sales pour wallet activity
-- 3. Index keyset couvrant pour /collections/:addr/floor
-- 4. Réécriture refresh_collection_stats : 2 subqueries → 1 agrégation
-- ═══════════════════════════════════════════════════════════════

-- ─── 1. Keyset pagination — /collections/:address/sales ──────
--
-- Ancienne pagination OFFSET : scan séquentiel de N lignes ignorées.
-- Nouvelle pagination keyset : seek direct sur (collection_addr, block_ts DESC, id DESC).
--
-- La clause WHERE (block_ts, id) < ($cursor_ts, $cursor_id) utilise cet index
-- sans scanner les lignes précédentes.
--
-- Couvre aussi les colonnes SELECT pour éviter un heap fetch :
-- price_eth, marketplace, token_id sont inclus en INCLUDE.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_nft_sales_keyset
  ON nft_sales (collection_addr, block_ts DESC, id DESC)
  INCLUDE (tx_hash, token_id, seller, buyer, price_eth, price_usd, marketplace);

-- ─── 2. Keyset pagination — /wallets/:address/activity ───────
--
-- WHERE (buyer = $addr OR seller = $addr) AND (block_ts, id) < (cursor)
-- ORDER BY block_ts DESC, id DESC
--
-- Deux index partiels (buyer, seller) pour que l'optimiseur choisisse
-- le meilleur plan selon la sélectivité.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_nft_sales_buyer_keyset
  ON nft_sales (buyer, block_ts DESC, id DESC)
  INCLUDE (tx_hash, collection_addr, token_id, price_eth, price_usd, marketplace);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_nft_sales_seller_keyset
  ON nft_sales (seller, block_ts DESC, id DESC)
  INCLUDE (tx_hash, collection_addr, token_id, price_eth, price_usd, marketplace);

-- ─── 3. Index couvrant — /collections/:address/floor ─────────
--
-- GROUP BY date_trunc('hour', block_ts), MIN/AVG/COUNT sur price_eth.
-- Index (collection_addr, block_ts DESC) INCLUDE (price_eth) → index-only scan possible.
-- (L'index idx_nft_sales_collection existant couvre déjà (collection_addr, block_ts DESC)
--  mais sans price_eth — on ajoute un index couvrant dédié.)

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_nft_sales_floor_chart
  ON nft_sales (collection_addr, block_ts DESC)
  INCLUDE (price_eth);

-- ─── 4. Index — portfolio wallet (holders/portfolio) ─────────
--
-- Les requêtes UNION ALL font deux scans :
--   SELECT ... WHERE to_addr   = $1   → couvert par idx_nft_transfers_to_addr
--   SELECT ... WHERE from_addr = $1   → couvert par idx_nft_transfers_from_addr
-- Ces index existent déjà dans 001 — on ajoute juste INCLUDE (collection_addr, token_id)
-- pour permettre index-only scans sur les deux branches de l'UNION ALL.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_nft_transfers_to_covering
  ON nft_transfers (to_addr)
  INCLUDE (collection_addr, token_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_nft_transfers_from_covering
  ON nft_transfers (from_addr)
  INCLUDE (collection_addr, token_id);

-- ─── 5. Réécriture refresh_collection_stats ──────────────────
--
-- Ancienne version : 2 subqueries corrélées (SUM + COUNT séparés)
--   → 2 scans séquentiels de nft_sales par appel
--
-- Nouvelle version : 1 seule agrégation GROUP BY
--   → 1 scan, résultat utilisé pour les deux colonnes

CREATE OR REPLACE FUNCTION refresh_collection_stats(p_addr TEXT)
RETURNS void AS $$
BEGIN
    UPDATE collections c
    SET
        volume_24h_eth  = COALESCE(s.vol, 0),
        sales_count_24h = COALESCE(s.cnt, 0),
        updated_at      = now()
    FROM (
        SELECT
            SUM(price_eth)  AS vol,
            COUNT(*)::int   AS cnt
        FROM nft_sales
        WHERE collection_addr = p_addr
          AND block_ts > now() - INTERVAL '24 hours'
    ) s
    WHERE c.address = p_addr;
END;
$$ LANGUAGE plpgsql;

-- ─── Notes d'application ─────────────────────────────────────
--
-- CONCURRENTLY = index créé sans poser de verrou exclusif sur la table.
-- La table reste disponible en lecture/écriture pendant la création.
-- Peut prendre quelques minutes sur des tables volumineuses.
--
-- Ordre d'application : après 001 et 002.
-- Idempotent : IF NOT EXISTS sur chaque CREATE INDEX.
