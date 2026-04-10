'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ConnectionStatus } from '../live/AlertToast'

const NAV = [
  {
    label: 'Overview',
    items: [
      { href: '/',           icon: GridIcon,   label: 'Dashboard'   },
      { href: '/analytics',  icon: ChartIcon,  label: 'Analytics'   },
    ],
  },
  {
    label: 'Discover',
    items: [
      { href: '/collections', icon: ImageIcon, label: 'Collections'  },
      { href: '/tokens',      icon: CoinIcon,  label: 'Tokens'       },
      { href: '/whales',      icon: WhaleIcon, label: 'Whales'       },
    ],
  },
  {
    label: 'Tools',
    items: [
      { href: '/wallet',     icon: WalletIcon, label: 'Wallet Tracker' },
      { href: '/alerts',     icon: BellIcon,   label: 'Alerts'          },
    ],
  },
]

export function Sidebar() {
  const pathname = usePathname()

  return (
    <aside className="fixed left-0 top-0 h-screen w-56 flex flex-col glass border-r border-[var(--border)] z-40">

      {/* Logo */}
      <div className="px-5 py-5 border-b border-[var(--border)]">
        <div className="flex items-center gap-2.5">
          <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
            <span className="text-white text-xs font-black">A</span>
          </div>
          <span className="font-bold text-white tracking-tight">Abstrack</span>
        </div>
        <p className="text-xs text-[var(--text-muted)] mt-0.5 pl-9">Abstract Chain</p>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-4 px-3">
        {NAV.map((group) => (
          <div key={group.label} className="mb-6">
            <p className="text-[10px] uppercase tracking-widest text-[var(--text-muted)] px-2 mb-2">
              {group.label}
            </p>
            <ul className="space-y-0.5">
              {group.items.map(({ href, icon: Icon, label }) => {
                const active = pathname === href || (href !== '/' && pathname.startsWith(href))
                return (
                  <li key={href}>
                    <Link
                      href={href}
                      className={`
                        flex items-center gap-3 px-3 py-2 rounded-lg text-sm
                        transition-all duration-150
                        ${active
                          ? 'bg-blue-500/15 text-blue-400 font-medium'
                          : 'text-[var(--text-muted)] hover:text-white hover:bg-white/5'
                        }
                      `}
                    >
                      <Icon size={16} />
                      {label}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-4 py-4 border-t border-[var(--border)]">
        <ConnectionStatus />
        <p className="text-[10px] text-[var(--text-muted)] mt-1">
          Abstract · Chain ID 2741
        </p>
      </div>
    </aside>
  )
}

// ─── Icons (inline SVG pour ne pas dépendre d'une lib) ───────────────────────

function GridIcon({ size = 16 }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <rect x="1" y="1" width="6" height="6" rx="1"/><rect x="9" y="1" width="6" height="6" rx="1"/>
    <rect x="1" y="9" width="6" height="6" rx="1"/><rect x="9" y="9" width="6" height="6" rx="1"/>
  </svg>
}
function ChartIcon({ size = 16 }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <polyline points="1,12 5,7 9,9 15,3"/><line x1="1" y1="15" x2="15" y2="15"/>
  </svg>
}
function ImageIcon({ size = 16 }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <rect x="1" y="1" width="14" height="14" rx="2"/>
    <circle cx="5.5" cy="5.5" r="1.5"/><polyline points="1,11 5,7 8,10 11,8 15,12"/>
  </svg>
}
function CoinIcon({ size = 16 }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <circle cx="8" cy="8" r="7"/><path d="M8 4v1m0 6v1M6 8h4m-2-2v4"/>
  </svg>
}
function WhaleIcon({ size = 16 }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <path d="M2 10c1-5 8-7 11-4-1 3-4 5-7 5H2z"/><path d="M13 6c1-2 2-4 1-5"/>
  </svg>
}
function WalletIcon({ size = 16 }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <rect x="1" y="3" width="14" height="11" rx="2"/>
    <path d="M1 7h14"/><circle cx="11.5" cy="11" r="1"/>
  </svg>
}
function BellIcon({ size = 16 }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <path d="M8 1a5 5 0 0 1 5 5v4l1 1H2l1-1V6a5 5 0 0 1 5-5z"/>
    <path d="M6.5 13a1.5 1.5 0 0 0 3 0"/>
  </svg>
}
