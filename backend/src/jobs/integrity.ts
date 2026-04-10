/**
 * Intégrité des données — cron quotidien.
 *
 * Vérifie la cohérence entre les stats cachées (collections.volume_24h_eth,
 * sales_count_24h) et les données réelles (nft_sales).
 * Si dérive détectée → rebuild automatique.
 *
 * Planifié à 02:00 UTC pour minimiser l'impact sur les requêtes live.
 */

import cron from 'node-cron'
import { db } from '../db/client'
import { childLogger } from '../lib/logger'

const log = childLogger('integrity')

interface StatsDrift {
  address: string
  name: string
  cached_volume: number
  real_volume: number
  volume_drift: number
  cached_sales: number
  real_sales: number
  sales_drift: number
}

export function startIntegrityCron() {
  // Tous les jours à 02:00 UTC
  cron.schedule('0 2 * * *', () => {
    runIntegrityCheck().catch(err =>
      log.error({ err }, 'Integrity cron failed')
    )
  })
  log.info('Integrity cron started (daily at 02:00 UTC)')
}

export async function runIntegrityCheck(): Promise<{
  drifted: number
  rebuilt: number
  ok: boolean
}> {
  log.info('Starting daily integrity check')
  const t0 = Date.now()

  const drifted = await db.query<StatsDrift>(
    'SELECT * FROM check_stats_drift()'
  )

  if (drifted.length === 0) {
    log.info({ duration_ms: Date.now() - t0 }, 'Integrity OK — no stats drift')
    return { drifted: 0, rebuilt: 0, ok: true }
  }

  // Log each drifting collection for operator visibility
  for (const row of drifted) {
    log.warn(
      {
        collection:     row.address,
        name:           row.name,
        cached_volume:  row.cached_volume,
        real_volume:    row.real_volume,
        volume_drift:   row.volume_drift,
        cached_sales:   row.cached_sales,
        real_sales:     row.real_sales,
        sales_drift:    row.sales_drift,
      },
      `Stats drift detected — ${row.address}`
    )
  }

  // Rebuild all stats in one SQL pass
  const rebuilt = await db.queryOne<{ count: number }>(
    'SELECT rebuild_all_stats() AS count'
  )
  const rebuiltCount = rebuilt?.count ?? 0

  log.warn(
    {
      drifted_count: drifted.length,
      rebuilt_count: rebuiltCount,
      duration_ms:   Date.now() - t0,
    },
    `Stats drift fixed — ${drifted.length} collection(s) rebuilt`
  )

  return { drifted: drifted.length, rebuilt: rebuiltCount, ok: false }
}
