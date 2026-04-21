'use client'

import { use }             from 'react'
import { useQuery }        from '@tanstack/react-query'
import { StatCard }        from '../../../../components/ui/StatCard'
import { DataTable }       from '../../../../components/ui/DataTable'
import { WalletActivity }  from '../../../../components/live/WalletActivity'

const API = process.env.NEXT_PUBLIC_API_URL

interface Params { params: Promise<{ address: string }> }

export default function WalletPage({ params }: Params) {
  const { address: addr } = use(params)

  const { data: profile } = useQuery({
    queryKey: ['wallet', addr],
    queryFn:  () => fetch(`${API}/api/v1/wallets/${addr}`).then(r => r.json()),
    staleTime: 60_000,
  })

  const { data: pnl } = useQuery({
    queryKey: ['wallet-pnl', addr],
    queryFn:  () => fetch(`${API}/api/v1/wallets/${addr}/pnl`).then(r => r.json()),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

  const { data: portfolio } = useQuery({
    queryKey: ['wallet-portfolio', addr],
    queryFn:  () => fetch(`${API}/api/v1/wallets/${addr}/portfolio`).then(r => r.json()),
    staleTime: 60_000,
  })

  const { data: activity } = useQuery({
    queryKey: ['wallet-activity', addr],
    queryFn:  () => fetch(`${API}/api/v1/wallets/${addr}/activity?limit=50`).then(r => r.json()),
    staleTime: 30_000,
  })

  const totalPnl      = pnl?.total_eth ?? 0
  const isProfitable  = totalPnl >= 0
  const labels        = profile?.labels ?? []

  return (
    <div className="space-y-6 max-w-[1400px]">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-4">
          {/* Jazzicon placeholder */}
          <div className="h-14 w-14 rounded-full bg-gradient-to-br from-purple-500 to-blue-600" />
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-white font-mono">
                {addr.slice(0, 12)}...{addr.slice(-6)}
              </h1>
              {labels.map((label: string) => (
                <LabelBadge key={label} label={label} />
              ))}
            </div>
            <div className="flex items-center gap-3 mt-1">
              {profile?.ens_name && (
                <span className="text-sm text-blue-400">{profile.ens_name}</span>
              )}
              <span className="text-xs text-[var(--text-muted)]">
                Active since {profile?.first_seen ? new Date(profile.first_seen).toLocaleDateString() : '—'}
              </span>
            </div>
          </div>
        </div>

        <button className="px-4 py-2 text-sm rounded-lg glass border border-[var(--border)] text-[var(--text-muted)] hover:text-white hover:border-white/20 transition flex items-center gap-2">
          <span>🔔</span> Set Alert
        </button>
      </div>

      {/* PnL KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Total PnL"
          value={`${isProfitable ? '+' : ''}${totalPnl.toFixed(4)} Ξ`}
          accent={isProfitable ? 'green' : 'red'}
          sub={pnl ? `$${Math.abs(pnl.total_eth * 2500).toFixed(0)}` : undefined}
        />
        <StatCard
          label="Realized PnL"
          value={`${(pnl?.realized_eth ?? 0).toFixed(4)} Ξ`}
          accent="blue"
        />
        <StatCard
          label="Unrealized"
          value={`${(pnl?.unrealized_eth ?? 0).toFixed(4)} Ξ`}
          sub="open positions"
        />
        <StatCard
          label="Total Trades"
          value={pnl?.trades_count ?? '—'}
          sub="transactions"
        />
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-3 gap-4">

        {/* Portfolio */}
        <div className="col-span-2 glass rounded-xl border border-[var(--border)] overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Portfolio</h2>
            <span className="text-xs text-[var(--text-muted)]">
              {portfolio?.length ?? 0} positions
            </span>
          </div>
          <DataTable
            columns={PORTFOLIO_COLUMNS}
            data={portfolio ?? []}
            keyFn={(r: any) => r.collection + r.token_id}
            loading={!portfolio}
          />
        </div>

        {/* Live activity */}
        <div className="glass rounded-xl border border-[var(--border)] overflow-hidden" style={{ maxHeight: 420 }}>
          <WalletActivity address={addr} maxItems={20} />
        </div>
      </div>

      {/* PnL by collection */}
      <div className="glass rounded-xl border border-[var(--border)] overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--border)]">
          <h2 className="text-sm font-semibold text-white">PnL by Collection</h2>
        </div>
        <DataTable
          columns={PNL_COLUMNS}
          data={activity ?? []}
          keyFn={(r: any) => r.tx_hash}
          loading={!activity}
          emptyText="No trade history"
        />
      </div>
    </div>
  )
}

// ─── Labels ────────────────────────────────────────────────────────────────

const LABEL_STYLES: Record<string, string> = {
  WHALE:             'bg-orange-500/15 text-orange-400 border-orange-500/30',
  MEGA_WHALE:        'bg-red-500/15 text-red-400 border-red-500/30',
  SMART_MONEY:       'bg-purple-500/15 text-purple-400 border-purple-500/30',
  ELITE_SMART_MONEY: 'bg-gradient-to-r from-purple-500/20 to-blue-500/20 text-purple-300 border-purple-400/40',
  LARGE_BUYER:       'bg-blue-500/15 text-blue-400 border-blue-500/30',
}

function LabelBadge({ label }: { label: string }) {
  const cls = LABEL_STYLES[label] ?? 'bg-white/10 text-white/60 border-white/20'
  return (
    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${cls}`}>
      {label.replace('_', ' ')}
    </span>
  )
}

// ─── Table columns ─────────────────────────────────────────────────────────

const PORTFOLIO_COLUMNS = [
  {
    key: 'nft', header: 'NFT',
    render: (r: any) => (
      <div className="flex items-center gap-3">
        <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-blue-600/40 to-purple-600/40 border border-white/10 shrink-0" />
        <div>
          <p className="text-sm text-white">{r.name || r.collection?.slice(0, 12) + '...'}</p>
          <p className="text-xs font-mono text-[var(--text-muted)]">#{r.token_id}</p>
        </div>
      </div>
    ),
  },
  {
    key: 'cost', header: 'Cost Basis', align: 'right' as const,
    render: (r: any) => (
      <span className="font-mono text-sm text-[var(--text-muted)]">{r.cost_basis_eth?.toFixed(4)} Ξ</span>
    ),
  },
  {
    key: 'floor', header: 'Floor Now', align: 'right' as const,
    render: (r: any) => (
      <span className="font-mono text-sm text-white">{r.floor_eth?.toFixed(4)} Ξ</span>
    ),
  },
  {
    key: 'pnl', header: 'Unrealized PnL', align: 'right' as const,
    render: (r: any) => {
      const pnl = (r.floor_eth - r.cost_basis_eth)
      return (
        <span className={`font-mono text-sm font-semibold ${pnl >= 0 ? 'positive' : 'negative'}`}>
          {pnl >= 0 ? '+' : ''}{pnl?.toFixed(4)} Ξ
        </span>
      )
    },
  },
]

const PNL_COLUMNS = [
  {
    key: 'action', header: 'Action',
    render: (r: any) => {
      const colors: Record<string, string> = {
        buy: 'text-green-400', sell: 'text-red-400',
        transfer: 'text-blue-400', mint: 'text-purple-400',
      }
      return (
        <span className={`text-xs font-semibold uppercase ${colors[r.action] ?? 'text-white'}`}>
          {r.action}
        </span>
      )
    },
  },
  {
    key: 'collection', header: 'Collection',
    render: (r: any) => (
      <a href={`/collections/${r.collection}`} className="text-xs font-mono text-blue-400 hover:text-blue-300">
        {r.collection?.slice(0, 12)}...
      </a>
    ),
  },
  {
    key: 'value', header: 'Value', align: 'right' as const,
    render: (r: any) => (
      <span className="font-mono text-sm text-white">{r.value_eth?.toFixed(4)} Ξ</span>
    ),
  },
  {
    key: 'time', header: 'When', align: 'right' as const,
    render: (r: any) => {
      const diff = Math.floor((Date.now() - r.timestamp) / 1000)
      return (
        <span className="text-xs text-[var(--text-muted)]">
          {diff < 3600 ? `${Math.floor(diff/60)}m` : `${Math.floor(diff/3600)}h`} ago
        </span>
      )
    },
  },
]
