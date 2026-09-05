import { ArrowLeft } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'

/**
 * The header for a screen reached from somewhere else.
 *
 * The back control is a real button that calls `navigate(-1)` when there is
 * history and falls back to an explicit destination otherwise — a deep link
 * opened straight from a home-screen icon has nothing to go back to, and a
 * back button that does nothing is worse than no back button.
 */
export function SubHeader({
  title,
  subtitle,
  fallbackTo = '/',
  action,
}: {
  title: string
  subtitle?: string
  fallbackTo?: string
  action?: ReactNode
}) {
  const navigate = useNavigate()

  const goBack = () => {
    if (window.history.length > 1) navigate(-1)
    else navigate(fallbackTo)
  }

  return (
    <div className="row" style={{ paddingTop: 'var(--s-4)', alignItems: 'flex-start' }}>
      <button
        type="button"
        className="btn btn--ghost"
        onClick={goBack}
        aria-label="Go back"
        style={{ minWidth: 'var(--tap-min)', padding: '0 var(--s-3)', flex: 'none' }}
      >
        <ArrowLeft size={20} aria-hidden="true" />
      </button>
      <div className="grow">
        <h1>{title}</h1>
        {subtitle ? <p className="small muted">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  )
}
