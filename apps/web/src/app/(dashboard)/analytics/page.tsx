'use client'

import { useQuery }   from '@tanstack/react-query'
import Link           from 'next/link'
import { StatCard }   from '../../../components/ui/StatCard'
import type { CollectionRow, GlobalStats } from '../../../lib/types'

const API = process.env.NEXT_PUBLIC_API_URL

export default function AnalyticsPage() {
  const { data: global, isLoading: globalLoading } = useQuery<GlobalStats>({
    queryKey:        ['analytics-global'],
    queryFn:         () => fetch(`${API}/api/v1/analytics/global`).then(r => r.json()),
    refetchInterval: 30_000,
    staleTime:       30_000,
  })

  const { data: topVolume, isLoading: volumeLoading } = useQuery<CollectionRow[]>({
    queryKey:  ['analytics-top-volume'],
    queryFn:   () => fetch(`${API}/api/v1/collections?sort=volume_24h&limit=10`).then(r => r.json()),
    staleTime: 60_000,
  })

  const { data: topSales, isLoading: salesLoading } = useQuery<CollectionRow[]>({
    queryKey:  ['analytics-top-sales'],
    queryFn:   () => fetch(`${API}/api/v1/collections?sort=sales&limit=10`).then(r => r.json()),
    staleTime: 60_000,
  })

  return (
    <div className="space-y-6 max-w-[1400px]">

      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-white">Analytics</h1>
        <p className="text-sm text-[var(--text-muted)]">Market overview — Abstract Chain</p>
      </div>

      {/* KPIs depuis /analytics/global */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Volume 24h"
          value={global ? `${Number(global.volume_24h_eth).toFixed(1)} ETH` : '—'}
          sub="last 24 hours"
          accent="blue"
          loading={globalLoading}
        />
        <StatCard
          label="Sales 24h"
          value={global ? global.sales_24h.toLocaleString() : '—'}
          sub="transactions"
          accent="purple"
          loading={globalLoading}
        />
        <StatCard
          label="Avg Sale Price"
          value={global ? `${Number(global.avg_price_eth).toFixed(3)} ETH` : '—'}
          sub="per transaction"
          accent="green"
          loading={globalLoading}
        />
        <StatCard
          label="Active Collections"
          value={global ? global.collections_active.toLocaleString() : '—'}
          sub="with sales today"
          accent="orange"
          loading={globalLoading}
        />
      </div>

      {/* Leaderboards */}
      <div className="grid grid-cols-2 gap-4">
        <LeaderboardTable
          title="Top by Volume 24h"
          data={topVolume ?? []}
          loading={volumeLoading}
          valueKey="volume"
        />
        <LeaderboardTable
          title="Top by Sales Count"
          data={topSales ?? []}
          loading={salesLoading}
          valueKey="sales"
        />
      </div>
    </div>
  )
}

// ─── Leaderboard table ────────────────────────────────────────────────────────

function LeaderboardTable({
  title, data, loading, valueKey,
}: {
  title:    string
  data:     CollectionRow[]
  loading:  boolean
  valueKey: 'volume' | 'sales'
}) {
  return (
    <div className="glass rounded-xl border border-[var(--border)] overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--border)]">
        <h2 className="text-sm font-semibold text-white">{title}</h2>
      </div>

      {loading ? (
        <div className="divide-y divide-[var(--border)] animate-pulse">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <div className="h-3 w-4 rounded bg-white/5" />
              <div className="h-7 w-7 rounded-lg bg-white/5 shrink-0" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-28 rounded bg-white/5" />
              </div>
              <div className="h-3 w-16 rounded bg-white/5" />
            </div>
          ))}
        </div>
      ) : data.length === 0 ? (
        <div className="flex items-center justify-center h-32 text-[var(--text-muted)] text-sm">
          No data yet
        </div>
      ) : (
        <div className="divide-y divide-[var(--border)]">
          {data.map((row, i) => (
            <LeaderboardRow key={row.address} row={row} rank={i + 1} valueKey={valueKey} />
          ))}
        </div>
      )}
    </div>
  )
}

function LeaderboardRow({
  row, rank, valueKey,
}: {
  row:      CollectionRow
  rank:     number
  valueKey: 'volume' | 'sales'
}) {
  const hue = parseInt(row.address.slice(2, 4), 16) * 1.4

  return (
    <Link
      href={`/collections/${row.address}`}
      className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.04] transition-colors"
    >
      <span className="text-xs text-[var(--text-muted)] tabular-nums w-4">{rank}</span>
      {row.thumbnail_url ? (
        <img
          src={row.thumbnail_url}
          alt={row.name ?? ''}
          className="h-7 w-7 rounded-lg object-cover shrink-0"
          onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
      ) : (
        <div
          className="h-7 w-7 rounded-lg shrink-0 flex items-center justify-center text-[10px] font-bold text-white/70"
          style={{ background: `hsl(${hue}deg 60% 25%)` }}
        >
          {(row.name || row.address).slice(0, 2).toUpperCase()}
        </div>
      )}
      <span className="flex-1 text-sm text-white truncate">
        {row.name || `${row.address.slice(0, 8)}…`}
      </span>
      <span className="font-mono text-sm text-white tabular-nums shrink-0">
        {valueKey === 'volume'
          ? `${Number(row.volume_24h_eth).toFixed(2)} ETH`
          : row.sales_count_24h.toLocaleString()
        }
      </span>
    </Link>
  )
}
