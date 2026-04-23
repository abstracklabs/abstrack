'use client'

import { useQuery }      from '@tanstack/react-query'
import { useRouter }     from 'next/navigation'
import { StatCard }      from '../../components/ui/StatCard'
import { LiveSalesFeed } from '../../components/live/LiveSalesFeed'
import { AlphaFeed }     from '../../components/live/AlphaFeed'
import { apiFetch } from '../../lib/api'
import type { CollectionRow, GlobalStats } from '../../lib/types'

const API = process.env.NEXT_PUBLIC_API_URL

export function DashboardClient() {
  const router = useRouter()

  // Stats globales depuis /analytics/global (source of truth)
  const { data: global, isLoading: globalLoading } = useQuery<GlobalStats>({
    queryKey:        ['analytics-global'],
    queryFn:         () => apiFetch<GlobalStats>(`${API}/api/v1/analytics/global`),
    refetchInterval: 30_000,
  })

  // Top collections
  const { data: collections, isLoading: collectionsLoading } = useQuery<CollectionRow[]>({
    queryKey:        ['top-collections'],
    queryFn:         () => apiFetch<CollectionRow[]>(`${API}/api/v1/collections?sort=volume_24h&limit=20`),
    refetchInterval: 30_000,
  })

  return (
    <div className="space-y-5 max-w-[1600px]">

      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-white tracking-tight">Dashboard</h1>
        <p className="text-sm text-[var(--text-muted)] mt-0.5">Abstract Chain — Live analytics</p>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Volume 24h"
          value={global ? `${Number(global.volume_24h_eth).toFixed(1)} ETH` : '—'}
          sub="last 24 hours"
          accent="blue"
          loading={globalLoading}
        />
        <StatCard
          label="Sales 24h"
          value={global ? (global.sales_24h ?? 0).toLocaleString() : '—'}
          sub="transactions"
          accent="purple"
          loading={globalLoading}
        />
        <StatCard
          label="Collections"
          value={global ? (global.collections_active ?? 0).toLocaleString() : '—'}
          sub="with activity"
          accent="green"
          loading={globalLoading}
        />
        <StatCard
          label="Avg Sale"
          value={global ? `${Number(global.avg_price_eth).toFixed(3)} ETH` : '—'}
          sub="per transaction"
          accent="orange"
          loading={globalLoading}
        />
      </div>

      {/* Main grid : Collections | Live Sales | Alpha Feed */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px_300px] gap-4 min-h-[560px]">

        {/* Top Collections */}
        <div className="glass rounded-xl border border-[var(--border)] overflow-hidden flex flex-col">
          <CollectionsTable
            collections={collections ?? []}
            loading={collectionsLoading}
            onRowClick={r => router.push(`/collections/${r.address}`)}
          />
        </div>

        {/* Live Sales */}
        <div className="glass rounded-xl border border-[var(--border)] overflow-hidden flex flex-col">
          <LiveSalesFeed maxItems={30} />
        </div>

        {/* Alpha Feed */}
        <div className="glass rounded-xl border border-[var(--border)] overflow-hidden flex flex-col">
          <AlphaFeed />
        </div>

      </div>
    </div>
  )
}

// ─── Collections table ────────────────────────────────────────────────────

interface CollectionsTableProps {
  collections: CollectionRow[]
  loading:     boolean
  onRowClick:  (row: CollectionRow) => void
}

function CollectionsTable({ collections, loading, onRowClick }: CollectionsTableProps) {
  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] shrink-0">
        <h2 className="text-sm font-semibold text-white">Top Collections</h2>
        <span className="text-xs text-[var(--text-muted)]">by volume 24h</span>
      </div>

      {/* Column headers */}
      <div className="grid grid-cols-[auto_1fr_auto_auto_auto] gap-4 px-4 py-2 border-b border-[var(--border)] shrink-0">
        <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] w-5">#</span>
        <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Collection</span>
        <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] text-right">Floor</span>
        <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] text-right">Vol 24h</span>
        <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] text-right">Sales</span>
      </div>

      {/* Rows */}
      <div className="flex-1 overflow-y-auto overscroll-contain">
        {loading ? (
          <CollectionsSkeleton />
        ) : collections.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-[var(--text-muted)] text-sm">
            No collections yet
          </div>
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {collections.map((col, i) => (
              <CollectionRow
                key={col.address}
                row={col}
                rank={i + 1}
                onClick={() => onRowClick(col)}
              />
            ))}
          </div>
        )}
      </div>
    </>
  )
}

