# Live Visitors V2 — from page hits to lead intent

Owner brief 2026-10-10, *"ALWAYS PRECISE — LIVE VISITORS → LEAD INTENT
DASHBOARD"* (§1–§51), against an approved mockup of the list screen and the
expanded visitor screen. *"THIS IS NOT A STATIC UI REDESIGN. Build the real
tracking/data model needed to populate it accurately."*

This file is the durable record: what existed, what was decided and why, what
the tests found, and what only the owner's own devices can confirm. It lives
in `visitor-alerts/`, which never ships to the public site.

## 1. What existed (the audit)

- **KV only.** `HITS` held a rolling log of the last 120 page views, the 30-day
  counter, the rate limiter, the passcode lockout and the alert debounce;
  `SUBS` the push subscriptions. No database, no visitor tables.
- **Identity was the network.** A daily hash of IP + user agent + date — so two
  people on one Wi-Fi with the same phone model were one visitor, and the brief
  forbids exactly that (§5, §40).
- **Every alert was a page view**: once per 15 minutes per hash, and *every*
  intake or contact page view — a refresh of the intake buzzed the phone again.
- **The free plan allows 1,000 KV writes a day** and a page view already spent
  three or four. The passcode lockout writes there too, so a feature that ran
  the allowance out would also switch the lockout off.

## 2. Decisions

**D1 — Journeys live in a D1 database of their own.** `api-visitor-journeys`,
binding `VDB`, bound to `api-visitor-alerts` only. D1 allows 100,000 row writes
a day and answers "which pages did this visitor see" as a query; one statement
at a time per database, so two pages arriving together cannot open two visits.
**Never the case portal's database**, which holds claimant names and
signatures: the reason the two Workers were kept apart in the first place.
The KV log, counter, limiter and lockout are untouched, and the event path
(`/t`) makes **no KV call at all** — a test counts them.

**D2 — A visitor is a random token the browser keeps.** 16 random bytes in the
site's own local storage (`apiv-id`), sent with each beacon call; the Worker
stores only `sha256('vid|token|SALT')`. Not a cookie, not an IP, not a user
agent, not a fingerprint. Do Not Track, Global Privacy Control and the owner's
own browser return **before a token is made**. Storage blocked means no token:
the page view is still counted the old way, with no journey. A browser that
clears its storage, a private window, or a second browser is a new visitor, and
the dashboard never claims otherwise. Browsers may also clear script storage
for a site that has not been visited in a while (Safari's tracking prevention
does), which reads as a new visitor too.

**D3 — Visits are decided by the Worker, after 30 minutes of nothing.** One
conditional INSERT decides whether a visit is open. A reload is a new page view
in the same visit; navigation never opens a visit; two tabs share one.

**D4 — Engagement is time someone was actually looking.** The page counts time
that is visible, focused, and within a minute of the last touch, scroll, key or
pointer movement. It reports the running total when the page is hidden or left,
and at most once a minute while it is being read (30 check-ins per page view at
most). The Worker caps a page's total at the wall time since it opened, and
only ever raises it.

**D5 — Actions are a fixed vocabulary.** Call (`tel:`), Email (`mailto:`),
Contact (`#contact`), and the intake buttons, classified by the link's own
address into the site's own words ("Request a Child Custody Investigation",
"Submit an Insurance Assignment", …). *Opened intake* is the Worker's own fact,
written when an intake page view arrives — a request cannot claim it. *Started
intake* is the first `input`/`change` anywhere on the intake page, sent once;
the listener never looks at which element changed. Each press counts once per
event id; a visit records at most sixty.

**D6 — The intake link is deterministic and first-party (§16).** After the
firm has the submission (portal stored it, or the notice went), the intake page
hands the visitor script the request number it minted and the service key. The
Worker accepts it only on an intake page view of the same token, only with an
`API-YYYYMMDD-NNNN` number dated within three days, once per number. Never
inferred from an address, a city, a browser or a nearby time. Nothing else from
the submission is sent — the tests type into every field and search every
request and every row for what was typed.

**D7 — The score is a count, not a probability (§18–§21).** Over the seven days
before the visitor's last activity: returning +10; two or more visits in those
seven days +10; each service page +5 up to three, +5 more for two or more;
engaged over 2 minutes +5, over 5 minutes +10 more; opened the intake +20;
started it +10; Call +20; Email or Contact +15; an intake button +15. Reloads,
idle time, repeated presses and bots add nothing. **50+ is High intent only
with a service page or the intake seen**, so a homepage-only visit never is;
20+ is Interested. A submitted intake shows **New intake** beside the tier. The
reasons are stored with their points and printed; the ⓘ explains the rules.

**D8 — Likely interest comes from what they looked at and pressed.** A
submission decides it; an opened intake or an intake button outweighs pages; a
specific service outweighs the general Private Investigator pages; nothing is
"Not determined". The basis is printed, strongest first.

