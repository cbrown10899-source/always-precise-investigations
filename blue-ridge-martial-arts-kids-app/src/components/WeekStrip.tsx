import { Check, Home, Moon, Swords } from 'lucide-react'
import type { WeeklyPlan } from '../types'
import { DAY_SHORT, isoDate, shortDate } from '../utils/dates'

/**
 * Monday-to-Sunday at a glance — what each day is FOR, and whether a practice
 * has been logged on it.
 *
 * The three day kinds each carry their own icon and their own word, so they do
 * not depend on the border colour to tell them apart.
 */
const KIND_ICON = { home: Home, dojo: Swords, rest: Moon }

/**
 * The word the strip draws, as opposed to the plan's own label.
 *
 * Seven columns on a 320px screen give each day about 40px. "Home Practice"
 * there was two cramped lines at 9px. The short word is what is drawn; the
 * plan's full label is what a screen reader is given, so nothing is lost.
 */
const KIND_SHORT = { home: 'Home', dojo: 'Dojo', rest: 'Rest' } as const

export function WeekStrip({
  plan,
  dates,
  today,
  practiceDates,
  onSelectDay,
  selectedKey,
}: {
  plan: WeeklyPlan
  dates: Date[]
  today: Date
  /** Local YYYY-MM-DD keys the student practised on. */
  practiceDates: Set<string>
  /**
   * Makes each day a button. Without it the strip is a read-only summary,
   * which is what Home wants — a control that does nothing is worse than no
   * control, so interactivity is opt-in rather than always on.
   */
  onSelectDay?: (date: Date) => void
  /** The day currently open in the detail panel, as a YYYY-MM-DD key. */
  selectedKey?: string
}) {
  const todayKey = isoDate(today)

  return (
    <ol className="week" aria-label="This week">
      {dates.map((date) => {
        const dayIndex = date.getDay()
        const day = plan.days.find((d) => d.dayIndex === dayIndex)
        const kind = day?.kind ?? 'home'
        const key = isoDate(date)
        const isToday = key === todayKey
        const practised = practiceDates.has(key)
        const KindIcon = KIND_ICON[kind]

        const classes = [
          'weekday',
          `weekday--${kind}`,
          isToday ? 'weekday--today' : '',
          key === selectedKey ? 'weekday--selected' : '',
        ]
          .filter(Boolean)
          .join(' ')

        const label =
          `${DAY_SHORT[dayIndex]} ${shortDate(date)}. ${day?.label ?? 'Home Practice'}.` +
          `${isToday ? ' Today.' : ''}` +
          `${practised ? ' Practice done.' : ' No practice logged yet.'}`

        const body = (
          <>
            <span className="weekday__name" aria-hidden="true">
              {DAY_SHORT[dayIndex]}
            </span>
            <span className="weekday__date" aria-hidden="true">
              {shortDate(date)}
            </span>
            <span className="weekday__icon" aria-hidden="true">
              <KindIcon size={15} strokeWidth={2.5} />
            </span>
            <span className="weekday__kind" aria-hidden="true">
              {KIND_SHORT[kind]}
            </span>
            <span className="weekday__mark" aria-hidden="true">
              {practised ? (
                <Check size={15} strokeWidth={3.5} color="var(--green-solid)" />
              ) : (
                <span
                  style={{
                    display: 'block',
                    width: 14,
                    height: 14,
                    borderRadius: '50%',
                    border: '2px solid var(--line-strong)',
                  }}
                />
              )}
            </span>
            <span className="vh">{label}</span>
          </>
        )

        return (
          <li key={key} className={onSelectDay ? undefined : classes}>
            {onSelectDay ? (
              <button
                type="button"
                className={classes}
                onClick={() => onSelectDay(date)}
                aria-pressed={key === selectedKey}
                aria-label={label}
                style={{ width: '100%' }}
              >
                {body}
              </button>
            ) : (
              body
            )}
          </li>
        )
      })}
    </ol>
  )
}
