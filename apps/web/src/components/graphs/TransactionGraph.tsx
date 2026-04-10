'use client'

/**
 * TransactionGraph — Force-directed graph des relations wallet.
 *
 * Algorithme : D3 Force Simulation
 *   - forceLink     : ressorts entre nœuds liés (distance ∝ 1/volume)
 *   - forceManyBody : répulsion électrostatique (Barnes-Hut θ=0.9)
 *   - forceCenter   : gravité vers le centre
 *   - forceCollide  : évite les chevauchements
 *
 * Performance :
 *   - Canvas 2D (pas SVG) → 60fps même à 500+ nœuds
 *   - Simulation stoppée après convergence (alpha < 0.001)
 *   - requestAnimationFrame pour le rendu
 *   - Quadtree pour le hover hit-test (O(log n))
 *   - Zoom/pan via d3-zoom natif canvas
 */

import { useEffect, useRef, useCallback, useState } from 'react'
import * as d3 from 'd3'
import { useTransactionGraph } from './hooks/useGraphData'
import type { GraphNode, GraphLink } from './types'
import { NODE_COLORS, NODE_RADIUS } from './types'

interface Props {
  address:   string
  depth?:    1 | 2 | 3
  height?:   number
  onNodeClick?: (node: GraphNode) => void
}

interface SimNode extends GraphNode {
  x: number; y: number; vx: number; vy: number; fx: number | null; fy: number | null
}
interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  value: number; count: number
}

