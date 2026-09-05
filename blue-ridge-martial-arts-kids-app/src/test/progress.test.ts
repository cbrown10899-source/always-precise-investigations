import { describe, expect, it } from 'vitest'
import {
  buildSession,
  currentStreak,
  growthLabelFor,
  growthReadings,
  isReadyForDojo,
  lessonCompletion,
  longestStreak,
  practicesThisWeek,
  parseLocalDate,
  readiness,
  weeklyProgress,
} from '../utils/progress'
import { CHECKLIST } from '../data/practice'
import { LESSONS } from '../data/lessons'
import { FIXED_NOW, emptyState, practiceOn } from './helpers'

describe('practice counting', () => {
  it('counts only practices inside the current week', () => {
    const state = emptyState(FIXED_NOW)
    // FIXED_NOW is a Thursday, so the week runs Sun 5 Apr – Sat 11 Apr.
    state.practiceHistory = [
      practiceOn(0, FIXED_NOW), // Thu, in
      practiceOn(2, FIXED_NOW), // Tue, in
      practiceOn(4, FIXED_NOW), // Sun, in
      practiceOn(5, FIXED_NOW), // Sat of the PREVIOUS week, out
      practiceOn(9, FIXED_NOW), // out
    ]
    expect(practicesThisWeek(state.practiceHistory, FIXED_NOW)).toHaveLength(3)
  })

  it('reads a date key in local time, not UTC', () => {
    // '2026-04-09' parsed as UTC would be the 8th anywhere west of Greenwich.
    const d = parseLocalDate('2026-04-09')
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(3)
    expect(d.getDate()).toBe(9)
  })
})

describe('streaks', () => {
  it('is zero with no history', () => {
    expect(currentStreak([], FIXED_NOW)).toBe(0)
  })

  it('counts consecutive days ending today', () => {
    const history = [practiceOn(0, FIXED_NOW), practiceOn(1, FIXED_NOW), practiceOn(2, FIXED_NOW)]
    expect(currentStreak(history, FIXED_NOW)).toBe(3)
  })

  it('keeps a streak alive when the most recent practice was yesterday', () => {
    // Today is not over, so yesterday's practice has not broken anything yet.
    const history = [practiceOn(1, FIXED_NOW), practiceOn(2, FIXED_NOW)]
    expect(currentStreak(history, FIXED_NOW)).toBe(2)
  })

  it('breaks after two silent days', () => {
    const history = [practiceOn(2, FIXED_NOW), practiceOn(3, FIXED_NOW)]
    expect(currentStreak(history, FIXED_NOW)).toBe(0)
  })

  it('counts two practices on one day as one day', () => {
    const history = [practiceOn(0, FIXED_NOW), practiceOn(0, FIXED_NOW), practiceOn(1, FIXED_NOW)]
    expect(currentStreak(history, FIXED_NOW)).toBe(2)
  })

  it('remembers the longest run even after it lapses', () => {
    const history = [
      practiceOn(0, FIXED_NOW),
      practiceOn(5, FIXED_NOW),
      practiceOn(6, FIXED_NOW),
      practiceOn(7, FIXED_NOW),
      practiceOn(8, FIXED_NOW),
    ]
    expect(longestStreak(history)).toBe(4)
    expect(currentStreak(history, FIXED_NOW)).toBe(1)
  })
})

describe('weekly goal', () => {
  it('reports progress against the instructor goal and caps the ratio at 1', () => {
    const state = emptyState(FIXED_NOW)
    state.instructor.weeklyPlan.goalPractices = 4
    state.practiceHistory = [0, 1, 2, 3, 4].map((d) => practiceOn(d, FIXED_NOW))

    const week = weeklyProgress(state, FIXED_NOW)
    expect(week.goal).toBe(4)
    expect(week.done).toBe(5)
    expect(week.met).toBe(true)
    expect(week.ratio).toBe(1)
  })

  it('is not met on an empty week', () => {
    const week = weeklyProgress(emptyState(FIXED_NOW), FIXED_NOW)
    expect(week.done).toBe(0)
    expect(week.met).toBe(false)
  })
})

