'use client'

/**
 * WalletClusters — Scatter plot 2D des wallets classifiés.
 *
 * Algorithme de projection :
 *   Les wallets ont N dimensions (win_rate, avg_roi, volume, early_entry...).
 *   On projette en 2D avec un t-SNE simplifié ou via coordonnées pré-calculées
 *   par le backend (PCA côté Python).
 *
 * Axes :
 *   X = Win Rate (% de trades profitables)
 *   Y = ROI moyen
 *   Rayon = Volume 30j
 *   Couleur = Cluster (DBSCAN label)
 *
 * Clustering :
 *   Algorithme côté backend : DBSCAN (epsilon=0.3, minPts=5)
 *   → pas de k à choisir, détecte le bruit (cluster=-1)
 *   Frontend : affiche seulement le résultat, colorie par cluster
 *
 * Performance :
 *   Canvas 2D, 500+ points à 60fps
 *   Lasso selection pour multi-sélection
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import * as d3 from 'd3'
import { useWalletClusters }  from './hooks/useGraphData'
import type { ClusterNode }   from './types'

const CLUSTER_PALETTE = [
  '#58a6ff', // 0 — blue
  '#a855f7', // 1 — purple
  '#3fb950', // 2 — green
  '#f97316', // 3 — orange
  '#ec4899', // 4 — pink
  '#eab308', // 5 — yellow
  '#06b6d4', // 6 — cyan
  '#f43f5e', // 7 — rose
]

interface Props {
  collection?: string
  height?:     number
  onSelect?:   (nodes: ClusterNode[]) => void
}

export function WalletClusters({ collection, height = 500, onSelect }: Props) {
  const canvasRef   = useRef<HTMLCanvasElement>(null)
  const wrapRef     = useRef<HTMLDivElement>(null)
  const nodesRef    = useRef<ClusterNode[]>([])
  const transformRef = useRef(d3.zoomIdentity)
  const scalesRef   = useRef<{ x: d3.ScaleLinear<number,number>; y: d3.ScaleLinear<number,number>; r: d3.ScalePower<number,number> } | null>(null)
  const hoveredRef  = useRef<ClusterNode | null>(null)
  const selectedRef = useRef<Set<string>>(new Set())
  const [tooltip, setTooltip]     = useState<{ node: ClusterNode; x: number; y: number } | null>(null)
  const [clusterInfo, setClusterInfo] = useState<Map<number, ClusterSummary>>(new Map())

  const { data: nodes, isLoading } = useWalletClusters(collection)

  // ─── Calcul des scales ──────────────────────────────────────────────────────
  const buildScales = useCallback((nodes: ClusterNode[], W: number, H: number) => {
    const PAD = 48
    const x = d3.scaleLinear()
      .domain([0, 1])              // win_rate [0-100%]
      .range([PAD, W - PAD])

    const y = d3.scaleLinear()
      .domain([-0.5, 3])           // avg_roi [-50% → 300%]
      .range([H - PAD, PAD])

    const rExtent = d3.extent(nodes, n => n.value) as [number, number]
    const r = d3.scaleSqrt()
      .domain([0, rExtent[1] || 1])
      .range([3, 18])
      .clamp(true)

    return { x, y, r }
  }, [])

  // ─── Rendu Canvas ────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !scalesRef.current) return
    const ctx = canvas.getContext('2d')!
    const { k, x: tx, y: ty } = transformRef.current
    const { x: xScale, y: yScale, r: rScale } = scalesRef.current
    const W = canvas.width
    const H = canvas.height

    ctx.save()
    ctx.clearRect(0, 0, W, H)

    // ── Grille de fond ─────────────────────────────────────────────────────
    ctx.strokeStyle = 'rgba(255,255,255,0.04)'
    ctx.lineWidth   = 1
    ;[0, 0.2, 0.4, 0.6, 0.8, 1.0].forEach(v => {
      const sx = tx + xScale(v) * k
      const sy = ty + yScale(v) * k
      ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, H); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(W, sy); ctx.stroke()
    })

    // ── Axes labels ────────────────────────────────────────────────────────
    ctx.font       = '10px JetBrains Mono'
    ctx.fillStyle  = 'rgba(255,255,255,0.25)'
    ctx.textAlign  = 'center'
    ;[0, 25, 50, 75, 100].forEach(v => {
      const sx = tx + xScale(v / 100) * k
      ctx.fillText(`${v}%`, sx, H - 8)
    })
    ctx.textAlign = 'right'
    ;[-50, 0, 50, 100, 200, 300].forEach(v => {
      const sy = ty + yScale(v / 100) * k
      ctx.fillText(`${v}%`, 40, sy + 4)
    })

    // ── Ligne zéro ROI ─────────────────────────────────────────────────────
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'
    ctx.lineWidth   = 1
    ctx.setLineDash([4, 4])
    const zeroY = ty + yScale(0) * k
    ctx.beginPath(); ctx.moveTo(0, zeroY); ctx.lineTo(W, zeroY); ctx.stroke()
    ctx.setLineDash([])

    ctx.translate(tx, ty)
    ctx.scale(k, k)

    // ── Points ─────────────────────────────────────────────────────────────
    for (const node of nodesRef.current) {
      const cx       = xScale(node.win_rate ?? 0)
      const cy       = yScale(node.pnl_eth !== undefined ? node.pnl_eth / Math.max(node.value, 0.001) : 0)
      const radius   = rScale(node.value)
      const color    = node.cluster === -1
        ? 'rgba(255,255,255,0.15)'       // bruit DBSCAN = gris
        : CLUSTER_PALETTE[node.cluster % CLUSTER_PALETTE.length]
      const isHover  = hoveredRef.current?.id === node.id
      const isSel    = selectedRef.current.has(node.id)

      if (isHover || isSel) {
        ctx.shadowColor = color
        ctx.shadowBlur  = isHover ? 20 : 10
      }

      ctx.beginPath()
      ctx.arc(cx, cy, radius, 0, Math.PI * 2)
      ctx.fillStyle   = color
      ctx.globalAlpha = isHover ? 1 : isSel ? 0.95 : 0.7
      ctx.fill()

      if (isSel || isHover) {
        ctx.strokeStyle = '#fff'
        ctx.lineWidth   = 1.5 / k
        ctx.stroke()
      }

      ctx.shadowBlur  = 0
      ctx.globalAlpha = 1
    }

    ctx.restore()
  }, [])

  // ─── Init ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!nodes?.length || !canvasRef.current || !wrapRef.current) return

    const W = wrapRef.current.clientWidth
    const H = height
    canvasRef.current.width  = W
    canvasRef.current.height = H

    nodesRef.current = nodes
    scalesRef.current = buildScales(nodes, W, H)

    // Résumé des clusters
    const summaries = new Map<number, ClusterSummary>()
    for (const n of nodes) {
      if (!summaries.has(n.cluster)) {
        summaries.set(n.cluster, { count: 0, totalPnl: 0, avgScore: 0, scoreSum: 0 })
      }
      const s = summaries.get(n.cluster)!
      s.count++
      s.totalPnl  += n.pnl_eth ?? 0
      s.scoreSum  += n.score   ?? 0
      s.avgScore   = s.scoreSum / s.count
    }
    setClusterInfo(summaries)

    draw()
  }, [nodes, height, buildScales, draw])

  // ─── Zoom ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const zoom = d3.zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.5, 8])
      .on('zoom', ({ transform }) => { transformRef.current = transform; draw() })
    d3.select(canvas).call(zoom)
  }, [draw])

  // ─── Hover ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const findNode = (px: number, py: number) => {
      const { k, x: tx, y: ty } = transformRef.current
      if (!scalesRef.current) return null
      const { x: xScale, y: yScale, r: rScale } = scalesRef.current
      const wx = (px - tx) / k
      const wy = (py - ty) / k

      let found: ClusterNode | null = null
      let minDist = Infinity

      for (const n of nodesRef.current) {
        const cx = xScale(n.win_rate ?? 0)
        const cy = yScale(n.pnl_eth !== undefined ? n.pnl_eth / Math.max(n.value, 0.001) : 0)
        const d  = Math.hypot(cx - wx, cy - wy)
        const r  = rScale(n.value)
        if (d <= r + 2 && d < minDist) { minDist = d; found = n }
      }
      return found
    }

    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      const node = findNode(e.clientX - rect.left, e.clientY - rect.top)
      if (node !== hoveredRef.current) {
        hoveredRef.current = node
        canvas.style.cursor = node ? 'pointer' : 'crosshair'
        setTooltip(node ? { node, x: e.clientX, y: e.clientY } : null)
        draw()
      }
    }

    const onClick = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      const node = findNode(e.clientX - rect.left, e.clientY - rect.top)
      if (node) {
        if (selectedRef.current.has(node.id)) selectedRef.current.delete(node.id)
        else selectedRef.current.add(node.id)
        onSelect?.(nodesRef.current.filter(n => selectedRef.current.has(n.id)))
        draw()
      }
    }

    canvas.addEventListener('mousemove', onMove)
    canvas.addEventListener('click',     onClick)
    return () => {
      canvas.removeEventListener('mousemove', onMove)
      canvas.removeEventListener('click',     onClick)
    }
  }, [draw, onSelect])

  return (
    <div ref={wrapRef} className="relative w-full" style={{ height }}>
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center text-[var(--text-muted)] text-sm">
          Clustering wallets...
        </div>
      )}

      <canvas
        ref={canvasRef}
        className="w-full rounded-xl"
        style={{ background: 'var(--bg-base)', cursor: 'crosshair' }}
      />

      {/* Axis labels */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 text-[10px] text-[var(--text-muted)]">
        Win Rate →
      </div>
      <div className="absolute left-1 top-1/2 -translate-y-1/2 -rotate-90 text-[10px] text-[var(--text-muted)] whitespace-nowrap">
        Avg ROI →
      </div>

      {/* Cluster legend */}
      <div className="absolute top-3 right-3 flex flex-col gap-1.5">
        {Array.from(clusterInfo.entries())
          .filter(([id]) => id !== -1)
          .slice(0, 6)
          .map(([id, summary]) => (
            <div key={id} className="flex items-center gap-2 glass rounded-md px-2 py-1">
              <span className="h-2 w-2 rounded-full shrink-0"
                style={{ background: CLUSTER_PALETTE[id % CLUSTER_PALETTE.length] }} />
              <span className="text-[10px] text-[var(--text-muted)]">
                C{id} · {summary.count} wallets · {summary.avgScore.toFixed(0)} score
              </span>
            </div>
          ))
        }
        {clusterInfo.has(-1) && (
          <div className="flex items-center gap-2 glass rounded-md px-2 py-1">
            <span className="h-2 w-2 rounded-full bg-white/20 shrink-0" />
            <span className="text-[10px] text-[var(--text-muted)]">
              Noise · {clusterInfo.get(-1)?.count} wallets
            </span>
          </div>
        )}
      </div>

      {/* Tooltip */}
      {tooltip && <ClusterTooltip node={tooltip.node} x={tooltip.x} y={tooltip.y} />}
    </div>
  )
}

