import type { Skill, SkillId } from '../types'

/**
 * The skills the app tracks.
 *
 * The labels are the TECHNIQUE names a student hears in class — "Ready
 * Stance", not "Stance" — so a focus chip, a lesson title and an instructor's
 * word for the same thing all read alike. `lessonId` is what lets a chip be
 * tapped through to the lesson that teaches it.
 */
export const SKILLS: Skill[] = [
  { id: 'stance', label: 'Ready Stance', blurb: 'A strong base makes everything else work.', lessonId: 'ready-stance' },
  { id: 'guard', label: 'Guard Position', blurb: 'Hands up, ready and protected.', lessonId: 'guard-position' },
  { id: 'punches', label: 'Straight Punch', blurb: 'Controlled punches into open space.', lessonId: 'straight-punch' },
  { id: 'kicks', label: 'Front Kick', blurb: 'Chamber, extend, and put the foot back down.', lessonId: 'front-kick-basics' },
  { id: 'footwork', label: 'Footwork', blurb: 'Move without losing your balance.', lessonId: 'movement-footwork' },
  { id: 'balance', label: 'Balance', blurb: 'Stay steady, even when it gets hard.', lessonId: 'balance-drill' },
  { id: 'focus', label: 'Focus', blurb: 'Eyes up, mind on the task.', lessonId: 'focus-drill' },
  { id: 'etiquette', label: 'Etiquette', blurb: 'Respect on and off the mat.', lessonId: 'dojo-etiquette' },
  { id: 'flexibility', label: 'Flexibility', blurb: 'Warm, loose muscles move better.' },
]

const BY_ID = new Map<SkillId, Skill>(SKILLS.map((s) => [s.id, s]))

/** The label for a skill, falling back to the raw id rather than an empty
 *  string, so a stale instructor selection is visible instead of invisible. */
export function skillLabel(id: SkillId): string {
  return BY_ID.get(id)?.label ?? id
}

/** The lesson that teaches a skill, or undefined when none does. */
export function skillLessonId(id: SkillId): string | undefined {
  return BY_ID.get(id)?.lessonId
}
