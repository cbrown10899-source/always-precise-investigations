import { Lock } from 'lucide-react'
import type { Badge } from '../types'
import { Icon } from './Icon'

/**
 * One badge.
 *
 * A locked badge is greyed AND carries a padlock AND says "Locked" to a screen
 * reader — three signals, because a greyed hexagon alone is colour doing the
 * work. The requirement is always announced, so a locked badge is never a
 * mystery a child has to guess at.
 */
export function BadgeTile({
  badge,
  earned,
  onSelect,
}: {
  badge: Badge
  earned: boolean
  onSelect?: (badge: Badge) => void
}) {
  const className = `badge badge--${badge.tone} ${earned ? '' : 'badge--locked'}`.trim()
  const description = earned
    ? `${badge.label}. Earned. ${badge.description}`
    : `${badge.label}. Locked. ${badge.requirement}.`

  const face = (
    <>
      <span className="badge__face" aria-hidden="true">
        {earned ? <Icon name={badge.icon} size={24} /> : <Lock size={20} strokeWidth={2.5} />}
      </span>
      <span className="badge__label" aria-hidden="true">
        {badge.label}
      </span>
      <span className="vh">{description}</span>
    </>
  )

  if (!onSelect) {
    return <div className={className}>{face}</div>
  }

  return (
    <button type="button" className={className} onClick={() => onSelect(badge)}>
      {face}
    </button>
  )
}
