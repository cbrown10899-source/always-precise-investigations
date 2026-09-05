import { MapPin } from 'lucide-react'
import { SubHeader } from '../components/SubHeader'
import { WeekStrip } from '../components/WeekStrip'
import { Card, CardHead, Chip, Note } from '../components/ui'
import { useApp } from '../hooks/useApp'
import { useToday } from '../hooks/useToday'
import { practiceDates } from '../utils/progress'
import {
  DAY_NAMES,
  formatTimeRange,
  longDate,
  nextDayOfWeek,
  relativeDayLabel,
  weekDates,
} from '../utils/dates'

export function ScheduleScreen() {
  const { state } = useApp()
  const today = useToday()
  const cls = state.instructor.classSession
  const nextClass = nextDayOfWeek(today, cls.dayIndex)
  const plan = state.instructor.weeklyPlan

  return (
    <div className="screen">
      <SubHeader title="Schedule" subtitle="Your week at Blue Ridge" fallbackTo="/more" />

      <Card variant="hero">
        <p className="tiny bold" style={{ color: 'var(--blue-600)', letterSpacing: '0.08em' }}>
          NEXT CLASS
        </p>
        <h2 style={{ fontSize: '1.375rem', marginTop: 2 }}>{cls.title}</h2>
        <p className="bold" style={{ color: 'var(--navy-700)', marginTop: 4 }}>
          {relativeDayLabel(nextClass, today)}, {longDate(nextClass)}
        </p>
        <p className="small muted">{formatTimeRange(cls.startTime, cls.endTime)}</p>
        <p className="small muted row" style={{ gap: 4, marginTop: 'var(--s-2)' }}>
          <MapPin size={15} aria-hidden="true" />
          {cls.locationName}, {cls.locationCity}
        </p>
        {cls.focus ? (
          <p className="small" style={{ marginTop: 'var(--s-3)' }}>
            <strong>Focus:</strong> {cls.focus}
          </p>
        ) : null}
      </Card>

      <Card>
        <CardHead title="This week" icon="calendar" />
        <WeekStrip
          plan={plan}
          dates={weekDates(today)}
          today={today}
          practiceDates={new Set(practiceDates(state.practiceHistory))}
        />
      </Card>

      <Card>
        <CardHead title="Weekly plan" icon="reps" />
        <ul className="rows" style={{ listStyle: 'none' }}>
          {plan.days.map((day) => (
            <li key={day.dayIndex} className="row-between" style={{ padding: 'var(--s-3) 0' }}>
              <span className="bold small">{DAY_NAMES[day.dayIndex]}</span>
              <Chip
                tone={day.kind === 'dojo' ? 'blue' : day.kind === 'rest' ? 'plain' : 'green'}
                icon={day.kind === 'dojo' ? 'etiquette' : day.kind === 'rest' ? 'star' : 'reps'}
              >
                {day.label}
              </Chip>
            </li>
          ))}
        </ul>
      </Card>

      <Note tone="gold" icon="shield" title="Demo schedule.">
        This class day and time were entered in the Instructor Demo area. Confirm the real schedule
        with Blue Ridge Martial Arts before relying on it.
      </Note>
    </div>
  )
}
