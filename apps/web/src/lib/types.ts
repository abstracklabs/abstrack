// Types partagés frontend (mirror de @abstrack/types)

export interface SaleData {
  txHash:      string
  collection:  string
  tokenId:     number
  priceEth:    number
  priceUsd:    number
  buyer:       string
  seller:      string
  marketplace: string
  timestamp:   number
}

export interface WalletActivityData {
  wallet:      string
  action:      'buy' | 'sell' | 'transfer' | 'mint'
  collection:  string
  tokenId:     number
  valueEth:    number
  valueUsd:    number
  timestamp:   number
}

export interface CollectionStats {
  collection:       string
  floorEth:         number
  floorUsd:         number
  volume24hUsd:     number
  volume7dUsd:      number
  sales24h:         number
  uniqueBuyers24h:  number
  holderCount:      number
  listingCount:     number
  change24hPct:     number
}

export type NFTSale = SaleData

// ─── Données REST API ──────────────────────────────────────────────────────

export interface CollectionRow {
  address:         string
  name:            string
  symbol:          string | null
  floor_price_eth: number
  volume_24h_eth:  number
  sales_count_24h: number
  change_24h_pct:  number | null
  thumbnail_url:   string | null
}

export interface GlobalStats {
  collections_active: number
  sales_24h:          number
  volume_24h_eth:     number
  avg_price_eth:      number
}

export interface MarketOverview {
  computed_at:              string
  // 24h
  sales_24h:                number
  volume_24h_eth:           number
  avg_price_24h_eth:        number
  collections_active_24h:   number
  unique_buyers_24h:        number
  unique_sellers_24h:       number
  // 7d
  sales_7d:                 number
  volume_7d_eth:            number
  collections_active_7d:    number
  // growth
  volume_prev_24h_eth:      number
  sales_prev_24h:           number
  // all-time
  total_sales_alltime:      number
  total_volume_alltime_eth: number
  total_collections:        number
  last_indexed_block:       number | null
}

export interface WalletPnl {
  total_spent_eth:    string
  total_received_eth: string
  realized_pnl_eth:   string
  buy_count:          number
  sell_count:         number
  unique_collections: number
  most_traded_coll:   string | null
  avg_buy_price_eth:  string
  avg_sell_price_eth: string
}

// ─── Alpha Feed ────────────────────────────────────────────────────────────

export interface AlphaEvent {
  type:            'whale_buy' | 'whale_sell' | 'volume_spike' | 'unusual_burst'
  score:           number           // 0–100
  ts:              string           // ISO timestamp
  collection:      string           // adresse
  collection_name: string | null
  data:            Record<string, unknown>
}

// ─── WebSocket messages ────────────────────────────────────────────────────

export type WSServerMessage =
  | { type: 'sale';            data: SaleData }
  | { type: 'wallet_activity'; data: WalletActivityData }
  | { type: 'floor_update';    collection: string; floorEth: number; changePct: number }
  | { type: 'whale_alert';     wallet: string; tier: string; collection: string; amountUsd: number }
  | { type: 'alert_trigger';   alertId: string; event: Record<string, unknown> }
  | { type: 'alpha_events';    events: AlphaEvent[]; ts: number }
  | { type: 'batch';           events: WSServerMessage[]; count: number }
  | { type: 'pong';            ts: number }
  | { type: 'ack';             room?: string; action?: string }
  | { type: 'error';           message: string }

export type WSClientMessage =
  | { action: 'sub';   room: string }
  | { action: 'unsub'; room: string }
  | { action: 'auth';  token: string }
  | { action: 'ping' }
