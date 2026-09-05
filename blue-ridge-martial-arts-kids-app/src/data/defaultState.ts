import type { AppState, DojoInfo, InstructorSettings, Student } from '../types'
import { LESSONS } from './lessons'

/** Bumped when the persisted shape changes. See `utils/storage.ts`. */
export const SCHEMA_VERSION = 1

/**
 * The school record.
 *
 * Every contact field is null on purpose. The app has NOT been given Blue
 * Ridge Martial Arts' phone number, address, website or instructor names, so
 * it must not invent them — the Dojo Information screen renders
 * "Add school contact information" wherever a field is null. There is a test
 * that fails if any of these gain a fabricated value.
 */
export const DEFAULT_DOJO: DojoInfo = {
  name: 'Blue Ridge Martial Arts',
  city: 'Forest',
  state: 'VA',
  phone: null,
  website: null,
  addressLine1: null,
  addressLine2: null,
  instructorName: null,
  email: null,
}

export const DEFAULT_STUDENT: Student = {
  id: 'demo-student',
  firstName: 'Alex',
  avatarId: 'summit',
  joinedOn: '2026-01-12',
}

export const DEFAULT_INSTRUCTOR: InstructorSettings = {
  currentBeltId: 'white',
  nextGoalBeltId: 'blue-stripe-test',
  testWindow: '',
  weeklyFocusSkillIds: ['stance', 'punches', 'kicks', 'balance', 'focus'],
  weeklyPlan: {
    days: [
      { dayIndex: 0, kind: 'rest', label: 'Rest & Grow' },
      { dayIndex: 1, kind: 'home', label: 'Home Practice' },
      { dayIndex: 2, kind: 'home', label: 'Home Practice' },
      { dayIndex: 3, kind: 'home', label: 'Home Practice' },
      { dayIndex: 4, kind: 'dojo', label: 'Dojo Class' },
      { dayIndex: 5, kind: 'home', label: 'Home Practice' },
      { dayIndex: 6, kind: 'home', label: 'Home Practice' },
    ],
    goalPractices: 4,
    mission: 'Practice with Purpose',
    missionDetail:
      'Complete 4 short home practices this week and arrive at class ready and confident.',
  },
  classSession: {
    id: 'weekly-class',
    dayIndex: 4,
    startTime: '18:00',
    endTime: '19:00',
    title: 'Thursday Dojo Class',
    locationName: 'Blue Ridge Martial Arts',
    locationCity: 'Forest, VA',
    focus: 'Stance, punches and front kick',
  },
  availableLessonIds: LESSONS.map((l) => l.id),
  insight: {
    practiced: ['Stance and balance', 'Front punches', 'Basic front kick', 'Focus and listening'],
    workOnNext: [
      'Keep hands up after punching',
      'Stronger chamber on the front kick',
      'Practise at home 2–3 minutes daily',
    ],
    instructorNote:
      'Great attitude in class this week. Alex listens well and is ready to work on keeping the guard up between techniques.',
    instructorName: null,
    updatedAt: null,
  },
  attendance: [],
}

/**
 * The seeded demo state.
 *
 * Two practices this week is the brief's demo figure, so the app opens with
 * something on it rather than an empty desk — but they are REAL rows in
 * `practiceHistory`, dated relative to today, not a number typed into a
 * counter. Everything on the dashboard is derived from these rows, so the
 * first number a parent reads is one the app can actually account for.
 */
export function createDefaultState(now: Date = new Date()): AppState {
  return {
    schemaVersion: SCHEMA_VERSION,
    student: { ...DEFAULT_STUDENT },
    instructor: structuredClone(DEFAULT_INSTRUCTOR),
    dojo: { ...DEFAULT_DOJO },
    lessonProgress: {},
    practiceHistory: seedPractices(now),
    checklist: [],
    earnedBadges: [],
    settings: { reduceMotion: false, largeText: false, celebrate: true },
  }
}

/** The two demo practices, placed on the two most recent past days of the
 *  current week so the week strip always has something in it. */
function seedPractices(now: Date) {
  const out = []
  const dayOfWeek = now.getDay()
  // Offsets back from today that are still inside this week (Sun start).
  const offsets = [1, 2].filter((o) => o <= dayOfWeek)
  for (const offset of offsets) {
    const d = new Date(now)
    d.setDate(d.getDate() - offset)
    out.push({
      id: `seed-practice-${offset}`,
      routineId: 'daily-10',
      routineTitle: "Today's Practice",
      date: isoDate(d),
      completedAt: d.toISOString(),
      minutes: 10,
      stepsCompleted: 6,
      stepsTotal: 6,
      skills: ['stance', 'punches', 'kicks', 'balance', 'focus'] as const satisfies readonly string[],
    })
  }
  return out.map((p) => ({ ...p, skills: [...p.skills] })) as AppState['practiceHistory']
}

/** Local-time YYYY-MM-DD. Never `toISOString().slice(0,10)`, which is UTC and
 *  puts an evening practice on tomorrow's date for anyone west of Greenwich. */
export function isoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
