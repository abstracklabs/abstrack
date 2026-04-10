/**
 * Logger partagé — instance Pino standalone pour les modules
 * qui n'ont pas accès à `app.log` (db, ws, jobs).
 *
 * Pino est déjà une dépendance directe de Fastify — pas de paquet supplémentaire.
 *
 * Comportement :
 *   - development : sortie colorée lisible (pino-pretty)
 *   - production  : JSON structuré sur stdout → capturé par Docker / systemd
 *
 * Champs présents dans chaque log :
 *   time, level, service, env, msg + champs contextuels selon l'event
 *
 * Exemples de sortie production (JSON, 1 ligne par event) :
 *
 *   {"time":"2026-04-09T12:00:01.234Z","level":"info","service":"backend","env":"production","msg":"PostgreSQL connected"}
 *   {"time":"2026-04-09T12:00:05.110Z","level":"warn","service":"backend","env":"production","msg":"Slow query","duration_ms":620,"sql":"SELECT * FROM nft_sales WHERE..."}
 *   {"time":"2026-04-09T12:00:08.900Z","level":"error","service":"backend","env":"production","msg":"DB error","err":{"message":"...","code":"23505"},"query":"INSERT INTO..."}
 */

import pino from 'pino'

const isDev = process.env.NODE_ENV !== 'production'

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',

  // Champs de base présents dans tous les logs
  base: {
    service: 'backend',
    env:     process.env.NODE_ENV ?? 'development',
    version: process.env.npm_package_version ?? '1.0.0',
  },

  // Timestamp ISO8601 lisible (vs epoch ms par défaut)
  timestamp: pino.stdTimeFunctions.isoTime,

  // Sérialise proprement les objets Error
  serializers: {
    err: pino.stdSerializers.err,
  },

  // Sortie colorée en dev, JSON pur en prod
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize:        true,
            translateTime:   'HH:MM:ss.l',
            ignore:          'pid,hostname,service,env,version',
            messageFormat:   '[{service}] {msg}',
          },
        },
      }
    : {}),
})

/**
 * Crée un logger enfant avec un contexte fixe.
 * Utiliser pour isoler les logs par sous-système.
 *
 * Usage :
 *   const log = childLogger('db')
 *   log.info({ pool: 'main' }, 'Connected')
 *   // → {"service":"backend","component":"db","msg":"Connected",...}
 */
export function childLogger(component: string) {
  return logger.child({ component })
}
