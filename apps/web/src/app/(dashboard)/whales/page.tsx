'use client'

import { useWhaleAlerts } from '../../../lib/hooks/useRealtime'

export default function WhalesPage() {
  const alerts = useWhaleAlerts(50)

  return (
    <div className="space-y-5 max-w-[900px]">
      <div>
        <h1 className="text-xl font-bold text-white">Whale Activity</h1>
        <p className="text-sm text-[var(--text-muted)]">Large NFT transactions on Abstract Chain — live</p>
      </div>

      <div className="card divide-y divide-[var(--border)]">
        {alerts.length === 0 && (
          <div className="px-6 py-16 text-center text-[var(--text-muted)]">
            <div className="text-3xl mb-3">🐳</div>
            <p>Watching for whale activity…</p>
            <p className="text-xs mt-1">Transactions above 5 ETH appear here in real-time</p>
          </div>
        )}
        {alerts.map((a, i) => (
          <div key={i} className="px-6 py-4 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="text-xl">{a.tier === 'mega' ? '🐋' : '🐳'}</span>
              <div>
                <div className="text-sm text-white font-medium font-mono">
                  {a.wallet.slice(0, 8)}…{a.wallet.slice(-6)}
                </div>
                <div className="text-xs text-[var(--text-muted)]">{a.collection.slice(0, 8)}…</div>
              </div>
            </div>
            <div className="text-right">
              <div className="text-sm font-bold text-white">
                ${a.amountUsd.toLocaleString('en', { maximumFractionDigits: 0 })}
              </div>
              <div className="text-xs text-[var(--text-muted)]">
                {new Date(a.ts).toLocaleTimeString()}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
