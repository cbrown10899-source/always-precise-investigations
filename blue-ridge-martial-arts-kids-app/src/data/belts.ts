import type { Belt, BeltId } from '../types'

/**
 * The demo belt ladder.
 *
 * This is DEMO progression, not Blue Ridge Martial Arts' promotion criteria.
 * Nothing in the app presents it as official — the Progress screen says so in
 * words, and only the instructor can move a student along it.
 */
export const BELTS: Belt[] = [
  {
    id: 'white',
    label: 'White Belt',
    shortLabel: 'White',
    kind: 'belt',
    color: 'var(--belt-white)',
    stripeColor: null,
    stripeCount: 0,
    order: 0,
  },
  {
    id: 'white-1',
    label: 'White Belt, 1 Stripe',
    shortLabel: 'White 1 Stripe',
    kind: 'belt',
    color: 'var(--belt-white)',
    stripeColor: 'var(--belt-blue)',
    stripeCount: 1,
    order: 1,
  },
  {
    id: 'white-2',
    label: 'White Belt, 2 Stripes',
    shortLabel: 'White 2 Stripes',
    kind: 'belt',
    color: 'var(--belt-white)',
    stripeColor: 'var(--belt-blue)',
    stripeCount: 2,
    order: 2,
  },
  {
    id: 'blue-stripe-test',
    label: 'Blue Stripe Test',
    shortLabel: 'Blue Stripe Test',
    kind: 'test',
    color: 'var(--belt-white)',
    stripeColor: 'var(--belt-blue)',
    stripeCount: 3,
    order: 3,
  },
  {
    id: 'blue',
    label: 'Blue Belt',
    shortLabel: 'Blue Belt',
    kind: 'belt',
    color: 'var(--belt-blue)',
    stripeColor: null,
    stripeCount: 0,
    order: 4,
  },
]

const BY_ID = new Map<BeltId, Belt>(BELTS.map((b) => [b.id, b]))

/** Resolves a belt id. Returns the first rung when the id is unknown, so a
 *  stale stored value can never leave the journey strip with nothing on it. */
export function beltById(id: BeltId): Belt {
  return BY_ID.get(id) ?? BELTS[0]
}
