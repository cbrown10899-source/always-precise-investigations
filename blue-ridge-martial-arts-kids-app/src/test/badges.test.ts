import { describe, expect, it } from 'vitest'
import { BADGE_RULES, applyBadges, awardBadges, hasBadge, newlyEarnedBadges } from '../utils/badges'
import { BADGES } from '../data/badges'
import { LESSONS } from '../data/lessons'
import { CHECKLIST } from '../data/practice'
import { FIXED_NOW, emptyState, practiceOn } from './helpers'
import type { AppState, BadgeId } from '../types'

/** Marks a lesson complete, the way the lesson screen does. */
function completeLesson(state: AppState, lessonId: string) {
  state.lessonProgress[lessonId] = {
    lessonId,
    currentStepIndex: 0,
    completedStepIds: [],
    completed: true,
    completedAt: FIXED_NOW.toISOString(),
    repsByStepId: {},
  }
}

describe('the catalogue and the rules agree', () => {
  it('every badge in the catalogue has a rule', () => {
    for (const badge of BADGES) {
      expect(BADGE_RULES[badge.id], `no rule for ${badge.id}`).toBeTypeOf('function')
    }
  })

  it('every rule names a badge in the catalogue', () => {
    const known = new Set(BADGES.map((b) => b.id))
    for (const id of Object.keys(BADGE_RULES) as BadgeId[]) {
      expect(known.has(id), `rule ${id} has no badge`).toBe(true)
    }
  })

  it('every badge states how it is earned', () => {
    for (const badge of BADGES) {
      expect(badge.requirement.trim().length).toBeGreaterThan(0)
      expect(badge.description.trim().length).toBeGreaterThan(0)
    }
  })
})

describe('nothing is earned by doing nothing', () => {
  it('a fresh, empty student holds no badges', () => {
    expect(newlyEarnedBadges(emptyState(FIXED_NOW), FIXED_NOW)).toEqual([])
  })
})

describe('each badge unlocks on its own stated requirement', () => {
  it('First Practice: one practice', () => {
    const state = emptyState(FIXED_NOW)
    expect(newlyEarnedBadges(state, FIXED_NOW)).not.toContain('first-practice')
    state.practiceHistory = [practiceOn(0, FIXED_NOW)]
    expect(newlyEarnedBadges(state, FIXED_NOW)).toContain('first-practice')
  })

  it('3 Day Streak: three consecutive days, not three practices', () => {
    const sameDay = emptyState(FIXED_NOW)
    sameDay.practiceHistory = [0, 0, 0].map((d) => practiceOn(d, FIXED_NOW))
    expect(newlyEarnedBadges(sameDay, FIXED_NOW)).not.toContain('three-day-streak')

    const threeDays = emptyState(FIXED_NOW)
    threeDays.practiceHistory = [0, 1, 2].map((d) => practiceOn(d, FIXED_NOW))
    expect(newlyEarnedBadges(threeDays, FIXED_NOW)).toContain('three-day-streak')
  })

  it('Hard Worker: five practices', () => {
    const four = emptyState(FIXED_NOW)
    four.practiceHistory = [0, 1, 2, 3].map((d) => practiceOn(d, FIXED_NOW))
    expect(newlyEarnedBadges(four, FIXED_NOW)).not.toContain('hard-worker')

    const five = emptyState(FIXED_NOW)
    five.practiceHistory = [0, 1, 2, 3, 4].map((d) => practiceOn(d, FIXED_NOW))
    expect(newlyEarnedBadges(five, FIXED_NOW)).toContain('hard-worker')
  })

  it('Great Listener: one completed lesson', () => {
    const state = emptyState(FIXED_NOW)
    expect(newlyEarnedBadges(state, FIXED_NOW)).not.toContain('great-listener')
    completeLesson(state, LESSONS[0].id)
    expect(newlyEarnedBadges(state, FIXED_NOW)).toContain('great-listener')
  })

  it('Good Attitude: a CHARACTER lesson specifically', () => {
    const beltLesson = LESSONS.find((l) => l.category === 'belt')!
    const characterLesson = LESSONS.find((l) => l.category === 'character')!

    const state = emptyState(FIXED_NOW)
    completeLesson(state, beltLesson.id)
    expect(newlyEarnedBadges(state, FIXED_NOW)).not.toContain('good-attitude')

    completeLesson(state, characterLesson.id)
    expect(newlyEarnedBadges(state, FIXED_NOW)).toContain('good-attitude')
  })

  it('Ready for Dojo: the whole checklist', () => {
    const state = emptyState(FIXED_NOW)
    state.checklist = CHECKLIST.slice(0, -1).map((c) => c.id)
    expect(newlyEarnedBadges(state, FIXED_NOW)).not.toContain('ready-for-dojo')

    state.checklist = CHECKLIST.map((c) => c.id)
    expect(newlyEarnedBadges(state, FIXED_NOW)).toContain('ready-for-dojo')
  })

  it('Practice Champion: the weekly goal met', () => {
    const state = emptyState(FIXED_NOW)
    state.instructor.weeklyPlan.goalPractices = 4
    state.practiceHistory = [0, 1, 2].map((d) => practiceOn(d, FIXED_NOW))
    expect(newlyEarnedBadges(state, FIXED_NOW)).not.toContain('practice-champion')

    state.practiceHistory.push(practiceOn(3, FIXED_NOW))
    expect(newlyEarnedBadges(state, FIXED_NOW)).toContain('practice-champion')
  })

  it('Balance Builder: three practices that include balance', () => {
    const state = emptyState(FIXED_NOW)
    state.practiceHistory = [0, 1, 2].map((d) => practiceOn(d, FIXED_NOW, ['stance']))
    expect(newlyEarnedBadges(state, FIXED_NOW)).not.toContain('balance-builder')

    state.practiceHistory = [0, 1, 2].map((d) => practiceOn(d, FIXED_NOW, ['stance', 'balance']))
    expect(newlyEarnedBadges(state, FIXED_NOW)).toContain('balance-builder')
  })
})

