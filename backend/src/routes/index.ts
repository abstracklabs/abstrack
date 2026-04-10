import type { FastifyInstance } from 'fastify'
import { collectionsRoutes } from './collections'
import { walletsRoutes }    from './wallets'
import { alertsRoutes }     from './alerts'
import { analyticsRoutes }  from './analytics'
import { alphaRoutes }      from './alpha'
import { adminRoutes }      from './admin'

export async function registerRoutes(app: FastifyInstance) {
  await app.register(collectionsRoutes, { prefix: '/api/v1/collections' })
  await app.register(walletsRoutes,     { prefix: '/api/v1/wallets' })
  await app.register(alertsRoutes,      { prefix: '/api/v1/alerts' })
  await app.register(analyticsRoutes,   { prefix: '/api/v1/analytics' })
  await app.register(alphaRoutes,       { prefix: '/api/v1/alpha-feed' })
  await app.register(adminRoutes,       { prefix: '/admin' })
}
