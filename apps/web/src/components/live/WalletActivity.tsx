'use client'

import { useWalletActivity } from '../../lib/hooks/useRealtime'
import { useCollectionNames } from '../../lib/hooks/useCollectionNames'
import type { WalletActivityData } from '../../lib/types'

const ACTION_STYLES: Record<string, { color: string; label: string }> = {
  buy:      { color: 'text-green-400',  label: 'Bought' },
  sell:     { color: 'text-red-400',    label: 'Sold'   },
  transfer: { color: 'text-blue-400',   label: 'Sent'   },
  mint:     { color: 'text-purple-400', label: 'Minted' },
}

interface Props {
  address:   string
  maxItems?: number
}

export function WalletActivity({ address, maxItems = 20 }: Props) {
  const events = useWalletActivity(address, maxItems)

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/10">
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
        </span>
        <span className="text-sm font-medium text-white">Live Activity</span>
      </div>

      <div className="flex-1 overflow-y-auto divide-y divide-white/5">
        {events.length === 0 ? (
          <div className="flex items-center justify-center h-24 text-white/30 text-sm">
            No recent activity
          </div>
        ) : (
          events.map((event, i) => (
            <ActivityRow key={`${event.timestamp}-${i}`} event={event} isNew={i === 0} />
          ))
        )}
      </div>
    </div>
  )
}

function ActivityRow({ event, isNew }: { event: WalletActivityData; isNew: boolean }) {
  const style   = ACTION_STYLES[event.action] ?? ACTION_STYLES.transfer
  const timeAgo = formatTime(event.timestamp)
  const { getCollectionName } = useCollectionNames()

  return (
    <div className={`
      px-4 py-3 flex items-center gap-3
      ${isNew ? 'animate-flash bg-blue-500/10' : 'hover:bg-white/5'}
      transition-all duration-300
    `}>
      {/* Action badge */}
      <span className={`text-xs font-medium w-12 shrink-0 ${style.color}`}>
        {style.label}
      </span>

      {/* NFT info */}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-white truncate">
          {getCollectionName(event.collection)}
          <span className="text-white/40 ml-1">#{event.tokenId}</span>
        </p>
        <p className="text-xs text-white/30">{timeAgo}</p>
      </div>

      {/* Valeur */}
      {event.valueEth > 0 && (
        <div className="text-right shrink-0">
          <p className="text-sm text-white">{event.valueEth.toFixed(3)} ETH</p>
          <p className="text-xs text-white/40">${event.valueUsd.toFixed(0)}</p>
        </div>
      )}
    </div>
  )
}

function formatTime(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000)
  if (diff < 60)   return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  return `${Math.floor(diff / 3600)}h ago`
}
