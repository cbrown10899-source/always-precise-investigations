import { useEffect, useRef } from 'react'
import { badgeById } from '../data/badges'
import { useApp } from '../hooks/useApp'
import { Icon } from './Icon'

/**
 * Announces badges the last action unlocked.
 *
 * It is a live region rather than a dialog: a child in the middle of a
 * practice must not have focus taken away from the control they are using. The
 * banner dismisses itself, and can be dismissed early.
 *
 * The celebration setting turns off the animation, not the announcement —
 * earning a badge is information, not decoration.
 */
export function BadgeCelebration() {
  const { justEarned, clearJustEarned, state } = useApp()
  const timer = useRef<number | null>(null)

  useEffect(() => {
    if (justEarned.length === 0) return
    timer.current = window.setTimeout(clearJustEarned, 6000)
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [justEarned, clearJustEarned])

  const badges = justEarned.map(badgeById).filter((b) => b !== undefined)

  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: `calc(var(--nav-height) + max(18px, env(safe-area-inset-bottom)) + 8px)`,
        zIndex: 90,
        display: 'flex',
        justifyContent: 'center',
        pointerEvents: 'none',
        padding: '0 var(--s-4)',
      }}
    >
      {badges.length > 0 ? (
        <div
          className={state.settings.celebrate ? 'celebrate' : undefined}
          style={{
            pointerEvents: 'auto',
            maxWidth: 'var(--app-max)',
            width: '100%',
            background: 'var(--navy-900)',
            color: 'var(--white)',
            borderRadius: 'var(--r-lg)',
            padding: 'var(--s-3) var(--s-4)',
            boxShadow: 'var(--shadow-lg)',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--s-3)',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              flex: 'none',
              width: 38,
              height: 38,
              display: 'grid',
              placeItems: 'center',
              borderRadius: '50%',
              background: 'var(--gold-solid)',
              color: 'var(--navy-900)',
            }}
          >
            <Icon name={badges[0].icon} size={20} />
          </span>
          <span className="grow" style={{ fontSize: '0.875rem' }}>
            <strong style={{ display: 'block' }}>
              {badges.length === 1 ? 'Badge earned!' : `${badges.length} badges earned!`}
            </strong>
            {badges.map((b) => b.label).join(', ')}
          </span>
          <button
            type="button"
            onClick={clearJustEarned}
            aria-label="Dismiss badge announcement"
            style={{
              flex: 'none',
              minHeight: 44,
              minWidth: 44,
              borderRadius: 'var(--r-md)',
              border: '1px solid rgba(255,255,255,0.28)',
              background: 'transparent',
              color: 'var(--white)',
              fontWeight: 700,
            }}
          >
            OK
          </button>
        </div>
      ) : null}
    </div>
  )
}
