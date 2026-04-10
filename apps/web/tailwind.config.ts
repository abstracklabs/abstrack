import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  // Safelist : classes dynamiques construites par string interpolation dans AlphaFeed
  safelist: [
    'bg-orange-500/8',  'border-orange-500/15', 'text-orange-400', 'bg-orange-400',
    'bg-red-500/8',     'border-red-500/15',    'text-red-400',    'bg-red-400',
    'bg-purple-500/8',  'border-purple-500/15', 'text-purple-400', 'bg-purple-400',
    'bg-blue-500/8',    'border-blue-500/15',   'text-blue-400',   'bg-blue-400',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'JetBrains Mono', 'monospace'],
      },
      colors: {
        border:   'var(--border)',
        bg: {
          base:     'var(--bg-base)',
          surface:  'var(--bg-surface)',
          elevated: 'var(--bg-elevated)',
        },
      },
      animation: {
        'flash-green': 'flash-green 0.8s ease-out forwards',
        'flash-red':   'flash-red   0.8s ease-out forwards',
        'slide-in':    'slide-in-right 0.25s ease-out',
        'ticker':      'ticker 40s linear infinite',
      },
      backgroundImage: {
        'grid-pattern': `
          linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)
        `,
      },
      backgroundSize: {
        'grid': '32px 32px',
      },
    },
  },
  plugins: [],
}

export default config
