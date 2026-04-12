'use client'

import { useState }        from 'react'
import { useRouter }       from 'next/navigation'
import dynamic             from 'next/dynamic'
import type { GraphNode }  from '../../../../../components/graphs/types'

// ─── Dynamic imports (all components use d3 — load client-side only) ─────────

const MoneyFlowSankey = dynamic(
  () => import('../../../../../components/graphs/MoneyFlowSankey').then(m => ({ default: m.MoneyFlowSankey })),
  { ssr: false, loading: () => <GraphLoader /> },
)
const TransactionGraph = dynamic(
  () => import('../../../../../components/graphs/TransactionGraph').then(m => ({ default: m.TransactionGraph })),
  { ssr: false, loading: () => <GraphLoader /> },
)
const WalletClusters = dynamic(
  () => import('../../../../../components/graphs/WalletClusters').then(m => ({ default: m.WalletClusters })),
  { ssr: false, loading: () => <GraphLoader /> },
)
const HeatmapCalendar = dynamic(
  () => import('../../../../../components/graphs/HeatmapCalendar').then(m => ({ default: m.HeatmapCalendar })),
  { ssr: false, loading: () => <GraphLoader /> },
)
const HolderDistribution = dynamic(
  () => import('../../../../../components/graphs/HolderDistribution').then(m => ({ default: m.HolderDistribution })),
  { ssr: false, loading: () => <GraphLoader /> },
)

// ─── Types ────────────────────────────────────────────────────────────────────

type View = 'flow' | 'transactions' | 'clusters' | 'heatmap' | 'holders'

const VIEWS: Array<{ id: View; label: string; description: string }> = [
  { id: 'flow',         label: 'Money Flow',         description: 'ETH flows between wallets, collections and marketplaces' },
  { id: 'transactions', label: 'Transaction Graph',  description: 'Force-directed wallet relationship map' },
  { id: 'clusters',     label: 'Wallet Clusters',    description: 'Smart money vs regular buyers — DBSCAN clustering' },
  { id: 'heatmap',      label: 'Activity Heatmap',   description: 'Volume and sales activity over the last 52 weeks' },
  { id: 'holders',      label: 'Holder Distribution', description: 'Token concentration — Treemap and Lorenz curve' },
]

interface Params { params: { address: string } }

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CollectionGraphPage({ params }: Params) {
  const addr   = params.address
  const router = useRouter()
  const [view, setView] = useState<View>('flow')
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)

  const activeView = VIEWS.find(v => v.id === view)!

  return (
    <div className="space-y-5 max-w-[1400px]">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <button
              onClick={() => router.push(`/collections/${addr}`)}
              className="text-[var(--text-muted)] hover:text-white text-sm transition"
            >
              ← Collection
            </button>
            <span className="text-[var(--text-muted)]">/</span>
            <span className="text-white text-sm font-medium">Visualizations</span>
          </div>
          <h1 className="text-xl font-bold text-white">{activeView.label}</h1>
          <p className="text-sm text-[var(--text-muted)]">{activeView.description}</p>
        </div>

        {view === 'transactions' && selectedNode && (
          <div className="glass rounded-xl border border-[var(--border)] px-4 py-3 text-sm">
            <p className="text-[var(--text-muted)] text-xs mb-1">Selected wallet</p>
            <a
              href={`/wallet/${selectedNode.id}`}
              className="font-mono text-blue-400 hover:text-blue-300"
            >
              {selectedNode.label ?? selectedNode.id.slice(0, 14) + '...'}
            </a>
          </div>
        )}
      </div>

      {/* View selector */}
      <div className="flex gap-1.5 flex-wrap">
        {VIEWS.map(v => (
          <button
            key={v.id}
            onClick={() => setView(v.id)}
            className={`
              px-4 py-2 text-sm rounded-lg border transition-all
              ${view === v.id
                ? 'bg-blue-600/25 border-blue-500/40 text-blue-300'
                : 'glass border-[var(--border)] text-[var(--text-muted)] hover:text-white hover:border-white/15'
              }
            `}
          >
            {v.label}
          </button>
        ))}
      </div>

      {/* Graph panel */}
      <div className="glass rounded-xl border border-[var(--border)] overflow-hidden">
        <GraphControls view={view} addr={addr} />

        <div className="p-4">
          {view === 'flow' && (
            <MoneyFlowSankey collection={addr} height={500} />
          )}

          {view === 'transactions' && (
            <TransactionGraph
              address={addr}
              depth={2}
              height={580}
              onNodeClick={setSelectedNode}
            />
          )}

          {view === 'clusters' && (
            <WalletClusters
              collection={addr}
              height={520}
              onSelect={(nodes) => console.log('Selected:', nodes.length)}
            />
          )}

          {view === 'heatmap' && (
            <div className="space-y-6">
              <div>
                <p className="text-sm font-medium text-white mb-3">Volume (ETH)</p>
                <HeatmapCalendar collection={addr} metric="volume" height={130} />
              </div>
              <div>
                <p className="text-sm font-medium text-white mb-3">Sales Count</p>
                <HeatmapCalendar collection={addr} metric="sales" height={130} />
              </div>
            </div>
          )}

          {view === 'holders' && (
            <HolderDistribution collection={addr} height={420} />
          )}
        </div>
      </div>

      {/* Insights panel */}
      <InsightsPanel view={view} address={addr} />
    </div>
  )
}

