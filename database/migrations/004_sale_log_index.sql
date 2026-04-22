-- ═══════════════════════════════════════════════════════════════
-- Migration 004 — log_index dans nft_sales
--
-- Problème : UNIQUE(tx_hash) empêche d'indexer plusieurs ventes
-- dans la même transaction (ex : sweep Seaport qui achète 5 NFTs
-- → seule la 1ère vente était stockée, les 4 autres ignorées).
--
-- Solution : ajout de log_index + contrainte composite (tx_hash, log_index).
-- log_index est l'index du log dans le bloc, unique par tx.
--
-- Données existantes : log_index = 0 par défaut (valeur historique
-- compatible car les enregistrements existants ont déjà tx_hash unique).
-- ═══════════════════════════════════════════════════════════════

-- Étape 1 : ajoute la colonne (nullable d'abord pour les lignes existantes)
ALTER TABLE nft_sales ADD COLUMN IF NOT EXISTS log_index INTEGER;

-- Étape 2 : valorise à 0 les lignes existantes (avant le NOT NULL)
UPDATE nft_sales SET log_index = 0 WHERE log_index IS NULL;

-- Étape 3 : passe en NOT NULL
ALTER TABLE nft_sales ALTER COLUMN log_index SET NOT NULL;
ALTER TABLE nft_sales ALTER COLUMN log_index SET DEFAULT 0;

-- Étape 4 : supprime l'ancienne contrainte UNIQUE(tx_hash)
ALTER TABLE nft_sales DROP CONSTRAINT IF EXISTS nft_sales_tx_hash_key;

-- Étape 5 : ajoute la contrainte composite
ALTER TABLE nft_sales
  ADD CONSTRAINT nft_sales_tx_hash_log_index_key UNIQUE (tx_hash, log_index);

-- Étape 6 : met à jour les index keyset pour inclure log_index
-- (le keyset de pagination utilise (block_ts DESC, id DESC) — pas impacté directement,
--  mais on réindexe les index couvrants pour cohérence)
DROP INDEX IF EXISTS idx_nft_sales_keyset;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_nft_sales_keyset
  ON nft_sales (collection_addr, block_ts DESC, id DESC)
  INCLUDE (tx_hash, log_index, token_id, seller, buyer, price_eth, price_usd, marketplace);
