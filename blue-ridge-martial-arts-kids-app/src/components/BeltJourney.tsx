import { Check } from 'lucide-react'
import { BELTS, beltById } from '../data/belts'
import { BeltGraphic } from './BeltGraphic'
import type { BeltId } from '../types'

/**
 * The belt ladder, with the student's position on it.
 *
 * A rung is "done" when it sits before the current belt, "current" when it is
 * the current belt, and "upcoming" after. Each state is announced in words as
 * well as drawn, because a tick mark and a grey label are both visual.
 *
 * This is the DEMO ladder. The screen that hosts it says so; this component
 * never claims the sequence is official promotion criteria.
 */
export function BeltJourney({
  currentBeltId,
  goalBeltId,
}: {
  currentBeltId: BeltId
  goalBeltId?: BeltId
}) {
  const current = beltById(currentBeltId)

  return (
    <ol className="journey" aria-label="Belt journey">
      {BELTS.map((belt) => {
        const done = belt.order < current.order
        const isCurrent = belt.id === current.id
        const isGoal = belt.id === goalBeltId
        const state = done ? 'done' : isCurrent ? 'current' : 'upcoming'

        const status = done
          ? 'Completed'
          : isCurrent
            ? 'Current'
            : isGoal
              ? 'Next goal'
              : 'Coming later'

        return (
          <li key={belt.id} className={`journey__node journey__node--${state}`}>
            <span className="journey__disc">
              <BeltGraphic belt={belt} width={40} />
              {done ? (
                <span className="journey__tick" aria-hidden="true">
                  <Check size={12} strokeWidth={4} />
                </span>
              ) : null}
            </span>
            <span className="journey__label">{belt.shortLabel}</span>
            <span className="vh">
              {belt.label}. {status}.
            </span>
          </li>
        )
      })}
    </ol>
  )
}
