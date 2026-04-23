/**
 * Hooks de fetch des données pour les graphes.
 * Transforme les données API en format D3.
 */

import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../../lib/api'
import type { GraphNode, GraphLink, FlowNode, FlowLink, ClusterNode } from '../types'

const API = process.env.NEXT_PUBLIC_API_URL

// ─── Transaction Graph (wallet-centric) ──────────────────────────────────────

export function useTransactionGraph(address: string, depth = 2) {
  return useQuery({
    queryKey: ['graph', 'transactions', address, depth],
    queryFn:  async () => {
      const raw = await apiFetch(`${API}/api/v1/wallets/${address}/graph?depth=${depth}&limit=200`)
      return transformToGraph(raw)
    },
    staleTime:      60_000,
    placeholderData: { nodes: [], links: [] },
  })
}

function transformToGraph(raw: any): { nodes: GraphNode[]; links: GraphLink[] } {
  const nodesMap = new Map<string, GraphNode>()
  const links: GraphLink[] = []

  for (const tx of (Array.isArray(raw?.transactions) ? raw.transactions : [])) {
    // Ajouter / mettre à jour les nœuds
    for (const addr of [tx.from, tx.to]) {
      if (!nodesMap.has(addr)) {
        nodesMap.set(addr, {
          id:    addr,
          label: addr.slice(0, 8) + '...',
          type:  tx.labels?.[addr]?.[0] ?? 'regular',
          value: 0,
        })
      }
      nodesMap.get(addr)!.value += tx.value_eth ?? 0
    }

    links.push({
      source: tx.from,
      target: tx.to,
      value:  tx.value_eth,
      count:  tx.count ?? 1,
    })
  }

  return { nodes: Array.from(nodesMap.values()), links }
}

// ─── Money Flow (Sankey) ──────────────────────────────────────────────────────

export function useMoneyFlow(collection: string, period = '7d') {
  return useQuery({
    queryKey: ['graph', 'flow', collection, period],
    queryFn:  async () => {
      const raw = await apiFetch(`${API}/api/v1/collections/${collection}/flow?period=${period}`)
      return transformToSankey(raw)
    },
    staleTime: 120_000,
    placeholderData: { nodes: [], links: [] },
  })
}

function transformToSankey(raw: any): { nodes: FlowNode[]; links: FlowLink[] } {
  const nodes: FlowNode[] = Array.isArray(raw?.nodes) ? raw.nodes : []
  const links: FlowLink[] = (Array.isArray(raw?.links) ? raw.links : []).map((l: any) => ({
    source: typeof l.source === 'number' ? l.source : nodes.findIndex(n => n.id === l.source),
    target: typeof l.target === 'number' ? l.target : nodes.findIndex(n => n.id === l.target),
    value:  l.value_eth,
  }))
  return { nodes, links }
}

// ─── Wallet Clusters ──────────────────────────────────────────────────────────

export function useWalletClusters(collection?: string) {
  return useQuery({
    queryKey: ['graph', 'clusters', collection],
    queryFn:  async () => {
      const url = collection
        ? `${API}/api/v1/collections/${collection}/holders/clusters`
        : `${API}/api/v1/wallets/clusters?limit=300`
      const raw = await apiFetch(url)
      return transformToClusters(raw)
    },
    staleTime: 300_000,
    placeholderData: [],
  })
}

function transformToClusters(raw: any): ClusterNode[] {
  return (Array.isArray(raw?.wallets) ? raw.wallets : []).map((w: any) => ({
    id:       w.address,
    label:    w.ens_name ?? w.address.slice(0, 8) + '...',
    type:     w.labels?.[0] ?? 'regular',
    value:    w.volume_30d_eth ?? 0,
    score:    w.smart_money_score ?? 0,
    cluster:  w.cluster ?? 0,
    pnl_eth:  w.pnl_eth ?? 0,
    win_rate: w.win_rate ?? 0,
  }))
}