describe('readiness', () => {
  it('takes its total from the checklist itself', () => {
    expect(readiness(emptyState()).total).toBe(CHECKLIST.length)
  })

  it('ignores a stored id that is not a real checklist item', () => {
    const state = emptyState()
    state.checklist = [CHECKLIST[0].id, 'a-removed-item']
    expect(readiness(state).done).toBe(1)
  })

  it('is ready only when every item is ticked', () => {
    const state = emptyState()
    state.checklist = CHECKLIST.slice(0, -1).map((c) => c.id)
    expect(isReadyForDojo(state)).toBe(false)

    state.checklist = CHECKLIST.map((c) => c.id)
    expect(isReadyForDojo(state)).toBe(true)
  })
})

describe('lesson completion', () => {
  it('is 0 for an untouched lesson and 1 once completed', () => {
    const lesson = LESSONS[0]
    const state = emptyState()
    expect(lessonCompletion(lesson, state)).toBe(0)

    state.lessonProgress[lesson.id] = {
      lessonId: lesson.id,
      currentStepIndex: 0,
      completedStepIds: [],
      completed: true,
      completedAt: new Date().toISOString(),
      repsByStepId: {},
    }
    expect(lessonCompletion(lesson, state)).toBe(1)
  })

  it('counts part-done steps as a fraction', () => {
    const lesson = LESSONS[0]
    const state = emptyState()
    state.lessonProgress[lesson.id] = {
      lessonId: lesson.id,
      currentStepIndex: 2,
      completedStepIds: lesson.steps.slice(0, 3).map((s) => s.id),
      completed: false,
      completedAt: null,
      repsByStepId: {},
    }
    expect(lessonCompletion(lesson, state)).toBeCloseTo(3 / lesson.steps.length)
  })

  it('ignores a stored step id the lesson no longer has', () => {
    const lesson = LESSONS[0]
    const state = emptyState()
    state.lessonProgress[lesson.id] = {
      lessonId: lesson.id,
      currentStepIndex: 0,
      completedStepIds: ['a-step-that-was-removed'],
      completed: false,
      completedAt: null,
      repsByStepId: {},
    }
    expect(lessonCompletion(lesson, state)).toBe(0)
  })
})

describe('growth', () => {
  it('never reports a percentage — only the four labels', () => {
    const readings = growthReadings(emptyState(FIXED_NOW), FIXED_NOW)
    const allowed = ['Building', 'Improving', 'Strong', 'Excellent']
    for (const reading of readings) {
      expect(allowed).toContain(reading.level)
      expect(reading.basis).not.toMatch(/%/)
    }
  })

  it('maps counts onto ascending labels', () => {
    expect(growthLabelFor(0, [1, 3, 5])).toBe('Building')
    expect(growthLabelFor(1, [1, 3, 5])).toBe('Improving')
    expect(growthLabelFor(3, [1, 3, 5])).toBe('Strong')
    expect(growthLabelFor(9, [1, 3, 5])).toBe('Excellent')
  })

  it('rises as the student actually does more', () => {
    const consistency = (days: number[]) => {
      const state = emptyState(FIXED_NOW)
      state.practiceHistory = days.map((d) => practiceOn(d, FIXED_NOW))
      return growthReadings(state, FIXED_NOW).find((r) => r.id === 'consistency')!.level
    }

    // Consistency reads the streak against thresholds [1, 3, 5].
    expect(consistency([])).toBe('Building')
    expect(consistency([0])).toBe('Improving')
    expect(consistency([0, 1, 2, 3])).toBe('Strong')
    expect(consistency([0, 1, 2, 3, 4])).toBe('Excellent')
  })

  it('states the activity behind every reading, so no label is mysterious', () => {
    const state = emptyState(FIXED_NOW)
    state.practiceHistory = [practiceOn(0, FIXED_NOW)]
    for (const reading of growthReadings(state, FIXED_NOW)) {
      expect(reading.basis.trim().length).toBeGreaterThan(0)
    }
  })
})

describe('buildSession', () => {
  it('records the day in local time and de-duplicates skills', () => {
    const session = buildSession(
      'daily-10',
      "Today's Practice",
      ['stance', 'stance', 'balance'],
      6,
      6,
      10,
      FIXED_NOW,
    )
    expect(session.date).toBe('2026-04-09')
    expect(session.skills).toEqual(['stance', 'balance'])
    expect(session.stepsCompleted).toBe(6)
  })

  it('never records a zero-minute practice', () => {
    const session = buildSession('quick-5', 'Quick', ['stance'], 5, 5, 0, FIXED_NOW)
    expect(session.minutes).toBeGreaterThanOrEqual(1)
  })
})
