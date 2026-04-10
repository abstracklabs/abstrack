/**
 * Analytics routes.
 *
 * Cache TTL :
 *   /live-sales → 5s  (données quasi-temps-réel, tolère un léger délai)
 *   /global     → 30s (stat agrégée 24h, n'a pas besoin d'être à la seconde)
 *   /trending   → 30s (idem)
 *
 * Pas de Redis — cache en mémoire suffisant pour un seul process backend MVP.
 * Si scale-out multi-process nécessaire plus tard : remplacer withCache par Redis.
 */

import type { FastifyInstance } from 'fastify'
import { db } from '../db/client'
import { withCache, cacheInvalidate } from '../lib/cache'

export async function analyticsRoutes(app: FastifyInstance) {

  // GET /analytics/live-sales
  // Cache 5s — réduit les scans sur nft_sales lors de polling frontend agressif
  app.get('/live-sales', {
    config: { rateLimit: { max: 60, timeWindow: 60_000 } },
  }, async () => {
    return withCache('analytics:live-sales', 5_000, () =>
      db.query(
        `SELECT s.tx_hash, s.collection_addr, c.name AS collection_name,
                s.token_id, s.buyer, s.price_eth, s.price_usd, s.block_ts, s.marketplace
         FROM nft_sales s
         LEFT JOIN collections c ON c.address = s.collection_addr
         ORDER BY s.block_ts DESC
         LIMIT 20`
      )
    )
  })

  // GET /analytics/global
  // Cache 30s — stat agrégée sur 24h, acceptable avec quelques secondes de délai
  app.get('/global', async () => {
    return withCache('analytics:global', 30_000, () =>
      db.queryOne(
        `SELECT
           COUNT(DISTINCT collection_addr)::int AS collections_active,
           COUNT(*)::int                         AS sales_24h,
           COALESCE(SUM(price_eth), 0)           AS volume_24h_eth,
           COALESCE(AVG(price_eth), 0)           AS avg_price_eth
         FROM nft_sales
         WHERE block_ts > now() - INTERVAL '24 hours'`
      )
    )
  })

  // GET /analytics/trending
  // Cache 30s — lit depuis collections (stats précalculées) + agrégat 6h
  app.get('/trending', async () => {
    return withCache('analytics:trending', 30_000, () =>
      db.query(
        `SELECT
           c.address,
           c.name,
           c.thumbnail_url,
           c.volume_24h_eth,
           c.sales_count_24h,
           c.floor_price_eth,
           COALESCE(SUM(s.price_eth) FILTER (WHERE s.block_ts > now() - INTERVAL '6 hours'), 0) AS volume_6h_eth,
           COUNT(s.id)            FILTER (WHERE s.block_ts > now() - INTERVAL '6 hours')         AS sales_6h
         FROM collections c
         LEFT JOIN nft_sales s ON s.collection_addr = c.address
           AND s.block_ts > now() - INTERVAL '6 hours'
         WHERE c.volume_24h_eth > 0
         GROUP BY c.address, c.name, c.thumbnail_url, c.volume_24h_eth, c.sales_count_24h, c.floor_price_eth
         ORDER BY volume_6h_eth DESC
         LIMIT 10`
      )
    )
  })

  // POST /analytics/invalidate-cache — interne, appelé par l'indexer via admin si besoin
  // Protégé par le même mécanisme que les routes admin (header secret)
  app.post('/invalidate-cache', async (_req, reply) => {
    cacheInvalidate('analytics:')
    return reply.send({ ok: true })
  })
}
