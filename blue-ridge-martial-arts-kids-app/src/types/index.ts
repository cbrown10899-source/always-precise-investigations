/**
 * Domain types for the Blue Ridge Martial Arts Kids App.
 *
 * These describe the *shape of the data*, never how it is drawn. Screens and
 * components import from here; nothing in here imports from React. That
 * separation is what lets the storage layer be swapped for a real API later
 * without touching a single screen.
 */

/* ------------------------------------------------------------------ belts */

/** Stable identifiers for rungs on the demo belt ladder. */
export type BeltId =
  | 'white'
  | 'white-1'
  | 'white-2'
  | 'blue-stripe-test'
  | 'blue'

/**
 * One rung of the belt journey.
 *
 * `kind` separates a belt a student wears from a test they sit, because the
 * two read differently on the journey strip and a test is not something you
 * are currently "wearing".
 */
export interface Belt {
  id: BeltId
  /** What the student and parent see, e.g. "White Belt 1 Stripe". */
  label: string
  /** The short form used where space is tight, e.g. "White 1 Stripe". */
  shortLabel: string
  kind: 'belt' | 'test'
  /** Belt body colour, for the belt illustration. */
  color: string
  /** Stripe colour, or null when the belt carries no stripe. */
  stripeColor: string | null
  stripeCount: number
  /** Position on the ladder. Lower comes first. */
  order: number
}

/* ----------------------------------------------------------------- skills */

export type SkillId =
  | 'stance'
  | 'guard'
  | 'punches'
  | 'kicks'
  | 'footwork'
  | 'balance'
  | 'focus'
  | 'etiquette'
  | 'flexibility'

export interface Skill {
  id: SkillId
  label: string
  /** One friendly line a child can read. */
  blurb: string
}

/* ---------------------------------------------------------------- lessons */

export type LessonCategory = 'belt' | 'skills' | 'character'

export type LessonDifficulty = 'starter' | 'building' | 'challenge'

/**
 * The six section kinds a lesson step can be. The order they appear in a
 * lesson is the order of `Lesson.steps`; this type only says what a step *is*,
 * which is what decides how it is presented and whether it carries a timer or
 * a rep counter.
 */
export type LessonStepKind =
  | 'warmup'
  | 'demo'
  | 'learn'
  | 'reps'
  | 'check'
  | 'complete'

/** A multiple-choice question used by a `check` step. */
export interface LessonQuestion {
  id: string
  prompt: string
  options: string[]
  /** Index into `options`. */
  answerIndex: number
  /** Shown after answering, whichever option was chosen. */
  explanation: string
}

export interface LessonStep {
  id: string
  kind: LessonStepKind
  title: string
  /** One-line summary shown in the step list. */
  summary: string
  /** The teaching points, one per line. */
  points: string[]
  /** Seconds for a timed step. Absent when the step is not timed. */
  durationSeconds?: number
  /** Target repetitions for a counted step. Absent when not counted. */
  targetReps?: number
  /** Questions for a `check` step. */
  questions?: LessonQuestion[]
  /** Safety line specific to this step, shown in the safety callout. */
  safetyNote?: string
}

export interface Lesson {
  id: string
  title: string
  /** One kid-readable line under the title. */
  tagline: string
  category: LessonCategory
  /** The belt this lesson belongs to, for the "Current Belt" filter. */
  beltId: BeltId
  difficulty: LessonDifficulty
  /** Whole minutes, shown as "6 min". */
  estimatedMinutes: number
  /** Skills this lesson develops; drives the chips on the lesson card. */
  skills: SkillId[]
  /** Icon key resolved by the icon registry, never a component. */
  icon: IconKey
  steps: LessonStep[]
}

/** Progress through one lesson, stored per student. */
export interface LessonProgress {
  lessonId: string
  /** Index of the furthest step reached. */
  currentStepIndex: number
  /** Step ids the student has marked done. */
  completedStepIds: string[]
  completed: boolean
  /** ISO timestamp, or null when never completed. */
  completedAt: string | null
  /** Reps logged per step id, so a partly counted step survives a reload. */
  repsByStepId: Record<string, number>
}

