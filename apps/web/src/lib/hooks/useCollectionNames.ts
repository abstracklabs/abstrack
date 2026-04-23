/**
 * Hook centralisé pour résoudre les noms de collections à partir de leur adresse.
 *
 * Fetch la liste complète des collections une seule fois (cache 5 min),
 * retourne une fonction getCollectionName(addr) utilisable partout dans l'UI.
 */

import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../api'
import type { CollectionRow } from '../types'

const API = process.env.NEXT_PUBLIC_API_URL

function shortAddr(addr: string): string {
  if (!addr || addr.length < 10) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

export function useCollectionNames() {
  const { data } = useQuery<CollectionRow[]>({
    queryKey:  ['collection-names-map'],
    queryFn:   () => apiFetch<CollectionRow[]>(`${API}/api/v1/collections?limit=200`),
    staleTime: 5 * 60_000,   // 5 min — les noms changent rarement
    gcTime:    30 * 60_000,
  })

  const nameMap = new Map<string, string>()
  if (data) {
    for (const c of data) {
      if (c.address && c.name) {
        nameMap.set(c.address.toLowerCase(), c.name)
      }
    }
  }

  /** Retourne le nom de la collection, ou l'adresse courte en fallback. */
  function getCollectionName(addr: string | null | undefined): string {
    if (!addr) return '—'
    const name = nameMap.get(addr.toLowerCase())
    return name || shortAddr(addr)
  }

  return { getCollectionName, nameMap }
}
