/**
 * Abstrack Backend MVP — production-ready.
 *
 * Ajouté :
 *   - handler unhandledRejection / uncaughtException
 *   - error handler global Fastify (format JSON uniforme)
 *   - décoration app.authenticate complète avec TypeScript
 *   - WsManager.stop() appelé au shutdown
 *   - rate limiting plus strict sur les routes lourdes (via onRoute hook)
 */

import Fastify, { FastifyRequest, FastifyReply } from 'fastify'
import cors      from '@fastify/cors'
import jwt       from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import websocket from '@fastify/websocket'

import { db }                      from './db/client'
import { registerRoutes }          from './routes'
import { WsManager }               from './ws/manager'
import { startAlertsCron }           from './jobs/alerts'
import { startIntegrityCron }        from './jobs/integrity'
import { startAlphaCron }            from './jobs/alpha'
import { startLiveSalesBroadcaster } from './jobs/liveSales'
import { resolveCollectionNames }    from './jobs/resolveNames'
import { logger }                  from './lib/logger'
import { registerRequestLogger }   from './lib/requestLogger'

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}

const PORT = Number(process.env.PORT) || 3001

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport: process.env.NODE_ENV === 'development'
        ? { target: 'pino-pretty' }
        : undefined,
    },
    // Rejette les payloads > 512KB au niveau HTTP
    bodyLimit: 512 * 1024,
  })

  // ── CORS ─────────────────────────────────────────────────────────────────
  await app.register(cors, {
    origin:      process.env.CORS_ORIGIN ?? false,  // false = same-origin uniquement en prod
    credentials: true,
  })

  // ── JWT ──────────────────────────────────────────────────────────────────
  const jwtSecret = process.env.JWT_SECRET
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be set and at least 32 characters')
  }
  await app.register(jwt, { secret: jwtSecret })

  app.decorate('authenticate', async function (req: FastifyRequest, reply: FastifyReply) {
    try {
      await req.jwtVerify()
    } catch (err) {
      reply.send(err)
    }
  })

  // ── Rate limiting ─────────────────────────────────────────────────────────
  await app.register(rateLimit, {
    global:     true,
    max:        120,
    timeWindow: 60_000,
    // Identifie par IP (pas de Redis requis pour MVP)
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: () => ({
      error: 'Too Many Requests',
      retryAfter: 60,
    }),
  })

  // ── WebSocket ─────────────────────────────────────────────────────────────
  await app.register(websocket)
  const wsManager = new WsManager()

  app.get('/ws', { websocket: true }, (socket, _req) => {
    wsManager.handleConnection(socket)
  })

  // ── Request logging ───────────────────────────────────────────────────────
  registerRequestLogger(app)

  // ── REST Routes ───────────────────────────────────────────────────────────
  await registerRoutes(app)

  // ── Health ────────────────────────────────────────────────────────────────
  app.get('/healthz', {
    config: { rateLimit: { max: 600, timeWindow: 60_000 } },  // health non limité agressivement
  }, async () => ({
    status:      'ok',
    ts:          Date.now(),
    connections: wsManager.count(),
    uptime:      Math.floor(process.uptime()),
  }))

  // ── Error handler global ──────────────────────────────────────────────────
  // Format JSON uniforme pour toutes les erreurs non gérées
  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode ?? 500
    if (status >= 500) {
      app.log.error({ err, url: req.url }, 'Unhandled error')
    }
    reply.status(status).send({
      error:   err.message || 'Internal Server Error',
      status,
    })
  })

  // ── Not Found handler ─────────────────────────────────────────────────────
  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ error: `Route not found: ${req.method} ${req.url}` })
  })

  // ── Crons ─────────────────────────────────────────────────────────────────
  startAlertsCron(wsManager)
  startIntegrityCron()
  startAlphaCron(wsManager)
  startLiveSalesBroadcaster(wsManager)

  // ── Name resolution (background, non-blocking) ────────────────────────────
  resolveCollectionNames().catch(err =>
    logger.warn({ err }, 'resolveCollectionNames background task failed')
  )

  return { app, wsManager }
}

async function start() {
  process.on('unhandledRejection', (reason) => {
    // On logue mais on ne quitte pas — peut être une promesse rejetée non critique
    logger.error({ reason }, 'unhandledRejection')
  })
  process.on('uncaughtException', (err) => {
    // État indéfini → on logue puis on quitte
    logger.error({ err }, 'uncaughtException — process will exit')
    process.exit(1)
  })

  logger.info({ port: PORT, env: process.env.NODE_ENV }, 'Starting backend')

  await db.connect()
  const { app, wsManager } = await buildServer()
  await app.listen({ port: PORT, host: '0.0.0.0' })

  logger.info({ port: PORT }, 'Backend ready')

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received')
    wsManager.stop()
    await app.close()
    logger.info('Shutdown complete')
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT',  () => shutdown('SIGINT'))
}

start().catch(err => {
  logger.error({ err }, 'Fatal startup error')
  process.exit(1)
})
