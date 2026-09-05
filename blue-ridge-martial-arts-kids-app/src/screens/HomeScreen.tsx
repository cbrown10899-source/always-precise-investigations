import { Link, useNavigate } from 'react-router-dom'
import { Activity, BarChart3, BookOpen, CalendarDays, ChevronRight, Flame, Play } from 'lucide-react'
import { Masthead } from '../components/Masthead'
import { WeekStrip } from '../components/WeekStrip'
import { BadgeTile } from '../components/BadgeTile'
import { Icon } from '../components/Icon'
import { Card, CardHead, Chip, Note, ProgressBar, SectionHead, Stat } from '../components/ui'
import { BADGES } from '../data/badges'
import { skillLabel, skillLessonId } from '../data/skills'
import { DEFAULT_ROUTINE_ID, routineById } from '../data/practice'
import type { SkillId } from '../types'
import { useApp } from '../hooks/useApp'
import { useToday } from '../hooks/useToday'
import {
  currentStreak,
  isReadyForDojo,
  practiceDates,
  readiness,
  todayPlan,
  weeklyProgress,
} from '../utils/progress'
import { formatTimeRange, isoDate, nextDayOfWeek, relativeDayLabel, weekDates } from '../utils/dates'

/**
 * The dashboard.
 *
 * Every number on it is derived from the records in `state` — there is no
 * stored counter anywhere. A zero is a real answer and is shown as one; the
 * app never pads a total to make the screen look busier.
 */
