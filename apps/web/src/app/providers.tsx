'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools }               from '@tanstack/react-query-devtools'
import { useEffect, useState }              from 'react'
import { socket }                           from '../lib/socket'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime:    30_000,     // données fraîches 30s
      gcTime:       5 * 60_000, // cache 5min
      refetchOnWindowFocus: false,
      retry: 2,
    },
  },
})

export function Providers({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    // Connexion WebSocket globale dès le boot
    socket.connect()
    return () => socket.disconnect()
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {process.env.NODE_ENV === 'development' && (
        <ReactQueryDevtools initialIsOpen={false} />
      )}
    </QueryClientProvider>
  )
}
