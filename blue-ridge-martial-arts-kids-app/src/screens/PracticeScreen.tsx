import { useNavigate } from 'react-router-dom'
import { MapPin, Play } from 'lucide-react'
import { Masthead } from '../components/Masthead'
import { WeekStrip } from '../components/WeekStrip'
import { Icon } from '../components/Icon'
import { Card, CardHead, CheckRow, Chip, Note, ProgressRing, SectionHead } from '../components/ui'
import { CHECKLIST, ROUTINES } from '../data/practice'
import { useApp } from '../hooks/useApp'
import { useToday } from '../hooks/useToday'
import { isReadyForDojo, practiceDates, readiness, weeklyProgress } from '../utils/progress'
import { formatTimeRange, nextDayOfWeek, relativeDayLabel, weekDates } from '../utils/dates'

/**
 * The weekly plan, the Get Ready checklist and this week's mission.
 *
 * The readiness meter's denominator is `CHECKLIST.length`, so the meter and
 * the list it summarises cannot disagree — the brief's "0/5 through 5/5" is a
 * property of the list rather than a number typed in twice.
 */
export function PracticeScreen() {
  const { state, update } = useApp()
  const today = useToday()
  const navigate = useNavigate()

  const dates = weekDates(today)
  const practised = new Set(practiceDates(state.practiceHistory))
  const ready = readiness(state)
  const dojoReady = isReadyForDojo(state)
  const week = weeklyProgress(state, today)

  const cls = state.instructor.classSession
  const nextClass = nextDayOfWeek(today, cls.dayIndex)
  const plan = state.instructor.weeklyPlan

  const toggle = (id: string, next: boolean) => {
    update((draft) => ({
      ...draft,
      checklist: next
        ? [...new Set([...draft.checklist, id])]
        : draft.checklist.filter((c) => c !== id),
    }))
  }

  return (
    <>
      <Masthead greeting="Hi" />

      <div className="screen">
        <div>
          <h1>My Weekly Practice Plan</h1>
          <p className="small muted">Practice at home. Be ready for the dojo.</p>
        </div>

        {/* ------------------------------------------------------ week plan */}
        <Card>
          <WeekStrip plan={plan} dates={dates} today={today} practiceDates={practised} />
          <p className="small muted" style={{ marginTop: 'var(--s-3)' }}>
            {week.done} of {week.goal} home practices done this week.
          </p>
        </Card>

        {/* --------------------------------------------------- next class */}
        <Card variant="hero">
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <span
              aria-hidden="true"
              style={{
                flex: 'none',
                width: 44,
                height: 44,
                display: 'grid',
                placeItems: 'center',
                borderRadius: '50%',
                background: 'var(--white)',
                color: 'var(--blue-600)',
              }}
            >
              <Icon name="etiquette" size={22} />
            </span>
            <div className="grow">
              <h2>{cls.title}</h2>
              <p className="small bold" style={{ color: 'var(--navy-700)' }}>
                {relativeDayLabel(nextClass, today)} · {formatTimeRange(cls.startTime, cls.endTime)}
              </p>
              <p className="small muted row" style={{ gap: 4, marginTop: 2 }}>
                <MapPin size={14} aria-hidden="true" />
                {cls.locationName}, {cls.locationCity}
              </p>
            </div>
          </div>
          {cls.focus ? (
            <p className="small muted" style={{ marginTop: 'var(--s-3)' }}>
              <strong>Class focus:</strong> {cls.focus}
            </p>
          ) : null}
          <button
            type="button"
            className="btn btn--block"
            style={{ marginTop: 'var(--s-3)' }}
            onClick={() => navigate('/schedule')}
          >
            View Class Details
          </button>
        </Card>

        {/* ---------------------------------------------- get ready checklist */}
        <Card>
          <CardHead title="Get Ready for Class" icon="shield" />
          <div className="row" style={{ alignItems: 'flex-start', marginBottom: 'var(--s-3)' }}>
            <div className="grow">
              <p className="small muted">Check off your items before you go.</p>
            </div>
            <ProgressRing
              value={ready.done}
              max={ready.total}
              size={78}
              unit="Ready"
              tone={dojoReady ? 'green' : 'blue'}
              label={`Class readiness: ${ready.done} of ${ready.total} items done`}
            />
          </div>

          <div className="stack-2">
            {CHECKLIST.map((item) => (
              <CheckRow
                key={item.id}
                checked={state.checklist.includes(item.id)}
                onChange={(next) => toggle(item.id, next)}
                label={item.label}
                hint={item.hint}
                icon={item.icon}
              />
            ))}
          </div>

          {dojoReady ? (
            <div style={{ marginTop: 'var(--s-3)' }}>
              <Note tone="green" icon="complete" title="You're ready.">
                Prepared students make the most of class time.
              </Note>
            </div>
          ) : (
            <p className="small faint" style={{ marginTop: 'var(--s-3)' }}>
              {ready.total - ready.done} to go. Tick them off as you get them done.
            </p>
          )}
        </Card>

        {/* -------------------------------------------------------- mission */}
        <Card variant="tint">
          <CardHead title="This Week's Mission" icon="target" />
          <h3 style={{ fontSize: '1.125rem' }}>{plan.mission}</h3>
          <p className="small muted" style={{ marginTop: 4 }}>
            {plan.missionDetail}
          </p>
          <div className="row" style={{ gap: 'var(--s-2)', marginTop: 'var(--s-3)', flexWrap: 'wrap' }}>
            <Chip tone={week.met ? 'green' : 'blue'} icon={week.met ? 'complete' : 'target'}>
              {week.done} of {week.goal} done
            </Chip>
            {week.met ? <Chip tone="gold" icon="trophy">Mission complete</Chip> : null}
          </div>
        </Card>

        {/* -------------------------------------------------------- routines */}
        <section className="section">
          <SectionHead title="Start a practice" icon="reps" script="Practice with Purpose" />
          <div className="stack">
            {ROUTINES.map((routine) => (
              <button
                key={routine.id}
                type="button"
                className="card-link"
                onClick={() => navigate(`/practice/session/${routine.id}`)}
              >
                <div className="row">
                  <span
                    aria-hidden="true"
                    style={{
                      flex: 'none',
                      width: 44,
                      height: 44,
                      display: 'grid',
                      placeItems: 'center',
                      borderRadius: 'var(--r-md)',
                      background: 'var(--blue-100)',
                      color: 'var(--blue-600)',
                    }}
                  >
                    <Play size={21} />
                  </span>
                  <div className="grow">
                    <h3>{routine.title}</h3>
                    <p className="small muted">{routine.subtitle}</p>
                    <p className="tiny faint" style={{ marginTop: 2 }}>
                      {routine.steps.length} steps · about {routine.estimatedMinutes} minutes
                    </p>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </section>

        <Note tone="gold" icon="shield" title="Before you start.">
          Practise in a clear area, move slowly and stay in control, and stop if something hurts.
          Always practise with a parent or instructor's permission.
        </Note>
      </div>
    </>
  )
}
