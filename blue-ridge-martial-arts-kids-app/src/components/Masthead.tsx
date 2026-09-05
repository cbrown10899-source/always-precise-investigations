import { ChevronRight } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Avatar } from './Avatar'
import { MountainRidge } from './MountainRidge'
import { beltById } from '../data/belts'
import { useApp } from '../hooks/useApp'

/**
 * The brand masthead.
 *
 * The script aside and the ridge are decorative and hidden from the reader;
 * the wordmark carries the identity. The student button is a real control that
 * opens the profile, so it is a button with its own accessible name rather
 * than an avatar you have to guess is tappable.
 */
export function Masthead({ greeting }: { greeting?: string }) {
  const { state } = useApp()
  const navigate = useNavigate()
  const belt = beltById(state.instructor.currentBeltId)
  const name = state.student.firstName

  return (
    <header className="masthead">
      <div className="masthead__sky">
        <MountainRidge className="masthead__ridge" />

        <div className="masthead__inner">
          <p className="masthead__script" aria-hidden="true">
            Stronger Kids Brighter Futures
          </p>

          <div className="masthead__brand">
            <span className="masthead__name">BLUE RIDGE</span>
            <span className="masthead__sub">MARTIAL ARTS</span>
            <span className="masthead__place">FOREST, VA</span>
          </div>

          <button
            type="button"
            className="masthead__student"
            onClick={() => navigate('/profile')}
            aria-label={`${name}, ${belt.label}. Open student profile.`}
          >
            <Avatar id={state.student.avatarId} name={name} size={40} />
            <span className="masthead__studentname" aria-hidden="true">
              {greeting ? `${greeting}, ${name}!` : name}
              <ChevronRight size={12} strokeWidth={3} />
            </span>
            <span className="masthead__studentbelt" aria-hidden="true">
              {belt.label}
            </span>
          </button>
        </div>
      </div>

      <p className="masthead__tagline">DISCIPLINE TODAY &nbsp;•&nbsp; CONFIDENCE TOMORROW</p>
    </header>
  )
}
