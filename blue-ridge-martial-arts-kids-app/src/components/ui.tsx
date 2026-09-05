import type { ReactNode } from 'react'
import { Icon } from './Icon'
import type { IconKey } from '../types'

/* ------------------------------------------------------------------ card */

export function Card({
  children,
  variant,
  className = '',
  as: As = 'section',
  ...rest
}: {
  children: ReactNode
  variant?: 'tint' | 'hero' | 'flush'
  className?: string
  as?: 'section' | 'div' | 'article'
} & React.HTMLAttributes<HTMLElement>) {
  const variantClass = variant ? `card--${variant}` : ''
  return (
    <As className={`card ${variantClass} ${className}`.trim()} {...rest}>
      {children}
    </As>
  )
}

export function CardHead({
  title,
  icon,
  action,
}: {
  title: string
  icon?: IconKey
  action?: ReactNode
}) {
  return (
    <div className="card__head">
      <h2 className="card__title">
        {icon ? <Icon name={icon} size={18} /> : null}
        {title}
      </h2>
      {action}
    </div>
  )
}

/* --------------------------------------------------------------- section */

export function SectionHead({
  title,
  icon,
  script,
  action,
}: {
  title: string
  icon?: IconKey
  /** The handwritten brand aside. Decorative, so hidden from the reader. */
  script?: string
  action?: ReactNode
}) {
  return (
    <div className="section__head">
      <h2 className="section__title">
        {icon ? <Icon name={icon} size={19} /> : null}
        {title}
      </h2>
      {script ? (
        <span className="section__script" aria-hidden="true">
          {script}
        </span>
      ) : null}
      {action}
    </div>
  )
}

/* ------------------------------------------------------------------ chip */

export function Chip({
  children,
  tone = 'blue',
  icon,
}: {
  children: ReactNode
  tone?: 'blue' | 'green' | 'gold' | 'orange' | 'plain'
  icon?: IconKey
}) {
  const toneClass = tone === 'blue' ? '' : `chip--${tone}`
  return (
    <span className={`chip ${toneClass}`.trim()}>
      {icon ? <Icon name={icon} size={13} /> : null}
      {children}
    </span>
  )
}

/* -------------------------------------------------------------- progress */

export function ProgressBar({
  value,
  max = 1,
  tone,
  label,
}: {
  value: number
  max?: number
  tone?: 'green' | 'gold'
  /** An accessible name. Required: a bar with no name says nothing aloud. */
  label: string
}) {
  const ratio = max <= 0 ? 0 : Math.min(1, Math.max(0, value / max))
  const pct = Math.round(ratio * 100)
  return (
    <div
      className="bar"
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div
        className={`bar__fill ${tone ? `bar__fill--${tone}` : ''}`.trim()}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

/** A circular meter. The value is also written in the middle, so the reading
 *  never depends on judging an arc. */
export function ProgressRing({
  value,
  max,
  size = 84,
  unit,
  tone = 'blue',
  label,
}: {
  value: number
  max: number
  size?: number
  unit?: string
  tone?: 'blue' | 'green' | 'gold'
  label: string
}) {
  const stroke = 8
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const ratio = max <= 0 ? 0 : Math.min(1, Math.max(0, value / max))
  const colors = {
    blue: 'var(--blue-600)',
    green: 'var(--green-solid)',
    gold: 'var(--gold-solid)',
  }

  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} aria-hidden="true" focusable="false">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--blue-100)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={colors[tone]}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - ratio)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dashoffset 400ms ease' }}
        />
      </svg>
      <span className="ring__text">
        <span className="ring__value">
          {value}
          <span aria-hidden="true">/</span>
          {max}
        </span>
        {unit ? <span className="ring__unit">{unit}</span> : null}
      </span>
      <span className="vh">{label}</span>
    </div>
  )
}

/* ------------------------------------------------------------------ stat */

/**
 * A number and what it counts.
 *
 * `singular` is used when the value is exactly 1, because a fixed plural
 * label reads "1 Badges earned" on the most common state a new student is in.
 * Omit it where the label is not a count of things — "1 Day streak" is a
 * length, not a plural, and pluralising it would be wrong the other way.
 */
export function Stat({
  value,
  label,
  singular,
}: {
  value: ReactNode
  label: string
  singular?: string
}) {
  const text = typeof value === 'number' && value === 1 && singular ? singular : label
  return (
    <div className="stat">
      <span className="stat__value">{value}</span>
      <span className="stat__label">{text}</span>
    </div>
  )
}

/* ------------------------------------------------------------------ note */

export function Note({
  children,
  tone = 'blue',
  icon,
  title,
}: {
  children: ReactNode
  tone?: 'blue' | 'green' | 'gold' | 'orange' | 'red'
  icon?: IconKey
  title?: string
}) {
  const toneClass = tone === 'blue' ? '' : `note--${tone}`
  return (
    <p className={`note ${toneClass}`.trim()}>
      {icon ? (
        <span className="note__icon">
          <Icon name={icon} size={17} />
        </span>
      ) : null}
      <span>
        {title ? <strong>{title}</strong> : null}
        {children}
      </span>
    </p>
  )
}

/* ------------------------------------------------------------- empty state */

export function Empty({
  icon = 'mountain',
  title,
  children,
  action,
}: {
  icon?: IconKey
  title: string
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="empty">
      <Icon name={icon} size={34} />
      <h3>{title}</h3>
      {children ? <p className="small muted">{children}</p> : null}
      {action}
    </div>
  )
}

/* --------------------------------------------------------------- tickbox */

/**
 * A checkable row.
 *
 * It is a `<button>` with `aria-pressed`, not a styled `<input>`: the whole
 * row is the target, which is what gives a child a 48px surface instead of a
 * 20px box. Completion is shown by the tick AND the word in the label colour —
 * never by colour alone, which is why the tick mark is a shape.
 */
export function CheckRow({
  checked,
  onChange,
  label,
  hint,
  icon,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  hint?: string
  icon?: IconKey
}) {
  return (
    <button type="button" className="check" aria-pressed={checked} onClick={() => onChange(!checked)}>
      <span className="check__box" aria-hidden="true">
        {checked ? <Icon name="complete" size={16} strokeWidth={3} /> : null}
      </span>
      {icon ? <Icon name={icon} size={18} /> : null}
      <span className="grow">
        <span className="check__label">{label}</span>
        {hint ? (
          <span className="tiny faint" style={{ display: 'block' }}>
            {hint}
          </span>
        ) : null}
      </span>
      <span className="vh">{checked ? 'Done' : 'Not done yet'}</span>
    </button>
  )
}
