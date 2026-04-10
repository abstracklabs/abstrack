'use client'

import { useEffect, useRef } from 'react'
import { createChart, ColorType, CrosshairMode } from 'lightweight-charts'
import { useQuery } from '@tanstack/react-query'
import { useLiveFloor } from '../../lib/hooks/useRealtime'

const API = process.env.NEXT_PUBLIC_API_URL

interface Props {
  collection: string
  period?:    '24h' | '7d' | '30d'
  height?:    number
}

export function FloorChart({ collection, period = '7d', height = 240 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef     = useRef<ReturnType<typeof createChart> | null>(null)
  const seriesRef    = useRef<any>(null)
  const liveFloor    = useLiveFloor(collection)

  // Fetch historique
  const { data } = useQuery({
    queryKey: ['floor-history', collection, period],
    queryFn: () =>
      fetch(`${API}/api/v1/collections/${collection}/floor?period=${period}`)
        .then(r => r.json()),
    staleTime: 60_000,
  })

  // Init chart
  useEffect(() => {
    if (!containerRef.current) return

    const chart = createChart(containerRef.current, {
      width:  containerRef.current.clientWidth,
      height,
      layout: {
        background:  { type: ColorType.Solid, color: 'transparent' },
        textColor:   'rgba(230,237,243,0.4)',
        fontSize:    11,
        fontFamily:  'JetBrains Mono, monospace',
      },
      grid: {
        vertLines:   { color: 'rgba(255,255,255,0.04)' },
        horzLines:   { color: 'rgba(255,255,255,0.04)' },
      },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine:   { color: 'rgba(88,166,255,0.4)',  style: 0, labelBackgroundColor: '#1f2937' },
        horzLine:   { color: 'rgba(88,166,255,0.4)',  style: 0, labelBackgroundColor: '#1f2937' },
      },
      rightPriceScale: {
        borderColor: 'rgba(255,255,255,0.06)',
      },
      timeScale: {
        borderColor:    'rgba(255,255,255,0.06)',
        timeVisible:    true,
        secondsVisible: false,
      },
    })

    // Série de prix (area chart)
    const series = chart.addAreaSeries({
      lineColor:        '#58a6ff',
      topColor:         'rgba(88,166,255,0.15)',
      bottomColor:      'rgba(88,166,255,0)',
      lineWidth:        2,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius:  4,
      crosshairMarkerBorderColor: '#58a6ff',
      crosshairMarkerBackgroundColor: '#0d1117',
      priceFormat: { type: 'custom', formatter: (v: number) => `${v.toFixed(4)}Ξ` },
    })

    chartRef.current = chart
    seriesRef.current = series

    // Responsive resize
    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: containerRef.current!.clientWidth })
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      chart.remove()
    }
  }, [height])

  // Charger données historiques
  useEffect(() => {
    if (!seriesRef.current || !data?.length) return
    const formatted = data
      .map((d: any) => ({
        time:  Math.floor(new Date(d.t).getTime() / 1000),
        value: parseFloat(d.floor),
      }))
      .sort((a: any, b: any) => a.time - b.time)
    seriesRef.current.setData(formatted)
    chartRef.current?.timeScale().fitContent()
  }, [data])

  // Patch en temps réel avec le floor live
  useEffect(() => {
    if (!seriesRef.current || liveFloor === null) return
    seriesRef.current.update({
      time:  Math.floor(Date.now() / 1000),
      value: liveFloor,
    })
  }, [liveFloor])

  return (
    <div
      ref={containerRef}
      style={{ height }}
      className="w-full"
    />
  )
}
