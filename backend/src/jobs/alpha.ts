/**
 * Alpha Feed — détection d'activité notable en temps réel.
 *
 * Événements émis :
 *   whale_buy     — achat > WHALE_ETH dans les 60 dernières secondes
 *   whale_sell    — vente > WHALE_ETH dans les 60 dernières secondes
 *   volume_spike  — collection dont le volume 1h dépasse 2x sa moyenne 24h
 *   unusual_burst — collection avec > BURST_SALES ventes dans les 10 dernières minutes
 *
 * Cron : toutes les 15 secondes — assez réactif, pas de spam.
 * Chaque event contient un score de pertinence (0–100) pour permettre
 * au frontend de trier / filtrer visuellement.
 *
 * Diffusion WebSocket : room "alpha" — le client s'y abonne en envoyant
 *   { "type": "subscribe", "room": "alpha" }
 */

import cron from 'node-cron'
import { db } from '../db/client'
import { childLogger } from '../lib/logger'
import type { WsManager } from '../ws/manager'

const log = childLogger('alpha')

const WHALE_ETH   = Number(process.env.ALPHA_WHALE_ETH   ?? 5)    // seuil whale en ETH
const BURST_SALES = Number(process.env.ALPHA_BURST_SALES ?? 10)   // ventes/10min pour "burst"

export interface AlphaEvent {
  type:       'whale_buy' | 'whale_sell' | 'volume_spike' | 'unusual_burst'
  score:      number        // 0–100, pertinence relative
  ts:         string        // ISO timestamp de l'événement source
  collection: string        // adresse de la collection
  collection_name: string | null
  data:       Record<string, unknown>
}

export function startAlphaCron(ws: WsManager) {
  cron.schedule('*/15 * * * * *', () => {
    runAlphaDetection(ws).catch(err =>
      log.error({ err }, 'Alpha cron failed')
    )
  })
  log.info(`Alpha cron started (every 15s, whale threshold: ${WHALE_ETH} ETH)`)
}

async function runAlphaDetection(ws: WsManager) {
  const events = await detectAlphaEvents()
  if (events.length === 0) return

  // Tri par score décroissant — les événements les plus significatifs en tête
  events.sort((a, b) => b.score - a.score)

  log.info({ count: events.length, top_score: events[0].score }, 'Alpha events detected')

  ws.broadcast('alpha', {
    type:   'alpha_events',
    events,
    ts:     Date.now(),
  })
}

async function detectAlphaEvents(): Promise<AlphaEvent[]> {
  const [whales, spikes, bursts] = await Promise.all([
    detectWhales(),
    detectVolumeSpikes(),
    detectUnusualBursts(),
  ])
  return [...whales, ...spikes, ...bursts]
}

// ─── Whale buys/sells ──────────────────────────────────────────────────────

async function detectWhales(): Promise<AlphaEvent[]> {
  const rows = await db.query<{
    tx_hash:         string
    collection_addr: string
    collection_name: string | null
    token_id:        string
    buyer:           string
    seller:          string
    price_eth:       number
    price_usd:       number | null
    block_ts:        string
    marketplace:     string | null
  }>(
    // On cherche les ventes whale dans les 60 dernières secondes
    // Le cron tourne toutes les 15s → fenêtre 60s absorbe les délais sans manquer d'events
    `SELECT
       s.tx_hash, s.collection_addr, c.name AS collection_name,
       s.token_id, s.buyer, s.seller, s.price_eth, s.price_usd, s.block_ts,
       s.marketplace
     FROM nft_sales s
     LEFT JOIN collections c ON c.address = s.collection_addr
     WHERE s.price_eth >= $1
       AND s.block_ts > now() - INTERVAL '60 seconds'
     ORDER BY s.price_eth DESC
     LIMIT 10`,
    [WHALE_ETH]
  )

  return rows.map(r => ({
    // >= 3× threshold → seller received massive ETH = whale_sell signal
    // otherwise → buyer spent large ETH = whale_buy signal
    type:            r.price_eth >= WHALE_ETH * 3 ? 'whale_sell' : 'whale_buy',
    score:           _whaleScore(r.price_eth),
    ts:              r.block_ts,
    collection:      r.collection_addr,
    collection_name: r.collection_name,
    data: {
      tx_hash:     r.tx_hash,
      token_id:    r.token_id,
      buyer:       r.buyer,
      seller:      r.seller,
      price_eth:   r.price_eth,
      price_usd:   r.price_usd,
      marketplace: r.marketplace,
    },
  }))
}

