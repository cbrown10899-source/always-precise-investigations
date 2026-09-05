import { describe, expect, it } from 'vitest'
import { createDefaultState } from '../data/defaultState'
import { loadState, resetState, saveState } from '../utils/storage'
import { LESSONS } from '../data/lessons'
import { SKILLS } from '../data/skills'
import {
  readiness,
  todayPlan,
  weeklyProgress,
} from '../utils/progress'
import { CHECKLIST } from '../data/practice'
import { FIXED_NOW, emptyState, practiceOn } from './helpers'
import type { AppState } from '../types'

/**
 * Instructor settings propagation.
 *
 * `state.instructor` is the ONE place the child's app reads these values from,
 * so an instructor change reaching the student is a property of the shape
 * rather than of a sync step. These tests pin that at the data layer;
 * `app.test.tsx` pins the same thing through the real screens.
 */

function withInstructor(recipe: (s: AppState) => void, now = FIXED_NOW): AppState {
  const state = emptyState(now)
  recipe(state)
  return state
}

describe('the weekly goal is the instructor’s, not a constant', () => {
  it('changing the goal changes what the student is measured against', () => {
    const state = withInstructor((s) => {
      s.instructor.weeklyPlan.goalPractices = 4
      s.practiceHistory = [0, 1, 2].map((d) => practiceOn(d, FIXED_NOW))
    })
    expect(weeklyProgress(state, FIXED_NOW).met).toBe(false)

    state.instructor.weeklyPlan.goalPractices = 3
    expect(weeklyProgress(state, FIXED_NOW).met).toBe(true)

    state.instructor.weeklyPlan.goalPractices = 7
    const week = weeklyProgress(state, FIXED_NOW)
    expect(week.goal).toBe(7)
    expect(week.met).toBe(false)
  })

  it('a goal of zero cannot make every week vacuously complete', () => {
    // The instructor form clamps to 1, but the calculation must not depend on
    // the form having done so — a stored zero would otherwise divide by zero
    // and read as "goal met" on an empty week.
    const state = withInstructor((s) => {
      s.instructor.weeklyPlan.goalPractices = 0
    })
    const week = weeklyProgress(state, FIXED_NOW)
    expect(week.goal).toBeGreaterThanOrEqual(1)
    expect(week.met).toBe(false)
    expect(Number.isFinite(week.ratio)).toBe(true)
  })
})

describe('the weekly plan decides what a day is', () => {
  it('todayPlan reads the instructor’s plan for the actual weekday', () => {
    // FIXED_NOW is a Thursday (day 4), which the seeded plan calls a dojo day.
    const state = emptyState(FIXED_NOW)
    expect(todayPlan(state, FIXED_NOW).kind).toBe('dojo')

    // Move the class to Tuesday and Thursday becomes a home practice day.
    state.instructor.weeklyPlan.days = state.instructor.weeklyPlan.days.map((d) =>
      d.dayIndex === 4 ? { ...d, kind: 'home' as const, label: 'Home Practice' } : d,
    )
    expect(todayPlan(state, FIXED_NOW).kind).toBe('home')
  })

  it('reports a rest day as a rest day, so the screen never urges practice', () => {
    const state = emptyState(FIXED_NOW)
    state.instructor.weeklyPlan.days = state.instructor.weeklyPlan.days.map((d) =>
      d.dayIndex === 4 ? { ...d, kind: 'rest' as const, label: 'Rest & Grow' } : d,
    )
    const plan = todayPlan(state, FIXED_NOW)
    expect(plan.kind).toBe('rest')
    expect(plan.label).toBe('Rest & Grow')
  })

  it('falls back to a home practice day rather than throwing on a gap', () => {
    const state = emptyState(FIXED_NOW)
    state.instructor.weeklyPlan.days = []
    expect(todayPlan(state, FIXED_NOW).kind).toBe('home')
  })

  it('knows whether today has been practised', () => {
    const before = emptyState(FIXED_NOW)
    expect(todayPlan(before, FIXED_NOW).practisedToday).toBe(false)

    before.practiceHistory = [practiceOn(0, FIXED_NOW)]
    expect(todayPlan(before, FIXED_NOW).practisedToday).toBe(true)
  })
})

describe('lesson availability is the instructor’s switch', () => {
  it('an unlisted lesson is not offered', () => {
    const state = emptyState()
    expect(state.instructor.availableLessonIds).toContain('front-kick-basics')

    state.instructor.availableLessonIds = state.instructor.availableLessonIds.filter(
      (id) => id !== 'front-kick-basics',
    )
    const offered = LESSONS.filter((l) => state.instructor.availableLessonIds.includes(l.id))
    expect(offered.map((l) => l.id)).not.toContain('front-kick-basics')
    expect(offered.length).toBe(LESSONS.length - 1)
  })

  it('every seeded lesson is available by default', () => {
    const state = createDefaultState()
    expect([...state.instructor.availableLessonIds].sort()).toEqual(
      LESSONS.map((l) => l.id).sort(),
    )
  })
})

