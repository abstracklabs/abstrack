/**
 * Wallets routes — PostgreSQL uniquement.
 *
 * Optimisations :
 *   - /:address           : 3 queries en parallèle (inchangé — déjà optimal)
 *   - /:address/activity  : pagination par curseur keyset (OFFSET → seek par index)
 *   - /:address/portfolio : requête UNION ALL + delta au lieu de CTE received/sent
 */

import type { FastifyInstance } from 'fastify'
import { db } from '../db/client'

const NULL_ADDRESS = '0x' + '0'.repeat(40)

export async function walletsRoutes(app: FastifyInstance) {

  // GET /wallets/:address — stats globales
  app.get<{ Params: { address: string } }>('/:address', async (req) => {
    const address = req.params.address.toLowerCase()

    const [buys, sells, transfers] = await Promise.all([
      db.queryOne<{ count: string; total_eth: string }>(
        `SELECT COUNT(*)::text AS count, COALESCE(SUM(price_eth),0)::text AS total_eth
         FROM nft_sales WHERE buyer = $1`,
        [address]
      ),
      db.queryOne<{ count: string; total_eth: string }>(
        `SELECT COUNT(*)::text AS count, COALESCE(SUM(price_eth),0)::text AS total_eth
         FROM nft_sales WHERE seller = $1`,
        [address]
      ),
      db.queryOne<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM nft_transfers WHERE to_addr = $1 OR from_addr = $1`,
        [address]
      ),
    ])

    return {
      address,
      buys:      { count: buys?.count ?? '0',      total_eth: buys?.total_eth ?? '0' },
      sells:     { count: sells?.count ?? '0',     total_eth: sells?.total_eth ?? '0' },
      transfers: { count: transfers?.count ?? '0' },
    }
  })

  // GET /wallets/:address/activity?limit=50&before_ts=<ISO>&before_id=<uuid>
  //
  // Pagination keyset sur (block_ts DESC, id DESC).
  // OFFSET N scannait N lignes inutilement — keyset seek via index direct.
  //
  // Premier appel  : GET /activity?limit=50
  // Appels suivants: GET /activity?limit=50&before_ts=2024-01-15T10:00:00Z&before_id=<uuid>
  app.get<{
    Params: { address: string }
    Querystring: { limit?: string; before_ts?: string; before_id?: string }
  }>('/:address/activity', async (req) => {
    const address = req.params.address.toLowerCase()
    const limit   = Math.min(Number(req.query.limit) || 50, 200)
    const { before_ts, before_id } = req.query

    if (before_ts && before_id) {
      return db.query(
        `SELECT id, tx_hash, collection_addr, token_id, price_eth, price_usd,
                block_ts, marketplace,
                CASE WHEN buyer = $1 THEN 'buy' ELSE 'sell' END AS side
         FROM nft_sales
         WHERE (buyer = $1 OR seller = $1)
           AND (block_ts, id) < ($2::timestamptz, $3::uuid)
         ORDER BY block_ts DESC, id DESC
         LIMIT $4`,
        [address, before_ts, before_id, limit]
      )
    }

    return db.query(
      `SELECT id, tx_hash, collection_addr, token_id, price_eth, price_usd,
              block_ts, marketplace,
              CASE WHEN buyer = $1 THEN 'buy' ELSE 'sell' END AS side
       FROM nft_sales
       WHERE buyer = $1 OR seller = $1
       ORDER BY block_ts DESC, id DESC
       LIMIT $2`,
      [address, limit]
    )
  })

  // GET /wallets/:address/pnl
  // PnL réalisé via wallet_realized_pnl() SQL function.
  // Un seul scan nft_sales avec FILTER — beaucoup plus rapide que deux requêtes séparées.
  app.get<{ Params: { address: string } }>('/:address/pnl', async (req) => {
    const address = req.params.address.toLowerCase()
    const row = await db.queryOne(
      `SELECT * FROM wallet_realized_pnl($1)`,
      [address]
    )
    return row ?? {
      total_spent_eth:    '0',
      total_received_eth: '0',
      realized_pnl_eth:   '0',
      buy_count:          0,
      sell_count:         0,
      unique_collections: 0,
      most_traded_coll:   null,
      avg_buy_price_eth:  '0',
      avg_sell_price_eth: '0',
    }
  })

  // GET /wallets/:address/portfolio — NFT estimés (balance depuis transfers)
  //
  // Réécrit avec UNION ALL + delta : un seul GROUP BY au lieu de CTE received/sent + JOIN.
  app.get<{ Params: { address: string } }>('/:address/portfolio', async (req) => {
    const address = req.params.address.toLowerCase()

    return db.query(
      `SELECT
         t.collection_addr,
         t.token_id,
         c.name AS collection_name,
         c.floor_price_eth
       FROM (
         SELECT collection_addr, token_id, SUM(delta) AS balance
         FROM (
           SELECT collection_addr, token_id,  COALESCE(quantity, 1) AS delta FROM nft_transfers WHERE to_addr   = $1
           UNION ALL
           SELECT collection_addr, token_id, -COALESCE(quantity, 1) AS delta FROM nft_transfers WHERE from_addr = $1
         ) moves
         GROUP BY collection_addr, token_id
         HAVING SUM(delta) > 0
       ) t
       LEFT JOIN collections c ON c.address = t.collection_addr
       ORDER BY c.floor_price_eth DESC NULLS LAST
       LIMIT 200`,
      [address]
    )
  })
}
