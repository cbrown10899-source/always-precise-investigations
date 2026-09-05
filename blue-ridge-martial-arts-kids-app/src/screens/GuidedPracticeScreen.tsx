import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Check, ChevronLeft, ChevronRight, Minus, Pause, Play, Plus, X } from 'lucide-react'
import { Icon } from '../components/Icon'
import { Card, Empty } from '../components/ui'
import { routineById } from '../data/practice'
import { useApp } from '../hooks/useApp'
import { useCountdown } from '../hooks/useCountdown'
import { formatClock } from '../utils/dates'
import { buildSession } from '../utils/progress'
import type { PracticeStep, SkillId } from '../types'

/**
 * Guided practice: a full-screen, one-step-at-a-time player.
 *
 * The session is written ONCE, when the student finishes, and the write is the
 * only thing that touches the streak, the badges and the weekly count — the
 * store recomputes those from the record rather than incrementing counters, so
 * a double tap on Complete cannot log two practices (the completion flag
 * guards the second).
 */
export function GuidedPracticeScreen() {
  const { routineId } = useParams<{ routineId: string }>()
  const { update } = useApp()
  const navigate = useNavigate()
  const routine = routineId ? routineById(routineId) : undefined

  const [index, setIndex] = useState(0)
  const [doneIds, setDoneIds] = useState<string[]>([])
  const [reps, setReps] = useState<Record<string, number>>({})
  const [finished, setFinished] = useState(false)
  const startedAt = useRef(Date.now())
  // Guards the write: a second tap on Complete must not log a second practice.
  const logged = useRef(false)

  const step: PracticeStep | undefined = routine?.steps[index]

  const markDone = useCallback((id: string) => {
    setDoneIds((current) => (current.includes(id) ? current : [...current, id]))
  }, [])

  const complete = useCallback(() => {
    if (!routine || logged.current) return
    logged.current = true

    const now = new Date()
    const minutes = Math.max(1, Math.round((Date.now() - startedAt.current) / 60_000))
    const skills = [...new Set(routine.steps.flatMap((s) => s.skills))] as SkillId[]
    const completedCount = new Set([...doneIds, routine.steps[routine.steps.length - 1].id]).size

    const session = buildSession(
      routine.id,
      routine.title,
      skills,
      Math.min(completedCount, routine.steps.length),
      routine.steps.length,
      minutes,
      now,
    )

    update((draft) => ({ ...draft, practiceHistory: [...draft.practiceHistory, session] }))
    setFinished(true)
  }, [routine, doneIds, update])

  // Escape leaves the player, matching the on-screen Exit control.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') navigate('/practice')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])

  if (!routine) {
    return (
      <div className="app__main" style={{ maxWidth: 'var(--app-max)', margin: '0 auto' }}>
        <div className="screen">
          <Card>
            <Empty icon="reps" title="That practice was not found">
              <button
                type="button"
                className="btn"
                style={{ marginTop: 'var(--s-4)' }}
                onClick={() => navigate('/practice')}
              >
                Back to Practice
              </button>
            </Empty>
          </Card>
        </div>
      </div>
    )
  }

  if (finished) {
    return <PracticeComplete routineTitle={routine.title} onClose={() => navigate('/practice')} />
  }

  const isLast = index === routine.steps.length - 1

  return (
    <div className="player">
      <div className="player__bar">
        <button type="button" className="player__exit" onClick={() => navigate('/practice')}>
          <X size={17} aria-hidden="true" />
          Exit
        </button>
        <span className="player__count">
          Step {index + 1} of {routine.steps.length}
        </span>
      </div>

      <div className="player__track">
        <ol className="player__ticks" aria-label={`Practice progress, step ${index + 1} of ${routine.steps.length}`}>
          {routine.steps.map((s, i) => (
            <li
              key={s.id}
              className={`player__tick ${
                doneIds.includes(s.id) ? 'player__tick--done' : i === index ? 'player__tick--current' : ''
              }`.trim()}
            >
              <span className="vh">
                {s.title}: {doneIds.includes(s.id) ? 'done' : i === index ? 'current step' : 'to come'}
              </span>
            </li>
          ))}
        </ol>
      </div>

      <StepStage
        key={step!.id}
        step={step!}
        reps={reps[step!.id] ?? 0}
        onReps={(n) => setReps((r) => ({ ...r, [step!.id]: n }))}
        onAutoDone={() => markDone(step!.id)}
      />

      <div className="player__controls">
        <button
          type="button"
          className="player__side"
          onClick={() => setIndex((i) => Math.max(0, i - 1))}
          disabled={index === 0}
        >
          <ChevronLeft size={20} aria-hidden="true" />
          Previous
        </button>

        {isLast ? (
          <button type="button" className="player__main" onClick={complete}>
            <Check size={20} aria-hidden="true" />
            Complete
          </button>
        ) : (
          <button
            type="button"
            className="player__main"
            onClick={() => {
              markDone(step!.id)
              setIndex((i) => Math.min(routine.steps.length - 1, i + 1))
            }}
          >
            Next
            <ChevronRight size={20} aria-hidden="true" />
          </button>
        )}

        <button
          type="button"
          className="player__side"
          onClick={() => {
            markDone(step!.id)
            setIndex((i) => Math.min(routine.steps.length - 1, i + 1))
          }}
          disabled={isLast}
        >
          <ChevronRight size={20} aria-hidden="true" />
          Skip
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- one step */

function StepStage({
  step,
  reps,
  onReps,
  onAutoDone,
}: {
  step: PracticeStep
  reps: number
  onReps: (n: number) => void
  onAutoDone: () => void
}) {
  const target = step.targetReps ?? 0
  const timer = useCountdown(step.durationSeconds ?? 0, onAutoDone)

  const setReps = (n: number) => {
    const next = Math.max(0, Math.min(target, n))
    onReps(next)
    if (next >= target) onAutoDone()
  }

  const repLabel = useMemo(
    () => (step.perSide ? `${target} each side` : `${target} reps`),
    [step.perSide, target],
  )

  return (
    <div className="player__body">
      <span className="player__icon" aria-hidden="true">
        <Icon name={step.icon} size={38} />
      </span>

      <div>
        <h1 className="player__title">{step.title}</h1>
        <p className="player__instruction" style={{ marginTop: 6 }}>
          {step.instruction}
        </p>
      </div>

      {step.durationSeconds ? (
        <>
          <p className="player__dial" aria-live="off">
            {formatClock(timer.remaining)}
          </p>
          <button type="button" className="player__main" onClick={timer.toggle} disabled={timer.finished}>
            {timer.running ? <Pause size={20} aria-hidden="true" /> : <Play size={20} aria-hidden="true" />}
            {timer.running ? 'Pause' : timer.finished ? 'Finished' : 'Start'}
          </button>
          <span className="vh" aria-live="polite">
            {timer.finished ? 'Timer finished.' : ''}
          </span>
        </>
      ) : null}

      {target > 0 ? (
        <>
          <p className="player__instruction bold">{repLabel}</p>
          <div className="reps">
            <button
              type="button"
              className="reps__btn"
              onClick={() => setReps(reps - 1)}
              disabled={reps === 0}
              aria-label="One fewer rep"
            >
              <Minus size={24} aria-hidden="true" />
            </button>
            <span className="reps__value" aria-live="polite" aria-label={`${reps} of ${target} reps done`}>
              {reps}
              <span style={{ fontSize: '1rem', opacity: 0.7 }}> / {target}</span>
            </span>
            <button
              type="button"
              className="reps__btn"
              onClick={() => setReps(reps + 1)}
              disabled={reps >= target}
              aria-label="One more rep"
            >
              <Plus size={24} aria-hidden="true" />
            </button>
          </div>
        </>
      ) : null}

      <ul className="player__cues">
        {step.cues.map((cue) => (
          <li key={cue} className="player__cue">
            <Check size={16} aria-hidden="true" style={{ flex: 'none', marginTop: 2 }} />
            <span>{cue}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ------------------------------------------------------------ completion */

function PracticeComplete({
  routineTitle,
  onClose,
}: {
  routineTitle: string
  onClose: () => void
}) {
  const { state } = useApp()
  const total = state.practiceHistory.length

  return (
    <div className="player">
      <div className="player__body" style={{ justifyContent: 'center', flex: 1 }}>
        <span className="player__icon celebrate" aria-hidden="true" style={{ background: 'var(--gold-solid)', color: 'var(--navy-900)' }}>
          <Icon name="trophy" size={40} />
        </span>
        <h1 className="player__title">Practice complete!</h1>
        <p className="player__instruction">
          {routineTitle} is logged. That is {total} {total === 1 ? 'practice' : 'practices'} in total.
        </p>
        <p className="player__instruction" style={{ color: 'var(--gold-solid)', fontWeight: 700 }}>
          Small Steps. Big Progress.
        </p>
      </div>
      <div style={{ padding: 'var(--s-4)', maxWidth: 'var(--app-max)', width: '100%', margin: '0 auto' }}>
        <button type="button" className="player__main" style={{ width: '100%' }} onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  )
}
