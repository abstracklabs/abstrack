'use client'

import { use }             from 'react'
import { useQuery }        from '@tanstack/react-query'
import Link                from 'next/link'
import { StatCard }        from '../../../../components/ui/StatCard'
import { DataTable }       from '../../../../components/ui/DataTable'
import { WalletActivity }  from '../../../../components/live/WalletActivity'
import { useCollectionNames } from '../../../../lib/hooks/useCollectionNames'

const API = process.env.NEXT_PUBLIC_API_URL

interface Params { params: Promise<{ address: string }> }

export default function WalletPage({ params }: Params) {
  const { address: addr } = use(params)

  // Profile stats : buys, sells, transfers counts
  const { data: profile } = useQuery({
    queryKey: ['wallet', addr],
    queryFn:  () => fetch(`${API}/api/v1/wallets/${addr}`).then(r => r.json()),
    staleTime: 60_000,
  })

  // NFT positions actuelles (delta transfers)
  const { data: portfolio } = useQuery({
    queryKey: ['wallet-portfolio', addr],
    queryFn:  () => fetch(`${API}/api/v1/wallets/${addr}/portfolio`).then(r => r.json()),
    staleTime: 60_000,
  })

  // Historique des trades (sales)
  const { data: activity } = useQuery({
    queryKey: ['wallet-activity', addr],
    queryFn:  () => fetch(`${API}/api/v1/wallets/${addr}/activity?limit=50`).then(r => r.json()),
    staleTime: 30_000,
  })

  // Stats calculées depuis les données réelles
  const buysEth    = Number(profile?.buys?.total_eth ?? 0)
  const sellsEth   = Number(profile?.sells?.total_eth ?? 0)
  const realizedPnl = sellsEth - buysEth
  const totalTrades = (Number(profile?.buys?.count ?? 0) + Number(profile?.sells?.count ?? 0))

  const labels = profile?.labels ?? []
  const { getCollectionName } = useCollectionNames()
  const portfolioColumns = buildPortfolioColumns(getCollectionName)
  const activityColumns  = buildActivityColumns()

  return (
    <div className="space-y-6 max-w-[1400px]">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-4">
          <WalletAvatar address={addr} />
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
              <span className="text-xs text-[var(--text-muted)] font-mono">{addr}</span>
            </div>
          </div>
        </div>

        <button className="px-4 py-2 text-sm rounded-lg glass border border-[var(--border)] text-[var(--text-muted)] hover:text-white hover:border-white/20 transition flex items-center gap-2">
          <span>🔔</span> Set Alert
        </button>
      </div>

      {/* Stats réelles depuis l'API */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          label="Realized P&L"
          value={`${realizedPnl >= 0 ? '+' : ''}${realizedPnl.toFixed(4)} ETH`}
          accent={realizedPnl >= 0 ? 'green' : 'red'}
          sub="sells − buys"
        />
        <StatCard
          label="Total Spent"
          value={`${buysEth.toFixed(3)} ETH`}
          sub={`${profile?.buys?.count ?? 0} buys`}
          accent="blue"
        />
        <StatCard
          label="Total Received"
          value={`${sellsEth.toFixed(3)} ETH`}
          sub={`${profile?.sells?.count ?? 0} sells`}
          accent="purple"
        />
        <StatCard
          label="Total Trades"
          value={totalTrades > 0 ? totalTrades.toLocaleString() : '—'}
          sub="transactions"
        />
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-3 gap-4">

        {/* Portfolio — NFTs actuellement détenus */}
        <div className="col-span-2 glass rounded-xl border border-[var(--border)] overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Portfolio</h2>
            <span className="text-xs text-[var(--text-muted)]">
              {portfolio?.length ?? 0} positions
            </span>
          </div>
          <DataTable
            columns={portfolioColumns}
            data={portfolio ?? []}
            keyFn={(r: any) => `${r.collection_addr}:${r.token_id}`}
            loading={!portfolio}
            emptyText="No NFTs held"
          />
        </div>

        {/* Live activity */}
        <div className="glass rounded-xl border border-[var(--border)] overflow-hidden" style={{ maxHeight: 420 }}>
          <WalletActivity address={addr} maxItems={20} />
        </div>
      </div>

      {/* Historique des trades */}
      <div className="glass rounded-xl border border-[var(--border)] overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--border)]">
          <h2 className="text-sm font-semibold text-white">Trade History</h2>
        </div>
        <DataTable
          columns={activityColumns}
          data={activity ?? []}
          keyFn={(r: any) => r.id ?? r.tx_hash}
          loading={!activity}
          emptyText="No trade history"
        />
      </div>
    </div>
  )
}

// ─── Wallet avatar déterministe ────────────────────────────────────────────

function WalletAvatar({ address }: { address: string }) {
  const hue = parseInt(address.slice(2, 6), 16) % 360
  return (
    <div
      className="h-14 w-14 rounded-full flex items-center justify-center text-lg font-bold text-white/80 shadow-lg"
      style={{ background: `linear-gradient(135deg, hsl(${hue}deg 60% 30%), hsl(${(hue + 60) % 360}deg 70% 45%))` }}
    >
      {address.slice(2, 4).toUpperCase()}
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

// ─── Portfolio columns — champs réels de l'API ────────────────────────────
// GET /wallets/:address/portfolio retourne :
//   collection_addr, token_id, collection_name, floor_price_eth

function buildPortfolioColumns(getCollectionName: (a: string) => string) {
  return [
    {
      key: 'nft', header: 'NFT',
      render: (r: any) => (
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-blue-600/40 to-purple-600/40 border border-white/10 shrink-0" />
          <div>
            <p className="text-sm text-white">{r.collection_name || getCollectionName(r.collection_addr)}</p>
            <p className="text-xs font-mono text-[var(--text-muted)]">#{r.token_id}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'collection', header: 'Collection',
      render: (r: any) => (
        <Link
          href={`/collections/${r.collection_addr}`}
          className="text-xs font-mono text-blue-400 hover:text-blue-300 transition"
        >
          {r.collection_addr.slice(0, 8)}…
        </Link>
      ),
    },
    {
      key: 'floor', header: 'Floor', align: 'right' as const,
      render: (r: any) => (
        <span className="font-mono text-sm text-white">
          {r.floor_price_eth ? `${Number(r.floor_price_eth).toFixed(4)} ETH` : '—'}
        </span>
      ),
    },
  ]
}

// ─── Activity columns — champs réels de l'API ────────────────────────────
// GET /wallets/:address/activity retourne :
//   id, tx_hash, collection_addr, token_id, price_eth, price_usd, block_ts, marketplace, side

function buildActivityColumns() {
  return [
    {
      key: 'side', header: 'Side',
      render: (r: any) => {
        const colors: Record<string, string> = {
          buy:  'text-green-400', sell: 'text-red-400',
        }
        return (
          <span className={`text-xs font-bold uppercase ${colors[r.side] ?? 'text-white'}`}>
            {r.side}
          </span>
        )
      },
    },
    {
      key: 'collection', header: 'Collection',
      render: (r: any) => (
        <Link href={`/collections/${r.collection_addr}`} className="text-xs font-mono text-blue-400 hover:text-blue-300">
          {r.collection_addr.slice(0, 10)}…
        </Link>
      ),
    },
    {
      key: 'token', header: 'Token',
      render: (r: any) => (
        <span className="text-xs font-mono text-[var(--text-muted)]">#{r.token_id}</span>
      ),
    },
    {
      key: 'price', header: 'Price', align: 'right' as const,
      render: (r: any) => {
        const eth = Number(r.price_eth ?? 0)
        const usd = Number(r.price_usd ?? 0)
        return (
          <div className="text-right">
            <p className="font-mono text-sm text-white">{eth.toFixed(4)} ETH</p>
            {usd > 0 && <p className="font-mono text-xs text-[var(--text-muted)]">${usd.toFixed(0)}</p>}
          </div>
        )
      },
    },
    {
      key: 'marketplace', header: 'Market',
      render: (r: any) => (
        <span className="text-xs text-[var(--text-muted)]">{r.marketplace ?? '—'}</span>
      ),
    },
    {
      key: 'time', header: 'When', align: 'right' as const,
      render: (r: any) => {
        const ms = r.block_ts ? new Date(r.block_ts).getTime() : 0
        if (!ms || isNaN(ms)) return <span className="text-xs text-[var(--text-muted)]">—</span>
        const diff = Math.max(0, Math.floor((Date.now() - ms) / 1000))
        const label = diff < 60   ? `${diff}s`
                    : diff < 3600 ? `${Math.floor(diff / 60)}m`
                    : `${Math.floor(diff / 3600)}h`
        return <span className="text-xs text-[var(--text-muted)]">{label} ago</span>
      },
    },
  ]
}