**D9 — Three alerts, one per request, never twice.** A new visit; crossing
INTO High intent (and not again while the tier never left, nor within a week);
a new intake submission. A refresh, another page or a heartbeat inside a tier
says nothing. The lock-screen text names the place and the service and **no
request number** — the portal's rule for a text message. The phone's service
worker shows the newest alert it has not shown.

**D10 — Every displayed time is composed by the Worker, in Eastern.**
`America/New_York`, EST or EDT from the date itself; the page only works out
"3h ago". A laptop set to Pacific draws a Virginia visit at Virginia time (the
browser suite runs the dashboard in Los Angeles to prove it).

**D11 — Location is approximate and says so.** Cloudflare's city and region
for the connection, falling back to state, then country, then "Location
unavailable"; labelled *Approximate location (IP)* and never "exact". No
precise-location permission is ever asked for.

**D12 — A source is named only when certain.** Google, Bing, Facebook,
Instagram, DuckDuckGo, Yahoo by exact host; anything else is the host it was
("Referral: host"); no referrer is Direct. The referring HOST is kept, never a
URL, and no search phrase is claimed — no referrer carries one.

**D13 — Kept 90 days.** Journey rows older than 90 days are deleted by a sweep
that runs once a day (a row in the database marks the day, so the check costs
no KV write); alerts after 30 days. The KV log and 30-day counter are unchanged.
The privacy page states it, and a deploy test pins the page's number to the
Worker's.

**D14 — The owner's own browser is not a lead (§29).** Unlocking the dashboard
marks that browser (`apiv-exclude`, same site as the public pages); a toggle at
the foot of the page counts it again for testing. On iPhone the Home Screen app
and Safari keep separate storage, which the page says.

**D15 — It fails open.** No binding: every route behaves as before and the
dashboard shows the page-view log with a sentence saying why. A journey write
that throws is logged and the older alerts still fire. The beacon is
fire-and-forget; with the Worker unreachable the intake still submits (tested).

**D16 — The 30-day ticker stays on the KV counter**, which holds the history
from before journeys existed; its same-day dedupe now uses the token's daily
pseudonym (an older beacon without a token keeps the IP + user-agent hash).
*On the site now* (activity in the last 3 minutes) and *visits today* (visits
started since midnight in Virginia) come from journeys once they are set up.

**D17 — Setup without touching a secret.** `visitors-setup.yml` records the
serving version, creates or finds the database, applies the schema through
D1's query endpoint (comments stripped — hence no semicolons in comments),
uploads the Worker, then PATCHes the script settings with **every existing
binding re-listed as `inherit`** plus the new `d1` binding. `inherit` carries a
binding over from the current version by name; no value is read or copied. It
then checks that every binding is still there, that `/health` still reports the
passcode and push key configured, and that journeys are ready — and rolls the
Worker back to the recorded version if not. The API shapes were read from the
`cloudflare` SDK's types and wrangler's source (both from npm), because the
documentation site was not reachable from the build environment.

## 3. What the tests found

- **Real page views were being dropped as bots — in production, before this
  unit.** The Worker files a page view whose human signal came under 150 ms
  after load as a replayed request ("instant-fire"). A cursor already moving as
  the next page paints fires `pointermove` at once, so those visits — the ones
  arriving mid-browse — were thrown away silently. The beacon now waits out the
  first 200 ms before sending; the server rule is unchanged. Found by the
  browser suite moving the mouse the instant a page loaded.
- **A visit's current page lagged.** It was decided by `last_at`, which the page
  being LEFT keeps moving with its final check-in after the next page opened.
  It is the newest page by arrival now.
- **The intake was scored as a service page**, because its page view carries
  the door's service for the journey's wording. Service pages are the
  catalogue's now.
- **The journey drew "opened intake" twice.**
- **A late check-in held the visitor on the page they had left** — the same
  defect as the second bullet, found again by mutation (W23 in §5) after the
  browser stopped landing the race; now pinned in the Worker suite.
- **The score card overflowed a phone by 50px**: a heading spanning an
  `auto / 1fr` grid sized the number's track to its own width.
- **Sign out stayed on the phone's journey screen**: an inline style set by
  script beat the stylesheet.

## 4. Tests

- `visitor-alerts/test-worker.mjs` — the Worker on real SQLite: 49 checks
  before this unit, **206** after. The brief's fixtures are named in it: §39
  Visitor A end to end (score 85, the journey row by row with exact times,
  HIGH INTENT on opening the Child Custody intake, NEW INTAKE on submission);
  §40 same IP/city/device, different tokens → two visitors; §41 nothing typed
  is stored; §42 reloads, idle time, repeats and bots earn nothing; §43 one
  alert per crossing, none on refresh, another page or a heartbeat.
