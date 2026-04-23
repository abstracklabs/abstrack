/**
 * Hooks React pour le système temps réel.
 * Chaque hook gère son abonnement WS + son état local.
 */

'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { socket }  from '../socket'
import { useCollectionStore } from '../../store/collections'
import { useAlertsStore }     from '../../store/alerts'
import type { AlphaEvent, SaleData, WalletActivityData, WSServerMessage } from '../types'

// ─── Hook de connexion global ──────────────────────────────────────────────

export function useSocket(authToken?: string) {
  useEffect(() => {
    socket.connect(authToken)
    // Pas de disconnect ici : singleton global maintenu durant toute la session
  }, [authToken])

  const [connected, setConnected] = useState(socket.isConnected)

  useEffect(() => {
    const unsub = socket.onMessage((msg) => {
      if (msg.type === 'pong') setConnected(true)
      if (msg.type === 'error') setConnected(false)
    })
    return unsub
  }, [])

  return connected
}

// ─── Live sales feed (collection ou global) ──────────────────────────────

export function useLiveSales(collection?: string, maxItems = 50) {
  const [sales, setSales] = useState<SaleData[]>([])
  const room = collection ? `collection:${collection}` : 'global'

  useEffect(() => {
    const unsub = socket.subscribe(room, (msg) => {
      if (msg.type === 'sale') {
        setSales(prev => {
          const next = [msg.data, ...prev]
          return next.length > maxItems ? next.slice(0, maxItems) : next
        })
      }
      // Batch : dépacker et insérer tout
      if (msg.type === 'batch') {
        const events = Array.isArray((msg as any).events) ? (msg as any).events : []
        const newSales = events
          .filter((e: WSServerMessage) => e.type === 'sale')
          .map((e: Extract<WSServerMessage, { type: 'sale' }>) => e.data)
        if (newSales.length) {
          setSales(prev => {
            const next = [...newSales, ...prev]
            return next.length > maxItems ? next.slice(0, maxItems) : next
          })
        }
      }
    })
    return unsub
  }, [room, maxItems])

  return sales
}

// ─── Floor price live ──────────────────────────────────────────────────────

export function useLiveFloor(collection: string) {
  const setStats = useCollectionStore(s => s.setStats)
  const floor    = useCollectionStore(s => s.stats[collection]?.floorEth ?? null)

  useEffect(() => {
    const unsub = socket.subscribe(`collection:${collection}`, (msg) => {
      if (msg.type === 'floor_update' && msg.collection === collection) {
        setStats(collection, {
          floorEth:   msg.floorEth,
          change24h:  msg.changePct,
        })
      }
    })
    return unsub
  }, [collection, setStats])

  return floor
}

// ─── Activité wallet ──────────────────────────────────────────────────────

export function useWalletActivity(address: string, maxItems = 30) {
  const [events, setEvents] = useState<WalletActivityData[]>([])
  const room = `wallet:${address.toLowerCase()}`

  useEffect(() => {
    const unsub = socket.subscribe(room, (msg) => {
      if (msg.type === 'wallet_activity') {
        setEvents(prev => {
          const next = [msg.data, ...prev]
          return next.length > maxItems ? next.slice(0, maxItems) : next
        })
      }
    })
    return unsub
  }, [room, maxItems])

  return events
}

// ─── Alertes whale ────────────────────────────────────────────────────────

export function useWhaleAlerts(maxItems = 20) {
  const [alerts, setAlerts] = useState<Array<{
    wallet: string
    tier: string
    collection: string
    amountUsd: number
    ts: number
  }>>([])

  useEffect(() => {
    const unsub = socket.subscribe('whale', (msg) => {
      if (msg.type === 'whale_alert') {
        setAlerts(prev => {
          const next = [{ ...msg, ts: Date.now() }, ...prev]
          return next.length > maxItems ? next.slice(0, maxItems) : next
        })
      }
    })
    return unsub
  }, [maxItems])

  return alerts
}

// ─── Alertes personnalisées ───────────────────────────────────────────────

export function usePersonalAlerts(userId: string | null) {
  const addAlert = useAlertsStore(s => s.addTrigger)

  useEffect(() => {
    if (!userId) return
    const room  = `alerts:${userId}`
    const unsub = socket.subscribe(room, (msg) => {
      if (msg.type === 'alert_trigger') {
        addAlert({
          alertId:     msg.alertId,
          triggeredAt: Date.now(),
          event:       msg.event,
        })
      }
    })
    return unsub
  }, [userId, addAlert])
}

// ─── Alpha Feed live ──────────────────────────────────────────────────────

export function useAlphaFeed(maxItems = 30) {
  const [events, setEvents] = useState<AlphaEvent[]>([])

  useEffect(() => {
    socket.connect()
    const unsub = socket.subscribe('alpha', (msg) => {
      if (msg.type === 'alpha_events') {
        setEvents(prev => {
          // Merge + dédup par (type, collection, ts) + tri par score
          const incoming = (msg as Extract<WSServerMessage, { type: 'alpha_events' }>).events
          if (!Array.isArray(incoming)) return prev
          const combined = [...incoming, ...prev]
          const seen     = new Set<string>()
          const deduped  = combined.filter(e => {
            const key = `${e.type}:${e.collection}:${e.ts}`
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })
          return deduped.slice(0, maxItems)
        })
      }
    })
    return unsub
  }, [maxItems])

  return events
}

// ─── Hook utilitaire : stats de connexion ────────────────────────────────

export function useConnectionStatus() {
  const [status, setStatus] = useState<'connected' | 'reconnecting' | 'disconnected'>('disconnected')
  const [latency, setLatency] = useState<number | null>(null)
  const pingRef = useRef<number>(0)

  useEffect(() => {
    socket.connect()

    const unsub = socket.onMessage((msg) => {
      if (msg.type === 'pong') {
        setStatus('connected')
        setLatency(Date.now() - pingRef.current)
      }
    })

    // Mesure de latence toutes les 10s
    const pingInterval = setInterval(() => {
      pingRef.current = Date.now()
      ;(socket as any)._send({ action: 'ping' })
    }, 10_000)

    return () => {
      unsub()
      clearInterval(pingInterval)
    }
  }, [])

  return { status, latency }
}
