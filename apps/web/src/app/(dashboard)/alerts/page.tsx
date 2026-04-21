'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAlertsStore } from '../../../store/alerts'

const API = process.env.NEXT_PUBLIC_API_URL

// ─── Types ────────────────────────────────────────────────────────────────────

type AlertType = 'whale_buy' | 'volume_explosion' | 'trending_mint'
type Channel   = 'web' | 'discord' | 'email'

interface AlertCondition {
  field:    string
  operator: '>=' | '>' | '<=' | '<'
  value:    number
}

interface UserAlert {
  id:          string
  name:        string
  type:        AlertType
  collection?: string
  conditions:  AlertCondition[]
  channels:    Channel[]
  webhook_url?: string
  active:      boolean
  last_triggered?: string
}

// ─── Config des types d'alertes ───────────────────────────────────────────────

const ALERT_TEMPLATES: Record<AlertType, {
  label:       string
  icon:        string
  description: string
  color:       string
  defaultConditions: AlertCondition[]
  conditionFields: Array<{ value: string; label: string; unit: string }>
}> = {
  whale_buy: {
    label:       'Whale Purchase',
    icon:        '🐋',
    description: 'A whale wallet makes a large NFT purchase',
    color:       'orange',
    defaultConditions: [{ field: 'price_eth', operator: '>=', value: 5 }],
    conditionFields: [
      { value: 'price_eth', label: 'Purchase price', unit: 'ETH' },
    ],
  },
  volume_explosion: {
    label:       'Volume Explosion',
    icon:        '⚡',
    description: 'Collection volume spikes vs 7-day average',
    color:       'blue',
    defaultConditions: [{ field: 'volume_ratio_1h', operator: '>=', value: 3 }],
    conditionFields: [
      { value: 'volume_ratio_1h', label: 'Volume multiplier', unit: '×' },
      { value: 'volume_1h_eth',   label: 'Min 1h volume',    unit: 'ETH' },
    ],
  },
  trending_mint: {
    label:       'Trending Mint',
    icon:        '🔥',
    description: 'A new collection is minting rapidly with many unique buyers',
    color:       'green',
    defaultConditions: [{ field: 'trending_score', operator: '>=', value: 2 }],
    conditionFields: [
      { value: 'trending_score', label: 'Trending score',  unit: 'pts' },
    ],
  },
}

const COLOR_CLASSES = {
  orange: { badge: 'bg-orange-500/15 text-orange-400 border-orange-500/30', dot: 'bg-orange-400', border: 'border-orange-500/20' },
  blue:   { badge: 'bg-blue-500/15 text-blue-400 border-blue-500/30',   dot: 'bg-blue-400',   border: 'border-blue-500/20' },
  green:  { badge: 'bg-green-500/15 text-green-400 border-green-500/30', dot: 'bg-green-400',  border: 'border-green-500/20' },
}

// ─── Page principale ──────────────────────────────────────────────────────────

