import type { AppState, BadgeId, EarnedBadge } from '../types'
import { BADGES } from '../data/badges'
import { LESSONS } from '../data/lessons'
import {
  currentStreak,
  completedLessonIds,
  isReadyForDojo,
  weeklyProgress,
} from './progress'

/**
 * Badge rules.
 *
 * This is the ONE place a badge is decided. `data/badges.ts` states each
 * requirement in the child's own words, and the badge test holds the two
 * together: every badge in the catalogue must have a rule here, and every rule
 * must name a badge in the catalogue. A badge the app awards but never
 * explains, or explains but never awards, is the app telling a child something
 * untrue.
 *
 * Badges are never taken away. A three-day streak that later lapses was still
 * earned — removing it would rewrite history to match the present, which is
 * the opposite of what a record is for.
 */
type Rule = (state: AppState, now: Date) => boolean

export const BADGE_RULES: Record<BadgeId, Rule> = {
  'first-practice': (s) => s.practiceHistory.length >= 1,

  'three-day-streak': (s, now) => currentStreak(s.practiceHistory, now) >= 3,

  'great-listener': (s) => completedLessonIds(s).length >= 1,

  'hard-worker': (s) => s.practiceHistory.length >= 5,

  'ready-for-dojo': (s) => isReadyForDojo(s),

  'practice-champion': (s, now) => weeklyProgress(s, now).met,

  'good-attitude': (s) => {
    const characterIds = new Set(
      LESSONS.filter((l) => l.category === 'character').map((l) => l.id),
    )
    return completedLessonIds(s).some((id) => characterIds.has(id))
  },

  'balance-builder': (s) =>
    s.practiceHistory.filter((p) => p.skills.includes('balance')).length >= 3,
}

/**
 * Returns the badges newly earned by this state — those whose rule now passes
 * and which are not already held. It does NOT mutate; the caller decides
 * whether to record them, which is what lets the UI show a celebration for
 * exactly the badges that just unlocked.
 */
export function newlyEarnedBadges(state: AppState, now: Date = new Date()): BadgeId[] {
  const held = new Set(state.earnedBadges.map((b) => b.badgeId))
  const earned: BadgeId[] = []
  for (const badge of BADGES) {
    if (held.has(badge.id)) continue
    const rule = BADGE_RULES[badge.id]
    if (rule && rule(state, now)) earned.push(badge.id)
  }
  return earned
}

/** Appends newly earned badges, leaving existing ones untouched. */
export function awardBadges(state: AppState, ids: BadgeId[], now: Date = new Date()): EarnedBadge[] {
  if (ids.length === 0) return state.earnedBadges
  const held = new Set(state.earnedBadges.map((b) => b.badgeId))
  const additions = ids
    .filter((id) => !held.has(id))
    .map((id) => ({ badgeId: id, earnedAt: now.toISOString() }))
  return [...state.earnedBadges, ...additions]
}

/** Applies both steps: works out what is new, and returns the state carrying
 *  it, plus the ids that were added so the caller can celebrate them. */
export function applyBadges(
  state: AppState,
  now: Date = new Date(),
): { state: AppState; earned: BadgeId[] } {
  const earned = newlyEarnedBadges(state, now)
  if (earned.length === 0) return { state, earned }
  return { state: { ...state, earnedBadges: awardBadges(state, earned, now) }, earned }
}

export function hasBadge(state: AppState, id: BadgeId): boolean {
  return state.earnedBadges.some((b) => b.badgeId === id)
}