export function TransactionGraph({ address, depth = 2, height = 560, onNodeClick }: Props) {
  const canvasRef   = useRef<HTMLCanvasElement>(null)
  const simRef      = useRef<d3.Simulation<SimNode, SimLink> | null>(null)
  const transformRef = useRef(d3.zoomIdentity)
  const nodesRef    = useRef<SimNode[]>([])
  const linksRef    = useRef<SimLink[]>([])
  const hoveredRef  = useRef<SimNode | null>(null)
  const [tooltip, setTooltip] = useState<{ node: SimNode; x: number; y: number } | null>(null)

  const { data, isLoading } = useTransactionGraph(address, depth)

  // ─── Scale : volume ETH → rayon nœud ───────────────────────────────────────
  const radiusScale = useCallback((nodes: GraphNode[]) => {
    const extent = d3.extent(nodes, n => n.value) as [number, number]
    return d3.scaleSqrt()
      .domain([extent[0] || 0, extent[1] || 1])
      .range([NODE_RADIUS.min, NODE_RADIUS.max])
      .clamp(true)
  }, [])

  // ─── Rendu Canvas ────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx    = canvas.getContext('2d')!
    const { k, x, y } = transformRef.current

    ctx.save()
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.translate(x, y)
    ctx.scale(k, k)

    const rScale = radiusScale(nodesRef.current)

    // ── Liens ────────────────────────────────────────────────────────────────
    for (const link of linksRef.current) {
      const src = link.source as SimNode
      const tgt = link.target as SimNode
      if (!src.x || !tgt.x) continue

      const alpha = Math.min(0.1 + link.count * 0.05, 0.6)
      const width = Math.max(0.5, Math.min(link.value / 10, 4))

      ctx.beginPath()
      ctx.strokeStyle = `rgba(88, 166, 255, ${alpha})`
      ctx.lineWidth   = width / k
      ctx.moveTo(src.x, src.y)
      ctx.lineTo(tgt.x, tgt.y)
      ctx.stroke()

      // Flèche directionnelle
      drawArrow(ctx, src, tgt, width / k)
    }

    // ── Nœuds ────────────────────────────────────────────────────────────────
    for (const node of nodesRef.current) {
      if (!node.x) continue
      const r       = rScale(node.value)
      const color   = NODE_COLORS[node.type]
      const isHover = hoveredRef.current?.id === node.id
      const isRoot  = node.id === address

      // Halo pour nœud racine
      if (isRoot) {
        ctx.beginPath()
        ctx.arc(node.x, node.y, r + 6, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(88, 166, 255, 0.15)'
        ctx.fill()
        ctx.strokeStyle = 'rgba(88, 166, 255, 0.5)'
        ctx.lineWidth = 1.5 / k
        ctx.stroke()
      }

      // Glow sur hover
      if (isHover) {
        ctx.shadowColor = color
        ctx.shadowBlur  = 16
      }

      // Corps du nœud
      ctx.beginPath()
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.globalAlpha = isHover ? 1 : 0.85
      ctx.fill()

      // Bordure
      ctx.strokeStyle = isHover ? '#fff' : 'rgba(255,255,255,0.2)'
      ctx.lineWidth   = (isHover ? 1.5 : 0.5) / k
      ctx.stroke()

      ctx.shadowBlur  = 0
      ctx.globalAlpha = 1

      // Label (seulement si zoom suffisant ou si c'est le nœud central)
      if (k > 0.8 || isRoot) {
        ctx.font        = `${isRoot ? 600 : 400} ${11 / k}px JetBrains Mono`
        ctx.fillStyle   = isRoot ? '#fff' : 'rgba(255,255,255,0.7)'
        ctx.textAlign   = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(node.label ?? node.id.slice(0, 8), node.x, node.y + r + 10 / k)
      }
    }

    ctx.restore()
  }, [address, radiusScale])

  // ─── Hit-test avec Quadtree ──────────────────────────────────────────────────
  const findNode = useCallback((px: number, py: number): SimNode | null => {
    const { k, x, y } = transformRef.current
    const wx = (px - x) / k
    const wy = (py - y) / k
    const rScale = radiusScale(nodesRef.current)

    let found: SimNode | null = null
    let minDist = Infinity

    // Quadtree search : O(log n) vs O(n) brut force
    const qt = d3.quadtree<SimNode>()
      .x(n => n.x ?? 0)
      .y(n => n.y ?? 0)
      .addAll(nodesRef.current)

    qt.visit((node, x1, y1, x2, y2) => {
      if (!node.length) {
        const d = Math.hypot((node.data.x ?? 0) - wx, (node.data.y ?? 0) - wy)
        const r = rScale(node.data.value)
        if (d <= r && d < minDist) { minDist = d; found = node.data }
      }
      const r = NODE_RADIUS.max
      return wx < x1 - r || wx > x2 + r || wy < y1 - r || wy > y2 + r
    })

    return found
  }, [radiusScale])

  // ─── Init simulation ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!data?.nodes.length || !canvasRef.current) return

    const canvas = canvasRef.current
    const W = canvas.width
    const H = canvas.height

    const nodes = data.nodes.map(n => ({
      ...n, x: W / 2 + (Math.random() - 0.5) * 100,
             y: H / 2 + (Math.random() - 0.5) * 100,
      vx: 0, vy: 0, fx: null, fy: null,
    })) as SimNode[]

    const nodeMap = new Map(nodes.map(n => [n.id, n]))

    const links = data.links.map(l => ({
      source: nodeMap.get(typeof l.source === 'string' ? l.source : (l.source as any).id)!,
      target: nodeMap.get(typeof l.target === 'string' ? l.target : (l.target as any).id)!,
      value:  l.value,
      count:  l.count,
    })).filter(l => l.source && l.target) as SimLink[]

    nodesRef.current = nodes
    linksRef.current = links

    // Épingler le nœud racine au centre
    const root = nodes.find(n => n.id === address)
    if (root) { root.fx = W / 2; root.fy = H / 2 }

    // Créer la simulation
    const sim = d3.forceSimulation<SimNode>(nodes)
      .force('link', d3.forceLink<SimNode, SimLink>(links)
        .id(n => n.id)
        .distance(l => 80 + 60 / Math.max(l.value, 0.01))  // liens forts = plus courts
        .strength(0.4)
      )
      .force('charge', d3.forceManyBody<SimNode>()
        .strength(-300)
        .theta(0.9)     // Barnes-Hut approximation
        .distanceMax(400)
      )
      .force('center', d3.forceCenter(W / 2, H / 2).strength(0.05))
      .force('collide', d3.forceCollide<SimNode>(n => NODE_RADIUS.min + n.value * 0.5 + 4))
      .alphaDecay(0.02)   // refroidissement lent = meilleur layout
      .on('tick', draw)

    simRef.current = sim

    // Arrêter la sim après convergence (économie CPU)
    sim.on('end', () => {
      console.debug('[graph] simulation converged')
    })

    return () => { sim.stop() }
  }, [data, address, draw])

  // ─── Zoom / Pan ───────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const zoom = d3.zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.2, 4])
      .on('zoom', ({ transform }) => {
        transformRef.current = transform
        draw()
      })

    d3.select(canvas).call(zoom)
  }, [draw])

  // ─── Drag + hover ─────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let dragging: SimNode | null = null

    const onMouseMove = (e: MouseEvent) => {
      const rect  = canvas.getBoundingClientRect()
      const px    = e.clientX - rect.left
      const py    = e.clientY - rect.top

      if (dragging) {
        const { k, x, y } = transformRef.current
        dragging.fx = (px - x) / k
        dragging.fy = (py - y) / k
        simRef.current?.alpha(0.3).restart()
        return
      }

      const node = findNode(px, py)
      if (node !== hoveredRef.current) {
        hoveredRef.current = node
        canvas.style.cursor = node ? 'pointer' : 'grab'
        if (node) {
          setTooltip({ node, x: e.clientX, y: e.clientY })
        } else {
          setTooltip(null)
        }
        draw()
      }
    }

    const onMouseDown = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      const node = findNode(e.clientX - rect.left, e.clientY - rect.top)
      if (node) { dragging = node; e.stopPropagation() }
    }

    const onMouseUp = () => {
      if (dragging) {
        dragging.fx = null
        dragging.fy = null
        dragging = null
      }
    }

    const onClick = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      const node = findNode(e.clientX - rect.left, e.clientY - rect.top)
      if (node) onNodeClick?.(node)
    }

    canvas.addEventListener('mousemove',  onMouseMove)
    canvas.addEventListener('mousedown',  onMouseDown)
    canvas.addEventListener('mouseup',    onMouseUp)
    canvas.addEventListener('click',      onClick)
    return () => {
      canvas.removeEventListener('mousemove',  onMouseMove)
      canvas.removeEventListener('mousedown',  onMouseDown)
      canvas.removeEventListener('mouseup',    onMouseUp)
      canvas.removeEventListener('click',      onClick)
    }
  }, [findNode, draw, onNodeClick])

  return (
    <div className="relative w-full" style={{ height }}>
      {/* Loading overlay */}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-[var(--bg-base)]/80 rounded-xl z-10">
          <div className="flex items-center gap-3 text-[var(--text-muted)]">
            <Spinner />
            <span className="text-sm">Building graph...</span>
          </div>
        </div>
      )}

      {/* Canvas */}
      <canvas
        ref={canvasRef}
        width={canvasRef.current?.parentElement?.clientWidth ?? 800}
        height={height}
        className="w-full rounded-xl"
        style={{ background: 'var(--bg-base)' }}
      />

      {/* Legend */}
      <GraphLegend />

      {/* Stats */}
      {data && (
        <div className="absolute top-3 left-3 glass rounded-lg px-3 py-2 text-xs text-[var(--text-muted)]">
          {data.nodes.length} wallets · {data.links.length} connections
        </div>
      )}

      {/* Tooltip */}
      {tooltip && (
        <NodeTooltip node={tooltip.node} x={tooltip.x} y={tooltip.y} />
      )}
    </div>
  )
}

