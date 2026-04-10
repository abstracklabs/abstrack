/**
 * Alpha Feed — endpoint REST + abonnement WebSocket.
 *
 * GET /alpha-feed              → snapshot des derniers événements (polling ou premier chargement)
 * GET /alpha-feed/config       → paramètres actuels (seuils)
 *
 * Le live se fait via WebSocket room "alpha" :
 *   Client → { "type": "subscribe", "room": "alpha" }
 *   Server → { "type": "alpha_events", "events": [...], "ts": 1234567890 }
 *
 * Cache 10s sur le snapshot REST — le cron tourne toutes les 15s,
 * inutile de recalculer entre deux cycles.
 */

import type { FastifyInstance } from 'fastify'
import { db } from '../db/client'
import { withCache } from '../lib/cache'

const WHALE_ETH   = Number(process.env.ALPHA_WHALE_ETH   ?? 5)
const BURST_SALES = Number(process.env.ALPHA_BURST_SALES ?? 10)

export async function alphaRoutes(app: FastifyInstance) {

  // GET /alpha-feed
  // Snapshot calculé à la demande — même logique que le cron mais sans WebSocket push.
  // Utile pour le chargement initial de la page avant que le WS soit établi.
  app.get('/', {
    config: { rateLimit: { max: 30, timeWindow: 60_000 } },
  }, async () => {
    return withCache('alpha:snapshot', 10_000, async () => {
      const [whales, spikes, bursts] = await Promise.all([
        _queryWhales(),
        _querySpikes(),
        _queryBursts(),
      ])

      const events = [...whales, ...spikes, ...bursts]
        .sort((a, b) => b.score - a.score)

      return {
        events,
        meta: {
          whale_threshold_eth: WHALE_ETH,
          burst_threshold:     BURST_SALES,
          computed_at:         new Date().toISOString(),
          live_room:           'alpha',   // room WebSocket à rejoindre
        },
      }
    })
  })

  // GET /alpha-feed/config — expose les seuils pour que le frontend puisse les afficher
  app.get('/config', async () => ({
    whale_threshold_eth: WHALE_ETH,
    burst_threshold:     BURST_SALES,
    cron_interval_s:     15,
    ws_room:             'alpha',
  }))
}

// ─── Requêtes SQL (dupliquées volontairement depuis alpha.ts pour garder
//     le module routes autonome — DRY serait une sur-abstraction ici) ─────

async function _queryWhales() {
  const rows = await db.query<{
    tx_hash: string; collection_addr: string; collection_name: string | null
    token_id: string; buyer: string; seller: string
    price_eth: number; price_usd: number | null; block_ts: string; marketplace: string | null
  }>(
    `SELECT s.tx_hash, s.collection_addr, c.name AS collection_name,
            s.token_id, s.buyer, s.seller, s.price_eth, s.price_usd, s.block_ts, s.marketplace
     FROM nft_sales s
     LEFT JOIN collections c ON c.address = s.collection_addr
     WHERE s.price_eth >= $1
       AND s.block_ts > now() - INTERVAL '10 minutes'
     ORDER BY s.price_eth DESC
     LIMIT 10`,
    [WHALE_ETH]
  )

  return rows.map(r => ({
    type:            r.price_eth >= WHALE_ETH * 5 ? 'whale_buy' : 'whale_buy' as const,
    score:           _whaleScore(r.price_eth),
    ts:              r.block_ts,
    collection:      r.collection_addr,
    collection_name: r.collection_name,
    data: {
      tx_hash: r.tx_hash, token_id: r.token_id,
      buyer: r.buyer, seller: r.seller,
      price_eth: r.price_eth, price_usd: r.price_usd,
      marketplace: r.marketplace,
    },
  }))
}

async function _querySpikes() {
  const rows = await db.query<{
    collection_addr: string; collection_name: string | null
    volume_1h: number; volume_6h_avg: number; sales_1h: number; ratio: number
  }>(
    `WITH hourly AS (
       SELECT
         collection_addr,
         SUM(price_eth) FILTER (WHERE block_ts > now() - INTERVAL '1 hour')  AS volume_1h,
         COUNT(*)       FILTER (WHERE block_ts > now() - INTERVAL '1 hour')  AS sales_1h,
         SUM(price_eth) FILTER (
           WHERE block_ts > now() - INTERVAL '6 hours'
             AND block_ts <= now() - INTERVAL '1 hour'
         ) / NULLIF(5, 0) AS volume_6h_avg
       FROM nft_sales
       WHERE block_ts > now() - INTERVAL '6 hours'
       GROUP BY collection_addr
     )
     SELECT
       h.collection_addr, c.name AS collection_name,
       h.volume_1h, COALESCE(h.volume_6h_avg, 0) AS volume_6h_avg,
       h.sales_1h,
       CASE WHEN COALESCE(h.volume_6h_avg, 0) = 0 THEN 10
            ELSE h.volume_1h / h.volume_6h_avg END AS ratio
     FROM hourly h
     LEFT JOIN collections c ON c.address = h.collection_addr
     WHERE h.volume_1h > 0.5
       AND (COALESCE(h.volume_6h_avg, 0) = 0 OR h.volume_1h / h.volume_6h_avg >= 2.0)
     ORDER BY ratio DESC
     LIMIT 5`
  )

  return rows.map(r => ({
    type:            'volume_spike' as const,
    score:           _spikeScore(r.ratio, r.volume_1h),
    ts:              new Date().toISOString(),
    collection:      r.collection_addr,
    collection_name: r.collection_name,
    data: {
      volume_1h_eth: r.volume_1h,
      avg_1h_eth:    r.volume_6h_avg,
      ratio:         Math.round(r.ratio * 10) / 10,
      sales_1h:      r.sales_1h,
    },
  }))
}

async function _queryBursts() {
  const rows = await db.query<{
    collection_addr: string; collection_name: string | null
    sales_10min: number; volume_10min: number; avg_price_eth: number
  }>(
    `SELECT s.collection_addr, c.name AS collection_name,
            COUNT(*) AS sales_10min, SUM(s.price_eth) AS volume_10min,
            AVG(s.price_eth) AS avg_price_eth
     FROM nft_sales s
     LEFT JOIN collections c ON c.address = s.collection_addr
     WHERE s.block_ts > now() - INTERVAL '10 minutes'
     GROUP BY s.collection_addr, c.name
     HAVING COUNT(*) >= $1
     ORDER BY COUNT(*) DESC
     LIMIT 5`,
    [BURST_SALES]
  )

  return rows.map(r => ({
    type:            'unusual_burst' as const,
    score:           _burstScore(r.sales_10min, r.volume_10min),
    ts:              new Date().toISOString(),
    collection:      r.collection_addr,
    collection_name: r.collection_name,
    data: {
      sales_10min:      r.sales_10min,
      volume_10min_eth: r.volume_10min,
      avg_price_eth:    Math.round(r.avg_price_eth * 1000) / 1000,
    },
  }))
}

function _whaleScore(priceEth: number): number {
  return Math.min(100, Math.round(40 + Math.log2(priceEth / WHALE_ETH) * 20))
}
function _spikeScore(ratio: number, volumeEth: number): number {
  return Math.min(100, Math.round(30 + Math.log2(ratio) * 20) + Math.min(20, Math.round(volumeEth / 5)))
}
function _burstScore(sales: number, volumeEth: number): number {
  return Math.min(100, Math.round(30 + Math.log2(sales / BURST_SALES) * 20) + Math.min(30, Math.round(volumeEth / 3)))
}