/* --------------------------------------------------------------- practice */

/** One move inside a guided practice routine. */
export interface PracticeStep {
  id: string
  title: string
  /** What to do, in one or two short sentences. */
  instruction: string
  /** Cue points shown as a list during the step. */
  cues: string[]
  /** Seconds for a timed step. */
  durationSeconds?: number
  /** Reps for a counted step. */
  targetReps?: number
  /** "each side" steps say so rather than doubling the number. */
  perSide?: boolean
  skills: SkillId[]
  icon: IconKey
}

/** A named routine, e.g. today's ten-minute practice. */
export interface PracticeRoutine {
  id: string
  title: string
  subtitle: string
  estimatedMinutes: number
  steps: PracticeStep[]
}

/** A practice the student actually finished. History, never a plan. */
export interface PracticeSession {
  id: string
  routineId: string
  routineTitle: string
  /** ISO date (YYYY-MM-DD) in the student's local time. */
  date: string
  /** ISO timestamp of completion. */
  completedAt: string
  /** Whole minutes actually spent, measured by the guided player. */
  minutes: number
  /** Steps the student completed, out of the routine's total. */
  stepsCompleted: number
  stepsTotal: number
  skills: SkillId[]
}

/* ------------------------------------------------------------ weekly plan */

export type DayKind = 'home' | 'dojo' | 'rest'

/** 0 = Sunday … 6 = Saturday, matching `Date.getDay()`. */
export type DayIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** What a given weekday is *for*. The plan, not what happened. */
export interface WeeklyPlanDay {
  dayIndex: DayIndex
  kind: DayKind
  label: string
}

export interface WeeklyPlan {
  days: WeeklyPlanDay[]
  /** Home practices the student is aiming for this week. */
  goalPractices: number
  mission: string
  missionDetail: string
}

/* --------------------------------------------------------------- schedule */

export interface ClassSession {
  id: string
  dayIndex: DayIndex
  /** 24-hour "HH:MM", so it sorts and formats without parsing prose. */
  startTime: string
  endTime: string
  title: string
  locationName: string
  locationCity: string
  /** What the class covers. Instructor-editable. */
  focus: string
}

/* ------------------------------------------------------------- attendance */

export type AttendanceStatus = 'present' | 'absent' | 'upcoming'

export interface AttendanceRecord {
  id: string
  /** ISO date (YYYY-MM-DD). */
  date: string
  status: AttendanceStatus
  className: string
}

/* ----------------------------------------------------------------- badges */

export type BadgeId =
  | 'first-practice'
  | 'three-day-streak'
  | 'great-listener'
  | 'hard-worker'
  | 'ready-for-dojo'
  | 'practice-champion'
  | 'good-attitude'
  | 'balance-builder'

export interface Badge {
  id: BadgeId
  label: string
  /** What it means, in a child's words. */
  description: string
  /** How it is earned, stated plainly so it never feels arbitrary. */
  requirement: string
  icon: IconKey
  /** Accent used for the badge face. */
  tone: 'blue' | 'green' | 'gold' | 'orange'
}

export interface EarnedBadge {
  badgeId: BadgeId
  /** ISO timestamp. */
  earnedAt: string
}

/* -------------------------------------------------------------- checklist */

export interface ChecklistItem {
  id: string
  label: string
  /** One line of help, shown under the label. */
  hint: string
  icon: IconKey
}

/* ---------------------------------------------------------------- growth */

/**
 * Growth is reported as a word, never a percentage.
 *
 * Nothing here is measured instrumentally, so a number would be a precision
 * claim the app cannot support. The four labels are ordered, and
 * `growthLabelFor` in `utils/progress.ts` is the one place that maps
 * observed activity onto them.
 */
