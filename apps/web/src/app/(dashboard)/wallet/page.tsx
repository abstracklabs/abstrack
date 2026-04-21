'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function WalletPage() {
  const [address, setAddress] = useState('')
  const router = useRouter()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const addr = address.trim()
    if (/^0x[0-9a-fA-F]{40}$/.test(addr)) {
      router.push(`/wallet/${addr}`)
    }
  }

  return (
    <div className="max-w-lg mx-auto mt-24 space-y-6">
      <div className="text-center space-y-2">
        <h1 className="text-2xl font-bold text-white">Wallet Tracker</h1>
        <p className="text-sm text-[var(--text-muted)]">
          Enter a wallet address to view its NFT activity on Abstract Chain
        </p>
      </div>

      <form onSubmit={handleSubmit} className="card p-6 space-y-4">
        <div className="space-y-2">
          <label className="text-xs text-[var(--text-muted)] uppercase tracking-wider">
            Wallet Address
          </label>
          <input
            type="text"
            value={address}
            onChange={e => setAddress(e.target.value)}
            placeholder="0x..."
            className="w-full bg-white/5 border border-[var(--border)] rounded-lg px-4 py-3 text-sm text-white placeholder:text-[var(--text-muted)] focus:outline-none focus:border-blue-500/50 font-mono"
          />
        </div>
        <button
          type="submit"
          disabled={!/^0x[0-9a-fA-F]{40}$/.test(address.trim())}
          className="w-full py-2.5 rounded-lg bg-blue-500 text-white text-sm font-medium hover:bg-blue-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Track Wallet
        </button>
      </form>
    </div>
  )
}
