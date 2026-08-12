# Insurance pricing strategy — INTERNAL

**This file is deliberately inside `case-portal/`.** That directory is excluded
from the Pages deploy in `deploy.yml`, so nothing here is served from the public
site. Do not move it to the repo root, to `docs/`, or into any page — `deploy.yml`
rsyncs the root and would publish it verbatim. There is a guard in that workflow
that fails the build if a markdown file is ever staged for deploy.

This is the rate strategy from
`ALWAYS_PRECISE_INSURANCE_PORTAL_CLAUDE_CODE_HANDOFF.md`, recorded here because
it was lost once already in a session handoff. The machine-readable copy is
`RATES` in `worker.js`; this file is the reasoning behind those numbers.

## The rule that governs everything else

**Carrier rates are internal.** They are not published on the website, not shown
in the intake form, and not exposed by any endpoint a non-admin can reach.
Negotiated volume pricing is never advertised. The public-facing language is:

> Final rates and authorization will be confirmed before the assignment is
> accepted.

That is already how `insurance-investigations/`, its vendor subpage and the
carrier intake path behave. Keep it that way.

## Standard rates

| Service | Rate |
| --- | ---: |
| Workers' comp / liability / disability surveillance | **$150/hr** |
| Surveillance daily minimum | **8 hours** |
| Typical initial authorization | **3 days / 24 hours** |
| Typical 3-day authorization | **$3,600** + approved expenses |
| SIU / suspected fraud | $150–$175/hr |
| Field investigation / canvass | $125–$150/hr |
| Recorded / in-person statements | $125–$150/hr |
| Scene / liability investigation | $125–$150/hr |
| Background / social media research | $100–$150/hr |
| Complex fraud / asset / business | $150–$200+/hr |
| Court / deposition testimony | $200–$250/hr |
| Rush / holiday / special assignment | 1.25×–1.5× standard |

## Volume pricing

Rack rate stays **$150/hr**. For clients producing recurring assignments or
meaningful volume, the preferred-volume target is **$135–$150/hr**.

**Do not automatically offer the lowest number.** Decide the discount against
assignment count, expected monthly volume, geographic concentration, assignment
length, administrative burden, payment terms, travel and relationship value.

**Guardrail: avoid going below $125/hr** unless the volume is guaranteed or
highly predictable.

A negotiated rate is presented as a *preferred-volume rate* — never as evidence
that the standard rate was inflated.

## Why not $800/day

An $800 day is $100/hr × 8. Three days is $2,400. At $150/hr, 24 hours is
$3,600 — **$1,200 more per three-day case, $12,000 across ten assignments.**

Do not default the business to $800/day because it looks inexpensive. The goal
is not to be the cheapest investigation firm; it is professional service,
responsive communication and strong reporting at a competitive rate. Negotiate
aggressively when a carrier brings real volume, from $150 downward — not from
$100 upward.

## Billing guardrails

- **8-hour minimum per surveillance day.** Authorizations come in 8 / 16 / 24
  hours or custom.
- **Reporting time is billable.** Field time, surveillance, video review,
  chronology, report writing, evidence organisation, case-file preparation and
  delivery are all investigator time. Do not promise free reporting anywhere.
- **Expenses bill separately** from the hourly rate, when approved: mileage,
  tolls, parking, lodging, airfare, rental vehicle, database and record fees,
  unusual equipment, authorised third-party costs.

  Note the one standing exception already published on the vendor page —
  mileage and travel time are **not** charged inside the defined service area,
  and travel beyond it is quoted honestly before acceptance. That promise is
  live on the site; expense billing applies outside it.

## Consumer pricing is a separate question

The rates above are commercial. The consumer path in `intake/` (surveillance for
private clients, process serving) is priced separately in `PACKAGES` in
`intake/index.html`, and those numbers *are* public because a consumer pays them
at intake.

The two must not be confused. A carrier seeing a consumer day rate is a bad
look, and a consumer quoted a carrier rate will walk. `FEES.claims` carries no
figure for exactly this reason.

**Open decision:** the consumer blocks currently sit at $100/hr ($800/day,
$2,200 for three days). That is the same $800/day this document rejects for
carrier work. It may well be right for private clients paying out of pocket —
but it was set before this strategy was recovered, and nobody has confirmed it
against the reasoning above. Revisit deliberately.

## When pricing changes

`RATES` in `worker.js` is the one internal configuration: standard rate, minimum
hours, preferred-volume band, floor, per-service ranges, rush and holiday
multipliers, mileage and the expense categories. Change it there. Do not copy a
rate into a page, a component or a second config — the point of one place is
that a rate rise cannot leave a stale figure behind.

Client-specific negotiated rates belong in that structure too when they are
built, keyed per carrier, and stay admin-only like everything else here.