- `watch/test-watch.mjs` — **74 checks** in Playwright: the beacon on the real
  public pages, the custody CTA → intake → submit walk, §41 in a real browser,
  GPC / the owner's browser / automation send nothing, fail-open with the
  Worker down, and the dashboard at 390, 320 and 1280 against the real Worker.
- `.github/test-deploy.mjs` — 127 → **139**: the published privacy page states
  what is recorded and the retention the Worker enforces; the schema and the
  test never ship.
- `intake/test-intake.mjs` — **934 passed, 0 failed**, unchanged: the intake
  page's hooks change nothing the suite measures.

**Mutations** (`git worktree`, one property broken at a time): see §5.

## 5. Mutation record

Forty-eight mutations, each one string replacement in a `git worktree` that
breaks one promised property, run against the suites that hold it; the file is
restored byte for byte after each. A mutation counts as caught only when an
assertion FAILS BY NAME — a crash names nothing and counts as a miss. (The
numbering has gaps where a drafted mutation was dropped before the run.)

**All 48 caught by name.** Six needed the tests strengthened first, and each is
worth keeping:

- **W01, W02** (raw token as the id; every browser one visitor) crashed the
  Worker suite on a null read, so they named nothing. The suite now prints its
  results before it exits, and its journey reads are null-safe: 29 and 38 named
  failures.
