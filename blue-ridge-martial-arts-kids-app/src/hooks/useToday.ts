import { useEffect, useState } from 'react'

/**
 * "Now", refreshed when the date could have changed.
 *
 * Every derived figure in the app — the week strip, the streak, this week's
 * practices — is computed against a Date. Capturing it once at module load
 * means an app left open overnight draws yesterday's week. This re-reads on
 * an interval and whenever the tab is brought back to the foreground, which is
 * when a phone app actually resumes.
 */
export function useToday(): Date {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const refresh = () => setNow(new Date())

    // A minute is plenty: nothing here is finer-grained than a day.
    const id = window.setInterval(refresh, 60_000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', refresh)

    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  return now
}