describe('the belt and the goal are the instructor’s', () => {
  it('a belt change is what the student’s screens read', () => {
    const state = emptyState()
    expect(state.instructor.currentBeltId).toBe('white')
    state.instructor.currentBeltId = 'white-2'
    expect(state.instructor.currentBeltId).toBe('white-2')

    // And it survives a save/load, which is what makes it visible tomorrow.
    saveState(state)
    expect(loadState().instructor.currentBeltId).toBe('white-2')
  })

  it('an unset test window stays empty rather than being guessed', () => {
    expect(createDefaultState().instructor.testWindow).toBe('')
  })
})

describe('the focus list is the instructor’s', () => {
  it('every seeded focus skill is a real skill', () => {
    const known = new Set(SKILLS.map((s) => s.id))
    for (const id of createDefaultState().instructor.weeklyFocusSkillIds) {
      expect(known.has(id), `${id} is not a skill`).toBe(true)
    }
  })

  it('the seeded focus matches the brief: stance, punch, kick, balance, focus', () => {
    expect(createDefaultState().instructor.weeklyFocusSkillIds).toEqual([
      'stance',
      'punches',
      'kicks',
      'balance',
      'focus',
    ])
  })

  it('an empty focus list is a legal state, not a crash', () => {
    const state = emptyState()
    state.instructor.weeklyFocusSkillIds = []
    saveState(state)
    expect(loadState().instructor.weeklyFocusSkillIds).toEqual([])
  })
})

describe('the parent insight is authored, never generated', () => {
  it('is seeded from the instructor record and survives a round trip', () => {
    const state = emptyState()
    state.instructor.insight.practiced = ['Ready stance', 'Straight punches']
    state.instructor.insight.workOnNext = ['Hands return to guard']
    state.instructor.insight.instructorNote = 'Great focus this week.'
    state.instructor.insight.instructorName = 'Sensei Rivera'
    saveState(state)

    const loaded = loadState().instructor.insight
    expect(loaded.practiced).toEqual(['Ready stance', 'Straight punches'])
    expect(loaded.workOnNext).toEqual(['Hands return to guard'])
    expect(loaded.instructorNote).toBe('Great focus this week.')
    expect(loaded.instructorName).toBe('Sensei Rivera')
  })

  it('an unnamed instructor stays null rather than becoming a placeholder', () => {
    expect(createDefaultState().instructor.insight.instructorName).toBeNull()
    expect(createDefaultState().instructor.insight.updatedAt).toBeNull()
  })
})

describe('attendance is a record the instructor writes', () => {
  it('starts empty — the app invents no attendance', () => {
    expect(createDefaultState().instructor.attendance).toEqual([])
  })

  it('persists and is readable back', () => {
    const state = emptyState()
    state.instructor.attendance = [
      { id: 'a1', date: '2026-04-02', status: 'present', className: 'Thursday Dojo Class' },
      { id: 'a2', date: '2026-04-09', status: 'absent', className: 'Thursday Dojo Class' },
    ]
    saveState(state)
    const loaded = loadState().instructor.attendance
    expect(loaded).toHaveLength(2)
    expect(loaded.filter((a) => a.status === 'present')).toHaveLength(1)
  })
})

describe('reset restores the instructor’s defaults too', () => {
  it('clears every instructor edit', () => {
    const state = createDefaultState()
    state.instructor.currentBeltId = 'blue'
    state.instructor.weeklyPlan.goalPractices = 9
    state.instructor.weeklyPlan.mission = 'Something else'
    state.instructor.availableLessonIds = []
    state.instructor.insight.instructorName = 'Someone'
    state.instructor.attendance = [
      { id: 'a1', date: '2026-04-02', status: 'present', className: 'x' },
    ]
    state.checklist = CHECKLIST.map((c) => c.id)
    saveState(state)

    const fresh = resetState()
    expect(fresh.instructor.currentBeltId).toBe('white')
    expect(fresh.instructor.weeklyPlan.goalPractices).toBe(4)
    expect(fresh.instructor.weeklyPlan.mission).toBe('Practice with Purpose')
    expect(fresh.instructor.availableLessonIds).toHaveLength(LESSONS.length)
    expect(fresh.instructor.insight.instructorName).toBeNull()
    expect(fresh.instructor.attendance).toEqual([])
    expect(readiness(fresh).done).toBe(0)
  })

  it('does not leak state between resets', () => {
    const first = resetState()
    first.student.firstName = 'Changed'
    saveState(first)
    const second = resetState()
    expect(second.student.firstName).toBe('Alex')
  })
})
