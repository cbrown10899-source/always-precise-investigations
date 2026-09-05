import { useMemo, useState } from 'react'
import { Masthead } from '../components/Masthead'
import { LessonCard } from '../components/LessonCard'
import { Card, Empty, Note, SectionHead } from '../components/ui'
import { LESSONS } from '../data/lessons'
import { beltById } from '../data/belts'
import { useApp } from '../hooks/useApp'
import { lessonCompletion } from '../utils/progress'
import type { LessonCategory } from '../types'

type Filter = 'all' | 'belt' | 'skills' | 'character'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All Lessons' },
  { id: 'belt', label: 'Current Belt' },
  { id: 'skills', label: 'Skills' },
  { id: 'character', label: 'Character' },
]

/**
 * The lesson library.
 *
 * "Current Belt" filters by the student's ACTUAL belt, not by the category
 * name, so a student who is promoted sees a different set without anything
 * being re-tagged. A lesson the instructor has withdrawn is not listed at all
 * — `availableLessonIds` is the instructor's control over what is offered.
 */
export function LessonsScreen() {
  const { state } = useApp()
  const [filter, setFilter] = useState<Filter>('all')

  const available = useMemo(
    () => new Set(state.instructor.availableLessonIds),
    [state.instructor.availableLessonIds],
  )

  const visible = useMemo(() => {
    const offered = LESSONS.filter((l) => available.has(l.id))
    if (filter === 'all') return offered
    if (filter === 'belt') {
      return offered.filter((l) => l.beltId === state.instructor.currentBeltId)
    }
    return offered.filter((l) => l.category === (filter as LessonCategory))
  }, [available, filter, state.instructor.currentBeltId])

  const completedCount = LESSONS.filter((l) => lessonCompletion(l, state) >= 1).length

  return (
    <>
      <Masthead greeting="Hi" />

      <div className="screen">
        <div>
          <h1>Lessons</h1>
          <p className="small muted">Learn at home. Practice. Grow. Be your best.</p>
        </div>

        <div className="tabs" role="tablist" aria-label="Lesson categories">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              className="tabs__btn"
              aria-selected={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>

        <Card variant="tint">
          <p className="small">
            <strong>{completedCount}</strong> of <strong>{LESSONS.length}</strong> lessons completed.{' '}
            {completedCount === LESSONS.length
              ? 'Every lesson done — ask your instructor what is next.'
              : 'Finish a lesson all the way through to earn the Great Listener badge.'}
          </p>
        </Card>

        <section className="section">
          <SectionHead
            title={filter === 'all' ? 'All lessons' : FILTERS.find((f) => f.id === filter)!.label}
            script="Small Steps. Big Progress!"
          />

          {visible.length === 0 ? (
            <Card>
              <Empty icon="learn" title="No lessons here yet">
                {filter === 'belt'
                  ? 'There are no lessons tagged for your current belt right now. Try All Lessons.'
                  : 'Your instructor has not made lessons available in this category yet.'}
              </Empty>
            </Card>
          ) : (
            <div className="stack">
              {visible.map((lesson) => (
                <LessonCard
                  key={lesson.id}
                  lesson={lesson}
                  completion={lessonCompletion(lesson, state)}
                  beltLabel={beltById(lesson.beltId).shortLabel}
                />
              ))}
            </div>
          )}
        </section>

        <Note tone="green" icon="shield" title="Practise safely.">
          Clear area, move slowly, stay in control, and stop if something hurts. Always practise with
          a parent or instructor's permission.
        </Note>
      </div>
    </>
  )
}
