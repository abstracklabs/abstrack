'use client'

import { useEffect, useRef, useState } from 'react'
import { useLiveFloor } from '../../lib/hooks/useRealtime'

interface Props {
  collection: string
  initialFloor?: number
}

export function LiveFloorTicker({ collection, initialFloor }: Props) {
  const liveFloor = useLiveFloor(collection)
  const floor     = liveFloor ?? initialFloor ?? null
  const prevFloor = useRef<number | null>(null)
  const [flash, setFlash] = useState<'up' | 'down' | null>(null)

  useEffect(() => {
    if (floor === null || prevFloor.current === null) {
      prevFloor.current = floor
      return
    }

    const direction = floor > prevFloor.current ? 'up' : floor < prevFloor.current ? 'down' : null
    prevFloor.current = floor

    if (direction) {
      setFlash(direction)
      const timer = setTimeout(() => setFlash(null), 800)
      return () => clearTimeout(timer)
    }
  }, [floor])

  if (floor === null) {
    return <span className="text-white/30 text-sm animate-pulse">—</span>
  }

  return (
    <span className={`
      font-mono font-semibold tabular-nums
      transition-colors duration-300
      ${flash === 'up'   ? 'text-green-400' :
        flash === 'down' ? 'text-red-400'   :
        'text-white'}
    `}>
      {floor.toFixed(4)} ETH
      {flash === 'up'   && <Arrow dir="up" />}
      {flash === 'down' && <Arrow dir="down" />}
    </span>
  )
}

function Arrow({ dir }: { dir: 'up' | 'down' }) {
  return (
    <span className={`
      ml-1 text-xs font-bold
      ${dir === 'up' ? 'text-green-400' : 'text-red-400'}
    `}>
      {dir === 'up' ? '▲' : '▼'}
    </span>
  )
}
