import { Link } from 'react-router-dom'
import {
  CalendarDays, ChevronRight, GraduationCap, MapPin, RotateCcw, Settings, ShieldCheck, User, Users,
} from 'lucide-react'
import { Masthead } from '../components/Masthead'
import { Card, SectionHead } from '../components/ui'
import { useApp } from '../hooks/useApp'
import { useState } from 'react'

const LINKS = [
  { to: '/profile', label: 'Student Profile', hint: 'Name, avatar and belt', Glyph: User },
  { to: '/parent', label: 'Parent Mode', hint: 'Weekly summary — PIN protected', Glyph: Users },
  { to: '/instructor', label: 'Instructor Demo', hint: 'Edit what the student sees', Glyph: GraduationCap },
  { to: '/schedule', label: 'Schedule', hint: 'Class day and time', Glyph: CalendarDays },
  { to: '/dojo', label: 'Dojo Information', hint: 'About the school', Glyph: MapPin },
  { to: '/safety', label: 'Safety', hint: 'How to practise safely at home', Glyph: ShieldCheck },
  { to: '/settings', label: 'App Settings', hint: 'Motion, text size and data', Glyph: Settings },
]

export function MoreScreen() {
  const { state, reset } = useApp()
  const [confirming, setConfirming] = useState(false)

  return (
    <>
      <Masthead />

      <div className="screen">
        <div>
          <h1>More</h1>
          <p className="small muted">Profile, parent and instructor tools, and app settings.</p>
        </div>

        <Card variant="flush">
          <ul className="rows" style={{ listStyle: 'none' }}>
            {LINKS.map(({ to, label, hint, Glyph }) => (
              <li key={to}>
                <Link to={to} className="row-item">
                  <span
                    aria-hidden="true"
                    style={{
                      flex: 'none',
                      width: 36,
                      height: 36,
                      display: 'grid',
                      placeItems: 'center',
                      borderRadius: 'var(--r-md)',
                      background: 'var(--blue-100)',
                      color: 'var(--blue-600)',
                    }}
                  >
                    <Glyph size={18} />
                  </span>
                  <span className="grow">
                    <span className="bold" style={{ display: 'block', color: 'var(--navy-900)' }}>
                      {label}
                    </span>
                    <span className="tiny faint">{hint}</span>
                  </span>
                  <ChevronRight size={18} aria-hidden="true" color="var(--ink-faint)" />
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        {/* ----------------------------------------------------- reset demo */}
        <section className="section">
          <SectionHead title="Demo data" icon="sparkle" />
          <Card>
            <p className="small muted">
              This demo stores everything on this device only. Resetting restores the starting demo
              student, clears your practice history, badges, lesson progress and instructor changes,
              and cannot be undone.
            </p>

            {confirming ? (
              <div className="stack-2" style={{ marginTop: 'var(--s-3)' }}>
                <p className="small bold" style={{ color: 'var(--red-ink)' }}>
                  Reset all demo data? This cannot be undone.
                </p>
                <div className="row" style={{ gap: 'var(--s-2)' }}>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    style={{ flex: 1 }}
                    onClick={() => setConfirming(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn--danger"
                    style={{ flex: 1 }}
                    onClick={() => {
                      reset()
                      setConfirming(false)
                    }}
                  >
                    Yes, reset
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn--danger btn--block"
                style={{ marginTop: 'var(--s-3)' }}
                onClick={() => setConfirming(true)}
              >
                <RotateCcw size={18} aria-hidden="true" />
                Reset Demo Data
              </button>
            )}
          </Card>
        </section>

        <p className="tiny faint center">
          Blue Ridge Martial Arts · Forest, VA
          <br />
          Demo build — {state.practiceHistory.length} practices and{' '}
          {state.earnedBadges.length} badges stored on this device.
        </p>
      </div>
    </>
  )
}
