'use client'

import { useQuery }   from '@tanstack/react-query'
import Link           from 'next/link'
import { StatCard }   from '../../../components/ui/StatCard'
import { apiFetch }  from '../../../lib/api'
import type { CollectionRow, MarketOverview } from '../../../lib/types'

const API = process.env.NEXT_PUBLIC_API_URL

function growthPct(current: number, prev: number): string | null {
  if (!prev || prev === 0) return null
  const pct = ((current - prev) / prev) * 100
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`
}

function fmtEth(n: number | undefined, decimals = 1): string {
  if (n === undefined || n === null) return '—'
  return `${Number(n).toFixed(decimals)} ETH`
}

export default function AnalyticsPage() {
  const { data: overview, isLoading: overviewLoading } = useQuery<MarketOverview>({
    queryKey:        ['analytics-market-overview'],
    queryFn:         () => apiFetch<MarketOverview>(`${API}/api/v1/analytics/market-overview`),
    refetchInterval: 60_000,
    staleTime:       60_000,
  })

  const { data: topVolume, isLoading: volumeLoading } = useQuery<CollectionRow[]>({
    queryKey:  ['analytics-top-volume'],
    queryFn:   () => apiFetch<CollectionRow[]>(`${API}/api/v1/collections?sort=volume_24h&limit=10`),
    staleTime: 60_000,
  })

  const { data: topSales, isLoading: salesLoading } = useQuery<CollectionRow[]>({
    queryKey:  ['analytics-top-sales'],
    queryFn:   () => apiFetch<CollectionRow[]>(`${API}/api/v1/collections?sort=sales&limit=10`),
    staleTime: 60_000,
  })

  const volumeGrowth = overview
    ? growthPct(Number(overview.volume_24h_eth), Number(overview.volume_prev_24h_eth))
    : null

  const salesGrowth = overview
    ? growthPct(overview.sales_24h, overview.sales_prev_24h)
    : null

  return (
    <div className="space-y-6 max-w-[1400px]">

      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-white">Analytics</h1>
        <p className="text-sm text-[var(--text-muted)]">Market overview — Abstract Chain</p>
      </div>

      {/* KPIs 24h */}
      <div>
        <p className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">Last 24 hours</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            label="Volume 24h"
            value={fmtEth(overview?.volume_24h_eth)}
            sub={volumeGrowth ? `${volumeGrowth} vs yesterday` : 'last 24 hours'}
            accent="blue"
            loading={overviewLoading}
          />
          <StatCard
            label="Sales 24h"
            value={overview ? (overview.sales_24h ?? 0).toLocaleString() : '—'}
            sub={salesGrowth ? `${salesGrowth} vs yesterday` : 'transactions'}
            accent="purple"
            loading={overviewLoading}
          />
          <StatCard
            label="Avg Sale Price"
            value={overview ? `${Number(overview.avg_price_24h_eth).toFixed(3)} ETH` : '—'}
            sub="per transaction"
            accent="green"
            loading={overviewLoading}
          />
          <StatCard
            label="Active Collections"
            value={overview ? (overview.collections_active_24h ?? 0).toLocaleString() : '—'}
            sub="with sales today"
            accent="orange"
            loading={overviewLoading}
          />
        </div>
      </div>

      {/* KPIs 7d + participants */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Volume 7d"
          value={fmtEth(overview?.volume_7d_eth)}
          sub="last 7 days"
          accent="blue"
          loading={overviewLoading}
        />
        <StatCard
          label="Sales 7d"
          value={overview ? Number(overview.sales_7d).toLocaleString() : '—'}
          sub="transactions"
          accent="purple"
          loading={overviewLoading}
        />
        <StatCard
          label="Unique Buyers 24h"
          value={overview ? Number(overview.unique_buyers_24h).toLocaleString() : '—'}
          sub="distinct wallets"
          accent="green"
          loading={overviewLoading}
        />
        <StatCard
          label="Unique Sellers 24h"
          value={overview ? Number(overview.unique_sellers_24h).toLocaleString() : '—'}
          sub="distinct wallets"
          accent="orange"
          loading={overviewLoading}
        />
      </div>

      {/* All-time strip */}
      <div className="glass rounded-xl border border-[var(--border)] px-5 py-4">
        <p className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">All-time</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
          <AllTimeStat
            label="Total Volume"
            value={fmtEth(overview?.total_volume_alltime_eth, 2)}
            loading={overviewLoading}
          />
          <AllTimeStat
            label="Total Sales"
            value={overview ? Number(overview.total_sales_alltime).toLocaleString() : '—'}
            loading={overviewLoading}
          />
          <AllTimeStat
            label="Collections"
            value={overview ? Number(overview.total_collections).toLocaleString() : '—'}
            loading={overviewLoading}
          />
          <AllTimeStat
            label="Last Indexed Block"
            value={overview?.last_indexed_block ? Number(overview.last_indexed_block).toLocaleString() : '—'}
            loading={overviewLoading}
          />
        </div>
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

// ─── All-time stat (inline, no accent border) ─────────────────────────────────

function AllTimeStat({ label, value, loading }: { label: string; value: string; loading: boolean }) {
  return (
    <div>
      <p className="text-xs text-[var(--text-muted)] mb-1">{label}</p>
      {loading ? (
        <div className="h-5 w-24 rounded bg-white/5 animate-pulse" />
      ) : (
        <p className="text-sm font-semibold text-white tabular-nums">{value}</p>
      )}
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

      <div className="flex items-center gap-2 shrink-0">
        {valueKey === 'volume' && row.change_24h_pct != null && (
          <span className={`text-[10px] font-semibold tabular-nums ${
            row.change_24h_pct >= 0 ? 'text-green-400' : 'text-red-400'
          }`}>
            {row.change_24h_pct >= 0 ? '+' : ''}{Number(row.change_24h_pct).toFixed(1)}%
          </span>
        )}
        <span className="font-mono text-sm text-white tabular-nums">
          {valueKey === 'volume'
            ? `${Number(row.volume_24h_eth).toFixed(2)} ETH`
            : (row.sales_count_24h ?? 0).toLocaleString()
          }
        </span>
      </div>
    </Link>
  )
}
