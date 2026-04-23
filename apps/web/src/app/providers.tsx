'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools }               from '@tanstack/react-query-devtools'
import { useEffect, useState }              from 'react'
import { socket }                           from '../lib/socket'

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime:            30_000,
        gcTime:               5 * 60_000,
        refetchOnWindowFocus: false,
        retry:                2,
      },
    },
  }))

  useEffect(() => {
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