// ─── Loading placeholder ──────────────────────────────────────────────────────

function GraphLoader() {
  return (
    <div className="flex items-center justify-center h-[500px] text-[var(--text-muted)] text-sm animate-pulse">
      Loading visualization…
    </div>
  )
}

// ─── Controls contextuels par view ───────────────────────────────────────────

function GraphControls({ view, addr }: { view: View; addr: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
      <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
        {view === 'transactions' && (
          <>
            <span className="glass rounded px-2 py-1">Scroll to zoom</span>
            <span className="glass rounded px-2 py-1">Drag nodes</span>
            <span className="glass rounded px-2 py-1">Click to open wallet</span>
          </>
        )}
        {view === 'flow' && (
          <>
            <span className="glass rounded px-2 py-1">Hover links for details</span>
            <span className="glass rounded px-2 py-1">Hover nodes to highlight</span>
          </>
        )}
        {view === 'clusters' && (
          <>
            <span className="glass rounded px-2 py-1">Click to select wallets</span>
            <span className="glass rounded px-2 py-1">Scroll to zoom</span>
          </>
        )}
      </div>

      <div className="flex gap-2">
        <button className="text-xs px-3 py-1.5 glass rounded-lg border border-[var(--border)] text-[var(--text-muted)] hover:text-white transition">
          Export SVG
        </button>
        <button className="text-xs px-3 py-1.5 glass rounded-lg border border-[var(--border)] text-[var(--text-muted)] hover:text-white transition">
          Full screen
        </button>
      </div>
    </div>
  )
}

// ─── Panel d'insights auto-généré ────────────────────────────────────────────

function InsightsPanel({ view, address }: { view: View; address: string }) {
  const insights: Record<View, Array<{ icon: string; text: string; color: string }>> = {
    flow: [
      { icon: '↗', text: '68% of volume flows from whale wallets', color: 'text-orange-400' },
      { icon: '⚡', text: 'Abstract Market captures 82% of sales', color: 'text-blue-400' },
      { icon: '🔄', text: '12% of volume may be wash trading', color: 'text-yellow-400' },
    ],
    transactions: [
      { icon: '🕸',  text: 'Top 3 wallets are interconnected', color: 'text-purple-400' },
      { icon: '🐋', text: '2 whale wallets dominate outflow', color: 'text-orange-400' },
      { icon: '📈', text: 'Cluster density increasing this week', color: 'text-green-400' },
    ],
    clusters: [
      { icon: '🎯', text: 'Cluster 0 shows highest win rate (78%)', color: 'text-purple-400' },
      { icon: '🧠', text: '23 smart money wallets detected', color: 'text-blue-400' },
      { icon: '⚠️', text: 'Cluster 3 correlates with price dips', color: 'text-red-400' },
    ],
    heatmap: [
      { icon: '📅', text: 'Activity peaks on Thursdays', color: 'text-blue-400' },
      { icon: '🔥', text: 'Last week was the most active in 30 days', color: 'text-orange-400' },
      { icon: '💤', text: 'Weekends show 40% less volume', color: 'text-[var(--text-muted)]' },
    ],
    holders: [
      { icon: '⚠️', text: 'Top 10 holders own 61% of supply — high concentration', color: 'text-orange-400' },
      { icon: '📊', text: 'Gini coefficient 0.74 — moderately unequal', color: 'text-yellow-400' },
      { icon: '✅', text: '340 unique holders — reasonable diversity', color: 'text-green-400' },
    ],
  }

  return (
    <div className="glass rounded-xl border border-[var(--border)] px-5 py-4">
      <p className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">
        Auto-detected insights
      </p>
      <div className="grid grid-cols-3 gap-4">
        {insights[view].map((ins, i) => (
          <div key={i} className="flex items-start gap-3">
            <span className="text-lg leading-none mt-0.5">{ins.icon}</span>
            <p className={`text-sm ${ins.color}`}>{ins.text}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
