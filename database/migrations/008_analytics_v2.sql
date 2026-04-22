-- ═══════════════════════════════════════════════════════════════
-- Migration 008 — Analytics v2
--
-- 1. Indexes composites nft_transfers pour holder count rapide
-- 2. Index nft_sales(price_eth DESC) pour détection whales
-- 3. Index nft_sales(block_ts DESC) pour live-sales broadcaster
-- 4. check_stats_drift() amélioré — vérifie aussi floor_price_eth
-- 5. wallet_realized_pnl()  — PnL réalisé (sells - buys) par wallet
-- 6. collection_analytics() — stats complètes d'une collection en 1 query
-- 7. market_overview()       — stats globales enrichies (7j + 30j)
-- ═══════════════════════════════════════════════════════════════

-- ─── 1. Indexes composites nft_transfers ─────────────────────
--
-- Le holder count fait une UNION ALL :
--   SELECT to_addr, quantity WHERE collection_addr = $1
--   SELECT from_addr, quantity WHERE collection_addr = $1
-- Ces deux branches ont besoin d'un index (collection_addr, to/from_addr)
-- avec INCLUDE(quantity) pour un index-only scan complet.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_nft_transfers_coll_to
  ON nft_transfers (collection_addr, to_addr)
  INCLUDE (quantity, token_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_nft_transfers_coll_from
  ON nft_transfers (collection_addr, from_addr)
  INCLUDE (quantity, token_id);

-- ─── 2. Index nft_sales(price_eth DESC) ──────────────────────
--
-- Utilisé par les requêtes whale : WHERE price_eth >= $threshold AND block_ts > now()-Ns
-- INCLUDE block_ts pour éviter le heap fetch sur le filtre temporel.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_nft_sales_price_eth_desc
  ON nft_sales (price_eth DESC)
  INCLUDE (block_ts, collection_addr, tx_hash, token_id, buyer, seller, price_usd, marketplace);

-- ─── 3. Index nft_sales(block_ts DESC) ───────────────────────
--
-- Utilisé par le live-sales broadcaster (poll toutes les 2s).
-- Couvre les colonnes SELECT pour index-only scan.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_nft_sales_block_ts_desc
  ON nft_sales (block_ts DESC, id DESC)
  INCLUDE (collection_addr, tx_hash, token_id, seller, buyer, price_eth, price_usd, marketplace);

-- ─── 4. check_stats_drift() amélioré ─────────────────────────
--
-- Version originale (002) : vérifie volume_24h_eth + sales_count_24h.
-- Version 008 : ajoute floor_price_eth (calculé sur 7j).
-- Seuil floor drift : > 0.001 ETH (évite les faux positifs sur petites collections).

CREATE OR REPLACE FUNCTION check_stats_drift()
RETURNS TABLE(
    address           VARCHAR(42),
    name              TEXT,
    cached_volume     NUMERIC,
    real_volume       NUMERIC,
    volume_drift      NUMERIC,
    cached_sales      INTEGER,
    real_sales        BIGINT,
    sales_drift       BIGINT,
    cached_floor      NUMERIC,
    real_floor        NUMERIC,
    floor_drift       NUMERIC
)
LANGUAGE sql STABLE AS $$
    WITH real_stats AS (
        SELECT
            collection_addr,
            COALESCE(SUM(price_eth) FILTER (
                WHERE block_ts > now() - INTERVAL '24 hours'
            ), 0)                                                          AS real_volume,
            COUNT(*) FILTER (
                WHERE block_ts > now() - INTERVAL '24 hours'
            )                                                              AS real_sales,
            MIN(price_eth) FILTER (
                WHERE price_eth > 0
                  AND block_ts > now() - INTERVAL '7 days'
            )                                                              AS real_floor
        FROM nft_sales
        WHERE block_ts > now() - INTERVAL '7 days'
        GROUP BY collection_addr
    )
    SELECT
        c.address,
        c.name,
        c.volume_24h_eth                                      AS cached_volume,
        COALESCE(r.real_volume, 0)                            AS real_volume,
        ABS(c.volume_24h_eth - COALESCE(r.real_volume, 0))   AS volume_drift,
        c.sales_count_24h                                     AS cached_sales,
        COALESCE(r.real_sales, 0)                             AS real_sales,
        ABS(c.sales_count_24h - COALESCE(r.real_sales, 0))   AS sales_drift,
        c.floor_price_eth                                     AS cached_floor,
        COALESCE(r.real_floor, 0)                             AS real_floor,
        ABS(c.floor_price_eth - COALESCE(r.real_floor, 0))   AS floor_drift
    FROM collections c
    LEFT JOIN real_stats r ON r.collection_addr = c.address
    WHERE
        ABS(c.volume_24h_eth - COALESCE(r.real_volume, 0)) > 0.01
        OR ABS(c.sales_count_24h - COALESCE(r.real_sales, 0)) > 5
        OR ABS(c.floor_price_eth - COALESCE(r.real_floor, 0)) > 0.001
    ORDER BY volume_drift DESC
$$;

-- ─── 5. wallet_realized_pnl() ─────────────────────────────────
--
-- Calcule le PnL réalisé d'un wallet :
--   realized_pnl = Σ(price_eth WHERE seller=addr) - Σ(price_eth WHERE buyer=addr)
--
-- Ce n'est pas un PnL par token (on n'a pas le prix d'achat par token_id)
-- mais un PnL global qui donne une vraie image de l'activité trading.
--
-- Utilise un seul scan sur nft_sales avec FILTER pour éviter deux requêtes.

CREATE OR REPLACE FUNCTION wallet_realized_pnl(p_addr TEXT)
RETURNS TABLE(
    total_spent_eth      NUMERIC,
    total_received_eth   NUMERIC,
    realized_pnl_eth     NUMERIC,
    buy_count            BIGINT,
    sell_count           BIGINT,
    unique_collections   BIGINT,
    most_traded_coll     TEXT,
    avg_buy_price_eth    NUMERIC,
    avg_sell_price_eth   NUMERIC
)
LANGUAGE sql STABLE AS $$
    SELECT
        COALESCE(SUM(price_eth) FILTER (WHERE buyer  = lower(p_addr)), 0) AS total_spent_eth,
        COALESCE(SUM(price_eth) FILTER (WHERE seller = lower(p_addr)), 0) AS total_received_eth,
        COALESCE(SUM(price_eth) FILTER (WHERE seller = lower(p_addr)), 0)
            - COALESCE(SUM(price_eth) FILTER (WHERE buyer = lower(p_addr)), 0) AS realized_pnl_eth,

        COUNT(*) FILTER (WHERE buyer  = lower(p_addr)) AS buy_count,
        COUNT(*) FILTER (WHERE seller = lower(p_addr)) AS sell_count,

        COUNT(DISTINCT collection_addr)
            FILTER (WHERE buyer = lower(p_addr) OR seller = lower(p_addr)) AS unique_collections,

        -- Collection la plus tradée (par nombre de transactions)
        (
            SELECT collection_addr
            FROM nft_sales
            WHERE buyer = lower(p_addr) OR seller = lower(p_addr)
            GROUP BY collection_addr
            ORDER BY COUNT(*) DESC
            LIMIT 1
        ) AS most_traded_coll,

        COALESCE(AVG(price_eth) FILTER (WHERE buyer  = lower(p_addr) AND price_eth > 0), 0) AS avg_buy_price_eth,
        COALESCE(AVG(price_eth) FILTER (WHERE seller = lower(p_addr) AND price_eth > 0), 0) AS avg_sell_price_eth
    FROM nft_sales
    WHERE buyer = lower(p_addr) OR seller = lower(p_addr)
$$;

-- ─── 6. collection_analytics() ────────────────────────────────
--
-- Toutes les stats analytiques d'une collection en une seule requête.
-- Utilisé par le backend GET /collections/:addr/analytics.
--
-- Inclut :
--   - Volume et ventes sur 1h, 24h, 7j, 30j
--   - Floor price sur 7j
--   - Prix moyen, max, médian sur 24h
--   - Nombre de buyers uniques sur 24h
--   - Momentum : ratio volume 1h / volume 24h moyen

CREATE OR REPLACE FUNCTION collection_analytics(p_addr TEXT)
RETURNS JSONB
LANGUAGE plpgsql STABLE AS $$
DECLARE
    result JSONB;
BEGIN
    SELECT jsonb_build_object(
        'address',         p_addr,
        'computed_at',     now(),

        -- Volumes par période
        'volume_1h_eth',   COALESCE(SUM(price_eth) FILTER (WHERE block_ts > now() - INTERVAL '1 hour'), 0),
        'volume_24h_eth',  COALESCE(SUM(price_eth) FILTER (WHERE block_ts > now() - INTERVAL '24 hours'), 0),
        'volume_7d_eth',   COALESCE(SUM(price_eth) FILTER (WHERE block_ts > now() - INTERVAL '7 days'), 0),
        'volume_30d_eth',  COALESCE(SUM(price_eth) FILTER (WHERE block_ts > now() - INTERVAL '30 days'), 0),

        -- Ventes par période
        'sales_1h',   COUNT(*) FILTER (WHERE block_ts > now() - INTERVAL '1 hour'),
        'sales_24h',  COUNT(*) FILTER (WHERE block_ts > now() - INTERVAL '24 hours'),
        'sales_7d',   COUNT(*) FILTER (WHERE block_ts > now() - INTERVAL '7 days'),
        'sales_30d',  COUNT(*) FILTER (WHERE block_ts > now() - INTERVAL '30 days'),

        -- Prix 24h
        'floor_24h_eth', MIN(price_eth) FILTER (WHERE price_eth > 0 AND block_ts > now() - INTERVAL '24 hours'),
        'floor_7d_eth',  MIN(price_eth) FILTER (WHERE price_eth > 0 AND block_ts > now() - INTERVAL '7 days'),
        'avg_24h_eth',   AVG(price_eth) FILTER (WHERE price_eth > 0 AND block_ts > now() - INTERVAL '24 hours'),
        'max_24h_eth',   MAX(price_eth) FILTER (WHERE block_ts > now() - INTERVAL '24 hours'),

        -- Buyers uniques 24h
        'unique_buyers_24h',  COUNT(DISTINCT buyer)  FILTER (WHERE block_ts > now() - INTERVAL '24 hours'),
        'unique_sellers_24h', COUNT(DISTINCT seller) FILTER (WHERE block_ts > now() - INTERVAL '24 hours'),

        -- Momentum : volume 1h vs volume 24h moyen (24h / 24 = volume/heure moyen)
        -- Ratio > 1 = accélération ; < 1 = décélération
        'momentum_ratio', CASE
            WHEN COALESCE(SUM(price_eth) FILTER (WHERE block_ts > now() - INTERVAL '24 hours'), 0) = 0 THEN NULL
            ELSE ROUND(
                COALESCE(SUM(price_eth) FILTER (WHERE block_ts > now() - INTERVAL '1 hour'), 0)
                / (COALESCE(SUM(price_eth) FILTER (WHERE block_ts > now() - INTERVAL '24 hours'), 0) / 24.0),
                2
            )
        END
    )
    INTO result
    FROM nft_sales
    WHERE collection_addr = lower(p_addr)
      AND block_ts > now() - INTERVAL '30 days';

    RETURN COALESCE(result, '{}'::JSONB);
END;
$$;

-- ─── 7. market_overview() ─────────────────────────────────────
--
-- Vue globale du marché NFT avec comparaison temporelle.
-- Plus riche que le simple /analytics/global qui ne couvre que 24h.

CREATE OR REPLACE FUNCTION market_overview()
RETURNS JSONB
LANGUAGE plpgsql STABLE AS $$
DECLARE
    result JSONB;
BEGIN
    SELECT jsonb_build_object(
        'computed_at',  now(),

        -- Stats 24h
        'sales_24h',            COUNT(*) FILTER (WHERE block_ts > now() - INTERVAL '24 hours'),
        'volume_24h_eth',       COALESCE(SUM(price_eth) FILTER (WHERE block_ts > now() - INTERVAL '24 hours'), 0),
        'avg_price_24h_eth',    COALESCE(AVG(price_eth) FILTER (WHERE price_eth > 0 AND block_ts > now() - INTERVAL '24 hours'), 0),
        'collections_active_24h', COUNT(DISTINCT collection_addr) FILTER (WHERE block_ts > now() - INTERVAL '24 hours'),
        'unique_buyers_24h',    COUNT(DISTINCT buyer)  FILTER (WHERE block_ts > now() - INTERVAL '24 hours'),
        'unique_sellers_24h',   COUNT(DISTINCT seller) FILTER (WHERE block_ts > now() - INTERVAL '24 hours'),

        -- Stats 7j
        'sales_7d',             COUNT(*) FILTER (WHERE block_ts > now() - INTERVAL '7 days'),
        'volume_7d_eth',        COALESCE(SUM(price_eth) FILTER (WHERE block_ts > now() - INTERVAL '7 days'), 0),
        'collections_active_7d', COUNT(DISTINCT collection_addr) FILTER (WHERE block_ts > now() - INTERVAL '7 days'),

        -- Comparaison 24h vs 24h précédentes (growth rate)
        'volume_prev_24h_eth',  COALESCE(SUM(price_eth) FILTER (
            WHERE block_ts BETWEEN now() - INTERVAL '48 hours' AND now() - INTERVAL '24 hours'
        ), 0),
        'sales_prev_24h',       COUNT(*) FILTER (
            WHERE block_ts BETWEEN now() - INTERVAL '48 hours' AND now() - INTERVAL '24 hours'
        ),

        -- Total all-time
        'total_sales_alltime',  COUNT(*),
        'total_volume_alltime_eth', COALESCE(SUM(price_eth), 0),
        'total_collections',    (SELECT COUNT(*) FROM collections),
        'last_indexed_block',   (SELECT value::BIGINT FROM indexer_state WHERE key = 'last_block')
    )
    INTO result
    FROM nft_sales;

    RETURN COALESCE(result, '{}'::JSONB);
END;
$$;
