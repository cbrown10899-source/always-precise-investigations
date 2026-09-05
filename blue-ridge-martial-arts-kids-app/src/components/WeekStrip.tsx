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

export function WeekStrip({
  plan,
  dates,
  today,
  practiceDates,
}: {
  plan: WeeklyPlan
  dates: Date[]
  today: Date
  /** Local YYYY-MM-DD keys the student practised on. */
  practiceDates: Set<string>
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
        ]
          .filter(Boolean)
          .join(' ')

        return (
          <li key={key} className={classes}>
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
              {day?.label ?? 'Home Practice'}
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
            <span className="vh">
              {DAY_SHORT[dayIndex]} {shortDate(date)}. {day?.label ?? 'Home Practice'}.
              {isToday ? ' Today.' : ''}
              {practised ? ' Practice done.' : ' No practice logged yet.'}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
