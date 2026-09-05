import type { Belt } from '../types'

/**
 * A belt, drawn from its own record.
 *
 * The stripe count comes from the belt data, so adding a rung to the ladder
 * needs no change here. The belt is decorative — every place it appears sits
 * beside the belt's label in text — so it is hidden from assistive technology
 * and the label is what a screen reader announces.
 */
export function BeltGraphic({ belt, width = 44 }: { belt: Belt; width?: number }) {
  const height = Math.round(width * 0.56)
  const stripeWidth = 4
  const gap = 3
  // Stripes sit at the right-hand end, as they do on a real belt tip.
  const firstStripeX = 40 - belt.stripeCount * (stripeWidth + gap)

  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 48 27"
      aria-hidden="true"
      focusable="false"
      role="presentation"
    >
      {/* The belt body. */}
      <rect x="2" y="9" width="44" height="10" rx="2.5" fill={belt.color} stroke="var(--belt-white-edge)" strokeWidth="1" />
      {/* The knot. */}
      <rect x="16" y="5" width="16" height="18" rx="3" fill={belt.color} stroke="var(--belt-white-edge)" strokeWidth="1" />
      <rect x="20" y="11" width="8" height="6" rx="1.5" fill={belt.color} stroke="var(--belt-white-edge)" strokeWidth="0.8" />
      {belt.stripeColor
        ? Array.from({ length: belt.stripeCount }, (_, i) => (
            <rect
              key={i}
              x={firstStripeX + i * (stripeWidth + gap)}
              y="9.6"
              width={stripeWidth}
              height="8.8"
              rx="1"
              fill={belt.stripeColor as string}
            />
          ))
        : null}
    </svg>
  )
}
