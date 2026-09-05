import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { SubHeader } from '../components/SubHeader'
import { Card, CardHead, Chip, Note } from '../components/ui'
import { BELTS } from '../data/belts'
import { SKILLS } from '../data/skills'
import { LESSONS } from '../data/lessons'
import { useApp } from '../hooks/useApp'
import { DAY_NAMES, isoDate } from '../utils/dates'
import type { AttendanceStatus, BeltId, DayIndex, SkillId } from '../types'

/**
 * Instructor Demo.
 *
 * Everything here writes into `state.instructor`, which is the ONE place the
 * child's app reads these values from — so a change lands on the Home,
 * Practice, Lessons and Progress screens immediately, with no syncing step.
 * That is the point of the screen: it demonstrates the whole future ecosystem
 * without a backend.
 *
 * It is NOT authentication and says so. A real build puts this behind a real
 * instructor account.
 */
export function InstructorDemoScreen() {
  const { state, update } = useApp()
  const instructor = state.instructor
  const [saved, setSaved] = useState<string | null>(null)

  const announce = (message: string) => {
    setSaved(message)
    window.setTimeout(() => setSaved(null), 3000)
  }

  const patch = (recipe: (i: typeof instructor) => typeof instructor, message: string) => {
    update((draft) => ({ ...draft, instructor: recipe(draft.instructor) }))
    announce(message)
  }

  const toggleSkill = (id: SkillId) => {
    patch(
      (i) => ({
        ...i,
        weeklyFocusSkillIds: i.weeklyFocusSkillIds.includes(id)
          ? i.weeklyFocusSkillIds.filter((s) => s !== id)
          : [...i.weeklyFocusSkillIds, id],
      }),
      'Weekly focus updated.',
    )
  }

  const toggleLesson = (id: string) => {
    patch(
      (i) => ({
        ...i,
        availableLessonIds: i.availableLessonIds.includes(id)
          ? i.availableLessonIds.filter((l) => l !== id)
          : [...i.availableLessonIds, id],
      }),
      'Lesson availability updated.',
    )
  }

  const addAttendance = (status: AttendanceStatus) => {
    const today = new Date()
    patch(
      (i) => ({
        ...i,
        attendance: [
          ...i.attendance,
          {
            id: `att-${Date.now()}`,
            date: isoDate(today),
            status,
            className: i.classSession.title,
          },
        ],
      }),
      'Attendance recorded.',
    )
  }

  return (
    <div className="screen">
      <SubHeader
        title="Instructor Demo"
        subtitle="Changes appear in the student's app straight away"
        fallbackTo="/more"
      />

      <Note tone="gold" icon="shield" title="INSTRUCTOR DEMO — not real authentication.">
        Anyone with this device can open this screen. A production build would put it behind a real
        instructor account. Every change here is stored on this device only.
      </Note>

      <div aria-live="polite">
        {saved ? (
          <Note tone="green" icon="complete">
            {saved}
          </Note>
        ) : null}
      </div>

      {/* -------------------------------------------------------- the belt */}
      <Card>
        <CardHead title="Belt and next goal" icon="belt" />
        <div className="stack">
          <div className="field">
            <label className="field__label" htmlFor="ins-belt">
              Current belt
            </label>
            <select
              id="ins-belt"
              className="select"
              value={instructor.currentBeltId}
              onChange={(e) =>
                patch((i) => ({ ...i, currentBeltId: e.target.value as BeltId }), 'Belt updated.')
              }
            >
              {BELTS.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="ins-goal">
              Next belt / stripe goal
            </label>
            <select
              id="ins-goal"
              className="select"
              value={instructor.nextGoalBeltId}
              onChange={(e) =>
                patch(
                  (i) => ({ ...i, nextGoalBeltId: e.target.value as BeltId }),
                  'Next goal updated.',
                )
              }
            >
              {BELTS.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="ins-window">
              Estimated test window (optional)
            </label>
            <input
              id="ins-window"
              className="input"
              type="text"
              placeholder="e.g. June 2026"
              value={instructor.testWindow}
              onChange={(e) => patch((i) => ({ ...i, testWindow: e.target.value }), 'Test window updated.')}
            />
            <span className="field__hint">
              Leave empty and the student's app says the window is not set, rather than guessing one.
            </span>
          </div>
        </div>
      </Card>

      {/* ------------------------------------------------------ weekly focus */}
      <Card>
        <CardHead title="Weekly focus" icon="target" />
        <p className="small muted" style={{ marginBottom: 'var(--s-3)' }}>
          Shown on the student's Home screen and in Parent Mode.
        </p>
        <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--s-2)' }}>
          {SKILLS.map((skill) => {
            const on = instructor.weeklyFocusSkillIds.includes(skill.id)
            return (
              <button
                key={skill.id}
                type="button"
                aria-pressed={on}
                onClick={() => toggleSkill(skill.id)}
                className={`chip ${on ? '' : 'chip--plain'}`}
                style={{ minHeight: 44, cursor: 'pointer', fontSize: '0.8125rem' }}
              >
                {on ? '✓ ' : ''}
                {skill.label}
              </button>
            )
          })}
        </div>
      </Card>

      {/* ------------------------------------------------------ class times */}
      <Card>
        <CardHead title="Dojo class" icon="calendar" />
        <div className="stack">
          <div className="field">
            <label className="field__label" htmlFor="ins-day">
              Class day
            </label>
            <select
              id="ins-day"
              className="select"
              value={instructor.classSession.dayIndex}
              onChange={(e) =>
                patch(
                  (i) => {
                    const dayIndex = Number(e.target.value) as DayIndex
                    return {
                      ...i,
                      classSession: {
                        ...i.classSession,
                        dayIndex,
                        title: `${DAY_NAMES[dayIndex]} Dojo Class`,
                      },
                      // The weekly plan's dojo day moves with the class, so the
                      // week strip cannot disagree with the schedule.
                      weeklyPlan: {
                        ...i.weeklyPlan,
                        days: i.weeklyPlan.days.map((d) =>
                          d.dayIndex === dayIndex
                            ? { ...d, kind: 'dojo' as const, label: 'Dojo Class' }
                            : d.kind === 'dojo'
                              ? { ...d, kind: 'home' as const, label: 'Home Practice' }
                              : d,
                        ),
                      },
                    }
                  },
                  'Class day updated.',
                )
              }
            >
              {DAY_NAMES.map((name, i) => (
                <option key={name} value={i}>
                  {name}
                </option>
              ))}
            </select>
          </div>

          <div className="grid-2">
            <div className="field">
              <label className="field__label" htmlFor="ins-start">
                Start time
              </label>
              <input
                id="ins-start"
                className="input"
                type="time"
                value={instructor.classSession.startTime}
                onChange={(e) =>
                  patch(
                    (i) => ({ ...i, classSession: { ...i.classSession, startTime: e.target.value } }),
                    'Class time updated.',
                  )
                }
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="ins-end">
                End time
              </label>
              <input
                id="ins-end"
                className="input"
                type="time"
                value={instructor.classSession.endTime}
                onChange={(e) =>
                  patch(
                    (i) => ({ ...i, classSession: { ...i.classSession, endTime: e.target.value } }),
                    'Class time updated.',
                  )
                }
              />
            </div>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="ins-focus">
              Class focus (optional)
            </label>
            <input
              id="ins-focus"
              className="input"
              type="text"
              value={instructor.classSession.focus}
              onChange={(e) =>
                patch(
                  (i) => ({ ...i, classSession: { ...i.classSession, focus: e.target.value } }),
                  'Class focus updated.',
                )
              }
            />
          </div>
        </div>
      </Card>

      {/* ---------------------------------------------------------- mission */}
      <Card>
        <CardHead title="Weekly mission and goal" icon="trophy" />
        <div className="stack">
          <NumberField
            id="ins-goalcount"
            label="Home practices per week"
            min={1}
            max={14}
            value={instructor.weeklyPlan.goalPractices}
            onCommit={(goalPractices) =>
              patch(
                (i) => ({ ...i, weeklyPlan: { ...i.weeklyPlan, goalPractices } }),
                'Weekly goal updated.',
              )
            }
          />

          <div className="field">
            <label className="field__label" htmlFor="ins-mission">
              Mission title
            </label>
            <input
              id="ins-mission"
              className="input"
              type="text"
              value={instructor.weeklyPlan.mission}
              onChange={(e) =>
                patch(
                  (i) => ({ ...i, weeklyPlan: { ...i.weeklyPlan, mission: e.target.value } }),
                  'Mission updated.',
                )
              }
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="ins-missiondetail">
              Mission detail
            </label>
            <textarea
              id="ins-missiondetail"
              className="textarea"
              value={instructor.weeklyPlan.missionDetail}
              onChange={(e) =>
                patch(
                  (i) => ({ ...i, weeklyPlan: { ...i.weeklyPlan, missionDetail: e.target.value } }),
                  'Mission updated.',
                )
              }
            />
          </div>
        </div>
      </Card>

      {/* ----------------------------------------------------- lesson access */}
      <Card>
        <CardHead title="Lesson availability" icon="learn" />
        <p className="small muted" style={{ marginBottom: 'var(--s-3)' }}>
          Unticked lessons are not listed in the student's library at all.
        </p>
        <div className="stack-2">
          {LESSONS.map((lesson) => {
            const on = instructor.availableLessonIds.includes(lesson.id)
            return (
              <button
                key={lesson.id}
                type="button"
                className="check"
                aria-pressed={on}
                // An explicit name, rather than letting the accessible name be
                // a concatenation of the title, the category, the duration and
                // the state — which is what a screen reader was reading out.
                aria-label={`${lesson.title} — ${on ? 'available to the student' : 'hidden from the student'}`}
                onClick={() => toggleLesson(lesson.id)}
              >
                <span className="check__box" aria-hidden="true">
                  {on ? '✓' : ''}
                </span>
                <span className="grow">
                  <span className="check__label">{lesson.title}</span>
                  <span className="tiny faint" style={{ display: 'block' }}>
                    {lesson.category === 'belt' ? 'Belt' : lesson.category === 'skills' ? 'Skills' : 'Character'}{' '}
                    · {lesson.estimatedMinutes} min
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </Card>

      {/* -------------------------------------------------- instructor note */}
      <Card>
        <CardHead title="Instructor note" icon="heart" />
        <div className="stack">
          <div className="field">
            <label className="field__label" htmlFor="ins-name">
              Your name (optional)
            </label>
            <input
              id="ins-name"
              className="input"
              type="text"
              placeholder="e.g. Sensei Smith"
              value={instructor.insight.instructorName ?? ''}
              onChange={(e) =>
                patch(
                  (i) => ({
                    ...i,
                    insight: { ...i.insight, instructorName: e.target.value.trim() || null },
                  }),
                  'Instructor name updated.',
                )
              }
            />
            <span className="field__hint">
              Left blank, Parent Mode says the name is not set rather than inventing one.
            </span>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="ins-note">
              Note to the parent
            </label>
            <textarea
              id="ins-note"
              className="textarea"
              value={instructor.insight.instructorNote}
              onChange={(e) =>
                patch(
                  (i) => ({
                    ...i,
                    insight: {
                      ...i.insight,
                      instructorNote: e.target.value,
                      updatedAt: isoDate(new Date()),
                    },
                  }),
                  'Note saved.',
                )
              }
            />
          </div>

          <EditableList
            label="What the student practised"
            items={instructor.insight.practiced}
            onChange={(practiced) =>
              patch((i) => ({ ...i, insight: { ...i.insight, practiced } }), 'Practised list updated.')
            }
            placeholder="e.g. Stance and balance"
          />

          <EditableList
            label="Work on next"
            items={instructor.insight.workOnNext}
            onChange={(workOnNext) =>
              patch((i) => ({ ...i, insight: { ...i.insight, workOnNext } }), 'Work-on list updated.')
            }
            placeholder="e.g. Keep hands up after punching"
          />
        </div>
      </Card>

      {/* ------------------------------------------------------- attendance */}
      <Card>
        <CardHead title="Attendance" icon="calendar" />
        <p className="small muted" style={{ marginBottom: 'var(--s-3)' }}>
          Records a class for today's date. Shown on the student's Progress screen.
        </p>
        <div className="row" style={{ gap: 'var(--s-2)' }}>
          <button type="button" className="btn" style={{ flex: 1 }} onClick={() => addAttendance('present')}>
            <Plus size={17} aria-hidden="true" />
            Attended
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            style={{ flex: 1 }}
            onClick={() => addAttendance('absent')}
          >
            <Plus size={17} aria-hidden="true" />
            Missed
          </button>
        </div>

        {instructor.attendance.length === 0 ? (
          <p className="small faint" style={{ marginTop: 'var(--s-3)' }}>
            No attendance recorded yet.
          </p>
        ) : (
          <ul className="rows" style={{ listStyle: 'none', marginTop: 'var(--s-3)' }}>
            {[...instructor.attendance]
              .sort((a, b) => b.date.localeCompare(a.date))
              .map((record) => (
                <li key={record.id} className="row-between" style={{ padding: 'var(--s-2) 0' }}>
                  <span className="small">
                    {record.date}
                    <br />
                    <span className="tiny faint">{record.className}</span>
                  </span>
                  <span className="row" style={{ gap: 'var(--s-2)' }}>
                    <Chip tone={record.status === 'present' ? 'green' : 'orange'}>
                      {record.status === 'present' ? 'Attended' : 'Missed'}
                    </Chip>
                    <button
                      type="button"
                      className="btn btn--danger"
                      style={{ minHeight: 44, padding: '0 var(--s-3)' }}
                      aria-label={`Remove attendance record for ${record.date}`}
                      onClick={() =>
                        patch(
                          (i) => ({ ...i, attendance: i.attendance.filter((a) => a.id !== record.id) }),
                          'Attendance record removed.',
                        )
                      }
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  </span>
                </li>
              ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

/* --------------------------------------------------------- editable list */

/**
 * A list the instructor edits by hand.
 *
 * The draft input is local state and is cleared only on a successful add, so a
 * repaint cannot silently discard what was typed — the same reason every form
 * in this app is controlled.
 */
function EditableList({
  label,
  items,
  onChange,
  placeholder,
}: {
  label: string
  items: string[]
  onChange: (next: string[]) => void
  placeholder: string
}) {
  const [draft, setDraft] = useState('')
  const inputId = `list-${label.replace(/\s+/g, '-').toLowerCase()}`

  const add = () => {
    const value = draft.trim()
    if (!value) return
    onChange([...items, value])
    setDraft('')
  }

  return (
    <div className="field">
      <span className="field__label" id={`${inputId}-label`}>
        {label}
      </span>

      {items.length > 0 ? (
        <ul className="stack-2" style={{ listStyle: 'none', marginBottom: 'var(--s-2)' }}>
          {items.map((item, i) => (
            <li key={`${item}-${i}`} className="row" style={{ gap: 'var(--s-2)' }}>
              <span className="grow small">{item}</span>
              <button
                type="button"
                className="btn btn--danger"
                style={{ minHeight: 44, padding: '0 var(--s-3)', flex: 'none' }}
                aria-label={`Remove "${item}"`}
                onClick={() => onChange(items.filter((_, index) => index !== i))}
              >
                <Trash2 size={15} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="tiny faint" style={{ marginBottom: 'var(--s-2)' }}>
          Nothing added yet.
        </p>
      )}

      <div className="row" style={{ gap: 'var(--s-2)' }}>
        <input
          id={inputId}
          className="input"
          type="text"
          placeholder={placeholder}
          aria-labelledby={`${inputId}-label`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
        />
        <button
          type="button"
          className="btn"
          style={{ flex: 'none', padding: '0 var(--s-4)' }}
          onClick={add}
          disabled={draft.trim().length === 0}
        >
          Add
        </button>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------- number field */

/**
 * A number input that does not fight the person typing in it.
 *
 * The first version clamped on every keystroke, so clearing the box snapped it
 * to the minimum and the next digit typed appended to that — "7" became 17,
 * then clamped to 14. It holds a draft while the field has focus and commits a
 * clamped value on blur, which is also what makes an intermediate empty box
 * legal.
 */
function NumberField({
  id,
  label,
  value,
  min,
  max,
  onCommit,
}: {
  id: string
  label: string
  value: number
  min: number
  max: number
  onCommit: (next: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)

  const commit = () => {
    const parsed = Number(draft)
    setDraft(null)
    // An empty or unparseable box means "no change", never "reset to minimum".
    if (draft === null || draft.trim() === '' || Number.isNaN(parsed)) return
    const clamped = Math.max(min, Math.min(max, Math.round(parsed)))
    if (clamped !== value) onCommit(clamped)
  }

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input"
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={draft ?? String(value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
        }}
      />
      <span className="field__hint">
        Between {min} and {max}. Saved when you leave the box.
      </span>
    </div>
  )
}
