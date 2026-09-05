import type { AppState } from '../types'
import { SCHEMA_VERSION, createDefaultState } from '../data/defaultState'

export const STORAGE_KEY = 'brma.kids.v1'

/**
 * The persistence boundary.
 *
 * Everything the app stores goes through `loadState` / `saveState`, and
 * nothing else in the codebase touches `localStorage`. That is what makes the
 * future backend swap a change to this one file: replace the two functions
 * with API calls (and make them async) and no screen has to be rewritten. The
 * storage test asserts the rest of `src/` contains no other `localStorage`
 * reference.
 *
 * Every access is wrapped, because `localStorage` does not merely return null
 * in a private window or with site data blocked — the accessor itself throws.
 */

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function writeRaw(value: string): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, value)
    return true
  } catch {
    // A full quota or a blocked store must not break the app. The session
    // still works; it just will not survive a reload.
    return false
  }
}

function removeRaw(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* nothing to do — the same conditions that block a write block a remove */
  }
}

/**
 * Reads the stored state, or a fresh default.
 *
 * A stored blob is merged ONTO the defaults rather than used as-is: a build
 * that adds a field must not read `undefined` out of a browser that stored the
 * previous shape. A version mismatch discards rather than guesses — a wrong
 * migration silently corrupts a child's record, and this is demo data.
 */
export function loadState(): AppState {
  const raw = readRaw()
  if (!raw) return createDefaultState()

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return createDefaultState()
  }

  if (!parsed || typeof parsed !== 'object') return createDefaultState()
  const candidate = parsed as Partial<AppState>
  if (candidate.schemaVersion !== SCHEMA_VERSION) return createDefaultState()

  return mergeState(createDefaultState(), candidate)
}

/** Fills any absent branch from the defaults. Shallow per top-level key, plus
 *  one level into the two nested objects that screens read field by field. */
function mergeState(base: AppState, stored: Partial<AppState>): AppState {
  return {
    schemaVersion: SCHEMA_VERSION,
    student: { ...base.student, ...stored.student },
    instructor: {
      ...base.instructor,
      ...stored.instructor,
      weeklyPlan: { ...base.instructor.weeklyPlan, ...stored.instructor?.weeklyPlan },
      classSession: { ...base.instructor.classSession, ...stored.instructor?.classSession },
      insight: { ...base.instructor.insight, ...stored.instructor?.insight },
    },
    dojo: { ...base.dojo, ...stored.dojo },
    lessonProgress: stored.lessonProgress ?? base.lessonProgress,
    practiceHistory: stored.practiceHistory ?? base.practiceHistory,
    checklist: stored.checklist ?? base.checklist,
    earnedBadges: stored.earnedBadges ?? base.earnedBadges,
    settings: { ...base.settings, ...stored.settings },
  }
}

/** Persists the state. Returns false when the browser refused the write, so a
 *  caller can tell the difference rather than assume it landed. */
export function saveState(state: AppState): boolean {
  try {
    return writeRaw(JSON.stringify(state))
  } catch {
    return false
  }
}

/** Clears everything and returns the fresh default — the Reset Demo path. */
export function resetState(): AppState {
  removeRaw()
  const fresh = createDefaultState()
  saveState(fresh)
  return fresh
}
