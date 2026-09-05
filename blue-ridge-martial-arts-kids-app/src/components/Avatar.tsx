import type { AvatarId } from '../types'
import { AVATAR_PALETTES } from '../data/avatars'

/**
 * A generated avatar — never a photograph of a child.
 *
 * The initial sits on top of a Blue Ridge motif, so the avatar still
 * identifies the student when several are on screen. It is decorative beside
 * the student's name everywhere it appears, so it is hidden from assistive
 * technology and the name is what is announced.
 */
export function Avatar({
  id,
  name,
  size = 44,
}: {
  id: AvatarId
  name: string
  size?: number
}) {
  const palette = AVATAR_PALETTES[id] ?? AVATAR_PALETTES.summit
  const gradientId = `avatar-${id}`
  const initial = name.trim().charAt(0).toUpperCase() || 'S'

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      aria-hidden="true"
      focusable="false"
      style={{ borderRadius: '50%', flex: 'none' }}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={palette.from} />
          <stop offset="100%" stopColor={palette.to} />
        </linearGradient>
      </defs>
      <circle cx="24" cy="24" r="24" fill={`url(#${gradientId})`} />
      {/* A ridge line across the lower half, so each avatar reads as a place. */}
      <path
        d="M0 34 L10 26 L18 32 L26 22 L34 31 L42 25 L48 30 L48 48 L0 48 Z"
        fill="var(--white)"
        opacity="0.22"
      />
      <text
        x="24"
        y="25"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="19"
        fontWeight="800"
        fill={palette.ink}
        fontFamily="var(--font-ui)"
      >
        {initial}
      </text>
    </svg>
  )
}
