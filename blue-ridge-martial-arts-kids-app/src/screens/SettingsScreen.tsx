import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { SubHeader } from '../components/SubHeader'
import { Card, CardHead, CheckRow, Note, Stat } from '../components/ui'
import { useApp } from '../hooks/useApp'
import { STORAGE_KEY } from '../utils/storage'
import { LESSONS } from '../data/lessons'
import { lessonsCompletedCount } from '../utils/progress'

export function SettingsScreen() {
  const { state, update, reset, persisted } = useApp()
  const [confirming, setConfirming] = useState(false)

  const setSetting = (key: keyof typeof state.settings, value: boolean) => {
    update((draft) => ({ ...draft, settings: { ...draft.settings, [key]: value } }))
  }

  return (
    <div className="screen">
      <SubHeader title="App Settings" fallbackTo="/more" />

      {!persisted ? (
        <Note tone="orange" icon="shield" title="Changes are not being saved.">
          This browser refused to store data — a private window, or site data turned off. The app
          still works, but nothing will survive a reload.
        </Note>
      ) : null}

      <Card>
        <CardHead title="Display" icon="sparkle" />
        <div className="stack-2">
          <CheckRow
            checked={state.settings.largeText}
            onChange={(v) => setSetting('largeText', v)}
            label="Larger text"
            hint="Increases text size everywhere in the app."
            icon="learn"
          />
          <CheckRow
            checked={state.settings.reduceMotion}
            onChange={(v) => setSetting('reduceMotion', v)}
            label="Reduce motion"
            hint="Turns off animations and transitions."
            icon="balance"
          />
          <CheckRow
            checked={state.settings.celebrate}
            onChange={(v) => setSetting('celebrate', v)}
            label="Celebrate badges"
            hint="Animates the badge banner. Badges are still announced either way."
            icon="trophy"
          />
        </div>
        <p className="tiny faint" style={{ marginTop: 'var(--s-3)' }}>
          If your device is already set to reduce motion, the app follows that setting too.
        </p>
      </Card>

      <Card>
        <CardHead title="Stored on this device" icon="shield" />
        <div className="grid-2">
          <Stat value={state.practiceHistory.length} label="Practices" />
          <Stat value={`${lessonsCompletedCount(state)}/${LESSONS.length}`} label="Lessons done" />
          <Stat value={state.earnedBadges.length} label="Badges" />
          <Stat value={state.checklist.length} label="Checklist ticks" />
        </div>
        <p className="small muted" style={{ marginTop: 'var(--s-3)' }}>
          Everything is kept in this browser's local storage under{' '}
          <code style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}>{STORAGE_KEY}</code>.
          Nothing is uploaded, and there is no account and no server.
        </p>
      </Card>

      <Card>
        <CardHead title="Reset demo data" icon="reps" />
        <p className="small muted">
          Restores the starting demo student and clears practice history, badges, lesson progress,
          checklist ticks and every Instructor Demo change. This cannot be undone.
        </p>

        {confirming ? (
          <div className="stack-2" style={{ marginTop: 'var(--s-3)' }}>
            <p className="small bold" style={{ color: 'var(--red-ink)' }}>
              Reset all demo data? This cannot be undone.
            </p>
            <div className="row" style={{ gap: 'var(--s-2)' }}>
              <button
                type="button"
                className="btn btn--ghost"
                style={{ flex: 1 }}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--danger"
                style={{ flex: 1 }}
                onClick={() => {
                  reset()
                  setConfirming(false)
                }}
              >
                Yes, reset
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn--danger btn--block"
            style={{ marginTop: 'var(--s-3)' }}
            onClick={() => setConfirming(true)}
          >
            <RotateCcw size={18} aria-hidden="true" />
            Reset Demo Data
          </button>
        )}
      </Card>

      <Note tone="blue" icon="shield" title="About this build.">
        A demo of the Blue Ridge Martial Arts kids app. No accounts, no payments, no messaging, and
        no data leaves this device.
      </Note>
    </div>
  )
}