export type GrowthLevel = 'Building' | 'Improving' | 'Strong' | 'Excellent'

export type GrowthCategoryId = 'focus' | 'consistency' | 'effort' | 'confidence'

export interface GrowthCategory {
  id: GrowthCategoryId
  label: string
  /** What this category is looking at, so the label is never mysterious. */
  basis: string
  icon: IconKey
}

/* --------------------------------------------------------- parent insight */

/**
 * Instructor- or demo-authored notes. Never generated, never inferred from
 * the student's activity — this app does not diagnose a child.
 */
export interface ParentInsight {
  practiced: string[]
  workOnNext: string[]
  /** The instructor's own note, editable in Instructor Demo. */
  instructorNote: string
  /** Who the note is from, or null when nobody has been named. */
  instructorName: string | null
  /** ISO date the note was last written, or null. */
  updatedAt: string | null
}

/* ------------------------------------------------- instructor demo config */

/**
 * Everything the Instructor Demo can change. Kept as one object so a single
 * write persists a coherent configuration, and so the child's app can read
 * from exactly one place.
 */
export interface InstructorSettings {
  currentBeltId: BeltId
  nextGoalBeltId: BeltId
  /** Estimated test window, free text, e.g. "June 2026". Empty when unset. */
  testWindow: string
  weeklyFocusSkillIds: SkillId[]
  weeklyPlan: WeeklyPlan
  classSession: ClassSession
  /** Lesson ids the instructor has made available. */
  availableLessonIds: string[]
  insight: ParentInsight
  attendance: AttendanceRecord[]
}

/* ------------------------------------------------------------ dojo / school */

/**
 * Every field here is nullable on purpose: the app must show
 * "Add school contact information" rather than invent a phone number.
 */
export interface DojoInfo {
  name: string
  city: string
  state: string
  phone: string | null
  website: string | null
  addressLine1: string | null
  addressLine2: string | null
  instructorName: string | null
  email: string | null
}

/* ---------------------------------------------------------------- student */

export interface Student {
  id: string
  firstName: string
  /** Avatar key resolved by the avatar registry — never a photograph. */
  avatarId: AvatarId
  /** ISO date the student joined, used for "member since". */
  joinedOn: string
}

export type AvatarId = 'summit' | 'trail' | 'ridge' | 'falcon' | 'river' | 'pine'

/* ------------------------------------------------------------------ icons */

/**
 * Icon keys, resolved to components by `components/Icon.tsx`.
 *
 * Data files name an icon by key so that the data layer stays free of React
 * imports and can be replaced by an API response without change.
 */
export type IconKey =
  | 'stance'
  | 'guard'
  | 'punch'
  | 'kick'
  | 'footwork'
  | 'balance'
  | 'focus'
  | 'etiquette'
  | 'flexibility'
  | 'warmup'
  | 'demo'
  | 'learn'
  | 'reps'
  | 'check'
  | 'complete'
  | 'cooldown'
  | 'mountain'
  | 'trophy'
  | 'star'
  | 'flame'
  | 'calendar'
  | 'clock'
  | 'belt'
  | 'shield'
  | 'heart'
  | 'smile'
  | 'target'
  | 'sparkle'

/* ------------------------------------------------------------- app state */

/**
 * The whole persisted state, versioned.
 *
 * `schemaVersion` exists so a future change can migrate rather than silently
 * reading a shape that no longer matches — see `utils/storage.ts`.
 */
export interface AppState {
  schemaVersion: number
  student: Student
  instructor: InstructorSettings
  dojo: DojoInfo
  lessonProgress: Record<string, LessonProgress>
  practiceHistory: PracticeSession[]
  /** Checklist item ids currently ticked. */
  checklist: string[]
  earnedBadges: EarnedBadge[]
  settings: AppSettings
}

export interface AppSettings {
  reduceMotion: boolean
  largeText: boolean
  /** Whether the child sees the celebration animation on completion. */
  celebrate: boolean
}
