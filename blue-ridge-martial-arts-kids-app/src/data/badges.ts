import type { Badge, BadgeId } from '../types'

/**
 * Every badge states the requirement it is earned by, in the child's own
 * terms. `utils/badges.ts` is the one place that decides whether a badge is
 * earned; if a requirement here and the rule there ever disagree, the child is
 * being told something untrue, so the badge test pins the pair together.
 */
export const BADGES: Badge[] = [
  {
    id: 'first-practice',
    label: 'First Practice',
    description: 'You finished your very first at-home practice.',
    requirement: 'Complete 1 practice',
    icon: 'star',
    tone: 'blue',
  },
  {
    id: 'three-practices',
    label: '3 Practices',
    description: 'Three practices done. You are building a habit.',
    requirement: 'Complete 3 practices',
    icon: 'reps',
    tone: 'blue',
  },
  {
    id: 'three-day-streak',
    label: '3 Day Streak',
    description: 'Three days in a row. That is how habits are built.',
    requirement: 'Practice 3 days in a row',
    icon: 'flame',
    tone: 'orange',
  },
  {
    id: 'great-listener',
    label: 'Great Listener',
    description: 'You finished a lesson all the way through, including the questions.',
    requirement: 'Complete 1 lesson',
    icon: 'heart',
    tone: 'blue',
  },
  {
    id: 'hard-worker',
    label: 'Hard Worker',
    description: 'Five practices done. That is real work.',
    requirement: 'Complete 5 practices',
    icon: 'mountain',
    tone: 'blue',
  },
  {
    id: 'ready-for-dojo',
    label: 'Ready for Dojo',
    description: 'Every item on your Get Ready checklist was ticked.',
    requirement: 'Finish the Get Ready for Class checklist',
    icon: 'shield',
    tone: 'green',
  },
  {
    id: 'practice-champion',
    label: 'Practice Champion',
    description: 'You hit your whole weekly practice goal.',
    requirement: 'Meet your weekly practice goal',
    icon: 'trophy',
    tone: 'gold',
  },
  {
    id: 'good-attitude',
    label: 'Good Attitude',
    description: 'You worked on character, not just technique.',
    requirement: 'Complete a Character lesson',
    icon: 'smile',
    tone: 'gold',
  },
  {
    id: 'balance-builder',
    label: 'Balance Builder',
    description: 'You kept working on balance until it got easier.',
    requirement: 'Complete 3 practices that include balance',
    icon: 'balance',
    tone: 'green',
  },
]

const BY_ID = new Map<BadgeId, Badge>(BADGES.map((b) => [b.id, b]))

export function badgeById(id: BadgeId): Badge | undefined {
  return BY_ID.get(id)
}
