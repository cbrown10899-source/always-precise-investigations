import { describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { STORAGE_KEY, loadState, resetState, saveState } from '../utils/storage'
import { SCHEMA_VERSION, createDefaultState } from '../data/defaultState'
import { FIXED_NOW, emptyState, practiceOn } from './helpers'

describe('round trip', () => {
  it('reads back exactly what was written', () => {
    const state = emptyState(FIXED_NOW)
    state.practiceHistory = [practiceOn(0, FIXED_NOW)]
    state.checklist = ['uniform', 'belt']
    state.student.firstName = 'Jordan'

    expect(saveState(state)).toBe(true)
    const loaded = loadState()

    expect(loaded.practiceHistory).toHaveLength(1)
    expect(loaded.checklist).toEqual(['uniform', 'belt'])
    expect(loaded.student.firstName).toBe('Jordan')
  })

  it('returns the seeded default when nothing is stored', () => {
    window.localStorage.clear()
    const loaded = loadState()
    expect(loaded.schemaVersion).toBe(SCHEMA_VERSION)
    expect(loaded.student.firstName).toBe('Alex')
  })

  it('persists an instructor change', () => {
    const state = createDefaultState(FIXED_NOW)
    state.instructor.currentBeltId = 'white-2'
    state.instructor.weeklyPlan.goalPractices = 6
    state.instructor.insight.instructorName = 'Sensei Rivera'
    saveState(state)

    const loaded = loadState()
    expect(loaded.instructor.currentBeltId).toBe('white-2')
    expect(loaded.instructor.weeklyPlan.goalPractices).toBe(6)
    expect(loaded.instructor.insight.instructorName).toBe('Sensei Rivera')
  })
})

describe('a bad or old blob never breaks the app', () => {
  it('survives unparseable JSON', () => {
    window.localStorage.setItem(STORAGE_KEY, '{not json at all')
    expect(loadState().student.firstName).toBe('Alex')
  })

  it('survives a stored null', () => {
    window.localStorage.setItem(STORAGE_KEY, 'null')
    expect(loadState().schemaVersion).toBe(SCHEMA_VERSION)
  })

  it('survives a stored array', () => {
    window.localStorage.setItem(STORAGE_KEY, '[1,2,3]')
    expect(loadState().schemaVersion).toBe(SCHEMA_VERSION)
  })

  it('discards a blob from a different schema version rather than guessing', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ schemaVersion: 99, student: { firstName: 'Stale' } }),
    )
    expect(loadState().student.firstName).toBe('Alex')
  })

  it('fills in a branch a previous build did not store', () => {
    // A blob written before `settings` existed must not read as undefined.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, student: { firstName: 'Sam' } }),
    )
    const loaded = loadState()
    expect(loaded.student.firstName).toBe('Sam')
    expect(loaded.settings).toBeDefined()
    expect(loaded.settings.celebrate).toBe(true)
    expect(Array.isArray(loaded.earnedBadges)).toBe(true)
    expect(loaded.instructor.weeklyPlan.days).toHaveLength(7)
  })
})

describe('a browser that refuses to store', () => {
  it('reports the refusal rather than throwing', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError')
    })
    expect(saveState(createDefaultState())).toBe(false)
    spy.mockRestore()
  })

  it('loads a default rather than throwing when reading is blocked', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('SecurityError')
    })
    expect(loadState().student.firstName).toBe('Alex')
    spy.mockRestore()
  })
})

describe('reset', () => {
  it('clears progress and restores the demo student', () => {
    const state = emptyState(FIXED_NOW)
    state.practiceHistory = [0, 1, 2].map((d) => practiceOn(d, FIXED_NOW))
    state.checklist = ['uniform']
    state.earnedBadges = [{ badgeId: 'first-practice', earnedAt: FIXED_NOW.toISOString() }]
    state.student.firstName = 'Jordan'
    state.instructor.currentBeltId = 'blue'
    saveState(state)

    const fresh = resetState()
    expect(fresh.student.firstName).toBe('Alex')
    expect(fresh.instructor.currentBeltId).toBe('white')
    expect(fresh.checklist).toEqual([])
    expect(fresh.earnedBadges).toEqual([])
    expect(fresh.lessonProgress).toEqual({})

    // And the reset is what is now on disk, not just what was returned.
    expect(loadState().student.firstName).toBe('Alex')
    expect(loadState().checklist).toEqual([])
  })

  it('leaves the seeded demo practices, so the app is never a blank slate', () => {
    const fresh = resetState()
    expect(fresh.practiceHistory.length).toBeGreaterThan(0)
    for (const practice of fresh.practiceHistory) {
      expect(practice.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})

describe('the persistence boundary', () => {
  it('is the only place in src/ that touches localStorage', () => {
    // A second reader would be a second thing to migrate, and the future
    // backend swap is meant to be a change to storage.ts alone.
    const root = join(process.cwd(), 'src')
    const offenders: string[] = []
    let scanned = 0

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue
        if (full.endsWith(join('utils', 'storage.ts'))) continue
        if (full.includes(join('src', 'test'))) continue
        scanned += 1
        if (/localStorage|sessionStorage/.test(readFileSync(full, 'utf8'))) {
          offenders.push(full.slice(root.length + 1))
        }
      }
    }
    walk(root)

    // Without this the assertion below would pass on an empty walk, which is
    // a guard that tests nothing while looking like it works.
    expect(scanned).toBeGreaterThan(20)
    expect(offenders).toEqual([])
  })
})
