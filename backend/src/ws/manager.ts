/**
 * WsManager — WebSocket production-ready.
 *
 * Ajouté :
 *   - heartbeat ping/pong toutes les 30s
 *   - détection et terminaison des connexions zombies (pas de pong reçu)
 *   - nettoyage des rooms vides après départ d'un client
 *   - limite : MAX_CONNECTIONS connexions simultanées
 *   - limite : MAX_ROOMS_PER_CLIENT rooms par connexion
 *   - taille max des messages entrants (16KB)
 *   - broadcast ignore les sockets mortes et les retire du Set
 */

import { WebSocket } from 'ws'
import { childLogger } from '../lib/logger'

const log                 = childLogger('ws')
const WS_OPEN             = WebSocket.OPEN
const HEARTBEAT_INTERVAL  = 30_000   // ms entre chaque ping
const HEARTBEAT_TIMEOUT   = 10_000   // ms pour recevoir le pong avant de kill
const MAX_CONNECTIONS     = 1_000
const MAX_ROOMS_PER_CLIENT = 10
const MAX_MESSAGE_BYTES   = 16 * 1024  // 16KB

type Room = string

interface ClientMeta {
  rooms:       Set<Room>
  isAlive:     boolean   // false = ping envoyé, pas encore de pong
  connectedAt: number
}

export class WsManager {
  private clients  = new Map<WebSocket, ClientMeta>()
  private rooms    = new Map<Room, Set<WebSocket>>()
  private interval: ReturnType<typeof setInterval> | null = null

