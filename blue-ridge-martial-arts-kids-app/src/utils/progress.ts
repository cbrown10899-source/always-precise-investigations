import type {
  AppState,
  DayKind,
  GrowthLevel,
  Lesson,
  PracticeSession,
  SkillId,
} from '../types'
import { CHECKLIST } from '../data/practice'
import { daysBetween, isoDate, startOfWeek } from './dates'

/**
 * Derived progress.
 *
 * Nothing in here is stored. Every figure the app shows is computed from the
 * practice history, the lesson progress and the checklist, so a number can
 * never drift from the records behind it — the same reason the invoice totals
 * in the firm's other system are arithmetic rather than a stored flag.
 */

/** Practice sessions that fall inside the week containing `now`. */
export function practicesThisWeek(history: PracticeSession[], now: Date): PracticeSession[] {
  const start = startOfWeek(now)
  const end = new Date(start)
  end.setDate(end.getDate() + 7)
  return history.filter((p) => {
    const d = parseLocalDate(p.date)
    return d >= start && d < end
  })
}

/** Parses a YYYY-MM-DD key as LOCAL midnight. `new Date('2026-04-07')` is
 *  parsed as UTC, which lands on the 6th for anyone west of Greenwich. */
export function parseLocalDate(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}

/** Distinct dates the student practised on, newest first. */
export function practiceDates(history: PracticeSession[]): string[] {
  return [...new Set(history.map((p) => p.date))].sort().reverse()
}

/**
 * The current streak in days.
 *
 * A streak that has not been broken YET counts: practising yesterday and not
 * having practised today is still a live streak, because today is not over.
 * Two days of silence ends it.
 */
export function currentStreak(history: PracticeSession[], now: Date): number {
  const dates = practiceDates(history)
  if (dates.length === 0) return 0

  const mostRecent = parseLocalDate(dates[0])
  const gap = daysBetween(mostRecent, now)
  if (gap > 1) return 0

  let streak = 1
  for (let i = 1; i < dates.length; i += 1) {
    const prev = parseLocalDate(dates[i - 1])
    const cur = parseLocalDate(dates[i])
    if (daysBetween(cur, prev) === 1) streak += 1
    else break
  }
  return streak
}

/** The longest run of consecutive practice days in the whole history. */
export function longestStreak(history: PracticeSession[]): number {
  const dates = practiceDates(history).reverse()
  if (dates.length === 0) return 0
  let best = 1
  let run = 1
  for (let i = 1; i < dates.length; i += 1) {
    const gap = daysBetween(parseLocalDate(dates[i - 1]), parseLocalDate(dates[i]))
    run = gap === 1 ? run + 1 : 1
    if (run > best) best = run
  }
  return best
}

/** Lessons the student has finished. */
export function completedLessonIds(state: AppState): string[] {
  return Object.values(state.lessonProgress)
    .filter((p) => p.completed)
    .map((p) => p.lessonId)
}

export function lessonsCompletedCount(state: AppState): number {
  return completedLessonIds(state).length
}

/** How far through a lesson the student is, 0–1. */
export function lessonCompletion(lesson: Lesson, state: AppState): number {
  const progress = state.lessonProgress[lesson.id]
  if (!progress) return 0
  if (progress.completed) return 1
  const done = progress.completedStepIds.filter((id) =>
    lesson.steps.some((s) => s.id === id),
  ).length
  return lesson.steps.length === 0 ? 0 : done / lesson.steps.length
}

/** Checklist items ticked, and the total. The total is the list's own length
 *  so the meter and the list can never disagree. */
export function readiness(state: AppState): { done: number; total: number } {
  const valid = new Set(CHECKLIST.map((c) => c.id))
  const done = state.checklist.filter((id) => valid.has(id)).length
  return { done, total: CHECKLIST.length }
}

export function isReadyForDojo(state: AppState): boolean {
  const { done, total } = readiness(state)
  return total > 0 && done >= total
}

/** Weekly practice progress against the instructor's goal. */
export function weeklyProgress(state: AppState, now: Date) {
  const done = practicesThisWeek(state.practiceHistory, now).length
  const goal = Math.max(1, state.instructor.weeklyPlan.goalPractices)
  return {
    done,
    goal,
    /** Capped at 1 so a fifth practice does not draw a bar past the end. */
    ratio: Math.min(1, done / goal),
    met: done >= goal,
  }
}

/** Dojo classes attended, out of those recorded as attended or missed. */
export function attendanceSummary(state: AppState) {
  const recorded = state.instructor.attendance.filter((a) => a.status !== 'upcoming')
  const present = recorded.filter((a) => a.status === 'present').length
  return {
    present,
    total: recorded.length,
    ratio: recorded.length === 0 ? 0 : present / recorded.length,
  }
}

