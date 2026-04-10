-- ═══════════════════════════════════════════════════════════════
-- Migration 002 — Fiabilité des données
--
-- Ajoute :
--   1. indexed_block_ranges  — suivi précis des plages indexées
--   2. find_indexer_gaps()   — détecte les trous de blocs
--   3. check_stats_drift()   — compare stats cachées vs données réelles
--   4. rebuild_all_stats()   — recalcule toutes les stats collections
--   5. check_duplicate_sales() — détecte les ventes en double
-- ═══════════════════════════════════════════════════════════════

-- ─── 1. Suivi des plages indexées ────────────────────────────
--
-- Pourquoi des plages et pas des blocs individuels ?
--   - Un bloc par ligne = des millions de lignes rapidement
--   - Une plage [from, to] = compact, O(1) à insérer, merge possible
--   - Abstract ~2s/bloc → ~15M blocs/an → 15M lignes si par bloc
--
-- Un enregistrement représente une séquence continue de blocs traités.
-- Exemple : {from=1000, to=1049}, {from=1051, to=2000}
--   → trou détecté au bloc 1050

CREATE TABLE IF NOT EXISTS indexed_block_ranges (
    id         BIGSERIAL   PRIMARY KEY,
    from_block BIGINT      NOT NULL,
    to_block   BIGINT      NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_range_order CHECK (to_block >= from_block)
);

CREATE INDEX idx_ibr_from ON indexed_block_ranges(from_block);
CREATE INDEX idx_ibr_to   ON indexed_block_ranges(to_block);

-- ─── 2. Détection des trous de blocs ────────────────────────
--
-- Utilise generate_series pour matérialiser la séquence attendue
-- puis compare avec les blocs réellement couverts.
--
-- Retourne les plages manquantes, pas les blocs individuels :
--   (gap_from, gap_to, gap_size)
--
-- Usage :
--   SELECT * FROM find_indexer_gaps(1000000, 1010000);
--   → (1005000, 1005100, 101)  ← trou de 101 blocs

CREATE OR REPLACE FUNCTION find_indexer_gaps(
    p_from BIGINT,
    p_to   BIGINT
)
RETURNS TABLE(gap_from BIGINT, gap_to BIGINT, gap_size BIGINT)
LANGUAGE sql STABLE AS $$
    -- Génère tous les "points de début" attendus dans la plage
    -- puis cherche ceux qui ne sont couverts par aucune range indexée.
    -- On travaille par tranches de 100 pour rester efficace.
    WITH expected AS (
        SELECT gs AS blk
        FROM generate_series(p_from, p_to, 100) gs
    ),
    covered AS (
        SELECT e.blk
        FROM expected e
        WHERE EXISTS (
            SELECT 1 FROM indexed_block_ranges r
            WHERE r.from_block <= e.blk AND r.to_block >= e.blk
        )
    ),
    uncovered AS (
        SELECT blk FROM expected
        EXCEPT
        SELECT blk FROM covered
        ORDER BY blk
    ),
    -- Regroupe les blocs non couverts consécutifs en plages
    grouped AS (
        SELECT
            blk,
            blk - ROW_NUMBER() OVER (ORDER BY blk) * 100 AS grp
        FROM uncovered
    )
    SELECT
        MIN(blk)        AS gap_from,
        MIN(blk) + 99   AS gap_to,
        COUNT(*) * 100  AS gap_size
    FROM grouped
    GROUP BY grp
    ORDER BY gap_from
$$;

-- ─── 3. Vérification de la cohérence des stats ───────────────
--
-- Compare les valeurs cachées (collections.volume_24h_eth, sales_count_24h)
-- avec ce qu'on calcule à partir des vraies données (nft_sales).
--
-- Une dérive > 0.01 ETH ou > 5 ventes est signalée.
--
-- Retourne les collections dont les stats sont incorrectes.
-- Résultat vide = tout est cohérent.

CREATE OR REPLACE FUNCTION check_stats_drift()
RETURNS TABLE(
    address         VARCHAR(42),
    name            TEXT,
    cached_volume   NUMERIC,
    real_volume     NUMERIC,
    volume_drift    NUMERIC,
    cached_sales    INTEGER,
    real_sales      BIGINT,
    sales_drift     BIGINT
)
LANGUAGE sql STABLE AS $$
    WITH real_stats AS (
        SELECT
            collection_addr,
            COALESCE(SUM(price_eth), 0)  AS real_volume,
            COUNT(*)                      AS real_sales
        FROM nft_sales
        WHERE block_ts > now() - INTERVAL '24 hours'
        GROUP BY collection_addr
    )
    SELECT
        c.address,
        c.name,
        c.volume_24h_eth                                  AS cached_volume,
        COALESCE(r.real_volume, 0)                        AS real_volume,
        ABS(c.volume_24h_eth - COALESCE(r.real_volume,0)) AS volume_drift,
        c.sales_count_24h                                 AS cached_sales,
        COALESCE(r.real_sales, 0)                         AS real_sales,
        ABS(c.sales_count_24h - COALESCE(r.real_sales,0)) AS sales_drift
    FROM collections c
    LEFT JOIN real_stats r ON r.collection_addr = c.address
    WHERE
        ABS(c.volume_24h_eth - COALESCE(r.real_volume, 0)) > 0.01
        OR
        ABS(c.sales_count_24h - COALESCE(r.real_sales, 0)) > 5
    ORDER BY volume_drift DESC
