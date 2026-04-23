'use client'

import { useEffect, useRef } from 'react'
import { useLiveSales } from '../../lib/hooks/useRealtime'
import type { SaleData } from '../../lib/types'

interface Props {
  collection?: string   // undefined = feed global
  maxItems?:   number
}

export function LiveSalesFeed({ collection, maxItems = 30 }: Props) {
  const sales      = useLiveSales(collection, maxItems)
  const listRef    = useRef<HTMLDivElement>(null)
  const isAtTop    = useRef(true)

  // Scroll automatique vers le haut uniquement si l'user n'a pas scrollé
  useEffect(() => {
    if (isAtTop.current && listRef.current) {
      listRef.current.scrollTop = 0
    }
  }, [sales])

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
          </span>
          <span className="text-sm font-medium text-white">Live Sales</span>
        </div>
        <span className="text-xs text-white/40">{sales.length} recent</span>
      </div>

      {/* Feed */}
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto overscroll-contain"
        onScroll={(e) => {
          isAtTop.current = e.currentTarget.scrollTop < 20
        }}
      >
        {sales.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-white/30 text-sm">
            Waiting for sales...
          </div>
        ) : (
          <div className="divide-y divide-white/5">
            {sales.map((sale, i) => (
              <SaleRow key={`${sale.txHash}-${i}`} sale={sale} isNew={i === 0} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function SaleRow({ sale, isNew }: { sale: SaleData; isNew: boolean }) {
  const timeAgo = useTimeAgo(sale.timestamp)

  return (
    <div className={`
      px-4 py-3 flex items-center justify-between gap-3
      transition-all duration-300
      ${isNew ? 'bg-green-500/10 animate-flash' : 'hover:bg-white/5'}
    `}>
      {/* Left : addresses */}
      <div className="flex flex-col gap-0.5 min-w-0">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-white/40">from</span>
          <WalletAddress address={sale.seller} />
          <span className="text-white/40">to</span>
          <WalletAddress address={sale.buyer} />
        </div>
        <div className="flex items-center gap-2 text-xs text-white/30">
          <span>#{sale.tokenId}</span>
          <span>·</span>
          <span>{sale.marketplace}</span>
          <span>·</span>
          <span>{timeAgo}</span>
        </div>
      </div>

      {/* Right : prix */}
      <div className="flex flex-col items-end shrink-0">
        <span className="text-sm font-semibold text-white">
          {Number(sale.priceEth ?? 0).toFixed(3)} ETH
        </span>
        {(sale.priceUsd ?? 0) > 0 && (
          <span className="text-xs text-white/40">
            ${Number(sale.priceUsd).toLocaleString('en', { maximumFractionDigits: 0 })}
          </span>
        )}
      </div>
    </div>
  )
}

function WalletAddress({ address }: { address: string }) {
  if (!address || address.length < 10) return <span className="text-[var(--text-muted)]">—</span>
  const short = `${address.slice(0, 6)}...${address.slice(-4)}`
  return (
    <a
      href={`/wallet/${address}`}
      className="font-mono text-blue-400 hover:text-blue-300 transition-colors truncate max-w-[80px]"
      onClick={e => e.stopPropagation()}
    >
      {short}
    </a>
  )
}

function useTimeAgo(timestamp: number): string {
  const diff = Math.floor((Date.now() - timestamp) / 1000)
  if (diff < 60)   return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  return `${Math.floor(diff / 3600)}h ago`
}
