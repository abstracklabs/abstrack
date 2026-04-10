import { Suspense } from 'react'
import { DashboardClient } from './DashboardClient'

export default function DashboardPage() {
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <DashboardClient />
    </Suspense>
  )
}

function DashboardSkeleton() {
  return (
    <div className="space-y-5 max-w-[1600px] animate-pulse">
      {/* Header */}
      <div className="space-y-1.5">
        <div className="h-6 w-32 rounded bg-white/5" />
        <div className="h-3 w-48 rounded bg-white/5" />
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-28 rounded-xl bg-white/5 border border-[var(--border)]" />
        ))}
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px_300px] gap-4">
        <div className="h-[560px] rounded-xl bg-white/5 border border-[var(--border)]" />
        <div className="h-[560px] rounded-xl bg-white/5 border border-[var(--border)]" />
        <div className="h-[560px] rounded-xl bg-white/5 border border-[var(--border)]" />
      </div>
    </div>
  )
}
