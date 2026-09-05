import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AppState, BadgeId } from '../types'
import { loadState, resetState, saveState } from '../utils/storage'
import { applyBadges } from '../utils/badges'
import { AppContext, type AppStore } from './context'

/**
 * Holds the whole app state and is the only thing that writes it.
 *
 * `update` takes a recipe rather than a patch so a caller that needs to read
 * the current value to compute the next one cannot race with another update —
 * the same reason the firm's portal resolves untouched fields inside the
 * UPDATE rather than from a value read a moment earlier.
 */
export function StoreProvider({ children }: { children: ReactNode }) {
  // Badges are settled ON LOAD as well as on update.
  //
  // They were only ever awarded inside `update`, so a state that arrived
  // already deserving one never got it: the seeded demo carries two completed
  // practices and drew "0 of 9" with First Practice — requirement "Complete 1
  // practice" — showing as locked. A locked badge whose own stated
  // requirement is already met is the app telling a child something untrue.
  //
  // Awarding here is silent: `justEarned` stays empty, because nobody just
  // did anything and a celebration for work done last week would be its own
  // small lie.
  const [state, setState] = useState<AppState>(() => applyBadges(loadState()).state)
  const [justEarned, setJustEarned] = useState<BadgeId[]>([])
  const [persisted, setPersisted] = useState(true)

  // Badge awards happen inside the state updater, which React may run twice in
  // StrictMode. Collecting the ids in a ref and flushing them in an effect
  // keeps the updater free of side effects.
  const pendingBadges = useRef<BadgeId[]>([])

  const update = useCallback((recipe: (draft: AppState) => AppState) => {
    setState((current) => {
      const next = recipe(current)
      const { state: withBadges, earned } = applyBadges(next)
      if (earned.length > 0) pendingBadges.current = earned
      return withBadges
    })
  }, [])

  // One write per settled state, rather than one per action.
  useEffect(() => {
    setPersisted(saveState(state))
    if (pendingBadges.current.length > 0) {
      setJustEarned(pendingBadges.current)
      pendingBadges.current = []
    }
  }, [state])

  // The two display settings are applied to the document root so the CSS can
  // key off them, exactly as it keys off the OS preference.
  useEffect(() => {
    const root = document.documentElement
    root.dataset.reduceMotion = String(state.settings.reduceMotion)
    root.dataset.largeText = String(state.settings.largeText)
  }, [state.settings.reduceMotion, state.settings.largeText])

  const reset = useCallback(() => {
    pendingBadges.current = []
    setJustEarned([])
    // Same rule as the initial load: the fresh demo carries seeded practices,
    // so the badges those practices earn are settled immediately and silently.
    const fresh = applyBadges(resetState()).state
    saveState(fresh)
    setState(fresh)
  }, [])

  const clearJustEarned = useCallback(() => setJustEarned([]), [])

  const value = useMemo<AppStore>(
    () => ({ state, update, justEarned, clearJustEarned, reset, persisted }),
    [state, update, justEarned, clearJustEarned, reset, persisted],
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}
