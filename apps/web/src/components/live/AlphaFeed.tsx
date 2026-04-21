'use client'

import { useEffect, useRef, useState } from 'react'
import { useQuery }                    from '@tanstack/react-query'
import { useAlphaFeed }                from '../../lib/hooks/useRealtime'
import type { AlphaEvent }             from '../../lib/types'

const API = process.env.NEXT_PUBLIC_API_URL

// ─── Config visuelle par type d'événement ─────────────────────────────────

const EVENT_CFG = {
  whale_buy: {
    label:  'Whale Buy',
    color:  'text-orange-400',
    bg:     'bg-orange-500/8',
    dot:    'bg-orange-400',
    border: 'border-orange-500/15',
    icon:   '🐳',
  },
  whale_sell: {
    label:  'Whale Sell',
    color:  'text-red-400',
    bg:     'bg-red-500/8',
    dot:    'bg-red-400',
    border: 'border-red-500/15',
    icon:   '🔴',
  },
  volume_spike: {
    label:  'Vol Spike',
    color:  'text-purple-400',
    bg:     'bg-purple-500/8',
    dot:    'bg-purple-400',
    border: 'border-purple-500/15',
    icon:   '⚡',
  },
  unusual_burst: {
    label:  'Hot Burst',
    color:  'text-blue-400',
    bg:     'bg-blue-500/8',
    dot:    'bg-blue-400',
    border: 'border-blue-500/15',
    icon:   '🔥',
  },
} satisfies Record<AlphaEvent['type'], {
  label: string; color: string; bg: string; dot: string; border: string; icon: string
}>

// ─── Composant principal ───────────────────────────────────────────────────

export function AlphaFeed() {
  // Snapshot initial via REST (chargement rapide avant que le WS ne démarre)
  const { data: snapshot } = useQuery<{ events: AlphaEvent[] }>({
    queryKey:        ['alpha-feed'],
    queryFn:         () => fetch(`${API}/api/v1/alpha-feed`).then(r => r.json()),
    refetchInterval: 15_000,  // même fréquence que le cron backend
    staleTime:       10_000,
  })

  // Enrichissement live via WebSocket
  const liveEvents = useAlphaFeed(40)

  // Merge : live en tête (plus frais), snapshot en fallback
  const events = liveEvents.length > 0
    ? liveEvents
    : (snapshot?.events ?? [])

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] shrink-0">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-orange-500" />
          </span>
          <span className="text-sm font-semibold text-white">Alpha Feed</span>
        </div>
        <span className="text-xs text-[var(--text-muted)]">{events.length} signals</span>
      </div>

      {/* Legend */}
      <div className="flex gap-3 px-4 py-2 border-b border-[var(--border)] shrink-0">
        {(Object.entries(EVENT_CFG) as [AlphaEvent['type'], typeof EVENT_CFG[AlphaEvent['type']]][]).map(([key, cfg]) => (
          <div key={key} className="flex items-center gap-1">
            <span className={`text-base leading-none`}>{cfg.icon}</span>
            <span className={`text-[10px] ${cfg.color} font-medium`}>{cfg.label}</span>
          </div>
        ))}
      </div>

      {/* Feed */}
      <div className="flex-1 overflow-y-auto overscroll-contain divide-y divide-[var(--border)]">
        {events.length === 0 ? (
          <AlphaEmpty />
        ) : (
          events.map((event, i) => (
            <AlphaEventRow key={`${event.type}:${event.collection}:${event.ts}`} event={event} isNew={i === 0} />
          ))
        )}
      </div>
    </div>
  )
}

// ─── Ligne d'événement ────────────────────────────────────────────────────

