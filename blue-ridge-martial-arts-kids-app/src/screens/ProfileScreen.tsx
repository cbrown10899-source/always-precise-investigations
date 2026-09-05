import { SubHeader } from '../components/SubHeader'
import { Avatar } from '../components/Avatar'
import { AVATAR_IDS, avatarLabel } from '../data/avatars'
import { BeltGraphic } from '../components/BeltGraphic'
import { Card, CardHead, Chip, Note, Stat } from '../components/ui'
import { beltById } from '../data/belts'
import { useApp } from '../hooks/useApp'
import { useToday } from '../hooks/useToday'
import { currentStreak, lessonsCompletedCount } from '../utils/progress'
import { longDate } from '../utils/dates'
import { parseLocalDate } from '../utils/progress'
import type { AvatarId } from '../types'

export function ProfileScreen() {
  const { state, update } = useApp()
  const today = useToday()
  const belt = beltById(state.instructor.currentBeltId)

  return (
    <div className="screen">
      <SubHeader title="Student Profile" fallbackTo="/more" />

      <Card>
        <div className="row">
          <Avatar id={state.student.avatarId} name={state.student.firstName} size={64} />
          <div className="grow">
            <h2>{state.student.firstName}</h2>
            <span className="row" style={{ gap: 6, marginTop: 2 }}>
              <BeltGraphic belt={belt} width={34} />
              <span className="small bold" style={{ color: 'var(--navy-700)' }}>
                {belt.label}
              </span>
            </span>
          </div>
        </div>

        <div className="field" style={{ marginTop: 'var(--s-4)' }}>
          <label className="field__label" htmlFor="student-name">
            First name
          </label>
          <input
            id="student-name"
            className="input"
            type="text"
            maxLength={24}
            value={state.student.firstName}
            onChange={(e) =>
              update((draft) => ({
                ...draft,
                student: { ...draft.student, firstName: e.target.value },
              }))
            }
          />
          <span className="field__hint">
            First name only. This demo never asks for a surname, an email address or a photograph.
          </span>
        </div>
      </Card>

      <Card>
        <CardHead title="Choose an avatar" icon="sparkle" />
        <p className="small muted" style={{ marginBottom: 'var(--s-3)' }}>
          These are Blue Ridge motifs, not photographs. No picture of a child is ever uploaded or
          stored by this app.
        </p>
        <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--s-3)' }}>
          {AVATAR_IDS.map((id: AvatarId) => {
            const selected = state.student.avatarId === id
            return (
              <button
                key={id}
                type="button"
                aria-pressed={selected}
                aria-label={`${avatarLabel(id)} avatar${selected ? ', selected' : ''}`}
                onClick={() =>
                  update((draft) => ({ ...draft, student: { ...draft.student, avatarId: id } }))
                }
                style={{
                  display: 'grid',
                  placeItems: 'center',
                  gap: 4,
                  padding: 6,
                  minWidth: 'var(--tap-min)',
                  minHeight: 'var(--tap-min)',
                  borderRadius: 'var(--r-md)',
                  border: selected ? '2px solid var(--blue-600)' : '1px solid var(--line)',
                  background: selected ? 'var(--blue-050)' : 'var(--white)',
                }}
              >
                <Avatar id={id} name={state.student.firstName} size={42} />
                <span className="tiny bold">{avatarLabel(id)}</span>
              </button>
            )
          })}
        </div>
      </Card>

      <div className="grid-2">
        <Stat value={state.practiceHistory.length} label="Practices logged" />
        <Stat value={lessonsCompletedCount(state)} label="Lessons completed" />
        <Stat value={currentStreak(state.practiceHistory, today)} label="Day streak" />
        <Stat value={state.earnedBadges.length} label="Badges earned" />
      </div>

      <Card>
        <CardHead title="Membership" icon="calendar" />
        <p className="small muted">
          Training since {longDate(parseLocalDate(state.student.joinedOn))}.
        </p>
        <div className="row" style={{ gap: 'var(--s-2)', marginTop: 'var(--s-2)', flexWrap: 'wrap' }}>
          <Chip icon="belt">{belt.label}</Chip>
          <Chip tone="plain" icon="mountain">
            Blue Ridge Martial Arts
          </Chip>
        </div>
      </Card>

      <Note tone="blue" icon="shield" title="Demo student.">
        Alex is a made-up student so the app has something to show. Change the name and avatar
        freely — everything stays on this device.
      </Note>
    </div>
  )
}
