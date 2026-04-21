'use client'

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import type { CollectionRow } from '../../../lib/types'

const API = process.env.NEXT_PUBLIC_API_URL

export default function CollectionsPage() {
  const { data: collections = [], isLoading } = useQuery<CollectionRow[]>({
    queryKey:        ['collections-all'],
    queryFn:         () => fetch(`${API}/api/v1/collections?sort=volume_24h&limit=100`).then(r => r.json()),
    refetchInterval: 30_000,
    staleTime:       30_000,
  })

  return (
    <div className="space-y-5 max-w-[1200px]">
      <div>
        <h1 className="text-xl font-bold text-white">Collections</h1>
        <p className="text-sm text-[var(--text-muted)]">NFT collections on Abstract Chain</p>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] text-[var(--text-muted)] text-xs uppercase tracking-wider">
              <th className="px-4 py-3 text-left w-8">#</th>
              <th className="px-4 py-3 text-left">Collection</th>
              <th className="px-4 py-3 text-right">Floor</th>
              <th className="px-4 py-3 text-right">Vol 24h</th>
              <th className="px-4 py-3 text-right">Sales 24h</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && Array.from({ length: 10 }).map((_, i) => (
              <tr key={i} className="border-b border-[var(--border)] animate-pulse">
                <td className="px-4 py-3"><div className="h-3 w-4 rounded bg-white/5" /></td>
                <td className="px-4 py-3"><div className="h-3 w-40 rounded bg-white/5" /></td>
                <td className="px-4 py-3"><div className="h-3 w-16 rounded bg-white/5 ml-auto" /></td>
                <td className="px-4 py-3"><div className="h-3 w-16 rounded bg-white/5 ml-auto" /></td>
                <td className="px-4 py-3"><div className="h-3 w-8 rounded bg-white/5 ml-auto" /></td>
              </tr>
            ))}
            {!isLoading && collections.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-[var(--text-muted)]">
                  No collections indexed yet — indexer is syncing
                </td>
              </tr>
            )}
            {collections.map((c, i) => (
              <tr key={c.address} className="border-b border-[var(--border)] hover:bg-white/3 transition-colors">
                <td className="px-4 py-3 text-[var(--text-muted)]">{i + 1}</td>
                <td className="px-4 py-3">
                  <Link href={`/collections/${c.address}`} className="text-white hover:text-blue-400 transition-colors font-medium">
                    {c.name || c.address.slice(0, 10) + '…'}
                  </Link>
                  <div className="text-xs text-[var(--text-muted)] font-mono mt-0.5">{c.address.slice(0, 8)}…</div>
                </td>
                <td className="px-4 py-3 text-right text-[var(--text-muted)]">
                  {c.floorEth ? `${c.floorEth.toFixed(3)} Ξ` : '—'}
                </td>
                <td className="px-4 py-3 text-right font-medium text-white">
                  {c.volume24hUsd ? `$${c.volume24hUsd.toLocaleString('en', { maximumFractionDigits: 0 })}` : '0'}
                </td>
                <td className="px-4 py-3 text-right text-[var(--text-muted)]">{c.sales24h ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
