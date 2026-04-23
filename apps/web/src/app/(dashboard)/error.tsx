'use client'

import { useEffect } from 'react'

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[dashboard error]', error)
  }, [error])

  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[400px] gap-6 text-center px-6">
      <div className="text-4xl">⚠️</div>
      <div>
        <h2 className="text-lg font-semibold text-white mb-1">Something went wrong</h2>
        <p className="text-sm text-[var(--text-muted)] max-w-sm">
          {error.message || 'An unexpected error occurred while loading this page.'}
        </p>
      </div>
      <button
        onClick={reset}
        className="px-4 py-2 text-sm rounded-lg bg-blue-600/20 border border-blue-500/30 text-blue-400 hover:bg-blue-600/30 transition"
      >
        Try again
      </button>
    </div>
  )
}
