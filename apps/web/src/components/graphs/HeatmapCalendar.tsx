'use client'

/**
 * HeatmapCalendar — Activité NFT par jour (GitHub-style).
 *
 * Affiche le volume ou le nombre de ventes par jour sur 52 semaines.
 * Couleur = intensité d'activité (scale logarithmique).
 *
 * Interactif : hover sur une cellule = tooltip avec détails du jour.
 */

import { useRef, useEffect, useState } from 'react'
import * as d3 from 'd3'
import { useQuery } from '@tanstack/react-query'

const API = process.env.NEXT_PUBLIC_API_URL

interface DayData {
  date:        string   // ISO YYYY-MM-DD
  volume_eth:  number
  sales_count: number
  floor_eth:   number
}

interface Props {
  collection?: string
  metric?:     'volume' | 'sales'
  height?:     number
}

const CELL    = 13
const GAP     = 2
const WEEKS   = 52
const DAYS    = 7

export function HeatmapCalendar({ collection, metric = 'volume', height = 130 }: Props) {
  const svgRef   = useRef<SVGSVGElement>(null)
  const [tooltip, setTooltip] = useState<{ day: DayData; x: number; y: number } | null>(null)

  const { data: days } = useQuery<DayData[]>({
    queryKey: ['heatmap', collection, metric],
    queryFn: () =>
      fetch(collection
        ? `${API}/api/v1/collections/${collection}/activity?period=365d&granularity=day`
        : `${API}/api/v1/analytics/activity?period=365d&granularity=day`
      ).then(r => r.json()),
    staleTime: 3_600_000,
    placeholderData: generateMockDays(),
  })

  useEffect(() => {
    if (!svgRef.current || !days?.length) return

    const W = WEEKS * (CELL + GAP)
    const H = height

    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()
    svg.attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`)

    // Color scale logarithmique
    const vals   = days.map(d => metric === 'volume' ? d.volume_eth : d.sales_count)
    const maxVal = d3.max(vals) || 1

    const color = d3.scaleSequential(d3.interpolateRgb(
      'rgba(88,166,255,0.08)',
      '#58a6ff'
    )).domain([0, Math.log1p(maxVal)])

    // Grouper par semaine
    const now   = new Date()
    const start = d3.timeWeek.floor(d3.timeDay.offset(now, -WEEKS * 7))
    const dayMap = new Map(days.map(d => [d.date, d]))

    const g = svg.append('g').attr('transform', 'translate(0,24)')

    // Labels mois
    let lastMonth = -1
    for (let w = 0; w < WEEKS; w++) {
      const weekStart = d3.timeWeek.offset(start, w)
      const month     = weekStart.getMonth()
      if (month !== lastMonth) {
        lastMonth = month
        g.append('text')
          .attr('x', w * (CELL + GAP))
          .attr('y', -8)
          .attr('font-size', 9)
          .attr('fill', 'rgba(255,255,255,0.3)')
          .attr('font-family', 'JetBrains Mono')
          .text(weekStart.toLocaleString('en', { month: 'short' }))
      }
    }

    // Cellules
    for (let w = 0; w < WEEKS; w++) {
      for (let d = 0; d < DAYS; d++) {
        const date = d3.timeDay.offset(d3.timeWeek.offset(start, w), d)
        if (date > now) continue

        const iso  = date.toISOString().slice(0, 10)
        const day  = dayMap.get(iso)
        const val  = day ? (metric === 'volume' ? day.volume_eth : day.sales_count) : 0

        g.append('rect')
          .attr('x', w * (CELL + GAP))
          .attr('y', d * (CELL + GAP))
          .attr('width',  CELL)
          .attr('height', CELL)
          .attr('rx', 2)
          .attr('fill',   val > 0 ? color(Math.log1p(val)) : 'rgba(255,255,255,0.05)')
          .attr('class', 'cursor-pointer transition-opacity')
          .on('mouseenter', function(event) {
            d3.select(this).attr('opacity', 0.7)
            if (day) setTooltip({ day, x: event.clientX, y: event.clientY })
          })
          .on('mouseleave', function() {
            d3.select(this).attr('opacity', 1)
            setTooltip(null)
          })
      }
    }

    // Labels jours
    const dayLabels = ['Mon', '', 'Wed', '', 'Fri', '', 'Sun']
    dayLabels.forEach((label, i) => {
      if (!label) return
      g.append('text')
        .attr('x', -28)
        .attr('y', i * (CELL + GAP) + CELL / 2 + 4)
        .attr('font-size', 9)
        .attr('fill', 'rgba(255,255,255,0.25)')
        .attr('font-family', 'JetBrains Mono')
        .text(label)
    })

  }, [days, metric, height])

  return (
    <div className="relative w-full">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-[var(--text-muted)]">
          Activity over the last 52 weeks
        </p>
        <div className="flex items-center gap-2 text-[10px] text-[var(--text-muted)]">
          <span>Less</span>
          {[0.1, 0.3, 0.5, 0.7, 0.9].map(v => (
            <span
              key={v}
              className="h-2.5 w-2.5 rounded-sm"
              style={{ background: `rgba(88,166,255,${v})` }}
            />
          ))}
          <span>More</span>
        </div>
      </div>
      <svg ref={svgRef} className="w-full overflow-visible" style={{ height }} />
      {tooltip && (
        <div
          className="fixed z-50 glass-elevated rounded-lg px-3 py-2 text-xs pointer-events-none border border-[var(--border)] shadow-xl"
          style={{ left: tooltip.x + 12, top: tooltip.y - 60 }}
        >
          <p className="text-white font-medium mb-1">{tooltip.day.date}</p>
          <p className="text-[var(--text-muted)]">
            Volume: <span className="text-white">{tooltip.day.volume_eth.toFixed(2)} ETH</span>
          </p>
          <p className="text-[var(--text-muted)]">
            Sales: <span className="text-white">{tooltip.day.sales_count}</span>
          </p>
          {tooltip.day.floor_eth > 0 && (
            <p className="text-[var(--text-muted)]">
              Floor: <span className="text-white">{tooltip.day.floor_eth.toFixed(4)} ETH</span>
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// Placeholder data pendant le chargement
function generateMockDays(): DayData[] {
  const days: DayData[] = []
  const now = new Date()
  for (let i = 365; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const rand = Math.random()
    days.push({
      date:        d.toISOString().slice(0, 10),
      volume_eth:  rand > 0.3 ? rand * 50 : 0,
      sales_count: rand > 0.3 ? Math.floor(rand * 100) : 0,
      floor_eth:   0.5 + rand * 2,
    })
  }
  return days
}
