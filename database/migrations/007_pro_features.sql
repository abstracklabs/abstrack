-- ═══════════════════════════════════════════════════════════════
-- Migration 007 — Fonctionnalités pro
--
-- 1. eth_price_history     — prix ETH/USD historiques (journalier)
--                            permet de stocker price_usd correct sur les ventes passées
-- 2. nft_transfers.quantity — quantité transférée (ERC-1155 support)
-- 3. nft_transfers.token_standard — ERC721 ou ERC1155
-- 4. rebuild_all_stats()   — version complète : floor + change + volume en 1 seul pass
-- 5. check_duplicate_sales() — note corrigée pour les ventes à 0 ETH (non-ETH valid)
-- ═══════════════════════════════════════════════════════════════

-- ─── 1. Prix ETH/USD historiques ─────────────────────────────
--
-- Granularité journalière — suffisante pour les stats NFT.
-- Peuplé par l'indexer au démarrage via CoinGecko.
-- Utilisé pour calculer price_usd des ventes historiques.

CREATE TABLE IF NOT EXISTS eth_price_history (
    date       DATE          PRIMARY KEY,
    price_usd  NUMERIC(12,4) NOT NULL,
    updated_at TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Lookup rapide par date (déjà PK mais index explicite pour ORDER BY queries)
CREATE INDEX IF NOT EXISTS idx_eth_price_history_date ON eth_price_history(date);

-- ─── 2. Quantité transférée dans nft_transfers ───────────────
--
-- ERC-721 : toujours 1
-- ERC-1155 : peut être > 1 (ex : transfert de 5 tokens d'un même ID)
-- Utilisé pour le calcul correct du holder_count

ALTER TABLE nft_transfers ADD COLUMN IF NOT EXISTS quantity BIGINT NOT NULL DEFAULT 1;

-- ─── 3. Standard du token ────────────────────────────────────
--
-- 'ERC721'  — Transfer(address,address,uint256) avec tokenId indexé
-- 'ERC1155' — TransferSingle / TransferBatch

ALTER TABLE nft_transfers ADD COLUMN IF NOT EXISTS token_standard TEXT NOT NULL DEFAULT 'ERC721';

-- ─── 4. rebuild_all_stats — version complète ─────────────────
--
-- Remplace la version de migration 002 qui ne calculait pas
-- floor_price_eth ni change_24h_pct.
--
-- Un seul UPDATE...FROM au lieu de N appels à refresh_collection_stats :
--   - aggregation CTE calculée une seule fois pour toutes les collections
--   - index idx_nft_sales_collection utilisé (collection_addr, block_ts DESC)
--   - beaucoup plus rapide que N requêtes corrélées séparées

CREATE OR REPLACE FUNCTION rebuild_all_stats()
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    updated_count INTEGER;
BEGIN
    WITH price_stats AS (
        SELECT
            collection_addr,
            -- Floor 7 jours (fenêtre stable pour le floor price)
            MIN(price_eth) FILTER (
                WHERE price_eth > 0
                  AND block_ts > now() - INTERVAL '7 days'
            ) AS floor_7d,
            -- Floor période précédente (pour delta change_24h)
            MIN(price_eth) FILTER (
                WHERE price_eth > 0
                  AND block_ts BETWEEN now() - INTERVAL '48 hours'
                                   AND now() - INTERVAL '24 hours'
            ) AS floor_48h_24h,
            -- Floor dernières 24h (pour delta change_24h)
            MIN(price_eth) FILTER (
                WHERE price_eth > 0
                  AND block_ts > now() - INTERVAL '24 hours'
            ) AS floor_24h,
            -- Volume et nombre de ventes 24h
            COALESCE(SUM(price_eth) FILTER (
                WHERE block_ts > now() - INTERVAL '24 hours'
            ), 0)                                                       AS vol_24h,
            COUNT(*)        FILTER (
                WHERE block_ts > now() - INTERVAL '24 hours'
            )::INTEGER                                                  AS cnt_24h
        FROM nft_sales
        WHERE block_ts > now() - INTERVAL '7 days'
        GROUP BY collection_addr
    )
    UPDATE collections c
    SET
        floor_price_eth  = COALESCE(ps.floor_7d, 0),
        volume_24h_eth   = ps.vol_24h,
        sales_count_24h  = ps.cnt_24h,
        change_24h_pct   = CASE
                             WHEN ps.floor_48h_24h > 0 AND ps.floor_24h IS NOT NULL
                             THEN ROUND(
                               ((ps.floor_24h - ps.floor_48h_24h) / ps.floor_48h_24h) * 100,
                               2
                             )
                             ELSE 0
                           END,
        updated_at       = now()
    FROM price_stats ps
    WHERE c.address = ps.collection_addr;

    GET DIAGNOSTICS updated_count = ROW_COUNT;

    -- Remet à zéro les collections sans activité récente
    UPDATE collections
    SET
        floor_price_eth = 0,
        volume_24h_eth  = 0,
        sales_count_24h = 0,
        change_24h_pct  = 0,
        updated_at      = now()
    WHERE address NOT IN (
        SELECT DISTINCT collection_addr
        FROM nft_sales
        WHERE block_ts > now() - INTERVAL '7 days'
    )
    AND (volume_24h_eth > 0 OR sales_count_24h > 0 OR floor_price_eth > 0);

    RETURN updated_count;
END;
$$;

-- ─── 5. check_duplicate_sales — note corrigée ────────────────
--
-- price_eth = 0 est valide pour les ventes payées en USDC/autre ERC20
-- (on ne track que ETH natif + WETH dans la consideration Seaport)

CREATE OR REPLACE FUNCTION check_duplicate_sales()
RETURNS TABLE(
    tx_hash      VARCHAR(66),
    in_sales     BOOLEAN,
    in_transfers BOOLEAN,
    sales_price  NUMERIC,
    note         TEXT
)
LANGUAGE sql STABLE AS $$
    SELECT
        tx_hash,
        TRUE  AS in_sales,
        FALSE AS in_transfers,
        price_eth,
        'Duplicate tx_hash in nft_sales — should be impossible with (tx_hash, log_index) UNIQUE' AS note
    FROM (
        SELECT tx_hash, price_eth, COUNT(*) OVER (PARTITION BY tx_hash) AS cnt
        FROM nft_sales
    ) s
    WHERE cnt > 1

    UNION ALL

    SELECT
        tx_hash,
        TRUE,
        FALSE,
        price_eth,
        'Sale with price_eth = 0 — non-ETH/WETH payment (USDC, etc.) — valid but check marketplace'
    FROM nft_sales
    WHERE price_eth = 0

    UNION ALL

    SELECT
        t.tx_hash,
        TRUE,
        TRUE,
        s.price_eth,
        'Sale and transfer on same tx with different collection addresses'
    FROM nft_transfers t
    JOIN nft_sales s ON s.tx_hash = t.tx_hash
    WHERE t.collection_addr != s.collection_addr

    ORDER BY note, tx_hash
    LIMIT 100
$$;

-- ─── 6. get_eth_price_at — lookup journalier ─────────────────
--
-- Retourne le prix ETH/USD le plus proche pour une date donnée.
-- Utilisé par le backend pour enrichir les ventes historiques en USD.

CREATE OR REPLACE FUNCTION get_eth_price_at(p_date DATE)
RETURNS NUMERIC(12,4)
LANGUAGE sql STABLE AS $$
    SELECT price_usd
    FROM eth_price_history
    ORDER BY ABS(date - p_date)
    LIMIT 1
$$;
