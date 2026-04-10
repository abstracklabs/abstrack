/**
 * Alertes — cron simple toutes les 30 secondes.
 * Remplace l'intégralité du service Python alerts/ (détecteurs, dispatcher, etc.).
 *
 * Détecteurs MVP :
 *   - whale_buy  : vente > threshold ETH dans les 30 dernières secondes
 *   - volume_spike : volume 1h > threshold ETH sur une collection
 *   - floor_drop : (TODO: nécessite un oracle floor — placeholder pour MVP)
 */

import cron from 'node-cron'
import { db } from '../db/client'
import { childLogger } from '../lib/logger'
import type { WsManager } from '../ws/manager'

const log = childLogger('alerts')

interface AlertCondition {
  type: 'whale_buy' | 'volume_spike' | 'floor_drop'
  collection?: string
  threshold?: number  // en ETH
}

export function startAlertsCron(ws: WsManager) {
  cron.schedule('*/30 * * * * *', () => {
    runAlertChecks(ws).catch(err =>
      log.error({ err }, 'Alert cron run failed')
    )
  })
  log.info('Alert cron started (every 30s)')
}

async function runAlertChecks(ws: WsManager) {
  const alerts = await db.query<{
    id: string
    user_id: string
    condition: AlertCondition
    cooldown_s: number
    last_triggered: Date | null
  }>(`
    SELECT id, user_id, condition, cooldown_s, last_triggered
    FROM alerts
    WHERE active = true
  `)

  for (const alert of alerts) {
    // Respect du cooldown
    if (alert.last_triggered) {
      const elapsed = (Date.now() - alert.last_triggered.getTime()) / 1000
      if (elapsed < alert.cooldown_s) continue
    }

    const triggered = await checkAlert(alert.condition)
    if (!triggered) continue

    await db.query(
      `INSERT INTO alert_triggers (alert_id, event_data) VALUES ($1, $2)`,
      [alert.id, JSON.stringify(triggered)]
    )
    await db.query(
      `UPDATE alerts SET last_triggered = now() WHERE id = $1`,
      [alert.id]
    )

    log.info(
      {
        alert_id:   alert.id,
        user_id:    alert.user_id,
        type:       alert.condition.type,
        collection: alert.condition.collection,
        data:       triggered,
      },
      `Alert triggered — ${alert.condition.type}`
    )

    ws.broadcast(`alerts:${alert.user_id}`, {
      type:    'alert_trigger',
      alertId: alert.id,
      data:    triggered,
      ts:      Date.now(),
    })
  }
}

async function checkAlert(condition: AlertCondition): Promise<object | null> {
  const threshold = condition.threshold ?? 1.0  // défaut : 1 ETH

  switch (condition.type) {
    case 'whale_buy': {
      // fix: fenêtre 90s au lieu de 30s — absorbe les délais du cron
      // Le cooldown de l'alerte évite les doublons
      const sql = condition.collection
        ? `SELECT tx_hash, collection_addr, price_eth, buyer
           FROM nft_sales
           WHERE price_eth >= $1
             AND block_ts > now() - INTERVAL '90 seconds'
             AND collection_addr = $2
           ORDER BY price_eth DESC
           LIMIT 1`
        : `SELECT tx_hash, collection_addr, price_eth, buyer
           FROM nft_sales
           WHERE price_eth >= $1
             AND block_ts > now() - INTERVAL '90 seconds'
           ORDER BY price_eth DESC
           LIMIT 1`

      const params = condition.collection
        ? [threshold, condition.collection.toLowerCase()]
        : [threshold]

      const row = await db.queryOne(sql, params)
      return row ? { type: 'whale_buy', sale: row } : null
    }

    case 'volume_spike': {
      // Volume 1h sur une collection > threshold ETH
      if (!condition.collection) return null
      const row = await db.queryOne<{ vol: string }>(
        `SELECT SUM(price_eth)::text AS vol
         FROM nft_sales
         WHERE collection_addr = $1
           AND block_ts > now() - INTERVAL '1 hour'`,
        [condition.collection.toLowerCase()]
      )
      const vol = parseFloat(row?.vol ?? '0')
      return vol >= threshold
        ? { type: 'volume_spike', collection: condition.collection, volume_1h_eth: vol }
        : null
    }

    case 'floor_drop':
      // MVP : non implémenté (nécessite un oracle)
      return null

    default:
      return null
  }
}
