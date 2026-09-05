import { ChevronRight, Clock } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { Lesson } from '../types'
import { Icon } from './Icon'
import { skillLabel } from '../data/skills'
import { Chip, ProgressBar } from './ui'

const DIFFICULTY_LABEL = {
  starter: 'Starter',
  building: 'Building',
  challenge: 'Challenge',
} as const

/**
 * A lesson in the library.
 *
 * The whole card is ONE link: one tab stop, one destination. The call to
 * action is a styled span rather than a nested button, which would be invalid
 * nesting and would give the card two tab stops for one place to go.
 */
export function LessonCard({
  lesson,
  completion,
  beltLabel,
}: {
  lesson: Lesson
  /** 0–1. */
  completion: number
  beltLabel: string
}) {
  // A skill whose label is already in the title tells the reader nothing.
  const extraSkills = lesson.skills
    .filter((id) => !lesson.title.toLowerCase().includes(skillLabel(id).toLowerCase()))
    .slice(0, 2)

  const started = completion > 0
  const done = completion >= 1
  const action = done ? 'Review' : started ? 'Continue' : 'Start'

  return (
    <Link
      to={`/lessons/${lesson.id}`}
      className="card-link"
      aria-label={`${lesson.title}. ${
        extraSkills.length > 0 ? `Also builds ${extraSkills.map(skillLabel).join(' and ')}. ` : ''
      }${lesson.estimatedMinutes} minutes. ${beltLabel}. ${
        done ? 'Completed.' : started ? `${Math.round(completion * 100)}% complete.` : 'Not started.'
      } ${action} lesson.`}
    >
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <span
          aria-hidden="true"
          style={{
            flex: 'none',
            width: 46,
            height: 46,
            display: 'grid',
            placeItems: 'center',
            borderRadius: 'var(--r-md)',
            background: done ? 'var(--green-tint)' : 'var(--blue-100)',
            color: done ? 'var(--green-ink)' : 'var(--blue-600)',
          }}
        >
          <Icon name={lesson.icon} size={23} />
        </span>

        <div className="grow">
          <h3 style={{ marginBottom: 2 }}>{lesson.title}</h3>
          <p className="small muted">{lesson.tagline}</p>
        </div>

        <ChevronRight size={20} aria-hidden="true" color="var(--ink-faint)" style={{ flex: 'none' }} />
      </div>

      <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--s-2)', marginTop: 'var(--s-3)' }}>
        {/* The skills the lesson develops BEYOND its own name.
            Since skills are named for techniques, "Ready Stance" as a chip on
            the Ready Stance card is the title twice; what a reader does not
            already know is that it also builds balance and focus. Two at most,
            or the row becomes a wall of chips at 320px. */}
        {extraSkills.map((id) => (
          <Chip key={id} tone="blue">
            {skillLabel(id)}
          </Chip>
        ))}
        <Chip tone="plain">
          <Clock size={12} aria-hidden="true" />
          {lesson.estimatedMinutes} min
        </Chip>
        <Chip tone="plain">{DIFFICULTY_LABEL[lesson.difficulty]}</Chip>
        <Chip tone="plain">{beltLabel}</Chip>
        {done ? (
          <Chip tone="green" icon="complete">
            Completed
          </Chip>
        ) : null}
      </div>

      {started && !done ? (
        <div style={{ marginTop: 'var(--s-3)' }}>
          <ProgressBar value={completion} label={`${lesson.title} progress`} />
        </div>
      ) : null}

      <p
        className="bold"
        style={{ marginTop: 'var(--s-3)', color: 'var(--blue-600)', fontSize: '0.9375rem' }}
        aria-hidden="true"
      >
        {action} lesson →
      </p>
    </Link>
  )
}
