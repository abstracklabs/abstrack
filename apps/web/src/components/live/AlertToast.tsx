'use client'

import { useEffect, useRef, useState } from 'react'
import { useAlertsStore }   from '../../store/alerts'
import { useWhaleAlerts }   from '../../lib/hooks/useRealtime'

// ─── Toast container (à placer dans le layout root) ──────────────────────────

export function AlertToastContainer() {
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none">
      <WhaleToasts />
      <PersonalAlertToasts />
    </div>
  )
}

// ─── Alertes whale ────────────────────────────────────────────────────────────

function WhaleToasts() {
  const alerts = useWhaleAlerts(5)
  const [visible, setVisible] = useState<typeof alerts>([])
  const prevLen = useRef(0)

  useEffect(() => {
    if (alerts.length > prevLen.current) {
      const newAlerts = alerts.slice(0, alerts.length - prevLen.current)
      setVisible(newAlerts)
      prevLen.current = alerts.length

      const timer = setTimeout(() => setVisible([]), 6_000)
      return () => clearTimeout(timer)
    }
  }, [alerts])

  return (
    <>
      {visible.map((alert, i) => (
        <Toast
          key={`whale-${alert.ts}-${i}`}
          variant="whale"
          title={`${alert.tier.replace('_', ' ')} Alert`}
          body={`${truncate(alert.wallet)} bought ${(alert.amountUsd ?? 0).toLocaleString('en', { maximumFractionDigits: 0 })}$`}
        />
      ))}
    </>
  )
}

// ─── Alertes personnalisées ───────────────────────────────────────────────────

function PersonalAlertToasts() {
  const triggers = useAlertsStore(s => s.triggers)
  const markRead = useAlertsStore(s => s.markRead)

  const recent = triggers.filter(t => !t.read && Date.now() - t.triggeredAt < 8_000)

  return (
    <>
      {recent.map((t) => {
        const ev = t.event
        const type = String(ev.type ?? '')

        let variant: 'whale' | 'volume' | 'mint' | 'alert' = 'alert'
        let title = 'Alert triggered'
        let body  = ''

        if (type === 'whale_buy') {
          variant = 'whale'
          title   = `🐋 ${String(ev.tier ?? 'Whale').replace(/_/g, ' ')}`
          body    = `${String(ev.buyer ?? '').slice(0, 8)}… · ${Number(ev.price_eth ?? 0).toFixed(2)} ETH`
        } else if (type === 'volume_explosion') {
          variant = 'volume'
          title   = `⚡ Volume ×${Number(ev.ratio ?? 0).toFixed(1)}`
          body    = `${String(ev.collection ?? '').slice(0, 12)}… · ${Number(ev.volume_1h_eth ?? 0).toFixed(2)} ETH/h`
        } else if (type === 'trending_mint') {
          variant = 'mint'
          title   = `🔥 Trending Mint`
          body    = `${Number(ev.mint_velocity ?? 0)} mints/h · ${Number(ev.unique_buyers ?? 0)} buyers`
        }

        return (
          <Toast
            key={t.alertId + t.triggeredAt}
            variant={variant}
            title={title}
            body={body}
            onDismiss={() => markRead(t.alertId)}
          />
        )
      })}
    </>
  )
}

// ─── Composant Toast ──────────────────────────────────────────────────────────

interface ToastProps {
  variant:    'whale' | 'volume' | 'mint' | 'alert' | 'info'
  title:      string
  body:       string
  onDismiss?: () => void
}

const VARIANT_STYLES = {
  whale:  'border-orange-500/50 bg-orange-950/90',
  volume: 'border-blue-500/50 bg-blue-950/90',
  mint:   'border-green-500/50 bg-green-950/90',
  alert:  'border-blue-500/50 bg-blue-950/90',
  info:   'border-white/20 bg-neutral-900/90',
}

const VARIANT_DOT = {
  whale:  'bg-orange-400',
  volume: 'bg-blue-400',
  mint:   'bg-green-400',
  alert:  'bg-blue-400',
  info:   'bg-white',
}

function Toast({ variant, title, body, onDismiss }: ToastProps) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    // Entrée avec délai micro pour déclencher l'animation CSS
    const t1 = setTimeout(() => setVisible(true), 10)
    const t2 = setTimeout(() => setVisible(false), 5_500)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [])

  return (
    <div
      className={`
        pointer-events-auto
        flex items-start gap-3 px-4 py-3 rounded-xl border
        backdrop-blur-xl shadow-xl
        transition-all duration-300
        ${VARIANT_STYLES[variant]}
        ${visible ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'}
      `}
    >
      <span className={`mt-1 h-2 w-2 rounded-full shrink-0 ${VARIANT_DOT[variant]}`} />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-white">{title}</p>
        <p className="text-xs text-white/60 truncate">{body}</p>
      </div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="text-white/30 hover:text-white/70 text-xs shrink-0"
        >
          ✕
        </button>
      )}
    </div>
  )
}

// ─── Indicateur de connexion WS ───────────────────────────────────────────────

export function ConnectionStatus() {
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    // Vérifier la connexion toutes les 5s
    const check = setInterval(() => {
      setConnected((socket as any).isConnected ?? false)
    }, 5_000)
    return () => clearInterval(check)
  }, [])

  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-green-400' : 'bg-red-400'}`} />
      <span className={connected ? 'text-green-400' : 'text-red-400'}>
        {connected ? 'Live' : 'Reconnecting...'}
      </span>
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function truncate(address: string): string {
  if (!address || address.length < 10) return address ?? '?'
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

// Import manquant résolu ici
import { socket } from '../../lib/socket'