describe('awarding', () => {
  it('does not award the same badge twice', () => {
    const state = emptyState(FIXED_NOW)
    state.practiceHistory = [practiceOn(0, FIXED_NOW)]

    const first = applyBadges(state, FIXED_NOW)
    expect(first.earned).toContain('first-practice')

    const second = applyBadges(first.state, FIXED_NOW)
    expect(second.earned).not.toContain('first-practice')
    expect(second.state.earnedBadges.filter((b) => b.badgeId === 'first-practice')).toHaveLength(1)
  })

  it('never takes a badge away once the streak lapses', () => {
    const state = emptyState(FIXED_NOW)
    state.practiceHistory = [0, 1, 2].map((d) => practiceOn(d, FIXED_NOW))
    const { state: earnedState } = applyBadges(state, FIXED_NOW)
    expect(hasBadge(earnedState, 'three-day-streak')).toBe(true)

    // Two weeks later, with nothing done since.
    const later = new Date(FIXED_NOW)
    later.setDate(later.getDate() + 14)
    const { state: afterLapse } = applyBadges(earnedState, later)
    expect(hasBadge(afterLapse, 'three-day-streak')).toBe(true)
  })

  it('records when a badge was earned', () => {
    const state = emptyState(FIXED_NOW)
    state.practiceHistory = [practiceOn(0, FIXED_NOW)]
    const { state: next } = applyBadges(state, FIXED_NOW)
    const record = next.earnedBadges.find((b) => b.badgeId === 'first-practice')!
    expect(record.earnedAt).toBe(FIXED_NOW.toISOString())
  })

  it('leaves the state untouched when nothing was earned', () => {
    const state = emptyState(FIXED_NOW)
    const result = applyBadges(state, FIXED_NOW)
    expect(result.earned).toEqual([])
    expect(result.state).toBe(state)
  })

  it('awardBadges ignores ids already held', () => {
    const state = emptyState(FIXED_NOW)
    state.earnedBadges = [{ badgeId: 'first-practice', earnedAt: FIXED_NOW.toISOString() }]
    const next = awardBadges(state, ['first-practice', 'hard-worker'], FIXED_NOW)
    expect(next).toHaveLength(2)
    expect(next.filter((b) => b.badgeId === 'first-practice')).toHaveLength(1)
  })
})
