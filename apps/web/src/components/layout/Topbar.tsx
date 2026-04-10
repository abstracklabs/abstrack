'use client'

import { useState } from 'react'
import Link         from 'next/link'
import { useRouter } from 'next/navigation'
import { useLiveSales } from '../live/LiveSalesFeed'

export function Topbar() {
  const [query, setQuery] = useState('')
  const router = useRouter()

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    const q = query.trim()
    if (!q) return
    if (q.startsWith('0x') && q.length === 42) {
      router.push(`/wallet/${q}`)
    } else {
      router.push(`/collections?q=${encodeURIComponent(q)}`)
    }
  }

  return (
    <header className="h-12 flex items-center justify-between px-6 glass border-b border-[var(--border)] sticky top-0 z-30">

      {/* Ticker live (ventes récentes) */}
      <LiveTicker />

      {/* Search */}
      <form onSubmit={handleSearch} className="relative">
        <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Address or collection..."
          className="
            w-72 pl-9 pr-4 py-1.5 text-sm rounded-lg
            bg-white/5 border border-[var(--border)]
            text-white placeholder:text-[var(--text-muted)]
            focus:outline-none focus:border-blue-500/50 focus:bg-white/8
            transition-all
          "
        />
        <kbd className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-[var(--text-muted)] font-mono">
          ⌘K
        </kbd>
      </form>

      {/* Right actions */}
      <div className="flex items-center gap-3">
        <Link
          href="/alerts"
          className="relative p-1.5 rounded-lg text-[var(--text-muted)] hover:text-white hover:bg-white/5 transition"
        >
          <BellIcon />
        </Link>
        <Link
          href="/wallet"
          className="px-3 py-1.5 text-xs rounded-lg bg-blue-600/20 border border-blue-500/30 text-blue-400 hover:bg-blue-600/30 transition"
        >
          Connect Wallet
        </Link>
      </div>
    </header>
  )
}

// ─── Live ticker ─────────────────────────────────────────────────────────────

function LiveTicker() {
  const sales = useLiveSales(undefined, 10)

  if (!sales.length) return (
    <div className="text-xs text-[var(--text-muted)]">Waiting for live data...</div>
  )

  const items = [...sales, ...sales]  // doublon pour loop seamless

  return (
    <div className="overflow-hidden w-80">
      <div className="flex gap-8 animate-ticker whitespace-nowrap">
        {items.map((sale, i) => (
          <span key={i} className="text-xs flex items-center gap-1.5 shrink-0">
            <span className="text-[var(--text-muted)]">
              {sale.collection.slice(0, 8)}...
            </span>
            <span className="text-white font-mono">{sale.priceEth.toFixed(3)}Ξ</span>
            <span className={sale.priceEth > 1 ? 'text-green-400' : 'text-[var(--text-muted)]'}>
              ●
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}

// ─── Icons ───────────────────────────────────────────────────────────────────

function SearchIcon({ className = '' }) {
  return (
    <svg className={className} width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2}>
      <circle cx="6.5" cy="6.5" r="5"/><line x1="10.5" y1="10.5" x2="15" y2="15"/>
    </svg>
  )
}

function BellIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M8 1a5 5 0 0 1 5 5v4l1 1H2l1-1V6a5 5 0 0 1 5-5z"/>
      <path d="M6.5 13a1.5 1.5 0 0 0 3 0"/>
    </svg>
  )
}

// Re-export pour le Topbar
export { useLiveSales }