export function HomeScreen() {
  const { state } = useApp()
  const today = useToday()
  const navigate = useNavigate()

  const week = weeklyProgress(state, today)
  const streak = currentStreak(state.practiceHistory, today)
  const ready = readiness(state)
  const dojoReady = isReadyForDojo(state)
  const dates = weekDates(today)
  const practised = new Set(practiceDates(state.practiceHistory))
  const plan = todayPlan(state, today)
  const routine = routineById(DEFAULT_ROUTINE_ID)
  const earned = new Set(state.earnedBadges.map((b) => b.badgeId))

  const cls = state.instructor.classSession
  const nextClass = nextDayOfWeek(today, cls.dayIndex)
  const classLabel = relativeDayLabel(nextClass, today)
  const practisedToday = practised.has(isoDate(today))

  return (
    <>
      <Masthead greeting="Hi" />

      <div className="screen">
        <h1 className="vh">Home</h1>

        {/* ---------------------------------------------- today's practice */}
        <Card variant="hero">
          <div className="row-between" style={{ alignItems: 'flex-start' }}>
            <div className="grow">
              <p className="tiny bold" style={{ color: 'var(--blue-600)', letterSpacing: '0.08em' }}>
                {plan.kind === 'dojo'
                  ? 'TODAY IS A DOJO DAY'
                  : plan.kind === 'rest'
                    ? 'TODAY IS A REST DAY'
                    : "TODAY'S AT-HOME PRACTICE"}
              </p>
              <h2 style={{ fontSize: '1.375rem', marginTop: 2 }}>
                {plan.kind === 'dojo'
                  ? cls.title
                  : plan.kind === 'rest'
                    ? 'Rest & Grow'
                    : (routine?.title ?? 'Practice')}
              </h2>
              <p className="small muted" style={{ marginTop: 2 }}>
                {plan.kind === 'dojo'
                  ? `${formatTimeRange(cls.startTime, cls.endTime)} · ${cls.locationName}`
                  : plan.kind === 'rest'
                    ? 'Rest is part of training. Your body gets stronger while it recovers.'
                    : routine
                      ? `${routine.steps.length} steps · about ${routine.estimatedMinutes} minutes`
                      : 'A short session you can do at home.'}
              </p>
            </div>
            <span className="section__script" aria-hidden="true" style={{ marginTop: 4 }}>
              Small Steps.<br />Big Progress!
            </span>
          </div>

          {practisedToday ? (
            <div style={{ marginTop: 'var(--s-3)' }}>
              <Note tone="green" icon="complete" title="Practice done today.">
                Nice work. You can always do another round if you want to.
              </Note>
            </div>
          ) : null}

          {/* On a dojo day the checklist is the primary action, because being
              ready for class is what today is actually for. Practising is
              still offered, never forbidden. */}
          {plan.kind === 'dojo' ? (
            <>
              <Link
                to="/practice"
                className="btn btn--lg btn--block"
                style={{ marginTop: 'var(--s-4)' }}
              >
                <Icon name="shield" size={20} />
                {dojoReady ? 'You are ready — see the checklist' : 'Get Ready for Class'}
              </Link>
              <button
                type="button"
                className="btn btn--ghost btn--block"
                style={{ marginTop: 'var(--s-2)' }}
                onClick={() => navigate(`/practice/session/${DEFAULT_ROUTINE_ID}`)}
              >
                <Play size={18} aria-hidden="true" />
                Warm up with a practice
              </button>
            </>
          ) : (
            <button
              type="button"
              className={`btn btn--block ${plan.kind === 'rest' ? 'btn--ghost' : 'btn--lg'}`}
              style={{ marginTop: 'var(--s-4)' }}
              onClick={() => navigate(`/practice/session/${DEFAULT_ROUTINE_ID}`)}
            >
              <Play size={plan.kind === 'rest' ? 18 : 20} aria-hidden="true" />
              {plan.kind === 'rest'
                ? 'Practise anyway'
                : practisedToday
                  ? 'Practice Again'
                  : 'Start Practice'}
            </button>
          )}
        </Card>

        {/* ------------------------------------------------ weekly progress */}
        <Card>
          <CardHead
            title="This Week"
            icon="calendar"
            action={
              <span className="small bold" style={{ color: 'var(--blue-600)' }}>
                {week.done} of {week.goal}
              </span>
            }
          />
          <ProgressBar
            value={week.done}
            max={week.goal}
            tone={week.met ? 'green' : undefined}
            label={`Weekly practice progress: ${week.done} of ${week.goal} practices done`}
          />
          <p className="small muted" style={{ marginTop: 'var(--s-2)' }}>
            {week.met
              ? 'Weekly goal complete. Everything from here is a bonus.'
              : `${week.goal - week.done} more home ${
                  week.goal - week.done === 1 ? 'practice' : 'practices'
                } to reach this week's goal.`}
          </p>

          <div style={{ marginTop: 'var(--s-4)' }}>
            <WeekStrip
              plan={state.instructor.weeklyPlan}
              dates={dates}
              today={today}
              practiceDates={practised}
            />
          </div>
        </Card>

        {/* ---------------------------------------------------- quick stats */}
        <div className="grid-3">
          <div className="stat">
            <span className="stat__value" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <Flame size={19} aria-hidden="true" color="var(--orange-solid)" />
              {streak}
            </span>
            <span className="stat__label">Day streak</span>
          </div>
          <Stat value={state.earnedBadges.length} label="Badges earned" singular="Badge earned" />
          <Stat value={`${ready.done}/${ready.total}`} label="Class ready" />
        </div>

        {/* --------------------------------------------------- ready status */}
        <Card variant={dojoReady ? undefined : 'tint'}>
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
                background: dojoReady ? 'var(--green-tint)' : 'var(--blue-100)',
                color: dojoReady ? 'var(--green-ink)' : 'var(--blue-600)',
              }}
            >
              <Icon name={dojoReady ? 'complete' : 'shield'} size={22} />
            </span>
            <div className="grow">
              <h3>{dojoReady ? 'Ready for Dojo' : 'Getting ready for Dojo'}</h3>
              <p className="small muted">
                {dojoReady
                  ? 'Everything on your checklist is ticked. See you on the mat.'
                  : `${ready.total - ready.done} ${
                      ready.total - ready.done === 1 ? 'item' : 'items'
                    } left on your Get Ready checklist.`}
              </p>
            </div>
          </div>
          <div className="row" style={{ marginTop: 'var(--s-3)', gap: 'var(--s-2)' }}>
            <Chip tone={dojoReady ? 'green' : 'plain'} icon="calendar">
              {classLabel} · {formatTimeRange(cls.startTime, cls.endTime)}
            </Chip>
          </div>
          <Link
            to="/practice"
            className="btn btn--ghost btn--block"
            style={{ marginTop: 'var(--s-3)' }}
          >
            Open the checklist
            <ChevronRight size={18} aria-hidden="true" />
          </Link>
        </Card>

        {/* --------------------------------------------------- week's focus */}
        <Card>
          <CardHead title="This Week's Focus" icon="target" />
          <p className="small muted" style={{ marginBottom: 'var(--s-3)' }}>
            What your instructor wants you working on. Tap one to open its lesson.
          </p>
          <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--s-2)' }}>
            {state.instructor.weeklyFocusSkillIds.length === 0 ? (
              <p className="small faint">No focus skills set yet.</p>
            ) : (
              state.instructor.weeklyFocusSkillIds.map((id) => <FocusChip key={id} skillId={id} />)
            )}
          </div>
        </Card>

        {/* -------------------------------------------------------- shortcuts */}
        <section className="section">
          <SectionHead title="Jump to" icon="sparkle" />
          <div className="grid-2">
            <Shortcut to="/lessons" label="Lessons" hint="Learn at home" Glyph={BookOpen} />
            <Shortcut to="/practice" label="Practice" hint="Weekly plan" Glyph={Activity} />
            <Shortcut to="/schedule" label="Schedule" hint="Class times" Glyph={CalendarDays} />
            <Shortcut to="/progress" label="Belt Progress" hint="Your journey" Glyph={BarChart3} />
          </div>
        </section>

        {/* ----------------------------------------------------------- badges */}
        <section className="section">
          <SectionHead
            title="Badges Earned"
            icon="trophy"
            action={
              <Link to="/progress" className="linkish">
                View all
              </Link>
            }
          />
          {state.earnedBadges.length === 0 ? (
            <Card>
              <p className="small muted">
                No badges yet. Finish your first practice and one is waiting for you.
              </p>
            </Card>
          ) : (
            <Card>
              <div className="badge-grid">
                {BADGES.filter((b) => earned.has(b.id))
                  .slice(0, 6)
                  .map((badge) => (
                    <BadgeTile key={badge.id} badge={badge} earned />
                  ))}
              </div>
            </Card>
          )}
        </section>
      </div>
    </>
  )
}

