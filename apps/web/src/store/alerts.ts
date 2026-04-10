'use client'

import { create } from 'zustand'

interface AlertTrigger {
  alertId:     string
  triggeredAt: number
  event:       Record<string, unknown>
  read:        boolean
}

interface AlertsState {
  triggers:   AlertTrigger[]
  unreadCount: number
  addTrigger:  (t: Omit<AlertTrigger, 'read'>) => void
  markRead:    (alertId: string) => void
  markAllRead: () => void
}

export const useAlertsStore = create<AlertsState>((set) => ({
  triggers:    [],
  unreadCount: 0,

  addTrigger: (t) => set(state => ({
    triggers:    [{ ...t, read: false }, ...state.triggers].slice(0, 100),
    unreadCount: state.unreadCount + 1,
  })),

  markRead: (alertId) => set(state => ({
    triggers: state.triggers.map(t =>
      t.alertId === alertId ? { ...t, read: true } : t
    ),
    unreadCount: Math.max(0, state.unreadCount - 1),
  })),

  markAllRead: () => set(state => ({
    triggers:    state.triggers.map(t => ({ ...t, read: true })),
    unreadCount: 0,
  })),
}))
