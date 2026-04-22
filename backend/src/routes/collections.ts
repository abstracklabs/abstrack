/**
 * Collections routes — PostgreSQL uniquement.
 *
 * Optimisations :
 *   - GET /             : cache 10s (liste top collections, lue sur chaque page d'accueil)
 *   - GET /:addr/sales  : pagination par curseur (keyset) au lieu de OFFSET
 *                         OFFSET 1000 sur nft_sales = scan de 1000 lignes inutiles
 *                         Curseur = seek direct via index (collection_addr, block_ts DESC, id)
 *   - GET /:addr/holders: requête unique WITH au lieu de double scan séparé
 */

import type { FastifyInstance } from 'fastify'
import { db } from '../db/client'
import { withCache } from '../lib/cache'
import { resolveNFTMeta } from '../lib/nftMeta'

export async function collectionsRoutes(app: FastifyInstance) {

  // GET /collections?sort=volume_24h&limit=20
  // Cache 10s — liste lue à chaque chargement de la homepage
  app.get<{ Querystring: { sort?: string; limit?: string } }>('/', async (req) => {
    const limit  = Math.min(Number(req.query.limit) || 20, 100)
    const bySales = req.query.sort === 'sales'
    const key    = `collections:list:${bySales}:${limit}`

    return withCache(key, 10_000, () =>
      db.query(
        `SELECT address, name, symbol, total_supply,
                floor_price_eth, volume_24h_eth, sales_count_24h,
                change_24h_pct, thumbnail_url
         FROM collections
         ORDER BY CASE WHEN $2 THEN sales_count_24h ELSE volume_24h_eth END DESC
         LIMIT $1`,
        [limit, bySales]
      )
    )
  })

  // GET /collections/:address
  // Holder count : delta method (to_addr +1 / from_addr -1) — exclut le zero address
  // Total sales  : COUNT(*) all-time sur nft_sales
  // Cache 30s — holder_count est coûteux mais pas critique à la seconde
  app.get<{ Params: { address: string } }>('/:address', async (req, reply) => {
    const addr = req.params.address.toLowerCase()
    const row  = await db.queryOne(
      `WITH holders AS (
         SELECT COUNT(*) AS holder_count
         FROM (
           SELECT addr
           FROM (
             SELECT to_addr   AS addr,  1 AS delta FROM nft_transfers WHERE collection_addr = $1
             UNION ALL
             SELECT from_addr AS addr, -1 AS delta FROM nft_transfers WHERE collection_addr = $1
           ) t
           WHERE addr != $2
           GROUP BY addr
           HAVING SUM(delta) > 0
         ) h
       ),
       totals AS (
         SELECT COUNT(*) AS total_sales FROM nft_sales WHERE collection_addr = $1
       )
       SELECT c.address, c.name, c.symbol, c.total_supply,
              c.floor_price_eth, c.volume_24h_eth, c.sales_count_24h,
              c.change_24h_pct, c.thumbnail_url, c.created_at,
              h.holder_count::int,
              t.total_sales::int
       FROM collections c, holders h, totals t
       WHERE c.address = $1`,
      [addr, '0x' + '0'.repeat(40)]
    )
    if (!row) return reply.status(404).send({ error: 'Not found' })
    return row
  })

  // GET /collections/:address/sales?limit=50&before_ts=<ISO>&before_id=<uuid>
  //
  // Pagination par curseur (keyset) — remplace OFFSET.
  // Principe : on se souvient du dernier élément retourné (block_ts + id) et on
  // cherche strictement "avant" ce point via l'index composite.
  //
  // Pourquoi keyset plutôt qu'OFFSET ?
  //   OFFSET N = PostgreSQL scanne et jette N lignes → O(N) même si on les ignore.
  //   Keyset   = seek direct via (collection_addr, block_ts DESC, id) → O(1) quel que soit N.
  //
  // Premier appel  : GET /sales?limit=50
  // Appels suivants: GET /sales?limit=50&before_ts=2024-01-15T10:00:00Z&before_id=<uuid-du-dernier>
  //
  // Le client stocke { block_ts, id } du dernier élément reçu pour construire le curseur suivant.
  app.get<{
    Params: { address: string }
    Querystring: { limit?: string; before_ts?: string; before_id?: string }
  }>('/:address/sales', async (req) => {
    const addr  = req.params.address.toLowerCase()
    const limit = Math.min(Number(req.query.limit) || 50, 200)

    const { before_ts, before_id } = req.query

    if (before_ts && before_id) {
      // Page suivante : strict keyset seek
      return db.query(
        `SELECT tx_hash, id, token_id, seller, buyer, price_eth, price_usd, marketplace, block_ts
         FROM nft_sales
         WHERE collection_addr = $1
           AND (block_ts, id) < ($2::timestamptz, $3::uuid)
         ORDER BY block_ts DESC, id DESC
         LIMIT $4`,
        [addr, before_ts, before_id, limit]
      )
    }

    // Première page
    return db.query(
      `SELECT tx_hash, id, token_id, seller, buyer, price_eth, price_usd, marketplace, block_ts
       FROM nft_sales
       WHERE collection_addr = $1
       ORDER BY block_ts DESC, id DESC
       LIMIT $2`,
      [addr, limit]
    )
  })

  // GET /collections/:address/floor?period=7d
  app.get<{
    Params: { address: string }
    Querystring: { period?: '24h' | '7d' | '30d' }
  }>('/:address/floor', async (req) => {
    const addr  = req.params.address.toLowerCase()
    const periodHours: Record<string, number> = { '24h': 24, '7d': 168, '30d': 720 }
    const hours = periodHours[req.query.period ?? '7d'] ?? 168
    const key   = `collections:floor:${addr}:${hours}`

    // Cache 60s — graphe de prix, pas critique à la seconde
    return withCache(key, 60_000, () =>
      db.query(
        `SELECT
           date_trunc('hour', block_ts) AS hour,
           MIN(price_eth) AS floor_eth,
           AVG(price_eth) AS avg_eth,
           COUNT(*)::int   AS sales
         FROM nft_sales
         WHERE collection_addr = $1
           AND block_ts > now() - ($2 * INTERVAL '1 hour')
         GROUP BY 1
         ORDER BY 1 ASC`,
        [addr, hours]
      )
    )
  })

  // GET /collections/:address/token/:tokenId/meta
  // Résout tokenURI → metadata JSON → image_url + name pour un NFT précis
  // Cache 24h (les métadonnées NFT ne changent pas)
  app.get<{
    Params: { address: string; tokenId: string }
  }>('/:address/token/:tokenId/meta', async (req, reply) => {
    const { address, tokenId } = req.params
    const key = `nft:meta:${address.toLowerCase()}:${tokenId}`
    return withCache(key, 86_400_000, () => resolveNFTMeta(address.toLowerCase(), tokenId))
  })

  // GET /collections/:address/holders?limit=50
  //
  // Requête réécrite : UNION ALL avec delta (+1/-1) au lieu de deux CTE séparées.
  // Un seul GROUP BY final au lieu de deux scans + JOIN → 2x moins de I/O.
  // L'index (collection_addr, to_addr) et (collection_addr, from_addr) couvrent les deux branches.
  app.get<{
    Params: { address: string }
    Querystring: { limit?: string }
  }>('/:address/holders', async (req) => {
    const addr  = req.params.address.toLowerCase()
    const limit = Math.min(Number(req.query.limit) || 50, 200)

    return db.query(
      `SELECT addr, SUM(delta)::int AS holding
       FROM (
         SELECT to_addr   AS addr,  1 AS delta FROM nft_transfers WHERE collection_addr = $1
         UNION ALL
         SELECT from_addr AS addr, -1 AS delta FROM nft_transfers WHERE collection_addr = $1
       ) t
       WHERE addr != $2
       GROUP BY addr
       HAVING SUM(delta) > 0
       ORDER BY holding DESC
       LIMIT $3`,
      [addr, '0x' + '0'.repeat(40), limit]
    )
  })
}