// Score whale : 5 ETH → 40pts, 10 ETH → 60pts, 50 ETH → 90pts, 100+ ETH → 100pts
function _whaleScore(priceEth: number): number {
  return Math.min(100, Math.round(40 + Math.log2(priceEth / WHALE_ETH) * 20))
}

// ─── Volume spike — collection dont le volume 1h > 2× moyenne 6h ──────────

async function detectVolumeSpikes(): Promise<AlphaEvent[]> {
  const rows = await db.query<{
    collection_addr: string
    collection_name: string | null
    volume_1h:       number
    volume_6h_avg:   number
    sales_1h:        number
    ratio:           number
  }>(
    `WITH hourly AS (
       SELECT
         collection_addr,
         SUM(price_eth) FILTER (WHERE block_ts > now() - INTERVAL '1 hour')  AS volume_1h,
         COUNT(*)       FILTER (WHERE block_ts > now() - INTERVAL '1 hour')  AS sales_1h,
         -- moyenne horaire sur les 6 dernières heures (hors dernière heure)
         SUM(price_eth) FILTER (
           WHERE block_ts > now() - INTERVAL '6 hours'
             AND block_ts <= now() - INTERVAL '1 hour'
         ) / NULLIF(5, 0) AS volume_6h_avg
       FROM nft_sales
       WHERE block_ts > now() - INTERVAL '6 hours'
       GROUP BY collection_addr
       HAVING SUM(price_eth) FILTER (WHERE block_ts > now() - INTERVAL '1 hour') > 0
     )
     SELECT
       h.collection_addr,
       c.name AS collection_name,
       h.volume_1h,
       COALESCE(h.volume_6h_avg, 0) AS volume_6h_avg,
       h.sales_1h,
       -- ratio : combien de fois au-dessus de la moyenne horaire
       CASE
         WHEN COALESCE(h.volume_6h_avg, 0) = 0 THEN 10  -- aucun historique → score élevé
         ELSE h.volume_1h / h.volume_6h_avg
       END AS ratio
     FROM hourly h
     LEFT JOIN collections c ON c.address = h.collection_addr
     WHERE h.volume_1h > 0.5   -- filtre le bruit : au moins 0.5 ETH de volume
       AND (
         COALESCE(h.volume_6h_avg, 0) = 0
         OR h.volume_1h / h.volume_6h_avg >= 2.0
       )
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
      volume_1h_eth:  r.volume_1h,
      avg_1h_eth:     r.volume_6h_avg,
      ratio:          Math.round(r.ratio * 10) / 10,
      sales_1h:       r.sales_1h,
    },
  }))
}

// Score spike : ratio 2× → 50pts, 5× → 70pts, 10× → 85pts, volume absolu bonus
function _spikeScore(ratio: number, volumeEth: number): number {
  const ratioScore  = Math.min(80, Math.round(30 + Math.log2(ratio) * 20))
  const volumeBonus = Math.min(20, Math.round(volumeEth / 5))
  return Math.min(100, ratioScore + volumeBonus)
}

// ─── Unusual burst — collection avec beaucoup de ventes en peu de temps ──

async function detectUnusualBursts(): Promise<AlphaEvent[]> {
  const rows = await db.query<{
    collection_addr: string
    collection_name: string | null
    sales_10min:     number
    volume_10min:    number
    avg_price_eth:   number
  }>(
    `SELECT
       s.collection_addr,
       c.name AS collection_name,
       COUNT(*)            AS sales_10min,
       SUM(s.price_eth)    AS volume_10min,
       AVG(s.price_eth)    AS avg_price_eth
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
      sales_10min:   r.sales_10min,
      volume_10min_eth: r.volume_10min,
      avg_price_eth: Math.round(r.avg_price_eth * 1000) / 1000,
    },
  }))
}

// Score burst : 10 ventes → 40pts, 20 → 55pts, 50 → 70pts, volume ETH bonus
function _burstScore(sales: number, volumeEth: number): number {
  const salesScore  = Math.min(70, Math.round(30 + Math.log2(sales / BURST_SALES) * 20))
  const volumeBonus = Math.min(30, Math.round(volumeEth / 3))
  return Math.min(100, salesScore + volumeBonus)
}