// ─── Helpers de rendu ─────────────────────────────────────────────────────────

function drawArrow(ctx: CanvasRenderingContext2D, src: SimNode, tgt: SimNode, lineWidth: number) {
  const dx   = (tgt.x ?? 0) - (src.x ?? 0)
  const dy   = (tgt.y ?? 0) - (src.y ?? 0)
  const len  = Math.hypot(dx, dy)
  if (len < 30) return

  const angle = Math.atan2(dy, dx)
  const tipX  = (tgt.x ?? 0) - (dx / len) * 12
  const tipY  = (tgt.y ?? 0) - (dy / len) * 12

  ctx.save()
  ctx.translate(tipX, tipY)
  ctx.rotate(angle)
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(-8 * lineWidth, 3 * lineWidth)
  ctx.lineTo(-8 * lineWidth, -3 * lineWidth)
  ctx.closePath()
  ctx.fillStyle = 'rgba(88, 166, 255, 0.5)'
  ctx.fill()
  ctx.restore()
}

// ─── Sous-composants UI ───────────────────────────────────────────────────────

function GraphLegend() {
  const items: Array<{ type: keyof typeof NODE_COLORS; label: string }> = [
    { type: 'whale',       label: 'Whale'       },
    { type: 'smart_money', label: 'Smart Money' },
    { type: 'large_buyer', label: 'Large Buyer' },
    { type: 'exchange',    label: 'Exchange'    },
    { type: 'regular',     label: 'Regular'     },
  ]
  return (
    <div className="absolute bottom-3 left-3 flex flex-wrap gap-3">
      {items.map(({ type, label }) => (
        <div key={type} className="flex items-center gap-1.5 glass rounded-md px-2 py-1">
          <span className="h-2 w-2 rounded-full" style={{ background: NODE_COLORS[type] }} />
          <span className="text-[10px] text-[var(--text-muted)]">{label}</span>
        </div>
      ))}
    </div>
  )
}

function NodeTooltip({ node, x, y }: { node: SimNode; x: number; y: number }) {
  return (
    <div
      className="fixed z-50 glass-elevated rounded-lg px-3 py-2 text-xs pointer-events-none border border-[var(--border)] shadow-xl"
      style={{ left: x + 12, top: y - 60 }}
    >
      <p className="font-mono text-white mb-1">{node.label ?? node.id.slice(0, 12) + '...'}</p>
      <p className="text-[var(--text-muted)]">
        Volume: <span className="text-white">{node.value.toFixed(2)} Ξ</span>
      </p>
      <p className="text-[var(--text-muted)]">
        Type: <span style={{ color: NODE_COLORS[node.type] }}>{node.type.replace('_', ' ')}</span>
      </p>
      {node.score !== undefined && (
        <p className="text-[var(--text-muted)]">
          Score: <span className="text-purple-400">{node.score}/100</span>
        </p>
      )}
    </div>
  )
}

function Spinner() {
  return (
    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  )
}
