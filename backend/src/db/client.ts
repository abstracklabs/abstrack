/**
 * Client PostgreSQL — pool avec logging structuré et détection des slow queries.
 *
 * Logs émis :
 *   INFO  "PostgreSQL connected" au démarrage
 *   WARN  "PG connect attempt N failed" + délai si retry
 *   WARN  "Slow query" si duration > SLOW_QUERY_MS (avec sql tronqué)
 *   ERROR "PG error" avec code PG, message, sql tronqué
 *   WARN  "PG idle client error" si connexion perdue en arrière-plan
 *
 * Exemple :
 *   {"component":"db","msg":"Slow query","duration_ms":820,"sql":"SELECT ... FROM nft_sales WHERE..."}
 *   {"component":"db","msg":"PG error 08006","err":{"message":"connection refused"},"sql":"INSERT INTO..."}
 */

import { Pool, PoolClient, DatabaseError } from 'pg'
import { childLogger } from '../lib/logger'

const log             = childLogger('db')
const QUERY_TIMEOUT   = 15_000   // ms — libère le pool si query bloquée
const SLOW_QUERY_MS   = 500      // ms — seuil de log "slow"
const SQL_SNIPPET_LEN = 150      // chars max du SQL dans les logs

class Database {
  private pool: Pool

  constructor() {
    this.pool = new Pool({
      connectionString:        process.env.DATABASE_URL,
      max:                     20,
      idleTimeoutMillis:       30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout:       QUERY_TIMEOUT,
      application_name:        'abstrack-backend',
      ssl:    { rejectUnauthorized: false },
      family: 4,   // force IPv4 — Railway ne supporte pas IPv6 en sortie
    })

    this.pool.on('error', (err) => {
      log.warn({ err }, 'PG idle client error — pool will reconnect automatically')
    })
  }

  async connect() {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const client = await this.pool.connect()
        client.release()
        log.info('PostgreSQL connected')
        return
      } catch (err) {
        if (attempt === 5) throw err
        const delay = attempt * 2_000
        const errMsg = err instanceof Error ? err.message : String(err)
        log.warn({ attempt, delay_ms: delay, error: errMsg }, `PG connect attempt ${attempt} failed — ${errMsg}`)
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }

  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    const start = Date.now()
    try {
      const result = await this.pool.query(sql, params)
      const duration = Date.now() - start

      if (duration > SLOW_QUERY_MS) {
        log.warn(
          { duration_ms: duration, sql: _snippet(sql) },
          `Slow query — ${duration}ms`
        )
      }

      return result.rows as T[]
    } catch (err) {
      _logAndRethrow(err, sql, Date.now() - start)
    }
  }

  async queryOne<T = any>(sql: string, params?: any[]): Promise<T | null> {
    const rows = await this.query<T>(sql, params)
    return rows[0] ?? null
  }

  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    const start  = Date.now()
    try {
      await client.query('BEGIN')
      const result = await fn(client)
      await client.query('COMMIT')
      log.info({ duration_ms: Date.now() - start }, 'Transaction committed')
      return result
    } catch (err) {
      await client.query('ROLLBACK')
      log.error({ err, duration_ms: Date.now() - start }, 'Transaction rolled back')
      throw err
    } finally {
      client.release()
    }
  }
}

function _snippet(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().slice(0, SQL_SNIPPET_LEN)
}

function _logAndRethrow(err: unknown, sql: string, duration: number): never {
  if (err instanceof DatabaseError) {
    log.error(
      { err, sql: _snippet(sql), duration_ms: duration, pg_code: err.code },
      `PG error ${err.code}: ${err.message}`
    )
    const enriched = new Error(`PG error ${err.code}: ${err.message}`)
    enriched.stack = err.stack
    throw enriched
  }
  log.error({ err, sql: _snippet(sql), duration_ms: duration }, 'Unexpected DB error')
  throw err
}

export const db = new Database()