interface ClusterSummary { count: number; totalPnl: number; avgScore: number; scoreSum: number }

function ClusterTooltip({ node, x, y }: { node: ClusterNode; x: number; y: number }) {
  const color = node.cluster === -1 ? '#6b7280' : CLUSTER_PALETTE[node.cluster % CLUSTER_PALETTE.length]
  return (
    <div
      className="fixed z-50 glass-elevated rounded-xl px-3 py-2.5 text-xs pointer-events-none border border-[var(--border)] shadow-2xl min-w-[180px]"
      style={{ left: x + 14, top: y - 80 }}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="h-2 w-2 rounded-full" style={{ background: color }} />
        <span className="font-mono text-white">{node.label}</span>
      </div>
      <div className="space-y-0.5 text-[var(--text-muted)]">
        <p>Win Rate: <span className="text-green-400">{((node.win_rate ?? 0) * 100).toFixed(1)}%</span></p>
        <p>Volume 30d: <span className="text-white">{node.value.toFixed(2)} ETH</span></p>
        <p>PnL: <span className={node.pnl_eth !== undefined && node.pnl_eth >= 0 ? 'positive' : 'negative'}>
          {(node.pnl_eth ?? 0) >= 0 ? '+' : ''}{(node.pnl_eth ?? 0).toFixed(3)} ETH
        </span></p>
        <p>Score: <span className="text-purple-400">{node.score ?? 0}/100</span></p>
        <p>Cluster: <span style={{ color }}>{node.cluster === -1 ? 'Noise' : `C${node.cluster}`}</span></p>
      </div>
    </div>
  )
}
