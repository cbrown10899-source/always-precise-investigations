import { useState } from 'react'
import { Lock } from 'lucide-react'
import { SubHeader } from '../components/SubHeader'
import { Icon } from '../components/Icon'
import { Card, CardHead, Chip, Note, ProgressBar, Stat } from '../components/ui'
import { useApp } from '../hooks/useApp'
import { useToday } from '../hooks/useToday'
import {
  currentStreak,
  lessonsCompletedCount,
  practicesThisWeek,
  readiness,
  weeklyProgress,
} from '../utils/progress'
import { skillLabel } from '../data/skills'
import { formatTimeRange, longDate, nextDayOfWeek, relativeDayLabel } from '../utils/dates'

/** The demo PIN. Stated on screen, because this is a demo gate and pretending
 *  otherwise would be the app claiming a security property it does not have. */
export const DEMO_PIN = '1234'

/**
 * Parent Mode.
 *
 * The gate is deliberately shallow and says so: it keeps a curious child out
 * of the summary, and that is all it is for. Everything shown is either a
 * count derived from the student's own records or a note the instructor wrote
 * — nothing here is generated, and the app never offers an opinion about a
 * child's ability.
 */
export function ParentModeScreen() {
  const { state } = useApp()
  const today = useToday()
  const [entry, setEntry] = useState('')
  const [unlocked, setUnlocked] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!unlocked) {
    return (
      <div className="screen">
        <SubHeader title="Parent Mode" subtitle="Enter the demo PIN to continue" fallbackTo="/more" />

        <Card>
          <div className="center stack" style={{ alignItems: 'center' }}>
            <span
              aria-hidden="true"
              style={{
                width: 54,
                height: 54,
                display: 'grid',
                placeItems: 'center',
                borderRadius: '50%',
                background: 'var(--blue-100)',
                color: 'var(--blue-600)',
              }}
            >
              <Lock size={24} />
            </span>
            <h2>Parent Mode</h2>
            <p className="small muted">A weekly summary of what your child has been practising.</p>
          </div>

          <form
            style={{ marginTop: 'var(--s-4)' }}
            onSubmit={(e) => {
              e.preventDefault()
              if (entry.trim() === DEMO_PIN) {
                setUnlocked(true)
                setError(null)
              } else {
                setError('That PIN did not match. The demo PIN is 1234.')
              }
            }}
          >
            <div className="field">
              <label className="field__label" htmlFor="parent-pin">
                Demo PIN
              </label>
              <input
                id="parent-pin"
                className="input"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                pattern="[0-9]*"
                maxLength={8}
                value={entry}
                onChange={(e) => {
                  setEntry(e.target.value)
                  setError(null)
                }}
                aria-describedby="parent-pin-help"
                aria-invalid={error ? 'true' : undefined}
              />
              <span className="field__hint" id="parent-pin-help">
                The demo PIN is <strong>1234</strong>.
              </span>
            </div>

            <div aria-live="polite">
              {error ? (
                <div style={{ marginTop: 'var(--s-3)' }}>
                  <Note tone="red" icon="shield">
                    {error}
                  </Note>
                </div>
              ) : null}
            </div>

            <button type="submit" className="btn btn--block" style={{ marginTop: 'var(--s-4)' }}>
              Unlock Parent Mode
            </button>
          </form>
        </Card>

        <Note tone="gold" icon="shield" title="DEMO ONLY.">
          This PIN is written into the app and shown on this screen. It is not real security and
          protects no real data — a production build would use proper parent accounts.
        </Note>
      </div>
    )
  }

  const week = weeklyProgress(state, today)
  const thisWeek = practicesThisWeek(state.practiceHistory, today)
  const streak = currentStreak(state.practiceHistory, today)
  const lessons = lessonsCompletedCount(state)
  const ready = readiness(state)
  const insight = state.instructor.insight
  const cls = state.instructor.classSession
  const nextClass = nextDayOfWeek(today, cls.dayIndex)
  const name = state.student.firstName

  return (
    <div className="screen">
      <SubHeader title="Parent Mode" subtitle={`This week for ${name}`} fallbackTo="/more" />

      <Note tone="gold" icon="shield" title="DEMO ONLY.">
        Sample data on this device. Not a real parent account.
      </Note>

      {/* ------------------------------------------------------ the numbers */}
      <div className="grid-2">
        <Stat value={`${week.done}/${week.goal}`} label="Practices this week" />
        <Stat value={lessons} label="Lessons completed" />
        <Stat value={streak} label="Day streak" />
        <Stat value={`${ready.done}/${ready.total}`} label="Class ready" />
      </div>

      <Card>
        <CardHead title="Weekly practice goal" icon="target" />
        <ProgressBar
          value={week.done}
          max={week.goal}
          tone={week.met ? 'green' : undefined}
          label={`Weekly goal: ${week.done} of ${week.goal}`}
        />
        <p className="small muted" style={{ marginTop: 'var(--s-2)' }}>
          {week.met
            ? `${name} has met this week's goal of ${week.goal} home practices.`
            : `${week.goal - week.done} more to reach this week's goal of ${week.goal}.`}
        </p>
      </Card>

      {/* --------------------------------------------------- upcoming class */}
      <Card variant="tint">
        <CardHead title="Next class" icon="calendar" />
        <p className="bold">{cls.title}</p>
        <p className="small">
          {relativeDayLabel(nextClass, today)}, {longDate(nextClass)}
        </p>
        <p className="small muted">
          {formatTimeRange(cls.startTime, cls.endTime)} · {cls.locationName}, {cls.locationCity}
        </p>
      </Card>

      {/* ------------------------------------------------------- what/next */}
      <Card>
        <CardHead title={`What ${name} practised`} icon="complete" />
        {insight.practiced.length === 0 ? (
          <p className="small muted">Your instructor has not added notes for this week yet.</p>
        ) : (
          <ul className="stack-2" style={{ listStyle: 'none' }}>
            {insight.practiced.map((item) => (
              <li key={item} className="row" style={{ gap: 'var(--s-2)', alignItems: 'flex-start' }}>
                <span style={{ color: 'var(--green-ink)', flex: 'none', marginTop: 2 }}>
                  <Icon name="complete" size={16} />
                </span>
                <span className="small">{item}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHead title="Work on next" icon="target" />
        {insight.workOnNext.length === 0 ? (
          <p className="small muted">Nothing has been flagged for this week.</p>
        ) : (
          <ul className="stack-2" style={{ listStyle: 'none' }}>
            {insight.workOnNext.map((item) => (
              <li key={item} className="row" style={{ gap: 'var(--s-2)', alignItems: 'flex-start' }}>
                <span style={{ color: 'var(--orange-ink)', flex: 'none', marginTop: 2 }}>
                  <Icon name="target" size={16} />
                </span>
                <span className="small">{item}</span>
              </li>
            ))}
          </ul>
        )}
        <Note tone="gold" icon="shield">
          These are instructor-style demo notes, not an automatic assessment of your child. Nothing
          in this app diagnoses or scores a student.
        </Note>
      </Card>

      {/* ---------------------------------------------------- current focus */}
      <Card>
        <CardHead title="Current focus" icon="sparkle" />
        <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--s-2)' }}>
          {state.instructor.weeklyFocusSkillIds.length === 0 ? (
            <p className="small muted">No focus skills set.</p>
          ) : (
            state.instructor.weeklyFocusSkillIds.map((id) => (
              <Chip key={id}>{skillLabel(id)}</Chip>
            ))
          )}
        </div>
        {insight.instructorNote ? (
          <blockquote
            style={{
              margin: 'var(--s-4) 0 0',
              paddingLeft: 'var(--s-3)',
              borderLeft: '3px solid var(--blue-300)',
              fontSize: '0.9375rem',
              color: 'var(--navy-700)',
            }}
          >
            {insight.instructorNote}
            <footer className="tiny faint" style={{ marginTop: 6 }}>
              — {insight.instructorName ?? 'Instructor note (name not set)'}
            </footer>
          </blockquote>
        ) : null}
      </Card>

      {/* ------------------------------------------------------- this week's */}
      <Card>
        <CardHead title="Practices logged this week" icon="calendar" />
        {thisWeek.length === 0 ? (
          <p className="small muted">
            No practices logged this week yet. Practices appear here as soon as they are completed.
          </p>
        ) : (
          <ul className="rows" style={{ listStyle: 'none' }}>
            {[...thisWeek]
              .sort((a, b) => b.completedAt.localeCompare(a.completedAt))
              .map((p) => (
                <li key={p.id} className="row-between" style={{ padding: 'var(--s-2) 0' }}>
                  <span className="small">
                    <span className="bold">{p.routineTitle}</span>
                    <br />
                    <span className="tiny faint">
                      {new Date(p.completedAt).toLocaleDateString(undefined, {
                        weekday: 'long',
                        month: 'short',
                        day: 'numeric',
                      })}
                    </span>
                  </span>
                  <Chip tone="green">{p.minutes} min</Chip>
                </li>
              ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
