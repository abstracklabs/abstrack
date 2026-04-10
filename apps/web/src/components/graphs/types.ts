// ─── Types partagés entre tous les graphes ────────────────────────────────────

export interface GraphNode {
  id:         string        // adresse wallet
  label?:     string        // ENS ou adresse courte
  type:       NodeType
  value:      number        // volume ETH total (rayon du nœud)
  score?:     number        // smart money score [0-100]
  // D3 simulation state (ajouté par D3)
  x?:         number
  y?:         number
  vx?:        number
  vy?:        number
  fx?:        number | null
  fy?:        number | null
}

export type NodeType =
  | 'whale'
  | 'smart_money'
  | 'large_buyer'
  | 'regular'
  | 'contract'
  | 'exchange'

export interface GraphLink {
  source:     string | GraphNode   // id ou référence D3
  target:     string | GraphNode
  value:      number               // ETH transféré
  count:      number               // nb de transactions
  timestamp?: number
}

export interface FlowNode {
  id:       string
  name:     string
  category: 'wallet' | 'collection' | 'marketplace'
  value:    number
}

export interface FlowLink {
  source:   number    // index dans nodes[]
  target:   number
  value:    number    // ETH
}

export interface ClusterNode extends GraphNode {
  cluster:  number     // groupe DBSCAN/k-means
  pnl_eth?: number
  win_rate?: number
}

export const NODE_COLORS: Record<NodeType, string> = {
  whale:       '#f97316',   // orange
  smart_money: '#a855f7',   // purple
  large_buyer: '#3b82f6',   // blue
  regular:     '#6b7280',   // gray
  contract:    '#10b981',   // green
  exchange:    '#eab308',   // yellow
}

export const NODE_RADIUS = {
  min: 6,
  max: 36,
}