$$;

-- ─── 4. Rebuild global des stats ─────────────────────────────
--
-- Recalcule volume_24h_eth et sales_count_24h pour toutes
-- les collections en une seule passe, sans boucle applicative.
--
-- Utilise un UPDATE...FROM pour éviter N requêtes séparées.
-- Beaucoup plus efficace que d'appeler refresh_collection_stats()
-- collection par collection depuis le code.
--
-- Retourne le nombre de collections mises à jour.

CREATE OR REPLACE FUNCTION rebuild_all_stats()
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    updated_count INTEGER;
BEGIN
    WITH stats AS (
        SELECT
            collection_addr,
            COALESCE(SUM(price_eth), 0) AS vol,
            COUNT(*)::INTEGER            AS cnt
        FROM nft_sales
        WHERE block_ts > now() - INTERVAL '24 hours'
        GROUP BY collection_addr
    )
    UPDATE collections c
    SET
        volume_24h_eth  = COALESCE(s.vol, 0),
        sales_count_24h = COALESCE(s.cnt, 0),
        updated_at      = now()
    FROM stats s
    WHERE c.address = s.collection_addr;

    -- Remet à zéro les collections sans vente dans les 24h
    UPDATE collections
    SET
        volume_24h_eth  = 0,
        sales_count_24h = 0,
        updated_at      = now()
    WHERE address NOT IN (
        SELECT DISTINCT collection_addr
        FROM nft_sales
        WHERE block_ts > now() - INTERVAL '24 hours'
    )
    AND (volume_24h_eth > 0 OR sales_count_24h > 0);

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RETURN updated_count;
END;
$$;

-- ─── 5. Détection des ventes dupliquées ──────────────────────
--
-- tx_hash est UNIQUE sur nft_sales mais un même token peut
-- apparaître dans transfers ET sales pour la même tx.
-- Ce check détecte les incohérences croisées.
--
-- Retourne les tx_hash présents dans les deux tables
-- avec des données contradictoires.

CREATE OR REPLACE FUNCTION check_duplicate_sales()
RETURNS TABLE(
    tx_hash      VARCHAR(66),
    in_sales     BOOLEAN,
    in_transfers BOOLEAN,
    sales_price  NUMERIC,
    note         TEXT
)
LANGUAGE sql STABLE AS $$
    -- Sales présentes plusieurs fois (ne devrait jamais arriver vu UNIQUE)
    SELECT
        tx_hash,
        TRUE  AS in_sales,
        FALSE AS in_transfers,
        price_eth,
        'Duplicate in nft_sales (should be impossible)' AS note
    FROM (
        SELECT tx_hash, price_eth, COUNT(*) OVER (PARTITION BY tx_hash) AS cnt
        FROM nft_sales
    ) s
    WHERE cnt > 1

    UNION ALL

    -- Ventes avec price_eth = 0 (données corrompues)
    SELECT
        tx_hash,
        TRUE,
        FALSE,
        price_eth,
        'Sale with zero price — possible indexing error'
    FROM nft_sales
    WHERE price_eth = 0

    UNION ALL

    -- Transfers d'une tx qui est aussi dans nft_sales mais vers une collection différente
    SELECT
        t.tx_hash,
        TRUE,
        TRUE,
        s.price_eth,
        'Sale and transfer on same tx with different collections'
    FROM nft_transfers t
    JOIN nft_sales s ON s.tx_hash = t.tx_hash
    WHERE t.collection_addr != s.collection_addr

    ORDER BY note, tx_hash
    LIMIT 100
$$;

-- ─── 6. Rapport global d'intégrité ───────────────────────────
--
-- Snapshot rapide de l'état de la DB.
-- Utilisé par le backend pour le endpoint GET /admin/integrity.

CREATE OR REPLACE FUNCTION integrity_report()
RETURNS JSONB
LANGUAGE plpgsql STABLE AS $$
DECLARE
    result JSONB;
BEGIN
    SELECT jsonb_build_object(
        'ts',                   now(),
        'last_indexed_block',   (SELECT value::BIGINT FROM indexer_state WHERE key = 'last_block'),
        'total_sales',          (SELECT COUNT(*) FROM nft_sales),
        'total_transfers',      (SELECT COUNT(*) FROM nft_transfers),
        'total_collections',    (SELECT COUNT(*) FROM collections),
        'collections_with_drift', (
            SELECT COUNT(*) FROM check_stats_drift()
        ),
        'duplicate_issues',     (
            SELECT COUNT(*) FROM check_duplicate_sales()
        ),
        'oldest_sale_ts',       (SELECT MIN(block_ts) FROM nft_sales),
        'newest_sale_ts',       (SELECT MAX(block_ts) FROM nft_sales),
        'indexed_ranges_count', (SELECT COUNT(*) FROM indexed_block_ranges)
    ) INTO result;
    RETURN result;
END;
$$;
