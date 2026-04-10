'use client'

import { create } from 'zustand'
import { immer }  from 'zustand/middleware/immer'
import type { SaleData } from '../lib/types'

interface CollectionPatch {
  floorEth?:  number
  change24h?: number
  volume24h?: number
}

interface CollectionsState {
  stats: Record<string, CollectionPatch>
  sales: SaleData[]
  setStats:  (collection: string, patch: CollectionPatch) => void
  addSale:   (sale: SaleData) => void
}

const MAX_SALES = 200

export const useCollectionStore = create<CollectionsState>()(
  immer((set) => ({
    stats: {},
    sales: [],

    setStats: (collection, patch) => set(state => {
      state.stats[collection] = { ...state.stats[collection], ...patch }
    }),

    addSale: (sale) => set(state => {
      state.sales.unshift(sale)
      if (state.sales.length > MAX_SALES) {
        state.sales.length = MAX_SALES
      }
      // Mise à jour optimiste du floor
      const current = state.stats[sale.collection]?.floorEth ?? Infinity
      if (sale.priceEth < current) {
        if (!state.stats[sale.collection]) state.stats[sale.collection] = {}
        state.stats[sale.collection].floorEth = sale.priceEth
      }
    }),
  }))
)
