import type { AppState, PracticeSession, SkillId } from '../types'
import { createDefaultState } from '../data/defaultState'
import { isoDate } from '../utils/dates'

/** A state with NO seeded practices, so a test asserts on what it put there. */
export function emptyState(now = new Date()): AppState {
  return { ...createDefaultState(now), practiceHistory: [] }
}

/** A practice on the day `daysAgo` before `from`. */
export function practiceOn(
  daysAgo: number,
  from = new Date(),
  skills: SkillId[] = ['stance'],
): PracticeSession {
  const d = new Date(from)
  d.setDate(d.getDate() - daysAgo)
  return {
    id: `p-${daysAgo}-${Math.random().toString(36).slice(2, 7)}`,
    routineId: 'daily-10',
    routineTitle: "Today's Practice",
    date: isoDate(d),
    completedAt: d.toISOString(),
    minutes: 10,
    stepsCompleted: 6,
    stepsTotal: 6,
    skills,
  }
}

/** A fixed date to reason against, so a test never depends on "now". */
export const FIXED_NOW = new Date(2026, 3, 9, 18, 0, 0) // Thu 9 Apr 2026, local
