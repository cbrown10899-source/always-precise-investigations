import type { ChecklistItem, PracticeRoutine } from '../types'

/**
 * Guided practice routines.
 *
 * Same safety rule as the lesson library: solo, controlled, open space. The
 * safety test greps this file too.
 */
export const ROUTINES: PracticeRoutine[] = [
  {
    id: 'daily-10',
    title: "Today's Practice",
    subtitle: 'A complete 10-minute session',
    estimatedMinutes: 10,
    steps: [
      {
        id: 'warmup',
        title: 'Warm Up',
        instruction: 'March in place, roll your shoulders, and loosen your ankles.',
        cues: [
          'March 20 slow steps.',
          'Shoulder rolls: 5 back, 5 forward.',
          'Ankle circles: 10 each way.',
        ],
        durationSeconds: 60,
        skills: ['flexibility'],
        icon: 'warmup',
      },
      {
        id: 'stance',
        title: 'Ready Stance',
        instruction: 'Drop into your ready stance and check all four points.',
        cues: [
          'Feet shoulder-width.',
          'Knees softly bent.',
          'Back tall, eyes forward.',
          'Reset between each one.',
        ],
        targetReps: 5,
        skills: ['stance', 'balance'],
        icon: 'stance',
      },
      {
        id: 'punches',
        title: 'Straight Punches',
        instruction: 'Controlled punches into open space, alternating hands.',
        cues: [
          'Thumb outside the fist.',
          'Straight out, straight back.',
          'The other hand stays up.',
          'Slow and correct, not fast and sloppy.',
        ],
        targetReps: 10,
        skills: ['punches', 'guard'],
        icon: 'punch',
      },
      {
        id: 'front-kick',
        title: 'Front Kick',
        instruction: 'Four counts every time: knee up, extend, re-chamber, set down.',
        cues: [
          'Knee up FIRST.',
          'Extend into open space.',
          'Pull the lower leg back.',
          'Set the foot down under control.',
        ],
        targetReps: 5,
        perSide: true,
        skills: ['kicks', 'balance'],
        icon: 'kick',
      },
      {
        id: 'balance',
        title: 'Balance Challenge',
        instruction: 'One knee up, eyes on one still spot. Hold steady.',
        cues: [
          'Eyes on one spot.',
          'Press the standing foot into the floor.',
          'Wobbling is normal — catch it and keep going.',
          'Stay near a wall.',
        ],
        durationSeconds: 30,
        skills: ['balance', 'focus'],
        icon: 'balance',
      },
      {
        id: 'cooldown',
        title: 'Cool Down',
        instruction: 'Slow breathing and a gentle stretch to finish.',
        cues: [
          'Five slow breaths in your ready stance.',
          'Gentle shoulder and calf stretch.',
          'Think of one thing that went well today.',
        ],
        durationSeconds: 60,
        skills: ['flexibility', 'focus'],
        icon: 'cooldown',
      },
    ],
  },
  {
    id: 'quick-5',
    title: 'Quick Practice',
    subtitle: 'Short on time? Five focused minutes.',
    estimatedMinutes: 5,
    steps: [
      {
        id: 'warmup',
        title: 'Quick Warm Up',
        instruction: 'March in place and roll your shoulders.',
        cues: ['20 marching steps.', 'Shoulder rolls, 5 each way.'],
        durationSeconds: 45,
        skills: ['flexibility'],
        icon: 'warmup',
      },
      {
        id: 'stance-guard',
        title: 'Stance and Guard',
        instruction: 'Drop into stance and bring your hands to guard.',
        cues: ['Feet shoulder-width.', 'Elbows in, hands at cheek height.'],
        targetReps: 8,
        skills: ['stance', 'guard'],
        icon: 'guard',
      },
      {
        id: 'punches',
        title: 'Straight Punches',
        instruction: 'Controlled punches into open space.',
        cues: ['Straight out, straight back.', 'Other hand stays up.'],
        targetReps: 10,
        skills: ['punches', 'guard'],
        icon: 'punch',
      },
      {
        id: 'balance',
        title: 'Balance Hold',
        instruction: 'One knee up, eyes on one spot.',
        cues: ['Eyes still.', 'Stay near a wall.'],
        durationSeconds: 30,
        skills: ['balance', 'focus'],
        icon: 'balance',
      },
      {
        id: 'cooldown',
        title: 'Cool Down',
        instruction: 'Three slow breaths and a stretch.',
        cues: ['Breathe out slowly.', 'Shoulders down.'],
        durationSeconds: 30,
        skills: ['flexibility'],
        icon: 'cooldown',
      },
    ],
  },
]

export function routineById(id: string): PracticeRoutine | undefined {
  return ROUTINES.find((r) => r.id === id)
}

/** The routine the Home screen offers as "today's". */
export const DEFAULT_ROUTINE_ID = 'daily-10'

/**
 * The Get Ready for Class checklist.
 *
 * Seven items; the readiness meter reports "n of 7". The brief's example
 * showed 0/5 through 5/5 — the meter is derived from this list's length so the
 * two can never disagree.
 */
export const CHECKLIST: ChecklistItem[] = [
  { id: 'uniform', label: 'Uniform ready', hint: 'Clean, and not still in the wash.', icon: 'shield' },
  { id: 'belt', label: 'Belt packed', hint: 'Rolled up in your bag, not on the floor.', icon: 'belt' },
  { id: 'water', label: 'Water bottle packed', hint: 'Filled and in the bag already.', icon: 'heart' },
  { id: 'stance', label: 'Review stance', hint: 'Four checkpoints, ten times.', icon: 'stance' },
  { id: 'punches', label: 'Review punches', hint: 'Slow and controlled, hands home.', icon: 'punch' },
  { id: 'kicks', label: 'Review kicks', hint: 'All four counts, both legs.', icon: 'kick' },
  { id: 'bowing', label: 'Bowing etiquette', hint: 'On the mat, off the mat, to your instructor.', icon: 'etiquette' },
]
