/**
 * Routes admin — protégées par header secret.
 *
 * Endpoints :
 *   GET  /admin/integrity       → snapshot JSON de l'état de la DB
 *   POST /admin/rebuild-stats   → recalcule toutes les stats collections
 *   POST /admin/resync          → reporte le checkpoint pour re-indexer une plage
 *
 * Authentification : header X-Admin-Secret doit correspondre à ADMIN_SECRET
 * (distinct du JWT utilisateur — accès ops uniquement).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { db } from '../db/client'
import { childLogger } from '../lib/logger'
import { runIntegrityCheck } from '../jobs/integrity'

const log = childLogger('admin')

const ADMIN_SECRET = process.env.ADMIN_SECRET ?? ''

function requireAdminSecret(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!ADMIN_SECRET) {
    reply.status(503).send({ error: 'ADMIN_SECRET not configured' })
    return false
  }
  const provided = req.headers['x-admin-secret']
  if (!provided || provided !== ADMIN_SECRET) {
    log.warn({ ip: req.ip, path: req.url }, 'Unauthorized admin access attempt')
    reply.status(401).send({ error: 'Unauthorized' })
    return false
  }
  return true
}

export async function adminRoutes(app: FastifyInstance) {
  // GET /admin/integrity
  app.get('/integrity', async (req, reply) => {
    if (!requireAdminSecret(req, reply)) return

    const row = await db.queryOne<{ report: object }>(
      'SELECT integrity_report() AS report'
    )
    return reply.send(row?.report ?? {})
  })

  // POST /admin/rebuild-stats
  app.post('/rebuild-stats', async (req, reply) => {
    if (!requireAdminSecret(req, reply)) return

    const result = await runIntegrityCheck()
    log.info({ result, triggered_by: req.ip }, 'Manual rebuild-stats triggered')
    return reply.send(result)
  })

  // POST /admin/resync?from=1000000&to=1001000
  // Resets the checkpoint so the indexer re-processes the range on next restart.
  // The indexer will catch up from last_block automatically.
  app.post('/resync', {
    schema: {
      querystring: {
        type: 'object',
        required: ['from'],
        properties: {
          from: { type: 'integer', minimum: 0 },
          to:   { type: 'integer', minimum: 0 },
        },
      },
    },
  }, async (req, reply) => {
    if (!requireAdminSecret(req, reply)) return

    const { from, to } = req.query as { from: number; to?: number }

    // Lower the checkpoint so indexer re-indexes from `from`
    // (indexer picks up from last_block + 1 on reconnect)
    const targetCheckpoint = Math.max(0, from - 1)
    await db.query(
      `INSERT INTO indexer_state (key, value)
       VALUES ('last_block', $1)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = now()`,
      [String(targetCheckpoint)]
    )

    // Also delete the indexed ranges in [from, to] so gap detector
    // knows they need to be re-processed
    if (to !== undefined) {
      await db.query(
        `DELETE FROM indexed_block_ranges
         WHERE from_block <= $2 AND to_block >= $1`,
        [from, to]
      )
    } else {
      await db.query(
        `DELETE FROM indexed_block_ranges WHERE to_block >= $1`,
        [from]
      )
    }

    log.warn(
      { from, to, new_checkpoint: targetCheckpoint, triggered_by: req.ip },
      'Manual resync triggered — indexer will re-process on next connect'
    )

    return reply.send({
      ok: true,
      message: `Checkpoint reset to ${targetCheckpoint}. Restart the indexer to begin resync.`,
      from,
      to: to ?? 'head',
    })
  })
}
