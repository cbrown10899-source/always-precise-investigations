import { useCallback, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Check, ChevronLeft, ChevronRight, Minus, Pause, Play, Plus, RotateCcw } from 'lucide-react'
import { SubHeader } from '../components/SubHeader'
import { Icon } from '../components/Icon'
import { Card, Chip, Empty, Note, ProgressBar } from '../components/ui'
import { lessonById } from '../data/lessons'
import { beltById } from '../data/belts'
import { useApp } from '../hooks/useApp'
import { useCountdown } from '../hooks/useCountdown'
import { formatClock } from '../utils/dates'
import type { AppState, LessonProgress, LessonStep } from '../types'

/**
 * A lesson, played step by step.
 *
 * Progress is written on every step change, so closing the app mid-lesson and
 * coming back lands on the step the student left — the reason `currentStepIndex`
 * is stored rather than only the completed set.
 */
export function LessonDetailScreen() {
  const { lessonId } = useParams<{ lessonId: string }>()
  const { state, update } = useApp()
  const navigate = useNavigate()
  const lesson = lessonId ? lessonById(lessonId) : undefined

  const stored = lesson ? state.lessonProgress[lesson.id] : undefined
  const [index, setIndex] = useState(() => stored?.currentStepIndex ?? 0)

  const writeProgress = useCallback(
    (recipe: (p: LessonProgress) => LessonProgress) => {
      if (!lesson) return
      update((draft: AppState) => {
        const existing: LessonProgress = draft.lessonProgress[lesson.id] ?? {
          lessonId: lesson.id,
          currentStepIndex: 0,
          completedStepIds: [],
          completed: false,
          completedAt: null,
          repsByStepId: {},
        }
        return {
          ...draft,
          lessonProgress: { ...draft.lessonProgress, [lesson.id]: recipe(existing) },
        }
      })
    },
    [lesson, update],
  )

  if (!lesson) {
    return (
      <div className="screen">
        <SubHeader title="Lesson not found" fallbackTo="/lessons" />
        <Card>
          <Empty icon="learn" title="We could not find that lesson">
            It may have been renamed, or the link may be out of date.
            <br />
            <button
              type="button"
              className="btn"
              style={{ marginTop: 'var(--s-4)' }}
              onClick={() => navigate('/lessons')}
            >
              Back to Lessons
            </button>
          </Empty>
        </Card>
      </div>
    )
  }

  const step = lesson.steps[Math.min(index, lesson.steps.length - 1)]
  const progress = state.lessonProgress[lesson.id]
  const doneIds = new Set(progress?.completedStepIds ?? [])
  const isLast = index === lesson.steps.length - 1
  const stepDone = doneIds.has(step.id)

  const markStepDone = () => {
    writeProgress((p) => ({
      ...p,
      completedStepIds: p.completedStepIds.includes(step.id)
        ? p.completedStepIds
        : [...p.completedStepIds, step.id],
    }))
  }

  const goTo = (next: number) => {
    const clamped = Math.max(0, Math.min(lesson.steps.length - 1, next))
    setIndex(clamped)
    writeProgress((p) => ({ ...p, currentStepIndex: clamped }))
  }

  const completeLesson = () => {
    markStepDone()
    writeProgress((p) => ({
      ...p,
      completedStepIds: [...new Set([...p.completedStepIds, ...lesson.steps.map((s) => s.id)])],
      completed: true,
      completedAt: new Date().toISOString(),
      currentStepIndex: lesson.steps.length - 1,
    }))
  }

  const restart = () => {
    writeProgress((p) => ({
      ...p,
      currentStepIndex: 0,
      completedStepIds: [],
      completed: false,
      repsByStepId: {},
    }))
    setIndex(0)
  }

  return (
    <div className="screen">
      <SubHeader
        title={lesson.title}
        subtitle={lesson.tagline}
        fallbackTo="/lessons"
      />

      <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--s-2)' }}>
        <Chip tone="plain" icon="clock">
          {lesson.estimatedMinutes} min
        </Chip>
        <Chip tone="plain">{beltById(lesson.beltId).shortLabel}</Chip>
        {progress?.completed ? (
          <Chip tone="green" icon="complete">
            Completed
          </Chip>
        ) : null}
      </div>

      {/* -------------------------------------------------------- step map */}
      <Card>
        <p className="tiny bold muted" style={{ letterSpacing: '0.06em', marginBottom: 6 }}>
          STEP {index + 1} OF {lesson.steps.length}
        </p>
        <ProgressBar
          value={doneIds.size}
          max={lesson.steps.length}
          tone={progress?.completed ? 'green' : undefined}
          label={`Lesson progress: ${doneIds.size} of ${lesson.steps.length} steps done`}
        />
        <ol
          className="row"
          style={{ gap: 6, marginTop: 'var(--s-3)', flexWrap: 'wrap', listStyle: 'none' }}
        >
          {lesson.steps.map((s, i) => {
            const done = doneIds.has(s.id)
            const current = i === index
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => goTo(i)}
                  aria-current={current ? 'step' : undefined}
                  aria-label={`Step ${i + 1}: ${s.title}. ${done ? 'Done.' : 'Not done yet.'}`}
                  className={`stepdot ${done ? 'stepdot--done' : ''} ${
                    current ? 'stepdot--current' : ''
                  }`.trim()}
                >
                  {done ? <Check size={16} strokeWidth={3} aria-hidden="true" /> : i + 1}
                </button>
              </li>
            )
          })}
        </ol>
      </Card>

      {/* ------------------------------------------------------ the step */}
      <StepPanel
        key={step.id}
        step={step}
        done={stepDone}
        savedReps={progress?.repsByStepId[step.id] ?? 0}
        onReps={(reps) =>
          writeProgress((p) => ({ ...p, repsByStepId: { ...p.repsByStepId, [step.id]: reps } }))
        }
        onDone={markStepDone}
        lessonCompleted={progress?.completed ?? false}
        onCompleteLesson={completeLesson}
        onRestart={restart}
      />

      {/* ------------------------------------------------------ controls */}
      <div className="row" style={{ gap: 'var(--s-3)' }}>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => goTo(index - 1)}
          disabled={index === 0}
          style={{ flex: 1 }}
        >
          <ChevronLeft size={18} aria-hidden="true" />
          Back
        </button>
        {isLast ? (
          <button
            type="button"
            className="btn"
            onClick={() => navigate('/lessons')}
            style={{ flex: 2 }}
          >
            Back to Lessons
          </button>
        ) : (
          <button
            type="button"
            className="btn"
            onClick={() => {
              markStepDone()
              goTo(index + 1)
            }}
            style={{ flex: 2 }}
          >
            Next
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- one step */

function StepPanel({
  step,
  done,
  savedReps,
  onReps,
  onDone,
  lessonCompleted,
  onCompleteLesson,
  onRestart,
}: {
  step: LessonStep
  done: boolean
  savedReps: number
  onReps: (n: number) => void
  onDone: () => void
  lessonCompleted: boolean
  onCompleteLesson: () => void
  onRestart: () => void
}) {
  return (
    <Card>
      <div className="row" style={{ alignItems: 'flex-start', marginBottom: 'var(--s-3)' }}>
        <span
          aria-hidden="true"
          style={{
            flex: 'none',
            width: 44,
            height: 44,
            display: 'grid',
            placeItems: 'center',
            borderRadius: 'var(--r-md)',
            background: done ? 'var(--green-tint)' : 'var(--blue-100)',
            color: done ? 'var(--green-ink)' : 'var(--blue-600)',
          }}
        >
          <Icon name={step.kind} size={22} />
        </span>
        <div className="grow">
          <h2>{step.title}</h2>
          <p className="small muted">{step.summary}</p>
        </div>
        {done ? <Chip tone="green" icon="complete">Done</Chip> : null}
      </div>

      {step.points.length > 0 ? (
        <ul className="stack-2" style={{ listStyle: 'none' }}>
          {step.points.map((point) => (
            <li key={point} className="row" style={{ alignItems: 'flex-start', gap: 'var(--s-2)' }}>
              <span
                aria-hidden="true"
                style={{
                  flex: 'none',
                  marginTop: 7,
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: 'var(--blue-400)',
                }}
              />
              <span style={{ fontSize: '0.9375rem' }}>{point}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {step.kind === 'demo' ? <DemoPlaceholder /> : null}

      {step.durationSeconds ? (
        <StepTimer seconds={step.durationSeconds} onFinish={onDone} />
      ) : null}

      {step.targetReps ? (
        <RepCounter
          target={step.targetReps}
          value={savedReps}
          onChange={onReps}
          onReach={onDone}
        />
      ) : null}

      {step.questions ? <Quiz questions={step.questions} onAllCorrect={onDone} /> : null}

      {step.kind === 'complete' ? (
        <div className="stack" style={{ marginTop: 'var(--s-4)' }}>
          {lessonCompleted ? (
            <>
              <Note tone="green" icon="complete" title="Lesson complete.">
                Well done. Come back any time to review it.
              </Note>
              <button type="button" className="btn btn--ghost btn--block" onClick={onRestart}>
                <RotateCcw size={18} aria-hidden="true" />
                Start this lesson again
              </button>
            </>
          ) : (
            <button type="button" className="btn btn--lg btn--block" onClick={onCompleteLesson}>
              <Check size={20} aria-hidden="true" />
              Complete Lesson
            </button>
          )}
        </div>
      ) : null}

      {step.safetyNote ? (
        <div style={{ marginTop: 'var(--s-4)' }}>
          <Note tone="gold" icon="shield" title="Safety">
            {step.safetyNote}
          </Note>
        </div>
      ) : null}
    </Card>
  )
}

/**
 * The demo step.
 *
 * There is no video in this demo build, and the panel says so rather than
 * showing a play button that does nothing. The written points above it are the
 * demonstration until the school supplies footage.
 */
function DemoPlaceholder() {
  return (
    <div
      style={{
        marginTop: 'var(--s-3)',
        borderRadius: 'var(--r-md)',
        border: '1px dashed var(--line-strong)',
        background: 'var(--paper)',
        padding: 'var(--s-5)',
        textAlign: 'center',
      }}
    >
      <Icon name="demo" size={28} />
      <p className="small bold" style={{ marginTop: 6 }}>
        Video demo coming soon
      </p>
      <p className="tiny faint" style={{ marginTop: 2 }}>
        Your instructor's own demonstration video will play here. For now, follow the written
        checkpoints above.
      </p>
    </div>
  )
}

/* ------------------------------------------------------------- step timer */

function StepTimer({ seconds, onFinish }: { seconds: number; onFinish: () => void }) {
  const timer = useCountdown(seconds, onFinish)
  const elapsed = seconds - timer.remaining

  return (
    <div style={{ marginTop: 'var(--s-4)' }}>
      <div className="row-between" style={{ marginBottom: 'var(--s-2)' }}>
        <span
          className="bold"
          style={{ fontSize: '2rem', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' }}
        >
          {formatClock(timer.remaining)}
        </span>
        <button
          type="button"
          className="btn"
          onClick={timer.toggle}
          disabled={timer.finished}
          aria-label={timer.running ? 'Pause timer' : 'Start timer'}
        >
          {timer.running ? <Pause size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}
          {timer.running ? 'Pause' : timer.finished ? 'Done' : 'Start'}
        </button>
      </div>
      <ProgressBar
        value={elapsed}
        max={seconds}
        tone={timer.finished ? 'green' : undefined}
        label="Step timer"
      />
      {timer.finished ? (
        <p className="small bold" style={{ color: 'var(--green-ink)', marginTop: 'var(--s-2)' }}>
          Time's up — nice work.
        </p>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------ rep counter */

function RepCounter({
  target,
  value,
  onChange,
  onReach,
}: {
  target: number
  value: number
  onChange: (n: number) => void
  onReach: () => void
}) {
  const set = (n: number) => {
    const next = Math.max(0, Math.min(target, n))
    onChange(next)
    if (next >= target) onReach()
  }

  return (
    <div style={{ marginTop: 'var(--s-4)' }}>
      <p className="small bold center muted" style={{ marginBottom: 'var(--s-2)' }}>
        Count your reps — target {target}
      </p>
      <div className="reps">
        <button
          type="button"
          className="reps__btn"
          onClick={() => set(value - 1)}
          disabled={value === 0}
          aria-label="One fewer rep"
        >
          <Minus size={22} aria-hidden="true" />
        </button>
        <span className="reps__value" aria-live="polite">
          {value}
          <span className="faint" style={{ fontSize: '1rem' }}>
            {' '}
            / {target}
          </span>
        </span>
        <button
          type="button"
          className="reps__btn"
          onClick={() => set(value + 1)}
          disabled={value >= target}
          aria-label="One more rep"
        >
          <Plus size={22} aria-hidden="true" />
        </button>
      </div>
      {value >= target ? (
        <p className="small bold center" style={{ color: 'var(--green-ink)', marginTop: 'var(--s-2)' }}>
          All {target} done.
        </p>
      ) : null}
    </div>
  )
}

/* -------------------------------------------------------------------- quiz */

function Quiz({
  questions,
  onAllCorrect,
}: {
  questions: NonNullable<LessonStep['questions']>
  onAllCorrect: () => void
}) {
  const [answers, setAnswers] = useState<Record<string, number>>({})

  const allCorrect = useMemo(
    () => questions.every((q) => answers[q.id] === q.answerIndex),
    [questions, answers],
  )

  const choose = (questionId: string, optionIndex: number) => {
    const next = { ...answers, [questionId]: optionIndex }
    setAnswers(next)
    if (questions.every((q) => next[q.id] === q.answerIndex)) onAllCorrect()
  }

  return (
    <div className="stack" style={{ marginTop: 'var(--s-4)' }}>
      {questions.map((q, qi) => {
        const chosen = answers[q.id]
        const answered = chosen !== undefined
        const correct = chosen === q.answerIndex

        return (
          <fieldset
            key={q.id}
            style={{ border: 'none', padding: 0, margin: 0 }}
          >
            <legend className="bold" style={{ marginBottom: 'var(--s-2)', fontSize: '0.9375rem' }}>
              {qi + 1}. {q.prompt}
            </legend>
            <div className="stack-2">
              {q.options.map((option, oi) => {
                const isChosen = chosen === oi
                const isAnswer = oi === q.answerIndex
                // Only the chosen option is coloured, and it carries a word as
                // well as a tint — a right answer the student did not pick is
                // never highlighted for them.
                const tint = !isChosen
                  ? 'var(--white)'
                  : isAnswer
                    ? 'var(--green-tint)'
                    : 'var(--red-tint)'
                const edge = !isChosen
                  ? 'var(--line)'
                  : isAnswer
                    ? 'var(--green-line)'
                    : 'var(--red-line)'

                return (
                  <button
                    key={option}
                    type="button"
                    onClick={() => choose(q.id, oi)}
                    aria-pressed={isChosen}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--s-2)',
                      width: '100%',
                      minHeight: 'var(--tap-min)',
                      textAlign: 'left',
                      padding: 'var(--s-3)',
                      borderRadius: 'var(--r-md)',
                      border: `1px solid ${edge}`,
                      background: tint,
                      fontSize: '0.9375rem',
                    }}
                  >
                    <span className="grow">{option}</span>
                    {isChosen ? (
                      <span
                        className="tiny bold"
                        style={{ color: isAnswer ? 'var(--green-ink)' : 'var(--red-ink)' }}
                      >
                        {isAnswer ? 'Correct' : 'Try again'}
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>
            {answered && correct ? (
              <p className="small muted" style={{ marginTop: 'var(--s-2)' }}>
                {q.explanation}
              </p>
            ) : null}
          </fieldset>
        )
      })}

      {allCorrect ? (
        <Note tone="green" icon="complete" title="All correct.">
          You have got it. Move on to finish the lesson.
        </Note>
      ) : (
        <p className="small faint">Pick an answer for each question. You can change your mind.</p>
      )}
    </div>
  )
}
