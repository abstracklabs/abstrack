'use client'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <html>
      <body className="bg-[#0d1117] text-white flex items-center justify-center min-h-screen">
        <div className="text-center space-y-4 px-6">
          <div className="text-4xl">⚠️</div>
          <h1 className="text-xl font-bold">Application error</h1>
          <p className="text-sm text-white/50 max-w-sm">
            {error.message || 'A critical error occurred. Please refresh the page.'}
          </p>
          <button
            onClick={reset}
            className="px-4 py-2 text-sm rounded-lg border border-white/20 text-white/70 hover:text-white hover:border-white/40 transition"
          >
            Refresh
          </button>
        </div>
      </body>
    </html>
  )
}