function AlphaEventRow({ event, isNew }: { event: AlphaEvent; isNew: boolean }) {
  const cfg     = EVENT_CFG[event.type]
  const timeAgo = useTimeAgo(event.ts)
  const [flash, setFlash] = useState(isNew)

  useEffect(() => {
    if (!isNew) return
    const t = setTimeout(() => setFlash(false), 1200)
    return () => clearTimeout(t)
  }, [isNew])

  return (
    <div className={`
      px-4 py-3 transition-colors duration-700
      ${flash ? cfg.bg : 'hover:bg-white/[0.03]'}
    `}>
      {/* Top row : type + score + age */}
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          <span className="text-sm leading-none">{cfg.icon}</span>
          <span className={`text-[11px] font-semibold uppercase tracking-wide ${cfg.color}`}>
            {cfg.label}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <ScoreBar score={event.score} color={cfg.dot} />
          <span className="text-[10px] text-[var(--text-muted)] tabular-nums">{timeAgo}</span>
        </div>
      </div>

      {/* Collection */}
      <p className="text-xs font-medium text-white truncate mb-1">
        {event.collection_name ?? shortAddr(event.collection)}
      </p>

      {/* Event-specific data */}
      <EventDetail event={event} cfg={cfg} />
    </div>
  )
}

// ─── Détail selon le type ─────────────────────────────────────────────────

function EventDetail({ event, cfg }: { event: AlphaEvent; cfg: typeof EVENT_CFG[AlphaEvent['type']] }) {
  const d = event.data

  if (event.type === 'whale_buy' || event.type === 'whale_sell') {
    return (
      <div className="flex items-center justify-between">
        <span className="text-xs text-[var(--text-muted)] font-mono">
          #{String(d.token_id ?? '').slice(0, 8)}
        </span>
        <div className="flex items-baseline gap-1">
          <span className={`text-sm font-bold tabular-nums ${cfg.color}`}>
            {Number(d.price_eth).toFixed(2)} ETH
          </span>
          {d.price_usd != null && (
            <span className="text-[10px] text-[var(--text-muted)]">
              ${Number(d.price_usd).toLocaleString('en', { maximumFractionDigits: 0 })}
            </span>
          )}
        </div>
      </div>
    )
  }

  if (event.type === 'volume_spike') {
    return (
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-[var(--text-muted)]">
          1h avg ×{Number(d.ratio).toFixed(1)}
        </span>
        <div className="flex items-baseline gap-1">
          <span className={`text-sm font-bold tabular-nums ${cfg.color}`}>
            {Number(d.volume_1h_eth).toFixed(2)} ETH
          </span>
          <span className="text-[10px] text-[var(--text-muted)]">/ 1h</span>
        </div>
      </div>
    )
  }

  if (event.type === 'unusual_burst') {
    return (
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-[var(--text-muted)]">
          {Number(d.sales_10min)} sales / 10min
        </span>
        <span className={`text-sm font-bold tabular-nums ${cfg.color}`}>
          {Number(d.volume_10min_eth).toFixed(2)} ETH
        </span>
      </div>
    )
  }

  return null
}

// ─── Score bar ────────────────────────────────────────────────────────────

function ScoreBar({ score, color }: { score: number; color: string }) {
  return (
    <div className="flex items-center gap-1" title={`Signal score: ${score}/100`}>
      {[20, 40, 60, 80, 100].map(threshold => (
        <div
          key={threshold}
          className={`h-1.5 w-1 rounded-full transition-opacity ${
            score >= threshold
              ? `${color} opacity-100`
              : 'bg-white/10'
          }`}
        />
      ))}
    </div>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────────

function AlphaEmpty() {
  return (
    <div className="flex flex-col items-center justify-center h-40 gap-2 text-center px-6">
      <span className="text-2xl">👀</span>
      <p className="text-xs text-[var(--text-muted)]">Scanning for alpha...</p>
      <p className="text-[10px] text-[var(--text-muted)]/60">
        Whales, spikes and bursts appear here in real-time
      </p>
    </div>
  )
}

// ─── Utilitaires ──────────────────────────────────────────────────────────

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function useTimeAgo(ts: string): string {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(interval)
  }, [])

  const diff = Math.floor((now - new Date(ts).getTime()) / 1000)
  if (diff < 60)   return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  return `${Math.floor(diff / 3600)}h ago`
}