  constructor() {
    this._startHeartbeat()
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────

  private _startHeartbeat() {
    this.interval = setInterval(() => {
      this._pingAll()
    }, HEARTBEAT_INTERVAL)
  }

  private _pingAll() {
    let zombies = 0
    for (const [ws, meta] of this.clients) {
      if (!meta.isAlive) {
        zombies++
        this._cleanup(ws, meta)
        ws.terminate()
        continue
      }
      meta.isAlive = false
      if (ws.readyState === WS_OPEN) ws.ping()
    }

    if (zombies > 0) {
      log.warn({ zombies_terminated: zombies }, `Terminated ${zombies} zombie connection(s)`)
    }
    // Log périodique — visible en prod pour monitorer la charge WS
    log.info(
      { connections: this.clients.size, rooms: this.rooms.size },
      'Heartbeat'
    )
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }

  // ── Nouvelle connexion ────────────────────────────────────────────────────

  handleConnection(ws: WebSocket) {
    if (this.clients.size >= MAX_CONNECTIONS) {
      log.warn({ connections: this.clients.size }, 'Connection rejected — server at capacity')
      ws.close(1013, 'Server at capacity')
      return
    }

    const meta: ClientMeta = {
      rooms:       new Set(),
      isAlive:     true,
      connectedAt: Date.now(),
    }
    this.clients.set(ws, meta)
    log.info({ connections: this.clients.size }, 'Client connected')

    // Pong reçu → connexion encore vivante
    ws.on('pong', () => {
      const m = this.clients.get(ws)
      if (m) m.isAlive = true
    })

    ws.on('message', (raw: Buffer | string, isBinary: boolean) => {
      if (isBinary) return  // on n'accepte que du texte

      // Limite taille des messages entrants
      const size = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(raw.toString())
      if (size > MAX_MESSAGE_BYTES) {
        this._send(ws, { type: 'error', message: 'Message too large' })
        return
      }

      try {
        const msg = JSON.parse(raw.toString())
        this._handleMessage(ws, meta, msg)
      } catch {
        this._send(ws, { type: 'error', message: 'Invalid JSON' })
      }
    })

    ws.on('close', (code: number) => {
      const duration = Date.now() - meta.connectedAt
      log.info(
        { code, duration_ms: duration, connections: this.clients.size - 1 },
        'Client disconnected'
      )
      this._cleanup(ws, meta)
    })

    ws.on('error', (err: Error) => {
      log.error({ err }, 'Socket error')
      this._cleanup(ws, meta)
      ws.terminate()
    })
  }

  // ── Broadcast ─────────────────────────────────────────────────────────────

  broadcast(room: Room, payload: object) {
    const members = this.rooms.get(room)
    if (!members || members.size === 0) return
    const data = JSON.stringify(payload)
    const dead: WebSocket[] = []

    for (const ws of members) {
      if (ws.readyState === WS_OPEN) {
        ws.send(data, (err: Error | undefined) => {
          if (err) console.error(`[ws] send error in room ${room}: ${err.message}`)
        })
      } else {
        dead.push(ws)
      }
    }

    // Nettoyage paresseux des sockets mortes dans ce Set
    for (const ws of dead) {
      members.delete(ws)
      const meta = this.clients.get(ws)
      if (meta) this._cleanup(ws, meta)
    }
  }

  broadcastAll(payload: object) {
    this.broadcast('global', payload)
  }

  count(): number {
    return this.clients.size
  }

  // ── Traitement des messages clients ───────────────────────────────────────

  private _handleMessage(ws: WebSocket, meta: ClientMeta, msg: any) {
    if (typeof msg !== 'object' || msg === null) return

    switch (msg.action) {
      case 'sub': {
        if (typeof msg.room !== 'string') return
        if (!this._isValidRoom(msg.room)) {
          log.warn({ room: msg.room }, 'Client tried to sub to invalid room')
          return this._send(ws, { type: 'error', message: `Invalid room: ${msg.room}` })
        }
        if (meta.rooms.size >= MAX_ROOMS_PER_CLIENT) {
          log.warn({ rooms: meta.rooms.size }, 'Client hit room limit')
          return this._send(ws, { type: 'error', message: `Room limit reached (${MAX_ROOMS_PER_CLIENT})` })
        }
        if (!meta.rooms.has(msg.room)) {
          meta.rooms.add(msg.room)
          if (!this.rooms.has(msg.room)) this.rooms.set(msg.room, new Set())
          this.rooms.get(msg.room)!.add(ws)
          log.info({ room: msg.room, members: this.rooms.get(msg.room)!.size }, 'Client subscribed')
        }
        this._send(ws, { type: 'ack', action: 'sub', room: msg.room })
        break
      }

      case 'unsub': {
        if (typeof msg.room !== 'string') return
        meta.rooms.delete(msg.room)
        const roomSet = this.rooms.get(msg.room)
        if (roomSet) {
          roomSet.delete(ws)
          if (roomSet.size === 0) this.rooms.delete(msg.room)  // nettoyage room vide
        }
        this._send(ws, { type: 'ack', action: 'unsub', room: msg.room })
        break
      }

      case 'ping':
        // ping applicatif (distinct du ping WebSocket protocolaire)
        this._send(ws, { type: 'pong', ts: Date.now() })
        break
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private _send(ws: WebSocket, data: object) {
    if (ws.readyState === WS_OPEN) {
      ws.send(JSON.stringify(data), (err: Error | undefined) => {
        if (err) log.warn({ err }, 'Send error')
      })
    }
  }

  private _cleanup(ws: WebSocket, meta: ClientMeta) {
    for (const room of meta.rooms) {
      const roomSet = this.rooms.get(room)
      if (roomSet) {
        roomSet.delete(ws)
        if (roomSet.size === 0) this.rooms.delete(room)  // room vide → supprimée
      }
    }
    meta.rooms.clear()
    this.clients.delete(ws)
  }

  private _isValidRoom(room: string): boolean {
    return (
      room === 'global' ||
      room === 'whale'  ||
      room === 'alpha'  ||
      /^collection:0x[0-9a-f]{40}$/i.test(room) ||
      /^wallet:0x[0-9a-f]{40}$/i.test(room)     ||
      /^alerts:[0-9a-f-]{36}$/i.test(room)
    )
  }
}
