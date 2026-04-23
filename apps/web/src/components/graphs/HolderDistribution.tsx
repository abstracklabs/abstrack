'use client'

/**
 * HolderDistribution — Visualisation de la concentration des holders.
 *
 * Deux vues :
 *   1. Treemap — surface ∝ tokens détenus (concentration visuelle immédiate)
 *   2. Lorenz curve — inégalité de distribution (Gini coefficient)
 *
 * Méthode Lorenz :
 *   - Trier les holders par nb de tokens (croissant)
 *   - x = % de holders cumulés
 *   - y = % de tokens cumulés
 *   - La diagonale = distribution parfaite
 *   - L'aire entre la courbe et la diagonale = inégalité
 *   - Gini = 2 × cette aire
 */

import { useRef, useEffect, useState } from 'react'
import * as d3 from 'd3'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../lib/api'

const API = process.env.NEXT_PUBLIC_API_URL

interface Holder {
  address:   string
  tokens:    number
  pct:       number       // % du supply
  label?:    string
  type?:     string
}

interface Props {
  collection: string
  view?:      'treemap' | 'lorenz'
  height?:    number
}

export function HolderDistribution({ collection, view = 'treemap', height = 400 }: Props) {
  const [activeView, setActiveView] = useState(view)

  return (
    <div className="w-full space-y-3">
      <div className="flex items-center gap-1 glass rounded-lg border border-[var(--border)] p-1 w-fit">
        {(['treemap', 'lorenz'] as const).map(v => (
          <button
            key={v}
            onClick={() => setActiveView(v)}
            className={`
              px-3 py-1 text-xs rounded-md capitalize transition-all
              ${activeView === v
                ? 'bg-blue-600/30 text-blue-400 border border-blue-500/30'
                : 'text-[var(--text-muted)] hover:text-white'
              }
            `}
          >
            {v === 'treemap' ? 'Treemap' : 'Lorenz Curve'}
          </button>
        ))}
      </div>

      {activeView === 'treemap'
        ? <HolderTreemap  collection={collection} height={height} />
        : <LorenzCurve    collection={collection} height={height} />
      }
    </div>
  )
}

// ─── Treemap ──────────────────────────────────────────────────────────────────

