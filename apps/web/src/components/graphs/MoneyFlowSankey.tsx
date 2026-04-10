'use client'

/**
 * MoneyFlowSankey — Flux d'argent entre wallets, collections et marketplaces.
 *
 * Algorithme : Sankey diagram (D3-sankey)
 *   - Nœuds ordonnés par couches (source → collection → destination)
 *   - Liens pondérés par volume ETH
 *   - Largeur des bandes ∝ volume
 *
 * Performance :
 *   - SVG (nombre de nœuds limité ~50 pour Sankey)
 *   - Pas de simulation — layout statique recalculé à chaque fetch
 *   - Transitions CSS sur les bandes
 */

import { useEffect, useRef, useState } from 'react'
import * as d3 from 'd3'
import { sankey, sankeyLinkHorizontal, sankeyLeft } from 'd3-sankey'
import { useMoneyFlow } from './hooks/useGraphData'
import type { FlowNode } from './types'

const CATEGORY_COLORS: Record<string, string> = {
  wallet:      '#58a6ff',
  collection:  '#a855f7',
  marketplace: '#10b981',
}

interface Props {
  collection: string
  period?:    '24h' | '7d' | '30d'
  height?:    number
}

export function MoneyFlowSankey({ collection, period = '7d', height = 480 }: Props) {
  const svgRef   = useRef<SVGSVGElement>(null)
  const wrapRef  = useRef<HTMLDivElement>(null)
  const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number } | null>(null)

  const { data, isLoading } = useMoneyFlow(collection, period)

  useEffect(() => {
    if (!svgRef.current || !wrapRef.current || !data?.nodes.length) return

    const W = wrapRef.current.clientWidth
    const H = height
    const MARGIN = { top: 20, right: 160, bottom: 20, left: 160 }

    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()
    svg.attr('width', W).attr('height', H)

    const innerW = W - MARGIN.left - MARGIN.right
    const innerH = H - MARGIN.top  - MARGIN.bottom

    const g = svg.append('g').attr('transform', `translate(${MARGIN.left},${MARGIN.top})`)

    // ─── Layout Sankey ───────────────────────────────────────────────────────
    const sankeyLayout = sankey<FlowNode, { source: number; target: number; value: number }>()
      .nodeId(d => d.id)
      .nodeAlign(sankeyLeft)
      .nodeWidth(18)
      .nodePadding(14)
      .extent([[0, 0], [innerW, innerH]])

    const { nodes, links } = sankeyLayout({
      nodes: data.nodes.map(d => ({ ...d })),
      links: data.links.map(d => ({ ...d })),
    })

    // ─── Liens ───────────────────────────────────────────────────────────────
    const linkG = g.append('g').attr('fill', 'none')

    linkG.selectAll('path')
      .data(links)
      .join('path')
      .attr('d', sankeyLinkHorizontal())
      .attr('stroke', l => {
        const src = l.source as any
        return CATEGORY_COLORS[src.category] ?? '#58a6ff'
      })
      .attr('stroke-width', l => Math.max(1, l.width ?? 1))
      .attr('stroke-opacity', 0.25)
      .attr('class', 'transition-all duration-200')
      .on('mouseenter', function(event, l) {
        d3.select(this).attr('stroke-opacity', 0.6)
        const src  = l.source as any
        const tgt  = l.target as any
        const eth  = (l.value ?? 0).toFixed(2)
        setTooltip({
          text: `${src.name} → ${tgt.name}\n${eth} ETH`,
          x:    event.clientX,
          y:    event.clientY,
        })
      })
      .on('mouseleave', function() {
        d3.select(this).attr('stroke-opacity', 0.25)
        setTooltip(null)
      })

    // ─── Nœuds ───────────────────────────────────────────────────────────────
    const nodeG = g.append('g')

    const nodeEl = nodeG.selectAll('g')
      .data(nodes)
      .join('g')
      .attr('transform', n => `translate(${n.x0},${n.y0})`)
      .style('cursor', 'pointer')

    // Rectangle du nœud
    nodeEl.append('rect')
      .attr('height', n => (n.y1 ?? 0) - (n.y0 ?? 0))
      .attr('width',  n => (n.x1 ?? 0) - (n.x0 ?? 0))
      .attr('rx', 3)
      .attr('fill', n => CATEGORY_COLORS[(n as any).category] ?? '#6b7280')
      .attr('fill-opacity', 0.9)
      .attr('stroke', 'rgba(255,255,255,0.15)')
      .attr('stroke-width', 1)

    // Label gauche ou droite selon position
    nodeEl.append('text')
      .attr('x', n => ((n.x0 ?? 0) < innerW / 2) ? -8 : (n.x1 ?? 0) - (n.x0 ?? 0) + 8)
      .attr('y', n => ((n.y1 ?? 0) - (n.y0 ?? 0)) / 2)
      .attr('dy', '0.35em')
      .attr('text-anchor', n => ((n.x0 ?? 0) < innerW / 2) ? 'end' : 'start')
      .attr('font-size', 11)
      .attr('font-family', 'JetBrains Mono, monospace')
      .attr('fill', 'rgba(230,237,243,0.8)')
      .text(n => {
        const name  = (n as any).name ?? n.id
        const value = (n as any).value?.toFixed(1) ?? ''
        return `${name.length > 16 ? name.slice(0, 14) + '…' : name}  ${value}Ξ`
      })

    // Hover highlight
    nodeEl
      .on('mouseenter', function(_, n) {
        // Highlight les liens connectés
        linkG.selectAll<SVGPathElement, any>('path')
          .attr('stroke-opacity', l =>
            (l.source as any).id === n.id || (l.target as any).id === n.id ? 0.7 : 0.08
          )
      })
      .on('mouseleave', function() {
        linkG.selectAll('path').attr('stroke-opacity', 0.25)
      })

  }, [data, height])

  return (
    <div ref={wrapRef} className="relative w-full" style={{ height }}>
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center text-[var(--text-muted)] text-sm">
          Loading flow data...
        </div>
      )}

      <svg ref={svgRef} className="w-full overflow-visible" />

      {tooltip && (
        <div
          className="fixed z-50 glass-elevated rounded-lg px-3 py-2 text-xs border border-[var(--border)] shadow-xl whitespace-pre pointer-events-none"
          style={{ left: tooltip.x + 12, top: tooltip.y - 40 }}
        >
          {tooltip.text}
        </div>
      )}

      {/* Légende */}
      <div className="absolute bottom-2 right-2 flex gap-3">
        {Object.entries(CATEGORY_COLORS).map(([cat, color]) => (
          <div key={cat} className="flex items-center gap-1.5 glass rounded px-2 py-1">
            <span className="h-2 w-2 rounded-full" style={{ background: color }} />
            <span className="text-[10px] text-[var(--text-muted)] capitalize">{cat}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