/** Distinct skills touched by practice this week. */
export function skillsPractisedThisWeek(state: AppState, now: Date): SkillId[] {
  const set = new Set<SkillId>()
  for (const p of practicesThisWeek(state.practiceHistory, now)) {
    for (const s of p.skills) set.add(s)
  }
  return [...set]
}

/* ----------------------------------------------------------------- growth */

/**
 * Growth is a WORD, never a percentage.
 *
 * The app does not measure a child's confidence, so a figure like "92%" would
 * be a precision claim it cannot support. `growthLabelFor` maps a count of
 * observed activity onto four ordered labels, and every growth card states the
 * activity it is counting, so the label is never mysterious.
 */
const LEVELS: GrowthLevel[] = ['Building', 'Improving', 'Strong', 'Excellent']

/** `count` against three ascending thresholds. Below the first is "Building". */
export function growthLabelFor(count: number, thresholds: [number, number, number]): GrowthLevel {
  if (count >= thresholds[2]) return LEVELS[3]
  if (count >= thresholds[1]) return LEVELS[2]
  if (count >= thresholds[0]) return LEVELS[1]
  return LEVELS[0]
}

/** Where a level sits on the scale, 0–1, for the bar beside the word. */
export function growthRatio(level: GrowthLevel): number {
  const i = LEVELS.indexOf(level)
  return (i + 1) / LEVELS.length
}

export interface GrowthReading {
  id: 'focus' | 'consistency' | 'effort' | 'confidence'
  label: string
  level: GrowthLevel
  /** What was counted, stated plainly. */
  basis: string
}

/** The four growth readings, each derived from something actually recorded. */
export function growthReadings(state: AppState, now: Date): GrowthReading[] {
  const lessonsDone = lessonsCompletedCount(state)
  const week = practicesThisWeek(state.practiceHistory, now).length
  const total = state.practiceHistory.length
  const streak = currentStreak(state.practiceHistory, now)

  return [
    {
      id: 'focus',
      label: 'Focus',
      level: growthLabelFor(lessonsDone, [1, 3, 6]),
      basis: `${lessonsDone} ${lessonsDone === 1 ? 'lesson' : 'lessons'} finished all the way through`,
    },
    {
      id: 'consistency',
      label: 'Consistency',
      level: growthLabelFor(streak, [1, 3, 5]),
      basis: `${streak}-day practice streak`,
    },
    {
      id: 'effort',
      label: 'Effort',
      level: growthLabelFor(total, [1, 5, 12]),
      basis: `${total} ${total === 1 ? 'practice' : 'practices'} completed in total`,
    },
    {
      id: 'confidence',
      label: 'Confidence',
      level: growthLabelFor(week, [1, 3, 4]),
      basis: `${week} ${week === 1 ? 'practice' : 'practices'} this week`,
    },
  ]
}

/* ------------------------------------------------------------ practice log */

/** Builds the record of a finished practice. Pure, so the test can assert the
 *  shape without driving the player. */
export function buildSession(
  routineId: string,
  routineTitle: string,
  skills: SkillId[],
  stepsCompleted: number,
  stepsTotal: number,
  minutes: number,
  now: Date,
): PracticeSession {
  return {
    id: `practice-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    routineId,
    routineTitle,
    date: isoDate(now),
    completedAt: now.toISOString(),
    minutes: Math.max(1, Math.round(minutes)),
    stepsCompleted,
    stepsTotal,
    skills: [...new Set(skills)],
  }
}

/* --------------------------------------------------------- today's plan */

export interface TodayPlan {
  kind: DayKind
  /** The plan's own word for the day, e.g. "Home Practice". */
  label: string
  /** Whether a practice has already been logged today. */
  practisedToday: boolean
}

/**
 * What today is, according to the instructor's weekly plan.
 *
 * Home used to announce "Today's At-Home Practice" on every day of the week,
 * including the one the plan calls a rest day — a screen telling a child to
 * train on the day their instructor set aside for recovery. The plan is the
 * record, so the screen reads it.
 */
export function todayPlan(state: AppState, now: Date): TodayPlan {
  const dayIndex = now.getDay()
  const day = state.instructor.weeklyPlan.days.find((d) => d.dayIndex === dayIndex)
  return {
    kind: day?.kind ?? 'home',
    label: day?.label ?? 'Home Practice',
    practisedToday: state.practiceHistory.some((p) => p.date === isoDate(now)),
  }
}
