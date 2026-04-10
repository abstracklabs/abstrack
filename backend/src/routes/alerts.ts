/**
 * Alerts routes — avec validation stricte via JSON Schema Fastify.
 *
 * Ajouté :
 *   - validation schema sur POST (name, condition, threshold)
 *   - limite de 20 alertes par utilisateur
 *   - validation UUID sur les params :id
 *   - vérification ownership sur triggers (IDOR corrigé)
 */

import type { FastifyInstance } from 'fastify'
import { db } from '../db/client'

const UUID_RE     = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ETH_ADDR_RE = /^0x[0-9a-f]{40}$/i
const MAX_ALERTS_PER_USER = 20

function isValidUuid(s: string) { return UUID_RE.test(s) }

export async function alertsRoutes(app: FastifyInstance) {

  // GET /alerts
  app.get('/', { onRequest: [app.authenticate] }, async (req) => {
    const userId = (req.user as any).sub
    return db.query(
      `SELECT id, name, condition, channels, active, cooldown_s, last_triggered, created_at
       FROM alerts WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    )
  })

  // POST /alerts
  app.post<{
    Body: {
      name: string
      condition: {
        type: 'whale_buy' | 'volume_spike' | 'floor_drop'
        collection?: string
        threshold?: number
      }
      channels?: string[]
      cooldown_s?: number
    }
  }>('/', {
    onRequest: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['name', 'condition'],
        additionalProperties: false,
        properties: {
          name:       { type: 'string', minLength: 1, maxLength: 100 },
          condition: {
            type: 'object',
            required: ['type'],
            additionalProperties: false,
            properties: {
              type:       { type: 'string', enum: ['whale_buy', 'volume_spike', 'floor_drop'] },
              collection: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
              threshold:  { type: 'number', minimum: 0.001, maximum: 100_000 },
            },
          },
          channels:   {
            type: 'array',
            items: { type: 'string', enum: ['in_app', 'email', 'discord'] },
            maxItems: 3,
            default: ['in_app'],
          },
          cooldown_s: { type: 'integer', minimum: 60, maximum: 86_400, default: 300 },
        },
      },
    },
  }, async (req, reply) => {
    const userId = (req.user as any).sub
    const { name, condition, channels = ['in_app'], cooldown_s = 300 } = req.body

    // Limite par utilisateur
    const countRow = await db.queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM alerts WHERE user_id = $1`,
      [userId]
    )
    if (parseInt(countRow?.count ?? '0') >= MAX_ALERTS_PER_USER) {
      return reply.status(429).send({ error: `Maximum ${MAX_ALERTS_PER_USER} alerts per user` })
    }

    // volume_spike et floor_drop nécessitent une collection
    if (condition.type !== 'whale_buy' && !condition.collection) {
      return reply.status(400).send({ error: `condition.collection is required for type "${condition.type}"` })
    }

    const row = await db.queryOne<{ id: string }>(
      `INSERT INTO alerts (user_id, name, condition, channels, cooldown_s)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [userId, name, JSON.stringify(condition), channels, cooldown_s]
    )
    return reply.status(201).send(row)
  })

  // PATCH /alerts/:id — toggle active
  app.patch<{
    Params: { id: string }
    Body: { active: boolean }
  }>('/:id', {
    onRequest: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['active'],
        properties: { active: { type: 'boolean' } },
      },
    },
  }, async (req, reply) => {
    if (!isValidUuid(req.params.id)) return reply.status(400).send({ error: 'Invalid id' })
    const userId = (req.user as any).sub
    const result = await db.query(
      `UPDATE alerts SET active = $1 WHERE id = $2 AND user_id = $3 RETURNING id`,
      [req.body.active, req.params.id, userId]
    )
    if (result.length === 0) return reply.status(404).send({ error: 'Not found' })
    return reply.status(200).send({ id: req.params.id, active: req.body.active })
  })

  // DELETE /alerts/:id
  app.delete<{ Params: { id: string } }>('/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (!isValidUuid(req.params.id)) return reply.status(400).send({ error: 'Invalid id' })
    const userId = (req.user as any).sub
    const result = await db.query(
      `DELETE FROM alerts WHERE id = $1 AND user_id = $2 RETURNING id`,
      [req.params.id, userId]
    )
    if (result.length === 0) return reply.status(404).send({ error: 'Not found' })
    return reply.status(204).send()
  })

  // GET /alerts/:id/triggers
  app.get<{ Params: { id: string } }>('/:id/triggers', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (!isValidUuid(req.params.id)) return reply.status(400).send({ error: 'Invalid id' })
    const userId = (req.user as any).sub

    // Ownership check (IDOR fix)
    const alert = await db.queryOne(
      `SELECT id FROM alerts WHERE id = $1 AND user_id = $2`,
      [req.params.id, userId]
    )
    if (!alert) return reply.status(404).send({ error: 'Not found' })

    return db.query(
      `SELECT triggered_at, event_data
       FROM alert_triggers WHERE alert_id = $1
       ORDER BY triggered_at DESC LIMIT 50`,
      [req.params.id]
    )
  })
}
