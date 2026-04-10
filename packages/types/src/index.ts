// ─── NFT ─────────────────────────────────────────────────────────────────────

export interface Collection {
  address: string
  name: string
  symbol: string
  totalSupply: number
  verified: boolean
  thumbnailUrl?: string
  description?: string
  website?: string
  twitter?: string
  discord?: string
  createdAt: string
  indexedAt: string
}

export interface CollectionStats {
  collection: string
  floorEth: number
  floorUsd: number
  volume24hUsd: number
  volume7dUsd: number
  sales24h: number
  uniqueBuyers24h: number
  holderCount: number
  listingCount: number
  change24hPct: number
}

export interface NFTSale {
  txHash: string
  blockNumber: number
  timestamp: number
  collection: string
  tokenId: number
  priceEth: number
  priceUsd: number
  buyer: string
  seller: string
  marketplace: Marketplace
}

export type Marketplace = 'abstract_market' | 'blur' | 'opensea' | 'unknown'

// ─── Wallet ──────────────────────────────────────────────────────────────────

export interface Wallet {
  address: string
  labels: WalletLabel[]
  ensName?: string
  firstSeen: string
  lastActive: string
  totalVolumeUsd: number
}

export type WalletLabel = 'whale' | 'smart_money' | 'exchange' | 'bot' | 'dev'

export interface WalletPnL {
  wallet: string
  collection: string
  tokensBought: number
  tokensSold: number
  spentEth: number
  earnedEth: number
  realizedPnl: number
  unrealizedPnl: number
  updatedAt: string
}

export interface WalletActivity {
  timestamp: number
  action: 'buy' | 'sell' | 'transfer' | 'mint'
  collection: string
  tokenId: number
  valueEth: number
  valueUsd: number
  counterparty: string
}

// ─── Token ───────────────────────────────────────────────────────────────────

export interface Token {
  address: string
  name: string
  symbol: string
  decimals: number
  totalSupply: string
  priceUsd: number
  marketCapUsd: number
  volume24hUsd: number
  change24hPct: number
}

export interface OHLC {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

// ─── Alerts ──────────────────────────────────────────────────────────────────

export type AlertCondition =
  | { type: 'FLOOR_BELOW';    collection: string; threshold: number }
  | { type: 'FLOOR_ABOVE';    collection: string; threshold: number }
  | { type: 'WHALE_BUY';      collection: string; minUsd: number }
  | { type: 'WALLET_ACTIVE';  address: string }
  | { type: 'VOLUME_SPIKE';   collection: string; multiplier: number }
  | { type: 'NEW_LISTING';    collection: string; maxPriceEth: number }

export interface Alert {
  id: string
  userId: string
  name: string
  condition: AlertCondition
  channels: AlertChannel[]
  active: boolean
  cooldownSeconds: number
  createdAt: string
}

export type AlertChannel = 'email' | 'telegram' | 'webhook' | 'in_app'

export interface AlertTrigger {
  alertId: string
  triggeredAt: number
  event: Record<string, unknown>
}

// ─── WebSocket Messages ───────────────────────────────────────────────────────

export type WSClientMessage =
  | { action: 'sub';   room: string }
  | { action: 'unsub'; room: string }
  | { action: 'ping' }

export type WSServerMessage =
  | { type: 'sale';          data: NFTSale }
  | { type: 'floor_update';  collection: string; floorEth: number; changePct: number }
  | { type: 'whale_alert';   wallet: string; collection: string; amountUsd: number }
  | { type: 'alert_trigger'; alertId: string; event: AlertTrigger }
  | { type: 'pong' }
  | { type: 'error';         message: string }

// ─── Kafka Events ────────────────────────────────────────────────────────────

export interface KafkaNFTSale extends NFTSale {
  _topic: 'abstrack.nft.sales'
  _partition: number
  _offset: string
}

export interface KafkaWalletActivity extends WalletActivity {
  wallet: string
  _topic: 'abstrack.wallets'
}
