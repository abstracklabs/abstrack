-- ═══════════════════════════════════════════════════════════════
-- Abstrack MVP — PostgreSQL schema
-- PostgreSQL only. No ClickHouse, no Redis.
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
    address         VARCHAR(42)   PRIMARY KEY,
    name            TEXT          NOT NULL DEFAULT '',
    symbol          TEXT,
    total_supply    INTEGER,
    floor_price_eth NUMERIC(20,8) DEFAULT 0,
    volume_24h_eth  NUMERIC(20,8) DEFAULT 0,
    sales_count_24h INTEGER       DEFAULT 0,
    thumbnail_url   TEXT,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Top collections par volume (homepage)
CREATE INDEX idx_collections_volume ON collections(volume_24h_eth DESC);
-- Top collections par nombre de ventes
CREATE INDEX idx_collections_sales  ON collections(sales_count_24h DESC);
-- Recherche textuelle sur le nom
CREATE INDEX idx_collections_name   ON collections USING gin(name gin_trgm_ops);

-- ─── NFT Sales ───────────────────────────────────────────────
CREATE TABLE nft_sales (
    id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
    tx_hash         VARCHAR(66)   NOT NULL UNIQUE,   -- VARCHAR, pas CHAR (pas de padding)
    block_number    BIGINT        NOT NULL,
    block_ts        TIMESTAMPTZ   NOT NULL,
    collection_addr VARCHAR(42)   NOT NULL REFERENCES collections(address) ON DELETE CASCADE,
    token_id        TEXT          NOT NULL,
    seller          VARCHAR(42)   NOT NULL,
    buyer           VARCHAR(42)   NOT NULL,
    price_eth       NUMERIC(20,8) NOT NULL,
    price_usd       NUMERIC(20,4),
    marketplace     TEXT,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Query principale : ventes d'une collection triées par date
CREATE INDEX idx_nft_sales_collection ON nft_sales(collection_addr, block_ts DESC);
-- Wallet activity (buyer ou seller)
CREATE INDEX idx_nft_sales_buyer      ON nft_sales(buyer,  block_ts DESC);
CREATE INDEX idx_nft_sales_seller     ON nft_sales(seller, block_ts DESC);
-- Whale alert : ventes > seuil récentes (prix DESC pour ORDER BY dans la query)
CREATE INDEX idx_nft_sales_price      ON nft_sales(price_eth DESC, block_ts DESC);
-- Trending / analytics globaux
CREATE INDEX idx_nft_sales_ts         ON nft_sales(block_ts DESC);
-- Rattrapage indexer par numéro de bloc
CREATE INDEX idx_nft_sales_block      ON nft_sales(block_number DESC);

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
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tx_hash, log_index)
);

-- Portfolio wallet : tokens reçus par adresse
CREATE INDEX idx_nft_transfers_to_addr    ON nft_transfers(to_addr,         block_ts DESC);
-- Portfolio wallet : tokens envoyés par adresse
CREATE INDEX idx_nft_transfers_from_addr  ON nft_transfers(from_addr,       block_ts DESC);
-- Holders par collection : tokens reçus groupés par collection+adresse
CREATE INDEX idx_nft_transfers_coll_to    ON nft_transfers(collection_addr, to_addr);
-- Holders par collection : tokens envoyés groupés par collection+adresse
CREATE INDEX idx_nft_transfers_coll_from  ON nft_transfers(collection_addr, from_addr);
-- Floor chart et stats collection par date
CREATE INDEX idx_nft_transfers_collection ON nft_transfers(collection_addr, block_ts DESC);
-- Rattrapage indexer
CREATE INDEX idx_nft_transfers_block      ON nft_transfers(block_number DESC);

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

-- Alertes d'un user (lecture dashboard)
CREATE INDEX idx_alerts_user   ON alerts(user_id);
-- Cron : ne scanne que les alertes actives
CREATE INDEX idx_alerts_active ON alerts(active) WHERE active = true;
-- Cron : évite de re-scanner les alertes en cooldown
CREATE INDEX idx_alerts_triggered ON alerts(last_triggered) WHERE active = true;

CREATE TABLE alert_triggers (
    id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    alert_id     UUID        NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    triggered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    event_data   JSONB       NOT NULL
);
CREATE INDEX idx_triggers_alert ON alert_triggers(alert_id, triggered_at DESC);

-- ─── Refresh stats collection ─────────────────────────────────
-- Appelé par l'indexer après chaque nouvelle vente (pas sur les doublons)
CREATE OR REPLACE FUNCTION refresh_collection_stats(p_addr TEXT)
RETURNS void AS $$
BEGIN
    UPDATE collections SET
        volume_24h_eth  = (
            SELECT COALESCE(SUM(price_eth), 0)
            FROM nft_sales
            WHERE collection_addr = p_addr
              AND block_ts > now() - INTERVAL '24 hours'
        ),
        sales_count_24h = (
            SELECT COUNT(*)
            FROM nft_sales
            WHERE collection_addr = p_addr
              AND block_ts > now() - INTERVAL '24 hours'
        ),
        updated_at = now()
    WHERE address = p_addr;
END;
$$ LANGUAGE plpgsql;

-- ─── Nettoyage automatique des triggers anciens ───────────────
-- Évite que la table alert_triggers grossisse indéfiniment
-- À planifier avec pg_cron ou un cron externe (ex: tous les jours à 3h)
CREATE OR REPLACE FUNCTION cleanup_old_alert_triggers(retention_days INTEGER DEFAULT 30)
RETURNS INTEGER AS $$
DECLARE
    deleted INTEGER;
BEGIN
    DELETE FROM alert_triggers
    WHERE triggered_at < now() - (retention_days || ' days')::INTERVAL;
    GET DIAGNOSTICS deleted = ROW_COUNT;
    RETURN deleted;
END;
$$ LANGUAGE plpgsql;