- **W07** (one visitor writing to another's page view) passed because the test
  sent a smaller engagement total, which is skipped for an unrelated reason. It
  sends a press too now, and asserts no action row appeared.
- **W13** (HIGH INTENT alerted on every event) was partly equivalent; the new
  test keeps a visitor High intent across a week and expects one alert.
- **W23** (current page compared with `last_at`) walked past the browser suite,
  which had found the defect once on a real walk and then stopped landing the
  race. The race is played deterministically in the Worker suite now.
- **W27, W29** crashed or passed for want of a guarded read and a
  return-after-three-weeks case; both added.
- **D08, D09** (the phone's back; the alert deep link) crashed the browser
  suite on a wait for a screen that never drew. Every browser section now runs
  under a guard that turns a throw into a FAIL named for the section, and the
  deep link has a bounded wait of its own.

| id | property broken | failures | first failing assertion |
| --- | --- | --- | --- |
| W01 | raw token stored as the visitor id | Worker 29 | no raw token is stored anywhere |
| W02 | every browser becomes one visitor | Worker 38 | same IP, same browser, same city, different tokens: TWO visitors |
| W03 | visit gap 5 hours | Worker 3 | 31 minutes of nothing starts a new visit |
| W04 | reloads earn service-page points | Worker 7 | a reload earns no second service-page point |
| W05 | engagement not capped at wall time | Worker 2 | a claimed ten hours is cut to the wall time since the page opened |
| W06 | heartbeats never stop | Worker 1 | a page left running stops spending writes after thirty check-ins |
| W07 | one visitor writes to another's page view | Worker 1 | one visitor cannot write to another's page view |
| W08 | any action name accepted | Worker 2 | Call, Email, Contact and an intake button are recorded |
| W09 | a request can claim *opened intake* | Worker 3 | Call, Email, Contact and an intake button are recorded |
| W10 | intake actions accepted off the intake page | Worker 5 | Call, Email, Contact and an intake button are recorded |
| W11 | an old request number links | Worker 1 | an old, malformed or hostile request number links nothing |
| W12 | a retried action counts as new | Worker 1 | the same submission again links nothing new and wakes nobody |
| W13 | HIGH INTENT alerted on every event | Worker 1 | §43 and no second HIGH INTENT alert |
| W14 | homepage-only can be HIGH INTENT | Worker 1 | §42 a homepage-only visitor is never HIGH INTENT |
| W15 | request number on the lock screen | Worker 2 | the alert reads NEW INTAKE / place / service |
| W16 | `/t` writes KV | Worker 1 | /t made no KV write and no KV read at all |
| W17 | a journey failure throws | Worker 2 | a journey write that fails is reported, not thrown |
| W18 | a journey failure silences the alert | Worker 1 | and the older alert still wakes the phone |
| W19 | journeys kept 25 years | Worker 3, deploy 1 | a visitor not seen for 90 days is deleted, every row of them |
| W20 | sweep on every page view | Worker 1 | the sweep runs once a day, not on every page view |
| W21 | `google.evil.com` called Google | Worker 1 | sources are named only when certain |
| W22 | times not in Eastern | Worker 9 | §39 first seen is exact, in Eastern time |
| W23 | current page compared with `last_at` | Worker 3 | a late check-in from the page being left does not hold the visit on that page |
| W24 | the intake page scored as a service page | Worker 2 | §39 the score is 85, and every point is a reason |
| W25 | extra request fields stored | Worker 5 | Call, Email, Contact and an intake button are recorded |
| W26 | *visits today* on UTC midnight | Worker 1 | "visits today" starts at midnight in Virginia |
| W27 | `/visitors` without the passcode | Worker 12 | /visitors names the missing setup instead of drawing an empty list |
| W28 | no location says nothing | Worker 2 | the place falls back from city to state to country to "Location unavailable" |
| W29 | 7-day visit points from all-time visits | Worker 1 | §42 a return three weeks later is "Returning", not "2 visits within 7 days" |
| W30 | every page view alerts | Worker 6 | /t made no KV write and no KV read at all |
| B01 | beacon sends before 200ms | browser 9, Worker 1 | a cursor already moving when the page opens still counts |
| B02 | query string sent | browser 1, Worker 1 | it carries the path and never the query string |
| B03 | token in a cookie | browser 1, Worker 1 | the token lives in this site's local storage, not a cookie |
| B04 | Global Privacy Control ignored | browser 2 | with Global Privacy Control: nothing is sent |
| B05 | the owner's browser counted | browser 2, Worker 1 | with a browser the owner marked as his own: nothing is sent |
| B07 | typed values captured | browser 2, Worker 1 | §41 nothing typed has left the page for the visitor Worker |
| B08 | no engagement on hide | browser 1 | engaged time is sent when the page is hidden |
| I01 | submission announced before the firm has it | Worker 1 | the submission is announced only after the firm has it |
| I02 | the *started* hook reads the value | Worker 1 | the started hook never looks at what changed |
| I03 | the whole payload handed over | Worker 1 | the submission is announced only after the firm has it |
| D01 | a failed read drawn as empty | browser 2 | a failed read says it could not load, and is not "nobody visited" |
| D02 | Sign out stays on the phone journey | browser 1 | and Sign out gives way to it, as in the mockup |
| D04 | score card overflows a phone | browser 1 | no sideways scroll on the journey at 390 |
| D05 | controls under the tap floor | browser 2 | every control on the list clears the 44px tap floor |
| D06 | HIGH INTENT card not gold | browser 1 | a HIGH INTENT card has the gold border |
| D07 | the owner's device not excluded by default | browser 2 | unlocking the dashboard marks this browser as not counted |
| D08 | the phone's back does not return | browser 2 | ← Live Visitors returns to the list |
| D09 | a link from an alert opens nothing | browser 1 | /watch/?v=<id> opens straight on that visitor's journey |

## 6. Not proven here — the owner's checks

- The binding attach runs against the real Cloudflare account, through
  `visitors-setup.yml`; its own verification step is the evidence.
- Real phones: the token surviving between visits in Safari, the alerts
  arriving and opening the right visitor, and the dashboard on the owner's
  iPhone.
- Engagement on a real phone, where a screen that sleeps hides the page.

## 7. Where it differs from the mockup, and why

- **No bottom navigation bar.** The mockup's Home / Studio / Build / Shop /
  Saved bar belongs to the app the mockup was drawn in; Live Visitors has no
  such destinations.
- **Real paths and labels.** The mockup's `/private-investigation/` and
  `/child-custody/` are this site's `/private-investigator/` and
  `/child-custody-investigations/`; "Background Checks" is not a page here, so
  it is not an interest the dashboard can show.
- **Sources are normalised** ("from Google"), per the brief's §9, where the
  mockup shows raw hosts.
- **Exact times carry seconds** everywhere ("11:48:09 PM EDT"), per §26.
- **Points beside each reason**, quiet, so the score is explainable at a glance;
  the full rules sit behind the ⓘ.
- **A visit header in the journey** ("Visit 2 · Oct 9, 2026 · Direct · times
  EDT"), because a journey that spans days needs the date and zone beside the
  times.

## 8. Found after shipping — the salt was never read

`visitors-setup.yml` prints the Worker's bindings, and on its first run
(2026-10-10, run 38062428707) the secret printed as `SALT ` — **a trailing
space in its name**. The Worker read `env.SALT`, which was therefore undefined,
and every salted hash — the lockout key, the rate limiter, the day pseudonym
for a beacon without a token, and now the visitor id — fell back to the
constant `'api'`, which this public repository publishes. Nothing said so,
because the fallback is exactly what made it work.

What it meant: a visitor id is a hash of 128 random bits, so it cannot be
walked back whatever the salt. The IP-and-browser day hashes could be, by
anyone holding the KV contents or the dashboard log, because the salt that
was meant to stop that was public.

The fix reads the salt by its trimmed name through one function, `saltOf`, the
only reader left (a test counts them). The live secret works as it is. The cost
is one change of every salted key at deploy: today's 30-day dedupe starts over
(a visitor seen before and after the deploy counts twice today), and the
handful of visitors recorded in the first hour of journeys appear again as new
visitors if they return. Doing it on the day journeys began is why that cost is
a handful rather than a history.
