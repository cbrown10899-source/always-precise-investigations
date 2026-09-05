import type { AvatarId } from '../types'

/**
 * The avatar catalogue.
 *
 * Each option is a Blue Ridge motif in its own colourway — never a photograph
 * of a child, and nothing here is uploaded or stored anywhere but this device.
 * It lives in `data/` rather than beside the component so the component file
 * exports only a component.
 */
export interface AvatarPalette {
  from: string
  to: string
  ink: string
  label: string
}

export const AVATAR_PALETTES: Record<AvatarId, AvatarPalette> = {
  summit: { from: 'var(--blue-400)', to: 'var(--navy-700)', ink: 'var(--white)', label: 'Summit' },
  trail: { from: 'var(--green-solid)', to: 'var(--green-ink)', ink: 'var(--white)', label: 'Trail' },
  ridge: { from: 'var(--sky-400)', to: 'var(--blue-600)', ink: 'var(--white)', label: 'Ridge' },
  falcon: { from: 'var(--gold-solid)', to: 'var(--gold-ink)', ink: 'var(--white)', label: 'Falcon' },
  river: { from: 'var(--blue-300)', to: 'var(--blue-600)', ink: 'var(--white)', label: 'River' },
  pine: { from: 'var(--orange-solid)', to: 'var(--orange-ink)', ink: 'var(--white)', label: 'Pine' },
}

export const AVATAR_IDS = Object.keys(AVATAR_PALETTES) as AvatarId[]

/** The name of an avatar, falling back to the first rather than to an empty
 *  string, so a stale stored id never leaves a control with no label. */
export function avatarLabel(id: AvatarId): string {
  return AVATAR_PALETTES[id]?.label ?? AVATAR_PALETTES.summit.label
}
