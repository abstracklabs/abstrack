import { ReactNode } from 'react'

interface Props {
  label:     string
  value:     string | number
  change?:   number           // % change, positif ou négatif
  sub?:      string
  icon?:     ReactNode
  accent?:   'blue' | 'green' | 'red' | 'purple' | 'orange'
  loading?:  boolean
}

const ACCENT_STYLES = {
  blue:   'from-blue-500/10 to-transparent border-blue-500/20',
  green:  'from-green-500/10 to-transparent border-green-500/20',
  red:    'from-red-500/10 to-transparent border-red-500/20',
  purple: 'from-purple-500/10 to-transparent border-purple-500/20',
  orange: 'from-orange-500/10 to-transparent border-orange-500/20',
}

export function StatCard({ label, value, change, sub, icon, accent, loading }: Props) {
  const isPositive = change !== undefined && change >= 0
  const accentCls  = accent ? ACCENT_STYLES[accent] : 'border-[var(--border)]'

  return (
    <div className={`
      relative overflow-hidden rounded-xl border bg-gradient-to-br p-4
      card-hover ${accentCls}
    `}>
      {/* Icon */}
      {icon && (
        <div className="absolute top-4 right-4 text-[var(--text-muted)] opacity-60">
          {icon}
        </div>
      )}

      {/* Label */}
      <p className="text-xs text-[var(--text-muted)] uppercase tracking-wider mb-2">
        {label}
      </p>

      {/* Value */}
      {loading ? (
        <div className="h-7 w-28 bg-white/5 rounded animate-pulse mb-1" />
      ) : (
        <p className="text-2xl font-bold text-white font-mono tabular-nums leading-none mb-1">
          {value}
        </p>
      )}

      {/* Change + sub */}
      <div className="flex items-center gap-2">
        {change !== undefined && !loading && (
          <span className={`text-xs font-medium flex items-center gap-0.5 ${isPositive ? 'positive' : 'negative'}`}>
            {isPositive ? '▲' : '▼'} {Math.abs(change).toFixed(2)}%
          </span>
        )}
        {sub && (
          <span className="text-xs text-[var(--text-muted)]">{sub}</span>
        )}
      </div>
    </div>
  )
}