function Shortcut({
  to,
  label,
  hint,
  Glyph,
}: {
  to: string
  label: string
  hint: string
  Glyph: typeof BookOpen
}) {
  return (
    <Link to={to} className="card-link" style={{ padding: 'var(--s-4) var(--s-3)' }}>
      <span
        aria-hidden="true"
        style={{
          display: 'grid',
          placeItems: 'center',
          width: 38,
          height: 38,
          borderRadius: 'var(--r-md)',
          background: 'var(--blue-100)',
          color: 'var(--blue-600)',
          marginBottom: 'var(--s-2)',
        }}
      >
        <Glyph size={20} />
      </span>
      <span className="bold" style={{ display: 'block', color: 'var(--navy-900)' }}>
        {label}
      </span>
      <span className="tiny faint">{hint}</span>
    </Link>
  )
}

/**
 * One "This Week's Focus" chip.
 *
 * A skill that has a lesson becomes a link to it — the shortest route from
 * "what should I work on" to actually working on it. A skill with no lesson is
 * drawn as plain text, because a control that can open nothing must not look
 * like a button.
 */
function FocusChip({ skillId }: { skillId: SkillId }) {
  const label = skillLabel(skillId)
  const lessonId = skillLessonId(skillId)

  if (!lessonId) return <Chip tone="blue">{label}</Chip>

  return (
    <Link
      to={`/lessons/${lessonId}`}
      className="chip chip--tap"
      aria-label={`${label}. Open the ${label} lesson.`}
    >
      {label}
      <ChevronRight size={13} aria-hidden="true" />
    </Link>
  )
}