function CollectionRow({ row, rank, onClick }: { row: CollectionRow; rank: number; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full grid grid-cols-[auto_1fr_auto_auto_auto] gap-4 items-center px-4 py-3 hover:bg-white/[0.04] transition-colors text-left"
    >
      {/* Rank */}
      <span className="text-xs text-[var(--text-muted)] tabular-nums w-5">{rank}</span>

      {/* Name + address */}
      <div className="flex items-center gap-3 min-w-0">
        <CollectionAvatar name={row.name} address={row.address} thumbnail={row.thumbnail_url} />
        <div className="min-w-0">
          <p className="text-sm font-medium text-white truncate">
            {row.name || shortAddr(row.address)}
          </p>
          <p className="text-[10px] text-[var(--text-muted)] font-mono">{shortAddr(row.address)}</p>
        </div>
      </div>

      {/* Floor */}
      <span className="text-sm font-mono text-white tabular-nums text-right">
        {Number(row.floor_price_eth) > 0 ? `${Number(row.floor_price_eth).toFixed(4)} ETH` : '—'}
      </span>

      {/* Volume */}
      <span className="text-sm font-mono text-white tabular-nums text-right">
        {_ethFmt(Number(row.volume_24h_eth))} ETH
      </span>

      {/* Sales */}
      <span className="text-sm font-mono text-[var(--text-muted)] tabular-nums text-right">
        {(row.sales_count_24h ?? 0).toLocaleString()}
      </span>
    </button>
  )
}

function CollectionAvatar({ name, address, thumbnail }: { name: string; address: string; thumbnail: string | null }) {
  if (thumbnail) {
    return (
      <img
        src={thumbnail}
        alt={name}
        className="h-9 w-9 rounded-lg object-cover shrink-0"
        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
      />
    )
  }
  // Fallback : gradient déterministe basé sur l'adresse
  const hue = parseInt(address.slice(2, 4), 16) * 1.4
  return (
    <div
      className="h-9 w-9 rounded-lg shrink-0 flex items-center justify-center text-xs font-bold text-white/70"
      style={{ background: `hsl(${hue}deg 60% 25%)` }}
    >
      {(name || address).slice(0, 2).toUpperCase()}
    </div>
  )
}

function CollectionsSkeleton() {
  return (
    <div className="divide-y divide-[var(--border)] animate-pulse">
      {Array.from({ length: 10 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-3">
          <div className="h-4 w-4 rounded bg-white/5" />
          <div className="h-9 w-9 rounded-lg bg-white/5 shrink-0" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 w-32 rounded bg-white/5" />
            <div className="h-2 w-20 rounded bg-white/5" />
          </div>
          <div className="h-3 w-16 rounded bg-white/5" />
          <div className="h-3 w-16 rounded bg-white/5" />
          <div className="h-3 w-8 rounded bg-white/5" />
        </div>
      ))}
    </div>
  )
}

// ─── Utilitaires ──────────────────────────────────────────────────────────

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function _ethFmt(eth: number): string {
  if (eth >= 1000) return `${(eth / 1000).toFixed(1)}k`
  if (eth >= 100)  return eth.toFixed(1)
  return eth.toFixed(2)
}

function _usdFmt(usd: number): string {
  if (usd >= 1_000_000) return `${(usd / 1_000_000).toFixed(1)}M`
  if (usd >= 1_000)     return `${(usd / 1_000).toFixed(0)}k`
  return `$${usd.toFixed(0)}`
}
