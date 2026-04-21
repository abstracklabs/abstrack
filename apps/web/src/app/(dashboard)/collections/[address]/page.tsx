'use client'

import { use }              from 'react'
import { useQuery }         from '@tanstack/react-query'
import { FloorChart }       from '../../../../components/charts/FloorChart'
import { LiveSalesFeed }    from '../../../../components/live/LiveSalesFeed'
import { LiveFloorTicker }  from '../../../../components/live/LiveFloorTicker'
import { StatCard }         from '../../../../components/ui/StatCard'
import { DataTable }        from '../../../../components/ui/DataTable'
import { NFTImage }         from '../../../../components/ui/NFTImage'
import { useLiveSales }     from '../../../../lib/hooks/useRealtime'

const API = process.env.NEXT_PUBLIC_API_URL

interface Params { params: Promise<{ address: string }> }

export default function CollectionPage({ params }: Params) {
  const { address: addr } = use(params)

  const { data: stats, isLoading } = useQuery({
    queryKey: ['collection', addr],
    queryFn:  () => fetch(`${API}/api/v1/collections/${addr}`).then(r => r.json()),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

  const { data: sales } = useQuery({
    queryKey: ['collection-sales', addr],
    queryFn:  () => fetch(`${API}/api/v1/collections/${addr}/sales?limit=100`).then(r => r.json()),
    staleTime: 10_000,
  })

  const liveSales = useLiveSales(addr, 50)

  // Fusionner live + historique (live en premier)
  const allSales = [...liveSales, ...(sales ?? [])].slice(0, 100)

  return (
    <div className="space-y-6 max-w-[1400px]">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-4">
          {stats?.thumbnail_url ? (
            <img
              src={stats.thumbnail_url}
              alt={stats.name ?? addr}
              className="h-14 w-14 rounded-2xl object-cover shadow-lg"
              onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
            />
          ) : (
            <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-blue-500 to-purple-700 shadow-lg shadow-blue-500/20" />
          )}
          <div>
            <h1 className="text-xl font-bold text-white">
              {stats?.name ?? (
                <span className="font-mono text-sm">{addr.slice(0, 16)}...</span>
              )}
            </h1>
            <div className="flex items-center gap-3 mt-1">
              <span className="font-mono text-xs text-[var(--text-muted)]">{addr}</span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400 border border-blue-500/20">
                Abstract
              </span>
            </div>
          </div>
        </div>

        <div className="text-right">
          <p className="text-xs text-[var(--text-muted)] mb-1">Floor Price</p>
          <LiveFloorTicker collection={addr} initialFloor={Number(stats?.floor_price_eth ?? 0) || undefined} />
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-5 gap-3">
        <StatCard label="Floor"      value={stats?.floor_price_eth ? `${Number(stats.floor_price_eth).toFixed(4)} ETH` : '—'} change={stats?.change_24h_pct} loading={isLoading} accent="blue" />
        <StatCard label="Volume 24h" value={stats?.volume_24h_eth   ? `${Number(stats.volume_24h_eth).toFixed(2)} ETH` : '—'} loading={isLoading} accent="purple" />
        <StatCard label="Sales 24h"  value={stats?.sales_count_24h ?? '—'} loading={isLoading} />
        <StatCard label="Holders"     value={stats?.holder_count ?? '—'}  loading={isLoading} />
        <StatCard label="Total Sales" value={stats?.total_sales ?? '—'}   loading={isLoading} />
      </div>

      {/* Chart + live feed */}
      <div className="grid grid-cols-3 gap-4">

        {/* Chart area */}
        <div className="col-span-2 glass rounded-xl border border-[var(--border)] overflow-hidden">
          <div className="flex items-center justify-between px-4 pt-4 pb-2">
            <h2 className="text-sm font-semibold text-white">Floor Price</h2>
            <PeriodSelector />
          </div>
          <div className="px-4 pb-4">
            <FloorChart collection={addr} height={220} />
          </div>
        </div>

        {/* Live sales column */}
        <div className="glass rounded-xl border border-[var(--border)] overflow-hidden" style={{ maxHeight: 340 }}>
          <LiveSalesFeed collection={addr} maxItems={30} />
        </div>
      </div>

      {/* Sales history table */}
      <div className="glass rounded-xl border border-[var(--border)] overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">Sales History</h2>
          <span className="text-xs text-[var(--text-muted)]">
            {liveSales.length > 0 && (
              <span className="text-green-400 mr-2">● {liveSales.length} live</span>
            )}
            {allSales.length} total
          </span>
        </div>
        <DataTable
          columns={salesColumns(addr)}
          data={allSales}
          keyFn={r => r.tx_hash || r.txHash}
        />
      </div>
    </div>
  )
}

// ─── Period selector ──────────────────────────────────────────────────────────

function PeriodSelector() {
  const periods = ['1H', '24H', '7D', '30D', 'ALL']
  return (
    <div className="flex gap-1 bg-white/5 rounded-lg p-1">
      {periods.map(p => (
        <button
          key={p}
          className="text-xs px-2.5 py-1 rounded-md text-[var(--text-muted)] hover:text-white transition first:bg-white/10 first:text-white"
        >
          {p}
        </button>
      ))}
    </div>
  )
}

// ─── Sales table columns ──────────────────────────────────────────────────────

function salesColumns(collection: string) {
  return [
  {
    key: 'token', header: 'NFT',
    render: (r: any) => {
      const tokenId = r.token_id ?? r.tokenId
      return (
        <div className="flex items-center gap-2.5">
          <NFTImage collection={collection} tokenId={tokenId} size={36} />
          <span className="font-mono text-white text-xs">#{tokenId}</span>
        </div>
      )
    },
  },
  {
    key: 'price', header: 'Price', align: 'right' as const,
    render: (r: any) => {
      const eth = Number(r.price_eth ?? r.priceEth ?? 0)
      const usd = Number(r.price_usd ?? r.priceUsd ?? 0)
      return (
        <div className="text-right">
          <p className="font-mono text-white text-sm">{eth.toFixed(4)} ETH</p>
          {usd > 0 && <p className="font-mono text-[var(--text-muted)] text-xs">${usd.toFixed(0)}</p>}
        </div>
      )
    },
  },
  {
    key: 'from', header: 'From',
    render: (r: any) => <AddressCell address={r.seller} />,
  },
  {
    key: 'to', header: 'To',
    render: (r: any) => <AddressCell address={r.buyer} />,
  },
  {
    key: 'marketplace', header: 'Market',
    render: (r: any) => (
      <span className="text-xs text-[var(--text-muted)]">{r.marketplace}</span>
    ),
  },
  {
    key: 'time', header: 'Time', align: 'right' as const,
    render: (r: any) => (
      <TimeCell ts={r.timestamp ?? r.ts} />
    ),
  },
  ]
}

function AddressCell({ address }: { address: string }) {
  if (!address) return <span className="text-[var(--text-muted)]">—</span>
  return (
    <a
      href={`/wallet/${address}`}
      className="font-mono text-xs text-blue-400 hover:text-blue-300 transition"
    >
      {address.slice(0, 8)}...{address.slice(-4)}
    </a>
  )
}

function TimeCell({ ts }: { ts: number }) {
  const diff = Math.floor((Date.now() - ts) / 1000)
  const label = diff < 60   ? `${diff}s`
              : diff < 3600 ? `${Math.floor(diff/60)}m`
              : `${Math.floor(diff/3600)}h`
  return <span className="text-xs text-[var(--text-muted)]">{label} ago</span>
}
