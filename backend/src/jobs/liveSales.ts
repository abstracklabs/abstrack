/**
 * Live Sales Broadcaster — poll toutes les 2s, push via WebSocket.
 *
 * Principe : on garde en mémoire le timestamp de la dernière vente broadcastée.
 * À chaque tick, on requête les ventes plus récentes que ce curseur et on les
 * envoie aux rooms concernées :
 *   - collection:<addr>  → tous les abonnés à cette collection
 *   - global             → tous les abonnés à la vue globale
 *
 * Pas de Redis, pas d'état persistant : en cas de redémarrage, on repart de
 * now() - 5s ce qui peut dupliquer quelques ventes côté client (sans gravité).
 */

import { db }          from '../db/client'
import { childLogger } from '../lib/logger'
import type { WsManager } from '../ws/manager'

const log = childLogger('live-sales')

const POLL_INTERVAL_MS = 2_000   // 2s — cadencé sur les blocs Abstract (~2s)
const BACKFILL_WINDOW  = 5_000   // au démarrage : récupère les 5 dernières secondes

interface SaleRow {
  tx_hash:         string
  id:              string
  token_id:        string
  seller:          string
  buyer:           string
  price_eth:       number
  price_usd:       number | null
  marketplace:     string | null
  block_ts:        string          // ISO string from PG
  collection_addr: string
  collection_name: string | null
}

export function startLiveSalesBroadcaster(ws: WsManager) {
  // Curseur : dernière vente déjà broadcastée
  // On démarre 5s en arrière pour absorber les ventes récentes
  let cursor = new Date(Date.now() - BACKFILL_WINDOW).toISOString()
  let lastId = ''   // tie-breaker : évite de re-broadcast la vente exactement au curseur

  setInterval(async () => {
    try {
      const rows = await db.query<SaleRow>(
        `SELECT
           s.tx_hash, s.id::text, s.token_id, s.seller, s.buyer,
           s.price_eth, s.price_usd, s.marketplace,
           s.block_ts::text AS block_ts,
           s.collection_addr,
           c.name AS collection_name
         FROM nft_sales s
         LEFT JOIN collections c ON c.address = s.collection_addr
         WHERE s.block_ts > $1::timestamptz
            OR (s.block_ts = $1::timestamptz AND s.id::text > $2)
         ORDER BY s.block_ts ASC, s.id ASC
         LIMIT 50`,
        [cursor, lastId]
      )

      if (rows.length === 0) return

      for (const row of rows) {
        const payload = {
          type: 'sale',
          data: {
            txHash:     row.tx_hash,
            tokenId:    row.token_id,
            seller:     row.seller,
            buyer:      row.buyer,
            priceEth:   Number(row.price_eth),
            priceUsd:   row.price_usd ? Number(row.price_usd) : null,
            marketplace: row.marketplace,
            ts:         new Date(row.block_ts).getTime(),
            collection: row.collection_addr,
            collectionName: row.collection_name,
          },
        }

        ws.broadcast(`collection:${row.collection_addr}`, payload)
        ws.broadcast('global', payload)
      }

      // Avance le curseur au-delà des ventes envoyées
      const last = rows[rows.length - 1]
      cursor = last.block_ts
      lastId = last.id

      log.debug({ count: rows.length, cursor }, 'Live sales broadcast')
    } catch (err) {
      log.warn({ err }, 'Live sales poll failed')
    }
  }, POLL_INTERVAL_MS)

  log.info({ interval_ms: POLL_INTERVAL_MS }, 'Live sales broadcaster started')
}
