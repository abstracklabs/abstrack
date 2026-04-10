/**
 * Hook de request logging — enregistre chaque requête HTTP avec :
 *   method, url, status, duration_ms, ip, user_id (si authentifié)
 *
 * On ne logue PAS /healthz en info (trop verbeux en prod, sonde toutes les 10s).
 * On logue toujours les 4xx/5xx même sur /healthz.
 *
 * Exemples de sortie :
 *
 *   INFO  [http] GET /api/v1/collections 200 — 12ms
 *   {"method":"GET","url":"/api/v1/collections","status":200,"duration_ms":12,"ip":"1.2.3.4"}
 *
 *   WARN  [http] GET /api/v1/wallets/0xabc 404 — 3ms
 *   {"method":"GET","url":"/api/v1/wallets/0xabc","status":404,"duration_ms":3,"ip":"1.2.3.4"}
 *
 *   ERROR [http] POST /api/v1/alerts 500 — 8ms
 *   {"method":"POST","url":"/api/v1/alerts","status":500,"duration_ms":8,"err":"PG error 08006"}
 */

import type { FastifyInstance } from 'fastify'
import { childLogger } from './logger'

const log = childLogger('http')

// Routes pour lesquelles on ne logue pas les 200 (trop fréquentes)
const SILENT_OK_ROUTES = new Set(['/healthz'])

export function registerRequestLogger(app: FastifyInstance) {
  // Enregistre le timestamp de début sur chaque requête
  app.addHook('onRequest', async (req) => {
    req.startTime = Date.now()
  })

  // Log à la fin, quand le status code est connu
  app.addHook('onResponse', async (req, reply) => {
    const duration = Date.now() - (req.startTime ?? Date.now())
    const status   = reply.statusCode
    const isSilent = SILENT_OK_ROUTES.has(req.url) && status < 400

    if (isSilent) return

    const ctx = {
      method:      req.method,
      url:         req.url,
      status,
      duration_ms: duration,
      ip:          req.ip,
      // user_id présent si la route est authentifiée
      user_id:     (req.user as any)?.sub ?? undefined,
    }

    if (status >= 500) {
      log.error(ctx, `${req.method} ${req.url} ${status} — ${duration}ms`)
    } else if (status >= 400) {
      log.warn(ctx,  `${req.method} ${req.url} ${status} — ${duration}ms`)
    } else if (duration > 1_000) {
      // Requête lente (>1s) même si 200
      log.warn({ ...ctx, slow: true }, `SLOW ${req.method} ${req.url} ${status} — ${duration}ms`)
    } else {
      log.info(ctx,  `${req.method} ${req.url} ${status} — ${duration}ms`)
    }
  })
}

// Augmentation de type pour req.startTime
declare module 'fastify' {
  interface FastifyRequest {
    startTime?: number
  }
}
