-- ═══════════════════════════════════════════════════════════════
-- Abstrack — Schéma complet (migrations 001 → 008 combinées)
-- À coller en une seule fois dans le SQL Editor Supabase
-- ═══════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ─── Indexer checkpoint ───────────────────────────────────────
CREATE TABLE indexer_state (
    key        TEXT        PRIMARY KEY,
    value      TEXT        NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO indexer_state (key, value) VALUES ('last_block', '0');

-- ─── Collections NFT ─────────────────────────────────────────
CREATE TABLE collections (
    address          VARCHAR(42)   PRIMARY KEY,
    name             TEXT          NOT NULL DEFAULT '',
    symbol           TEXT,
    total_supply     INTEGER,
    floor_price_eth  NUMERIC(20,8) DEFAULT 0,
    volume_24h_eth   NUMERIC(20,8) DEFAULT 0,
    sales_count_24h  INTEGER       DEFAULT 0,
    change_24h_pct   NUMERIC(8,2)  DEFAULT 0,
    thumbnail_url    TEXT,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX idx_collections_volume ON collections(volume_24h_eth DESC);
CREATE INDEX idx_collections_sales  ON collections(sales_count_24h DESC);
CREATE INDEX idx_collections_name   ON collections USING gin(name gin_trgm_ops);

-- ─── NFT Sales ───────────────────────────────────────────────
CREATE TABLE nft_sales (
    id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
    tx_hash         VARCHAR(66)   NOT NULL,
    log_index       INTEGER       NOT NULL DEFAULT 0,
    block_number    BIGINT        NOT NULL,
    block_ts        TIMESTAMPTZ   NOT NULL,
    collection_addr VARCHAR(42)   NOT NULL REFERENCES collections(address) ON DELETE CASCADE,
    token_id        TEXT          NOT NULL,
    seller          VARCHAR(42)   NOT NULL,
    buyer           VARCHAR(42)   NOT NULL,
    price_eth       NUMERIC(20,8) NOT NULL,
    price_usd       NUMERIC(20,4),
    marketplace     TEXT,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    UNIQUE(tx_hash, log_index)
);

CREATE INDEX idx_nft_sales_collection     ON nft_sales(collection_addr, block_ts DESC);
CREATE INDEX idx_nft_sales_buyer          ON nft_sales(buyer,  block_ts DESC);
CREATE INDEX idx_nft_sales_seller         ON nft_sales(seller, block_ts DESC);
CREATE INDEX idx_nft_sales_price          ON nft_sales(price_eth DESC, block_ts DESC);
CREATE INDEX idx_nft_sales_ts             ON nft_sales(block_ts DESC);
CREATE INDEX idx_nft_sales_block          ON nft_sales(block_number DESC);
CREATE INDEX idx_nft_sales_keyset         ON nft_sales(collection_addr, block_ts DESC, id DESC)
  INCLUDE (tx_hash, log_index, token_id, seller, buyer, price_eth, price_usd, marketplace);
CREATE INDEX idx_nft_sales_buyer_keyset   ON nft_sales(buyer,  block_ts DESC, id DESC)
  INCLUDE (tx_hash, collection_addr, token_id, price_eth, price_usd, marketplace);
CREATE INDEX idx_nft_sales_seller_keyset  ON nft_sales(seller, block_ts DESC, id DESC)
  INCLUDE (tx_hash, collection_addr, token_id, price_eth, price_usd, marketplace);
CREATE INDEX idx_nft_sales_floor_chart    ON nft_sales(collection_addr, block_ts DESC)
  INCLUDE (price_eth);
CREATE INDEX idx_nft_sales_price_eth_desc ON nft_sales(price_eth DESC)
  INCLUDE (block_ts, collection_addr, tx_hash, token_id, buyer, seller, price_usd, marketplace);
CREATE INDEX idx_nft_sales_block_ts_desc  ON nft_sales(block_ts DESC, id DESC)
  INCLUDE (collection_addr, tx_hash, token_id, seller, buyer, price_eth, price_usd, marketplace);

-- ─── NFT Transfers ───────────────────────────────────────────
CREATE TABLE nft_transfers (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    tx_hash         VARCHAR(66) NOT NULL,
    log_index       INTEGER     NOT NULL,
    block_number    BIGINT      NOT NULL,
    block_ts        TIMESTAMPTZ NOT NULL,
    collection_addr VARCHAR(42) NOT NULL,
    token_id        TEXT        NOT NULL,
    from_addr       VARCHAR(42) NOT NULL,
    to_addr         VARCHAR(42) NOT NULL,
    transfer_type   TEXT        NOT NULL DEFAULT 'transfer',
    quantity        BIGINT      NOT NULL DEFAULT 1,
    token_standard  TEXT        NOT NULL DEFAULT 'ERC721',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tx_hash, log_index)
);

CREATE INDEX idx_nft_transfers_to_addr       ON nft_transfers(to_addr,         block_ts DESC);
CREATE INDEX idx_nft_transfers_from_addr     ON nft_transfers(from_addr,       block_ts DESC);
CREATE INDEX idx_nft_transfers_coll_to       ON nft_transfers(collection_addr, to_addr)   INCLUDE (quantity, token_id);
CREATE INDEX idx_nft_transfers_coll_from     ON nft_transfers(collection_addr, from_addr) INCLUDE (quantity, token_id);
CREATE INDEX idx_nft_transfers_collection    ON nft_transfers(collection_addr, block_ts DESC);
CREATE INDEX idx_nft_transfers_block         ON nft_transfers(block_number DESC);
CREATE INDEX idx_nft_transfers_to_covering   ON nft_transfers(to_addr)   INCLUDE (collection_addr, token_id);
CREATE INDEX idx_nft_transfers_from_covering ON nft_transfers(from_addr) INCLUDE (collection_addr, token_id);

-- ─── Plages de blocs indexées ─────────────────────────────────
CREATE TABLE indexed_block_ranges (
    id         BIGSERIAL   PRIMARY KEY,
    from_block BIGINT      NOT NULL,
    to_block   BIGINT      NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_range_order CHECK (to_block >= from_block)
);
CREATE INDEX idx_ibr_from ON indexed_block_ranges(from_block);
CREATE INDEX idx_ibr_to   ON indexed_block_ranges(to_block);

-- ─── Prix ETH historiques ─────────────────────────────────────
CREATE TABLE eth_price_history (
    date       DATE          PRIMARY KEY,
    price_usd  NUMERIC(12,4) NOT NULL,
    updated_at TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX idx_eth_price_history_date ON eth_price_history(date);

-- ─── Users & Alerts ──────────────────────────────────────────
CREATE TABLE users (
    id             UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_address VARCHAR(42) UNIQUE NOT NULL,
    email          TEXT        UNIQUE,
    tier           TEXT        NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'api')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE alerts (
    id             UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name           TEXT        NOT NULL,
    condition      JSONB       NOT NULL,
    channels       TEXT[]      NOT NULL DEFAULT '{in_app}',
    active         BOOLEAN     NOT NULL DEFAULT true,
    cooldown_s     INTEGER     NOT NULL DEFAULT 300 CHECK (cooldown_s >= 60),
    last_triggered TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_alerts_user      ON alerts(user_id);
CREATE INDEX idx_alerts_active    ON alerts(active) WHERE active = true;
CREATE INDEX idx_alerts_triggered ON alerts(last_triggered) WHERE active = true;

CREATE TABLE alert_triggers (
    id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    alert_id     UUID        NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    triggered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    event_data   JSONB       NOT NULL
);
CREATE INDEX idx_triggers_alert ON alert_triggers(alert_id, triggered_at DESC);

-- ═══════════════════════════════════════════════════════════════
-- FONCTIONS SQL
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION refresh_collection_stats(p_addr TEXT)
RETURNS void AS $$
BEGIN
    UPDATE collections c
    SET
        volume_24h_eth  = COALESCE(s.vol, 0),
        sales_count_24h = COALESCE(s.cnt, 0),
        updated_at      = now()
    FROM (
        SELECT SUM(price_eth) AS vol, COUNT(*)::int AS cnt
        FROM nft_sales
        WHERE collection_addr = p_addr
          AND block_ts > now() - INTERVAL '24 hours'
    ) s
    WHERE c.address = p_addr;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION rebuild_all_stats()
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE updated_count INTEGER;
BEGIN
    WITH price_stats AS (
        SELECT
            collection_addr,
            MIN(price_eth) FILTER (WHERE price_eth > 0 AND block_ts > now() - INTERVAL '7 days')  AS floor_7d,
            MIN(price_eth) FILTER (WHERE price_eth > 0 AND block_ts BETWEEN now() - INTERVAL '48 hours' AND now() - INTERVAL '24 hours') AS floor_48h_24h,
            MIN(price_eth) FILTER (WHERE price_eth > 0 AND block_ts > now() - INTERVAL '24 hours') AS floor_24h,
            COALESCE(SUM(price_eth) FILTER (WHERE block_ts > now() - INTERVAL '24 hours'), 0)      AS vol_24h,
            COUNT(*)        FILTER (WHERE block_ts > now() - INTERVAL '24 hours')::INTEGER          AS cnt_24h
        FROM nft_sales
        WHERE block_ts > now() - INTERVAL '7 days'
        GROUP BY collection_addr
    )
    UPDATE collections c
    SET
        floor_price_eth = COALESCE(ps.floor_7d, 0),
        volume_24h_eth  = ps.vol_24h,
        sales_count_24h = ps.cnt_24h,
        change_24h_pct  = CASE
            WHEN ps.floor_48h_24h > 0 AND ps.floor_24h IS NOT NULL
            THEN ROUND(((ps.floor_24h - ps.floor_48h_24h) / ps.floor_48h_24h) * 100, 2)
            ELSE 0
        END,
        updated_at = now()
    FROM price_stats ps
    WHERE c.address = ps.collection_addr;

    GET DIAGNOSTICS updated_count = ROW_COUNT;

    UPDATE collections SET floor_price_eth=0, volume_24h_eth=0, sales_count_24h=0, change_24h_pct=0, updated_at=now()
    WHERE address NOT IN (SELECT DISTINCT collection_addr FROM nft_sales WHERE block_ts > now() - INTERVAL '7 days')
      AND (volume_24h_eth > 0 OR sales_count_24h > 0 OR floor_price_eth > 0);

    RETURN updated_count;
END;
$$;

CREATE OR REPLACE FUNCTION find_indexer_gaps(p_from BIGINT, p_to BIGINT)
RETURNS TABLE(gap_from BIGINT, gap_to BIGINT, gap_size BIGINT)
LANGUAGE sql STABLE AS $$
    WITH expected AS (SELECT gs AS blk FROM generate_series(p_from, p_to, 100) gs),
    covered AS (
        SELECT e.blk FROM expected e
        WHERE EXISTS (SELECT 1 FROM indexed_block_ranges r WHERE r.from_block <= e.blk AND r.to_block >= e.blk)
    ),
    uncovered AS (SELECT blk FROM expected EXCEPT SELECT blk FROM covered ORDER BY blk),
    grouped AS (SELECT blk, blk - ROW_NUMBER() OVER (ORDER BY blk) * 100 AS grp FROM uncovered)
    SELECT MIN(blk) AS gap_from, MIN(blk)+99 AS gap_to, COUNT(*)*100 AS gap_size
    FROM grouped GROUP BY grp ORDER BY gap_from
$$;

CREATE OR REPLACE FUNCTION check_stats_drift()
RETURNS TABLE(
    address VARCHAR(42), name TEXT,
    cached_volume NUMERIC, real_volume NUMERIC, volume_drift NUMERIC,
    cached_sales INTEGER, real_sales BIGINT, sales_drift BIGINT,
    cached_floor NUMERIC, real_floor NUMERIC, floor_drift NUMERIC
)
LANGUAGE sql STABLE AS $$
    WITH real_stats AS (
        SELECT collection_addr,
            COALESCE(SUM(price_eth) FILTER (WHERE block_ts > now() - INTERVAL '24 hours'), 0) AS real_volume,
            COUNT(*) FILTER (WHERE block_ts > now() - INTERVAL '24 hours')                     AS real_sales,
            MIN(price_eth) FILTER (WHERE price_eth > 0 AND block_ts > now() - INTERVAL '7 days') AS real_floor
        FROM nft_sales WHERE block_ts > now() - INTERVAL '7 days'
        GROUP BY collection_addr
    )
    SELECT c.address, c.name,
        c.volume_24h_eth, COALESCE(r.real_volume,0), ABS(c.volume_24h_eth - COALESCE(r.real_volume,0)),
        c.sales_count_24h, COALESCE(r.real_sales,0), ABS(c.sales_count_24h - COALESCE(r.real_sales,0)),
        c.floor_price_eth, COALESCE(r.real_floor,0), ABS(c.floor_price_eth - COALESCE(r.real_floor,0))
    FROM collections c LEFT JOIN real_stats r ON r.collection_addr = c.address
    WHERE ABS(c.volume_24h_eth - COALESCE(r.real_volume,0)) > 0.01
       OR ABS(c.sales_count_24h - COALESCE(r.real_sales,0)) > 5
       OR ABS(c.floor_price_eth - COALESCE(r.real_floor,0)) > 0.001
    ORDER BY ABS(c.volume_24h_eth - COALESCE(r.real_volume,0)) DESC
$$;

CREATE OR REPLACE FUNCTION check_duplicate_sales()
RETURNS TABLE(tx_hash VARCHAR(66), in_sales BOOLEAN, in_transfers BOOLEAN, sales_price NUMERIC, note TEXT)
LANGUAGE sql STABLE AS $$
    SELECT tx_hash, TRUE, FALSE, price_eth, 'Duplicate tx_hash in nft_sales'
    FROM (SELECT tx_hash, price_eth, COUNT(*) OVER (PARTITION BY tx_hash) AS cnt FROM nft_sales) s
    WHERE cnt > 1
    UNION ALL
    SELECT tx_hash, TRUE, FALSE, price_eth, 'Sale with price_eth = 0'
    FROM nft_sales WHERE price_eth = 0
    UNION ALL
    SELECT t.tx_hash, TRUE, TRUE, s.price_eth, 'Sale and transfer with different collections'
    FROM nft_transfers t JOIN nft_sales s ON s.tx_hash = t.tx_hash WHERE t.collection_addr != s.collection_addr
    ORDER BY 5, 1 LIMIT 100
$$;

CREATE OR REPLACE FUNCTION integrity_report()
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE result JSONB;
BEGIN
    SELECT jsonb_build_object(
        'ts',                     now(),
        'last_indexed_block',     (SELECT value::BIGINT FROM indexer_state WHERE key = 'last_block'),
        'total_sales',            (SELECT COUNT(*) FROM nft_sales),
        'total_transfers',        (SELECT COUNT(*) FROM nft_transfers),
        'total_collections',      (SELECT COUNT(*) FROM collections),
        'collections_with_drift', (SELECT COUNT(*) FROM check_stats_drift()),
        'duplicate_issues',       (SELECT COUNT(*) FROM check_duplicate_sales()),
        'oldest_sale_ts',         (SELECT MIN(block_ts) FROM nft_sales),
        'newest_sale_ts',         (SELECT MAX(block_ts) FROM nft_sales),
        'indexed_ranges_count',   (SELECT COUNT(*) FROM indexed_block_ranges)
    ) INTO result;
    RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION get_eth_price_at(p_date DATE)
RETURNS NUMERIC(12,4) LANGUAGE sql STABLE AS $$
    SELECT price_usd FROM eth_price_history ORDER BY ABS(date - p_date) LIMIT 1
$$;

CREATE OR REPLACE FUNCTION cleanup_old_alert_triggers(retention_days INTEGER DEFAULT 30)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE deleted INTEGER;
BEGIN
    DELETE FROM alert_triggers WHERE triggered_at < now() - (retention_days || ' days')::INTERVAL;
    GET DIAGNOSTICS deleted = ROW_COUNT;
    RETURN deleted;
END;
$$;

CREATE OR REPLACE FUNCTION wallet_realized_pnl(p_addr TEXT)
RETURNS TABLE(
    total_spent_eth NUMERIC, total_received_eth NUMERIC, realized_pnl_eth NUMERIC,
    buy_count BIGINT, sell_count BIGINT, unique_collections BIGINT,
    most_traded_coll TEXT, avg_buy_price_eth NUMERIC, avg_sell_price_eth NUMERIC
)
LANGUAGE sql STABLE AS $$
    SELECT
        COALESCE(SUM(price_eth) FILTER (WHERE buyer  = lower(p_addr)), 0),
        COALESCE(SUM(price_eth) FILTER (WHERE seller = lower(p_addr)), 0),
        COALESCE(SUM(price_eth) FILTER (WHERE seller = lower(p_addr)), 0)
            - COALESCE(SUM(price_eth) FILTER (WHERE buyer = lower(p_addr)), 0),
        COUNT(*) FILTER (WHERE buyer  = lower(p_addr)),
        COUNT(*) FILTER (WHERE seller = lower(p_addr)),
        COUNT(DISTINCT collection_addr) FILTER (WHERE buyer = lower(p_addr) OR seller = lower(p_addr)),
        (SELECT collection_addr FROM nft_sales WHERE buyer = lower(p_addr) OR seller = lower(p_addr)
         GROUP BY collection_addr ORDER BY COUNT(*) DESC LIMIT 1),
        COALESCE(AVG(price_eth) FILTER (WHERE buyer  = lower(p_addr) AND price_eth > 0), 0),
        COALESCE(AVG(price_eth) FILTER (WHERE seller = lower(p_addr) AND price_eth > 0), 0)
    FROM nft_sales
    WHERE buyer = lower(p_addr) OR seller = lower(p_addr)
$$;

CREATE OR REPLACE FUNCTION collection_analytics(p_addr TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE result JSONB;
BEGIN
    SELECT jsonb_build_object(
        'address', p_addr, 'computed_at', now(),
        'volume_1h_eth',  COALESCE(SUM(price_eth) FILTER (WHERE block_ts > now() - INTERVAL '1 hour'), 0),
        'volume_24h_eth', COALESCE(SUM(price_eth) FILTER (WHERE block_ts > now() - INTERVAL '24 hours'), 0),
        'volume_7d_eth',  COALESCE(SUM(price_eth) FILTER (WHERE block_ts > now() - INTERVAL '7 days'), 0),
        'volume_30d_eth', COALESCE(SUM(price_eth) FILTER (WHERE block_ts > now() - INTERVAL '30 days'), 0),
        'sales_1h',  COUNT(*) FILTER (WHERE block_ts > now() - INTERVAL '1 hour'),
        'sales_24h', COUNT(*) FILTER (WHERE block_ts > now() - INTERVAL '24 hours'),
        'sales_7d',  COUNT(*) FILTER (WHERE block_ts > now() - INTERVAL '7 days'),
        'sales_30d', COUNT(*) FILTER (WHERE block_ts > now() - INTERVAL '30 days'),
        'floor_24h_eth', MIN(price_eth) FILTER (WHERE price_eth > 0 AND block_ts > now() - INTERVAL '24 hours'),
        'floor_7d_eth',  MIN(price_eth) FILTER (WHERE price_eth > 0 AND block_ts > now() - INTERVAL '7 days'),
        'avg_24h_eth',   AVG(price_eth) FILTER (WHERE price_eth > 0 AND block_ts > now() - INTERVAL '24 hours'),
        'max_24h_eth',   MAX(price_eth) FILTER (WHERE block_ts > now() - INTERVAL '24 hours'),
        'unique_buyers_24h',  COUNT(DISTINCT buyer)  FILTER (WHERE block_ts > now() - INTERVAL '24 hours'),
        'unique_sellers_24h', COUNT(DISTINCT seller) FILTER (WHERE block_ts > now() - INTERVAL '24 hours'),
        'momentum_ratio', CASE
            WHEN COALESCE(SUM(price_eth) FILTER (WHERE block_ts > now() - INTERVAL '24 hours'), 0) = 0 THEN NULL
            ELSE ROUND(
                COALESCE(SUM(price_eth) FILTER (WHERE block_ts > now() - INTERVAL '1 hour'), 0)
                / (COALESCE(SUM(price_eth) FILTER (WHERE block_ts > now() - INTERVAL '24 hours'), 0) / 24.0), 2)
        END
    ) INTO result
    FROM nft_sales
    WHERE collection_addr = lower(p_addr) AND block_ts > now() - INTERVAL '30 days';
    RETURN COALESCE(result, '{}'::JSONB);
END;
$$;

CREATE OR REPLACE FUNCTION market_overview()
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE result JSONB;
BEGIN
    SELECT jsonb_build_object(
        'computed_at', now(),
        'sales_24h',              COUNT(*) FILTER (WHERE block_ts > now() - INTERVAL '24 hours'),
        'volume_24h_eth',         COALESCE(SUM(price_eth) FILTER (WHERE block_ts > now() - INTERVAL '24 hours'), 0),
        'avg_price_24h_eth',      COALESCE(AVG(price_eth) FILTER (WHERE price_eth > 0 AND block_ts > now() - INTERVAL '24 hours'), 0),
        'collections_active_24h', COUNT(DISTINCT collection_addr) FILTER (WHERE block_ts > now() - INTERVAL '24 hours'),
        'unique_buyers_24h',      COUNT(DISTINCT buyer)  FILTER (WHERE block_ts > now() - INTERVAL '24 hours'),
        'unique_sellers_24h',     COUNT(DISTINCT seller) FILTER (WHERE block_ts > now() - INTERVAL '24 hours'),
        'sales_7d',               COUNT(*) FILTER (WHERE block_ts > now() - INTERVAL '7 days'),
        'volume_7d_eth',          COALESCE(SUM(price_eth) FILTER (WHERE block_ts > now() - INTERVAL '7 days'), 0),
        'collections_active_7d',  COUNT(DISTINCT collection_addr) FILTER (WHERE block_ts > now() - INTERVAL '7 days'),
        'volume_prev_24h_eth',    COALESCE(SUM(price_eth) FILTER (WHERE block_ts BETWEEN now() - INTERVAL '48 hours' AND now() - INTERVAL '24 hours'), 0),
        'sales_prev_24h',         COUNT(*) FILTER (WHERE block_ts BETWEEN now() - INTERVAL '48 hours' AND now() - INTERVAL '24 hours'),
        'total_sales_alltime',    COUNT(*),
        'total_volume_alltime_eth', COALESCE(SUM(price_eth), 0),
        'total_collections',      (SELECT COUNT(*) FROM collections),
        'last_indexed_block',     (SELECT value::BIGINT FROM indexer_state WHERE key = 'last_block')
    ) INTO result FROM nft_sales;
    RETURN COALESCE(result, '{}'::JSONB);
END;
$$;