function HolderTreemap({ collection, height }: { collection: string; height: number }) {
  const svgRef  = useRef<SVGSVGElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [tooltip, setTooltip] = useState<{ h: Holder; x: number; y: number } | null>(null)

  const { data: holders } = useQuery<Holder[]>({
    queryKey: ['holders', collection],
    queryFn:  () => apiFetch<Holder[]>(`${API}/api/v1/collections/${collection}/holders?limit=100`),
    staleTime: 300_000,
    placeholderData: generateMockHolders(),
  })

  useEffect(() => {
    if (!svgRef.current || !wrapRef.current || !holders?.length) return

    const W = wrapRef.current.clientWidth
    const H = height

    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()
    svg.attr('width', W).attr('height', H)

    const root = d3.hierarchy({ children: holders } as any)
      .sum((d: any) => d.tokens ?? 0)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))

    d3.treemap<any>()
      .size([W, H])
      .paddingOuter(2)
      .paddingInner(1)
      .round(true)
      (root)

    const colorScale = d3.scaleSequential(d3.interpolateRgb('#1a2744', '#58a6ff'))
      .domain([0, (root.children?.[0]?.value ?? 1)])

    const cell = svg.selectAll('g')
      .data(root.leaves() as d3.HierarchyRectangularNode<any>[])
      .join('g')
      .attr('transform', d => `translate(${d.x0},${d.y0})`)

    cell.append('rect')
      .attr('width',  d => d.x1 - d.x0)
      .attr('height', d => d.y1 - d.y0)
      .attr('rx', 2)
      .attr('fill',         d => colorScale(d.value ?? 0))
      .attr('stroke',       'rgba(255,255,255,0.06)')
      .attr('stroke-width', 1)
      .style('cursor', 'pointer')
      .on('mouseenter', function(event, d) {
        d3.select(this).attr('fill-opacity', 0.8)
        setTooltip({ h: (d.data as any), x: event.clientX, y: event.clientY })
      })
      .on('mouseleave', function(_, d) {
        d3.select(this).attr('fill-opacity', 1)
        setTooltip(null)
      })

    // Label si cellule assez grande
    cell.filter(d => (d.x1 - d.x0) > 50 && (d.y1 - d.y0) > 30)
      .append('text')
      .attr('x', 6).attr('y', 16)
      .attr('font-size', 10)
      .attr('font-family', 'JetBrains Mono')
      .attr('fill', 'rgba(255,255,255,0.7)')
      .text(d => {
        const addr = (d.data as Holder).address
        return addr.slice(0, 8) + '...'
      })

    cell.filter(d => (d.x1 - d.x0) > 50 && (d.y1 - d.y0) > 46)
      .append('text')
      .attr('x', 6).attr('y', 30)
      .attr('font-size', 9)
      .attr('font-family', 'JetBrains Mono')
      .attr('fill', 'rgba(255,255,255,0.4)')
      .text(d => `${((d.data as Holder).pct * 100).toFixed(1)}%`)

  }, [holders, height])

  return (
    <div ref={wrapRef} className="relative w-full">
      <svg ref={svgRef} className="w-full rounded-xl overflow-hidden" />
      {tooltip && (
        <div
          className="fixed z-50 glass-elevated rounded-lg px-3 py-2 text-xs pointer-events-none border border-[var(--border)] shadow-xl"
          style={{ left: tooltip.x + 12, top: tooltip.y - 60 }}
        >
          <p className="font-mono text-white">{tooltip.h.address.slice(0, 12)}...</p>
          <p className="text-[var(--text-muted)]">
            Tokens: <span className="text-white">{tooltip.h.tokens}</span>
          </p>
          <p className="text-[var(--text-muted)]">
            Share: <span className="text-blue-400">{(tooltip.h.pct * 100).toFixed(2)}%</span>
          </p>
          {tooltip.h.type && (
            <p className="text-[var(--text-muted)]">
              Label: <span className="text-orange-400">{tooltip.h.type}</span>
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Lorenz Curve ─────────────────────────────────────────────────────────────

function LorenzCurve({ collection, height }: { collection: string; height: number }) {
  const svgRef = useRef<SVGSVGElement>(null)

  const { data: holders } = useQuery<Holder[]>({
    queryKey: ['holders', collection],
    queryFn:  () => apiFetch<Holder[]>(`${API}/api/v1/collections/${collection}/holders?limit=1000`),
    staleTime: 300_000,
    placeholderData: generateMockHolders(200),
  })

  useEffect(() => {
    if (!svgRef.current || !holders?.length) return

    const M    = { top: 30, right: 30, bottom: 40, left: 50 }
    const W    = (svgRef.current.parentElement?.clientWidth ?? 500) - M.left - M.right
    const H    = height - M.top - M.bottom

    const svg  = d3.select(svgRef.current)
    svg.selectAll('*').remove()
    svg.attr('width', W + M.left + M.right)
       .attr('height', H + M.top + M.bottom)

    const g = svg.append('g').attr('transform', `translate(${M.left},${M.top})`)

    // Calcul de la courbe de Lorenz
    const sorted   = [...holders].sort((a, b) => a.tokens - b.tokens)
    const total    = d3.sum(sorted, h => h.tokens)
    let cumTokens  = 0
    const points: Array<[number, number]> = [[0, 0]]
    sorted.forEach((h, i) => {
      cumTokens += h.tokens
      points.push([(i + 1) / sorted.length, cumTokens / total])
    })

    // Gini coefficient
    let areaUnder = 0
    for (let i = 1; i < points.length; i++) {
      const dx = points[i][0] - points[i-1][0]
      areaUnder += (points[i][1] + points[i-1][1]) / 2 * dx
    }
    const gini = 1 - 2 * areaUnder

    const x = d3.scaleLinear().domain([0, 1]).range([0, W])
    const y = d3.scaleLinear().domain([0, 1]).range([H, 0])

    // Fond de grille
    g.append('g').attr('class', 'grid')
      .call(d3.axisLeft(y).tickSize(-W).tickFormat(() => ''))
      .selectAll('line')
      .attr('stroke', 'rgba(255,255,255,0.05)')
    g.select('.grid .domain').remove()

    // Diagonale (égalité parfaite)
    g.append('line')
      .attr('x1', x(0)).attr('y1', y(0))
      .attr('x2', x(1)).attr('y2', y(1))
      .attr('stroke', 'rgba(255,255,255,0.2)')
      .attr('stroke-dasharray', '4,4')
      .attr('stroke-width', 1)

    g.append('text')
      .attr('x', x(0.7)).attr('y', y(0.75))
      .attr('transform', 'rotate(-45, ' + x(0.7) + ',' + y(0.75) + ')')
      .attr('font-size', 9)
      .attr('fill', 'rgba(255,255,255,0.2)')
      .attr('font-family', 'JetBrains Mono')
      .attr('text-anchor', 'middle')
      .text('Perfect equality')

    // Zone Gini (entre courbe et diagonale)
    const areaGen = d3.area<[number, number]>()
      .x(d => x(d[0]))
      .y0(d => y(d[0]))    // diagonale
      .y1(d => y(d[1]))    // courbe Lorenz

    g.append('path')
      .datum(points)
      .attr('d', areaGen)
      .attr('fill', 'rgba(248,81,73,0.12)')

    // Courbe de Lorenz
    const lineGen = d3.line<[number, number]>()
      .x(d => x(d[0]))
      .y(d => y(d[1]))
      .curve(d3.curveCatmullRom)

    g.append('path')
      .datum(points)
      .attr('d', lineGen)
      .attr('fill', 'none')
      .attr('stroke', '#58a6ff')
      .attr('stroke-width', 2)

    // Axes
    g.append('g').attr('transform', `translate(0,${H})`)
      .call(d3.axisBottom(x).tickFormat(d => `${(+d * 100).toFixed(0)}%`).ticks(5))
      .selectAll('text').attr('fill', 'rgba(255,255,255,0.3)').attr('font-size', 9).attr('font-family', 'JetBrains Mono')
    g.select('.domain').attr('stroke', 'rgba(255,255,255,0.1)')

    g.append('g').call(d3.axisLeft(y).tickFormat(d => `${(+d * 100).toFixed(0)}%`).ticks(5))
      .selectAll('text').attr('fill', 'rgba(255,255,255,0.3)').attr('font-size', 9).attr('font-family', 'JetBrains Mono')

    // Gini badge
    g.append('rect')
      .attr('x', W - 100).attr('y', H - 46).attr('width', 95).attr('height', 40).attr('rx', 6)
      .attr('fill', 'rgba(13,17,23,0.8)').attr('stroke', 'rgba(255,255,255,0.08)')

    g.append('text')
      .attr('x', W - 53).attr('y', H - 28)
      .attr('text-anchor', 'middle').attr('font-size', 9).attr('font-family', 'JetBrains Mono')
      .attr('fill', 'rgba(255,255,255,0.4)')
      .text('Gini Coefficient')

    g.append('text')
      .attr('x', W - 53).attr('y', H - 14)
      .attr('text-anchor', 'middle').attr('font-size', 16).attr('font-weight', 700).attr('font-family', 'JetBrains Mono')
      .attr('fill', gini > 0.7 ? '#f97316' : gini > 0.5 ? '#eab308' : '#3fb950')
      .text(gini.toFixed(3))

  }, [holders, height])

  return <svg ref={svgRef} className="w-full overflow-visible" />
}

// ─── Mock data ────────────────────────────────────────────────────────────────

// Deterministic mock — no Math.random() to avoid SSR/hydration mismatch
function generateMockHolders(n = 100): Holder[] {
  const holders: Holder[] = []
  for (let i = 0; i < n; i++) {
    // Deterministic pseudo-random values based on index
    const r1 = ((i * 2654435761) % 1000) / 1000
    const r2 = (((i + 137) * 1664525) % 1000) / 1000
    // Distribution Pareto (80/20)
    const tokens = Math.floor(Math.pow(r1, 3) * 500) + 1
    const addrHex = (i * 0xdeadbeef).toString(16).padStart(40, '0').slice(0, 40)
    holders.push({
      address: `0x${addrHex}`,
      tokens,
      pct: 0,
    })
  }
  const total = d3.sum(holders, h => h.tokens)
  holders.forEach(h => h.pct = h.tokens / total)
  return holders.sort((a, b) => b.tokens - a.tokens)
}
