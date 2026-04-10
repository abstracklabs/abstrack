/**
 * AbstrackSocket — Client WebSocket singleton.
 *
 * Features :
 *   - Reconnexion automatique (backoff exponentiel)
 *   - Réabonnement automatique aux rooms après reconnexion
 *   - Heartbeat / keepalive (ping toutes les 30s)
 *   - Multi-handlers par room (plusieurs composants peuvent écouter)
 *   - Auth token optionnel pour les alertes personnalisées
 *
 * Pattern pub/sub interne :
 *   subscribe(room, handler) → retourne une fonction d'unsubscribe
 *   Un même composant peut subscribe/unsubscribe proprement (useEffect cleanup)
 */

import type { WSServerMessage, WSClientMessage } from './types'

type Handler = (msg: WSServerMessage) => void

// Backend unifié — plus de service realtime séparé (était :3002)
const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:3001/ws'

class AbstrackSocket {
  private ws:               WebSocket | null = null
  private rooms:            Set<string> = new Set()
  private handlers:         Map<string, Set<Handler>> = new Map()
  private globalHandlers:   Set<Handler> = new Set()
  private authToken:        string | null = null
  private reconnectDelay    = 1_000
  private reconnectTimer:   ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer:   ReturnType<typeof setInterval> | null = null
  private connectionState:  'idle' | 'connecting' | 'open' | 'reconnecting' = 'idle'

  // ─── Connexion ─────────────────────────────────────────────────────────────

  connect(authToken?: string) {
    if (authToken) this.authToken = authToken
    if (this.connectionState === 'open' || this.connectionState === 'connecting') return
    this._connect()
  }

  disconnect() {
    this.connectionState = 'idle'
    this._clearTimers()
    this.ws?.close(1000, 'client disconnect')
    this.ws = null
  }

  private _connect() {
    this.connectionState = 'connecting'
    this.ws = new WebSocket(WS_URL)

    this.ws.onopen = () => {
      this.connectionState  = 'open'
      this.reconnectDelay   = 1_000

      // Auth si token disponible
      if (this.authToken) {
        this._send({ action: 'auth', token: this.authToken })
      }

      // Réabonnement à toutes les rooms (reconnect)
      for (const room of this.rooms) {
        this._send({ action: 'sub', room })
      }

      this._startHeartbeat()
      console.debug('[ws] connected')
    }

    this.ws.onmessage = (event) => {
      try {
        const msg: WSServerMessage = JSON.parse(event.data)
        this._dispatch(msg)
      } catch {
        console.warn('[ws] failed to parse message')
      }
    }

    this.ws.onclose = (event) => {
      this.connectionState = 'reconnecting'
      this._clearTimers()
      if (event.code !== 1000) {
        // Reconnexion automatique sauf fermeture propre
        this._scheduleReconnect()
      }
      console.debug(`[ws] closed (code=${event.code}), retry in ${this.reconnectDelay}ms`)
    }

    this.ws.onerror = () => {
      // onerror est toujours suivi de onclose → reconnect géré là
    }
  }

  private _scheduleReconnect() {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000)
      this._connect()
    }, this.reconnectDelay)
  }

  private _startHeartbeat() {
    this._clearHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.connectionState === 'open') {
        this._send({ action: 'ping' })
      }
    }, 30_000)
  }

  private _clearTimers() {
    this._clearHeartbeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private _clearHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  // ─── Pub/Sub ────────────────────────────────────────────────────────────────

  /**
   * Abonne à une room. Retourne une fonction de cleanup (React useEffect).
   *
   * Usage :
   *   useEffect(() => socket.subscribe('collection:0xabc', handler), [])
   */
  subscribe(room: string, handler: Handler): () => void {
    // Enregistrer le handler
    if (!this.handlers.has(room)) this.handlers.set(room, new Set())
    this.handlers.get(room)!.add(handler)

    // Envoyer la subscription si nouveau
    if (!this.rooms.has(room)) {
      this.rooms.add(room)
      this._send({ action: 'sub', room })
    }

    // Retourner la fonction de cleanup
    return () => {
      const set = this.handlers.get(room)
      if (set) {
        set.delete(handler)
        // Unsubscribe de la room si plus aucun handler
        if (set.size === 0) {
          this.handlers.delete(room)
          this.rooms.delete(room)
          this._send({ action: 'unsub', room })
        }
      }
    }
  }

  /** Écoute TOUS les messages (debug ou store global). */
  onMessage(handler: Handler): () => void {
    this.globalHandlers.add(handler)
    return () => this.globalHandlers.delete(handler)
  }

  private _dispatch(msg: WSServerMessage) {
    // Handlers globaux
    for (const h of this.globalHandlers) h(msg)

    // Handlers par room
    const room = this._msgToRoom(msg)
    if (room) {
      this.handlers.get(room)?.forEach(h => h(msg))
    }

    // 'sale' et 'whale_alert' vont aussi dans 'global'
    if (msg.type === 'sale' || msg.type === 'whale_alert') {
      this.handlers.get('global')?.forEach(h => h(msg))
    }
  }

  private _msgToRoom(msg: WSServerMessage): string | null {
    switch (msg.type) {
      case 'sale':
        return 'data' in msg && msg.data && 'collection' in msg.data
          ? `collection:${(msg.data as any).collection}`
          : null
      case 'floor_update':
        return `collection:${msg.collection}`
      case 'wallet_activity':
        return 'data' in msg && msg.data && 'wallet' in msg.data
          ? `wallet:${(msg.data as any).wallet}`
          : null
      case 'whale_alert':
        return 'whale'
      case 'alpha_events':
        return 'alpha'
      case 'alert_trigger':
        return null   // dispatché directement via alerts:{userId}
      default:
        return null
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private _send(msg: WSClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
    // Si pas connecté : ignoré (les subs seront réenvoyés à la reconnexion)
  }

  get isConnected() {
    return this.connectionState === 'open'
  }
}

// Singleton global — 1 seule connexion WS par onglet
export const socket = new AbstrackSocket()
