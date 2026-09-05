import { createContext } from 'react'
import type { AppState, BadgeId } from '../types'

/**
 * The store contract.
 *
 * Screens receive `state` and call an action; nothing outside the provider
 * writes to storage or recomputes badges. That single write path is what makes
 * "completing a practice updates the streak, the badges and the readiness"
 * true by construction rather than by every caller remembering to do it.
 */
export interface AppStore {
  state: AppState
  /** Applies a change, persists it, and awards any badges it unlocked. */
  update: (recipe: (draft: AppState) => AppState) => void
  /** Badge ids unlocked by the most recent update, for the celebration. */
  justEarned: BadgeId[]
  /** Clears the celebration once it has been shown. */
  clearJustEarned: () => void
  /** Restores the seeded demo data. */
  reset: () => void
  /** False when the browser refused the last write (private mode, full quota). */
  persisted: boolean
}

export const AppContext = createContext<AppStore | null>(null)