export default function AlertsPage() {
  const [creating, setCreating] = useState(false)
  const unreadCount = useAlertsStore(s => s.unreadCount)
  const markAllRead = useAlertsStore(s => s.markAllRead)
  const recentTriggers = useAlertsStore(s => s.triggers)

  const qc = useQueryClient()
  const { data: alerts = [], isLoading } = useQuery<UserAlert[]>({
    queryKey: ['alerts'],
    queryFn:  () => fetch(`${API}/api/v1/alerts`, { credentials: 'include' }).then(r => r.json()),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      fetch(`${API}/api/v1/alerts/${id}`, { method: 'DELETE', credentials: 'include' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts'] }),
  })

  const toggleMutation = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      fetch(`${API}/api/v1/alerts/${id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ active }),
        credentials: 'include',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts'] }),
  })

  return (
    <div className="space-y-6 max-w-4xl">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Alerts</h1>
          <p className="text-sm text-[var(--text-muted)]">
            Real-time notifications — web, Discord, email
          </p>
        </div>
        <div className="flex items-center gap-3">
          {unreadCount > 0 && (
            <button
              onClick={markAllRead}
              className="text-xs text-[var(--text-muted)] hover:text-white transition"
            >
              Mark all read ({unreadCount})
            </button>
          )}
          <button
            onClick={() => setCreating(true)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg font-medium transition"
          >
            + New alert
          </button>
        </div>
      </div>

      {/* Recent triggers */}
      {recentTriggers.length > 0 && (
        <div className="glass rounded-xl border border-[var(--border)] p-4">
          <p className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">
            Recent triggers
          </p>
          <div className="space-y-2">
            {recentTriggers.slice(0, 5).map((t) => (
              <TriggerRow key={t.alertId + t.triggeredAt} trigger={t} />
            ))}
          </div>
        </div>
      )}

      {/* Alert list */}
      {isLoading ? (
        <AlertsSkeleton />
      ) : alerts.length === 0 && !creating ? (
        <EmptyState onCreate={() => setCreating(true)} />
      ) : (
        <div className="space-y-3">
          {alerts.map(alert => (
            <AlertCard
              key={alert.id}
              alert={alert}
              onDelete={() => deleteMutation.mutate(alert.id)}
              onToggle={(active) => toggleMutation.mutate({ id: alert.id, active })}
            />
          ))}
        </div>
      )}

      {/* Create modal */}
      {creating && (
        <CreateAlertModal
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            qc.invalidateQueries({ queryKey: ['alerts'] })
          }}
        />
      )}
    </div>
  )
}

// ─── AlertCard ────────────────────────────────────────────────────────────────

function AlertCard({
  alert,
  onDelete,
  onToggle,
}: {
  alert:    UserAlert
  onDelete: () => void
  onToggle: (active: boolean) => void
}) {
  const tmpl   = ALERT_TEMPLATES[alert.type]
  const colors = COLOR_CLASSES[tmpl.color as keyof typeof COLOR_CLASSES]

  return (
    <div className={`glass rounded-xl border ${alert.active ? colors.border : 'border-[var(--border)]'} p-4`}>
      <div className="flex items-start gap-4">

        {/* Icon */}
        <div className={`
          shrink-0 h-10 w-10 rounded-xl border ${colors.badge}
          flex items-center justify-center text-lg
        `}>
          {tmpl.icon}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-white font-medium text-sm">{alert.name}</span>
            <span className={`text-[10px] px-2 py-0.5 rounded-full border ${colors.badge}`}>
              {tmpl.label}
            </span>
            {!alert.active && (
              <span className="text-[10px] px-2 py-0.5 rounded-full border border-[var(--border)] text-[var(--text-muted)]">
                Paused
              </span>
            )}
          </div>

          {/* Conditions */}
          <div className="flex flex-wrap gap-2 mb-2">
            {alert.conditions.map((c, i) => (
              <span key={i} className="text-xs font-mono text-[var(--text-muted)] glass rounded px-2 py-0.5">
                {c.field} {c.operator} {c.value}
              </span>
            ))}
            {alert.collection && (
              <span className="text-xs font-mono text-[var(--text-muted)] glass rounded px-2 py-0.5">
                {alert.collection.slice(0, 10)}…
              </span>
            )}
          </div>

          {/* Channels + last triggered */}
          <div className="flex items-center gap-3">
            <div className="flex gap-1.5">
              {alert.channels.map(ch => (
                <ChannelBadge key={ch} channel={ch} />
              ))}
            </div>
            {alert.last_triggered && (
              <span className="text-[11px] text-[var(--text-muted)]">
                Last: {new Date(alert.last_triggered).toLocaleString()}
              </span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => onToggle(!alert.active)}
            className={`
              relative h-5 w-9 rounded-full transition-colors
              ${alert.active ? 'bg-blue-600' : 'bg-[var(--border)]'}
            `}
          >
            <span className={`
              absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform
              ${alert.active ? 'translate-x-4' : 'translate-x-0.5'}
            `} />
          </button>
          <button
            onClick={onDelete}
            className="text-[var(--text-muted)] hover:text-red-400 text-sm transition"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── CreateAlertModal ─────────────────────────────────────────────────────────

function CreateAlertModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [step, setStep]           = useState<'type' | 'config'>('type')
  const [alertType, setAlertType] = useState<AlertType | null>(null)
  const [name, setName]           = useState('')
  const [collection, setCollection] = useState('')
  const [conditions, setConditions] = useState<AlertCondition[]>([])
  const [channels, setChannels]   = useState<Channel[]>(['web'])
  const [webhookUrl, setWebhookUrl] = useState('')
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState('')

  const selectType = (type: AlertType) => {
    setAlertType(type)
    setName(ALERT_TEMPLATES[type].label)
    setConditions(ALERT_TEMPLATES[type].defaultConditions.map(c => ({ ...c })))
    setStep('config')
  }

  const toggleChannel = (ch: Channel) => {
    setChannels(prev =>
      prev.includes(ch) ? prev.filter(c => c !== ch) : [...prev, ch]
    )
  }

  const submit = async () => {
    if (!alertType || !name || conditions.length === 0) return
    setLoading(true)
    setError('')

    try {
      const res = await fetch(`${API}/api/v1/alerts`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name,
          type:        alertType,
          collection:  collection || undefined,
          conditions,
          channels,
          webhook_url: webhookUrl || undefined,
        }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Unknown error')
      onCreated()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="glass-elevated rounded-2xl border border-[var(--border)] w-full max-w-lg mx-4 shadow-2xl">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
          <h2 className="text-white font-semibold">
            {step === 'type' ? 'Choose alert type' : 'Configure alert'}
          </h2>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-white text-lg transition">✕</button>
        </div>

        <div className="p-6 space-y-5">

          {/* Step 1 — Type selection */}
          {step === 'type' && (
            <div className="space-y-3">
              {(Object.entries(ALERT_TEMPLATES) as [AlertType, typeof ALERT_TEMPLATES[AlertType]][]).map(([type, tmpl]) => {
                const colors = COLOR_CLASSES[tmpl.color as keyof typeof COLOR_CLASSES]
                return (
                  <button
                    key={type}
                    onClick={() => selectType(type)}
                    className={`w-full text-left p-4 glass rounded-xl border ${colors.border} hover:bg-white/5 transition`}
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">{tmpl.icon}</span>
                      <div>
                        <p className="text-white font-medium text-sm">{tmpl.label}</p>
                        <p className="text-[var(--text-muted)] text-xs mt-0.5">{tmpl.description}</p>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          )}

          {/* Step 2 — Config */}
          {step === 'config' && alertType && (
            <>
              <div>
                <label className="block text-xs text-[var(--text-muted)] mb-1.5">Alert name</label>
                <input
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="My alert"
                  className="w-full glass rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-white bg-transparent focus:border-blue-500/50 outline-none"
                />
              </div>

              {alertType !== 'trending_mint' && (
                <div>
                  <label className="block text-xs text-[var(--text-muted)] mb-1.5">
                    Collection address <span className="opacity-50">(optional — leave empty for all)</span>
                  </label>
                  <input
                    value={collection}
                    onChange={e => setCollection(e.target.value)}
                    placeholder="0x..."
                    className="w-full glass rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-mono text-white bg-transparent focus:border-blue-500/50 outline-none"
                  />
                </div>
              )}

              <div>
                <label className="block text-xs text-[var(--text-muted)] mb-1.5">Trigger condition</label>
                <div className="space-y-2">
                  {conditions.map((cond, i) => (
                    <ConditionEditor
                      key={i}
                      condition={cond}
                      fields={ALERT_TEMPLATES[alertType].conditionFields}
                      onChange={updated => setConditions(prev =>
                        prev.map((c, idx) => idx === i ? updated : c)
                      )}
                    />
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs text-[var(--text-muted)] mb-2">Channels</label>
                <div className="flex gap-2">
                  {(['web', 'discord', 'email'] as Channel[]).map(ch => (
                    <button
                      key={ch}
                      onClick={() => toggleChannel(ch)}
                      className={`
                        px-3 py-1.5 text-xs rounded-lg border transition-all capitalize
                        ${channels.includes(ch)
                          ? 'bg-blue-600/25 border-blue-500/40 text-blue-300'
                          : 'glass border-[var(--border)] text-[var(--text-muted)] hover:text-white'
                        }
                      `}
                    >
                      <span className="mr-1">{ch === 'web' ? '🌐' : ch === 'discord' ? '💬' : '📧'}</span>
                      {ch}
                    </button>
                  ))}
                </div>
              </div>

              {channels.includes('discord') && (
                <div>
                  <label className="block text-xs text-[var(--text-muted)] mb-1.5">Discord webhook URL</label>
                  <input
                    value={webhookUrl}
                    onChange={e => setWebhookUrl(e.target.value)}
                    placeholder="https://discord.com/api/webhooks/..."
                    className="w-full glass rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-white bg-transparent focus:border-blue-500/50 outline-none"
                  />
                </div>
              )}

              {error && (
                <p className="text-red-400 text-xs">{error}</p>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => setStep('type')}
                  className="flex-1 py-2 glass rounded-lg border border-[var(--border)] text-sm text-[var(--text-muted)] hover:text-white transition"
                >
                  ← Back
                </button>
                <button
                  onClick={submit}
                  disabled={loading || !name}
                  className="flex-1 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm rounded-lg font-medium transition"
                >
                  {loading ? 'Creating…' : 'Create alert'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── ConditionEditor ──────────────────────────────────────────────────────────

function ConditionEditor({
  condition,
  fields,
  onChange,
}: {
  condition: AlertCondition
  fields:    Array<{ value: string; label: string; unit: string }>
  onChange:  (c: AlertCondition) => void
}) {
  const currentField = fields.find(f => f.value === condition.field) ?? fields[0]

  return (
    <div className="flex items-center gap-2">
      <select
        value={condition.field}
        onChange={e => onChange({ ...condition, field: e.target.value })}
        className="flex-1 glass rounded-lg border border-[var(--border)] px-2 py-2 text-xs text-white bg-[var(--bg-base)] outline-none"
      >
        {fields.map(f => (
          <option key={f.value} value={f.value}>{f.label}</option>
        ))}
      </select>
      <select
        value={condition.operator}
        onChange={e => onChange({ ...condition, operator: e.target.value as any })}
        className="glass rounded-lg border border-[var(--border)] px-2 py-2 text-xs text-white bg-[var(--bg-base)] outline-none"
      >
        {['>=', '>', '<=', '<'].map(op => (
          <option key={op} value={op}>{op}</option>
        ))}
      </select>
      <div className="relative">
        <input
          type="number"
          value={condition.value}
          onChange={e => onChange({ ...condition, value: Number(e.target.value) })}
          step="0.1"
          className="w-24 glass rounded-lg border border-[var(--border)] px-2 py-2 pr-8 text-xs text-white bg-transparent outline-none text-right"
        />
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-[var(--text-muted)]">
          {currentField.unit}
        </span>
      </div>
    </div>
  )
}

// ─── Helpers UI ───────────────────────────────────────────────────────────────

function ChannelBadge({ channel }: { channel: Channel }) {
  const icons: Record<Channel, string> = { web: '🌐', discord: '💬', email: '📧' }
  return (
    <span className="text-[10px] px-1.5 py-0.5 glass rounded border border-[var(--border)] text-[var(--text-muted)]">
      {icons[channel]} {channel}
    </span>
  )
}

function TriggerRow({ trigger }: { trigger: any }) {
  const event = trigger.event ?? {}
  const icon  = event.type === 'whale_buy' ? '🐋' : event.type === 'volume_explosion' ? '⚡' : '🔥'
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="text-base">{icon}</span>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-white truncate">
          {event.type === 'whale_buy'
            ? `${event.buyer?.slice(0, 8)}… bought ${event.price_eth?.toFixed(2)} ETH`
            : event.type === 'volume_explosion'
            ? `Volume ×${event.ratio?.toFixed(1)} on ${event.collection?.slice(0, 10)}…`
            : `Trending mint — score ${event.trending_score?.toFixed(1)}`
          }
        </p>
      </div>
      <span className="text-[10px] text-[var(--text-muted)] shrink-0">
        {new Date(trigger.triggeredAt).toLocaleTimeString()}
      </span>
      {!trigger.read && (
        <span className="h-1.5 w-1.5 rounded-full bg-blue-400 shrink-0" />
      )}
    </div>
  )
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="glass rounded-xl border border-[var(--border)] p-12 text-center">
      <p className="text-4xl mb-4">🔔</p>
      <p className="text-white font-medium mb-2">No alerts yet</p>
      <p className="text-sm text-[var(--text-muted)] mb-6">
        Get notified instantly when whales buy, volume spikes, or new mints trend.
      </p>
      <button
        onClick={onCreate}
        className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg font-medium transition"
      >
        Create your first alert
      </button>
    </div>
  )
}

function AlertsSkeleton() {
  return (
    <div className="space-y-3">
      {[1, 2, 3].map(i => (
        <div key={i} className="glass rounded-xl border border-[var(--border)] p-4">
          <div className="flex gap-4">
            <div className="h-10 w-10 rounded-xl bg-white/5 animate-pulse" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-40 bg-white/5 rounded animate-pulse" />
              <div className="h-3 w-64 bg-white/5 rounded animate-pulse" />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
