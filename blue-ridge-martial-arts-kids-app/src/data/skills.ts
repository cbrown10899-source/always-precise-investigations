import type { Skill, SkillId } from '../types'

export const SKILLS: Skill[] = [
  { id: 'stance', label: 'Stance', blurb: 'A strong base makes everything else work.' },
  { id: 'guard', label: 'Guard', blurb: 'Hands up, ready and protected.' },
  { id: 'punches', label: 'Punches', blurb: 'Controlled punches into open space.' },
  { id: 'kicks', label: 'Front Kick', blurb: 'Chamber, extend, and put the foot back down.' },
  { id: 'footwork', label: 'Footwork', blurb: 'Move without losing your balance.' },
  { id: 'balance', label: 'Balance', blurb: 'Stay steady, even when it gets hard.' },
  { id: 'focus', label: 'Focus', blurb: 'Eyes up, mind on the task.' },
  { id: 'etiquette', label: 'Etiquette', blurb: 'Respect on and off the mat.' },
  { id: 'flexibility', label: 'Flexibility', blurb: 'Warm, loose muscles move better.' },
]

const BY_ID = new Map<SkillId, Skill>(SKILLS.map((s) => [s.id, s]))

export function skillById(id: SkillId): Skill | undefined {
  return BY_ID.get(id)
}

/** The label for a skill, falling back to the raw id rather than an empty
 *  string, so a stale instructor selection is visible instead of invisible. */
export function skillLabel(id: SkillId): string {
  return BY_ID.get(id)?.label ?? id
}
