import { useState } from 'react'
import { Masthead } from '../components/Masthead'
import { BeltJourney } from '../components/BeltJourney'
import { BadgeTile } from '../components/BadgeTile'
import { Icon } from '../components/Icon'
import { Card, CardHead, Chip, Note, ProgressBar, ProgressRing, SectionHead, Stat } from '../components/ui'
import { BADGES } from '../data/badges'
import { LESSONS } from '../data/lessons'
import { beltById } from '../data/belts'
import { useApp } from '../hooks/useApp'
import { useToday } from '../hooks/useToday'
import {
  attendanceSummary,
  currentStreak,
  growthRatio,
  growthReadings,
  lessonsCompletedCount,
  longestStreak,
  weeklyProgress,
} from '../utils/progress'
import { longDate } from '../utils/dates'
import { parseLocalDate } from '../utils/progress'
import type { Badge } from '../types'

const GROWTH_ICON = { focus: 'focus', consistency: 'flame', effort: 'mountain', confidence: 'star' } as const

/**
 * Belt journey, growth, attendance and badges.
 *
 * Growth is reported as a WORD with the activity it counts stated beside it.
 * The app does not measure a child's confidence, so a percentage would be a
 * precision claim it cannot support — see `growthReadings`.
 */
export function ProgressScreen() {
  const { state } = useApp()
  const today = useToday()
  const [selected, setSelected] = useState<Badge | null>(null)

  const belt = beltById(state.instructor.currentBeltId)
  const goal = beltById(state.instructor.nextGoalBeltId)
  const week = weeklyProgress(state, today)
  const streak = currentStreak(state.practiceHistory, today)
  const best = longestStreak(state.practiceHistory)
  const lessonsDone = lessonsCompletedCount(state)
  const attendance = attendanceSummary(state)
  const growth = growthReadings(state, today)
  const earned = new Set(state.earnedBadges.map((b) => b.badgeId))

  return (
    <>
      <Masthead />

      <div className="screen">
        <div>
          <h1>Progress</h1>
          <p className="small muted">Every step forward builds a stronger you.</p>
        </div>

        {/* -------------------------------------------------- belt journey */}
        <Card>
          <CardHead title="Belt Journey" icon="belt" />
          <BeltJourney currentBeltId={belt.id} goalBeltId={goal.id} />
          <Note tone="gold" icon="shield" title="This is a demo progression.">
            Belts and stripes are awarded by your instructor at the dojo. This app only shows what
            your instructor has entered.
          </Note>
        </Card>

        {/* ---------------------------------------------------- next goal */}
        <Card variant="hero">
          <p className="tiny bold" style={{ color: 'var(--blue-600)', letterSpacing: '0.08em' }}>
            NEXT GOAL
          </p>
          <h2 style={{ fontSize: '1.375rem', marginTop: 2 }}>{goal.label}</h2>
          <p className="small muted" style={{ marginTop: 4 }}>
            Keep practising. Your instructor will let you know when you are ready.
          </p>
          <div className="row" style={{ gap: 'var(--s-2)', marginTop: 'var(--s-3)', flexWrap: 'wrap' }}>
            <Chip tone="plain" icon="belt">
              Now: {belt.label}
            </Chip>
            {state.instructor.testWindow ? (
              <Chip tone="blue" icon="calendar">
                Est. test window: {state.instructor.testWindow}
              </Chip>
            ) : (
              <Chip tone="plain" icon="calendar">
                Test window not set
              </Chip>
            )}
          </div>
        </Card>

        {/* -------------------------------------------------------- totals */}
        <div className="grid-2">
          <Stat value={state.practiceHistory.length} label="Home practices" singular="Home practice" />
          <Stat value={`${lessonsDone}/${LESSONS.length}`} label="Lessons completed" />
          <Stat value={streak} label="Current streak (days)" />
          <Stat value={best} label="Best streak (days)" />
        </div>

        {/* --------------------------------------------------- this week */}
        <Card>
          <CardHead
            title="This week"
            icon="calendar"
            action={<span className="small bold" style={{ color: 'var(--blue-600)' }}>{week.done}/{week.goal}</span>}
          />
          <ProgressBar
            value={week.done}
            max={week.goal}
            tone={week.met ? 'green' : undefined}
            label={`Weekly goal: ${week.done} of ${week.goal}`}
          />
        </Card>

        {/* --------------------------------------------------- growth */}
        <section className="section">
          <SectionHead title="Growth Tracker" icon="sparkle" script="Discipline Creates Freedom" />
          <Card>
            <p className="small muted" style={{ marginBottom: 'var(--s-3)' }}>
              These are descriptions of what you have been doing — not test scores.
            </p>
            <div className="stack">
              {growth.map((reading) => (
                <div key={reading.id}>
                  <div className="row-between" style={{ marginBottom: 4 }}>
                    <span className="row" style={{ gap: 6 }}>
                      <Icon name={GROWTH_ICON[reading.id]} size={16} />
                      <span className="bold" style={{ fontSize: '0.9375rem' }}>
                        {reading.label}
                      </span>
                    </span>
                    <Chip tone={reading.level === 'Excellent' ? 'gold' : reading.level === 'Strong' ? 'green' : 'blue'}>
                      {reading.level}
                    </Chip>
                  </div>
                  <ProgressBar
                    value={growthRatio(reading.level)}
                    label={`${reading.label}: ${reading.level}`}
                  />
                  <p className="tiny faint" style={{ marginTop: 4 }}>
                    Based on {reading.basis}.
                  </p>
                </div>
              ))}
            </div>
          </Card>
        </section>

        {/* ----------------------------------------------------- attendance */}
        <Card>
          <CardHead title="Dojo Attendance" icon="calendar" />
          {attendance.total === 0 ? (
            <p className="small muted">
              No class attendance has been recorded yet. Your instructor records this in the
              Instructor Demo area.
            </p>
          ) : (
            <div className="row" style={{ gap: 'var(--s-4)' }}>
              <ProgressRing
                value={attendance.present}
                max={attendance.total}
                unit="Classes"
                tone="green"
                label={`Attendance: ${attendance.present} of ${attendance.total} classes attended`}
              />
              <div className="grow">
                <p className="bold" style={{ fontSize: '1.125rem' }}>
                  {Math.round(attendance.ratio * 100)}% attended
                </p>
                <p className="small muted">Consistent students make faster progress.</p>
              </div>
            </div>
          )}
          {state.instructor.attendance.length > 0 ? (
            <ul className="rows" style={{ listStyle: 'none', marginTop: 'var(--s-3)' }}>
              {[...state.instructor.attendance]
                .sort((a, b) => b.date.localeCompare(a.date))
                .slice(0, 6)
                .map((record) => (
                  <li key={record.id} className="row-between" style={{ padding: 'var(--s-2) 0' }}>
                    <span className="small">{longDate(parseLocalDate(record.date))}</span>
                    <Chip
                      tone={
                        record.status === 'present' ? 'green' : record.status === 'absent' ? 'orange' : 'plain'
                      }
                    >
                      {record.status === 'present'
                        ? 'Attended'
                        : record.status === 'absent'
                          ? 'Missed'
                          : 'Upcoming'}
                    </Chip>
                  </li>
                ))}
            </ul>
          ) : null}
        </Card>

        {/* --------------------------------------------------------- badges */}
        <section className="section">
          <SectionHead
            title="Badges"
            icon="trophy"
            action={
              <span className="small bold" style={{ color: 'var(--blue-600)' }}>
                {state.earnedBadges.length} of {BADGES.length}
              </span>
            }
          />
          <Card>
            <div className="badge-grid">
              {BADGES.map((badge) => (
                <BadgeTile
                  key={badge.id}
                  badge={badge}
                  earned={earned.has(badge.id)}
                  onSelect={setSelected}
                />
              ))}
            </div>

            <div aria-live="polite" style={{ marginTop: 'var(--s-3)' }}>
              {selected ? (
                <Note tone={earned.has(selected.id) ? 'green' : 'blue'} icon={selected.icon} title={selected.label}>
                  {earned.has(selected.id)
                    ? selected.description
                    : `Locked — ${selected.requirement}.`}
                </Note>
              ) : (
                <p className="tiny faint">Tap a badge to see how it is earned.</p>
              )}
            </div>
          </Card>
        </section>
      </div>
    </>
  )
}
