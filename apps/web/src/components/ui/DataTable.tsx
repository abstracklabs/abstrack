'use client'

import { useState, ReactNode } from 'react'

export interface Column<T> {
  key:       string
  header:    string
  render:    (row: T) => ReactNode
  sortable?: boolean
  width?:    string
  align?:    'left' | 'right' | 'center'
}

interface Props<T> {
  columns:   Column<T>[]
  data:      T[]
  keyFn:     (row: T) => string
  loading?:  boolean
  emptyText?: string
  onRowClick?: (row: T) => void
}

export function DataTable<T>({ columns, data, keyFn, loading, emptyText = 'No data', onRowClick }: Props<T>) {
  const [sortKey, setSortKey]   = useState<string | null>(null)
  const [sortDir, setSortDir]   = useState<'asc' | 'desc'>('desc')

  const toggleSort = (key: string) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--border)]">
            {columns.map(col => (
              <th
                key={col.key}
                style={{ width: col.width }}
                onClick={() => col.sortable && toggleSort(col.key)}
                className={`
                  px-4 py-3 text-xs text-[var(--text-muted)] font-medium uppercase tracking-wider
                  text-${col.align ?? 'left'}
                  ${col.sortable ? 'cursor-pointer hover:text-white select-none' : ''}
                `}
              >
                <span className="flex items-center gap-1">
                  {col.header}
                  {col.sortable && sortKey === col.key && (
                    <span>{sortDir === 'asc' ? '↑' : '↓'}</span>
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {loading ? (
            Array.from({ length: 8 }).map((_, i) => (
              <tr key={i} className="border-b border-[var(--border)]/50">
                {columns.map(col => (
                  <td key={col.key} className="px-4 py-3">
                    <div className="h-4 bg-white/5 rounded animate-pulse" style={{ width: `${60 + Math.random() * 40}%` }} />
                  </td>
                ))}
              </tr>
            ))
          ) : data.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-12 text-center text-[var(--text-muted)]">
                {emptyText}
              </td>
            </tr>
          ) : (
            data.map(row => (
              <tr
                key={keyFn(row)}
                onClick={() => onRowClick?.(row)}
                className={`
                  border-b border-[var(--border)]/50
                  transition-colors duration-100
                  ${onRowClick ? 'cursor-pointer hover:bg-white/5' : ''}
                `}
              >
                {columns.map(col => (
                  <td
                    key={col.key}
                    className={`px-4 py-3 text-${col.align ?? 'left'} text-[var(--text)]`}
                  >
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
