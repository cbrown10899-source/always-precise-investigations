import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * A countdown that derives its remaining time from timestamps.
 *
 * It never counts ticks: a backgrounded phone throttles or stops the interval,
 * so a tick counter drifts and a child who locks the screen mid-step comes
 * back to a timer that lied. The interval only forces a re-render; the number
 * on screen is always computed from the wall clock.
 */
export function useCountdown(durationSeconds: number, onComplete?: () => void) {
  const [running, setRunning] = useState(false)
  const [remaining, setRemaining] = useState(durationSeconds)

  // Absolute instant the countdown should reach zero, while running.
  const deadline = useRef<number | null>(null)
  // Seconds left at the moment it was paused.
  const held = useRef(durationSeconds)
  const done = useRef(false)
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  // A new duration means a new step: reset everything.
  useEffect(() => {
    setRunning(false)
    setRemaining(durationSeconds)
    held.current = durationSeconds
    deadline.current = null
    done.current = false
  }, [durationSeconds])

  useEffect(() => {
    if (!running) return
    const tick = () => {
      if (deadline.current === null) return
      const left = Math.max(0, (deadline.current - Date.now()) / 1000)
      setRemaining(left)
      if (left <= 0 && !done.current) {
        done.current = true
        setRunning(false)
        held.current = 0
        onCompleteRef.current?.()
      }
    }
    tick()
    const id = window.setInterval(tick, 200)
    return () => window.clearInterval(id)
  }, [running])

  const start = useCallback(() => {
    if (done.current) return
    deadline.current = Date.now() + held.current * 1000
    setRunning(true)
  }, [])

  const pause = useCallback(() => {
    if (deadline.current !== null) {
      held.current = Math.max(0, (deadline.current - Date.now()) / 1000)
      setRemaining(held.current)
    }
    deadline.current = null
    setRunning(false)
  }, [])

  const reset = useCallback(() => {
    setRunning(false)
    deadline.current = null
    held.current = durationSeconds
    done.current = false
    setRemaining(durationSeconds)
  }, [durationSeconds])

  return {
    /** Seconds left, as a float. Format with `formatClock`. */
    remaining,
    running,
    finished: remaining <= 0,
    start,
    pause,
    reset,
    toggle: () => (running ? pause() : start()),
  }
}
