import { useEffect } from 'react'
import { useQuery }  from '@tanstack/react-query'
import { useCollectionStore } from '../../store/collections'
import { socket } from '../socket'
import type { CollectionStats, NFTSale } from '../types'

const API = process.env.NEXT_PUBLIC_API_URL

export function useCollectionStats(address: string) {
  const setStats = useCollectionStore(s => s.setStats)

  const query = useQuery<CollectionStats>({
    queryKey: ['collection', address, 'stats'],
    queryFn:  () => fetch(`${API}/api/v1/collections/${address}`).then(r => r.json()),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

  // Patch live via WebSocket
  useEffect(() => {
    const unsub = socket.subscribe(`collection:${address}`, (msg) => {
      if (msg.type === 'floor_update') {
        setStats(address, { floorEth: msg.floorEth })
      }
    })
    return unsub
  }, [address, setStats])

  return query
}

export function useFloorHistory(address: string, period = '7d') {
  return useQuery({
    queryKey: ['collection', address, 'floor', period],
    queryFn:  () =>
      fetch(`${API}/api/v1/collections/${address}/floor?period=${period}`)
        .then(r => r.json()),
    staleTime: 60_000,
  })
}

export function useLiveSales(address?: string) {
  const addSale = useCollectionStore(s => s.addSale)

  useEffect(() => {
    const room = address ? `collection:${address}` : 'global'
    const unsub = socket.subscribe(room, (msg) => {
      if (msg.type === 'sale') addSale(msg.data)
    })
    return unsub
  }, [address, addSale])

  return useCollectionStore(s =>
    address
      ? s.sales.filter(sale => sale.collection === address)
      : s.sales
  )
}
