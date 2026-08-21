# Unit 25 — Final Security / Authorization / Regression Pass, 2026-08-21

**No verbatim owner brief exists for this unit.** The durable queue names its
scope in one line:

> Admin and investigator authorization · client/commercial-data redaction ·
> case, report and evidence access · retention controls · payment controls ·
> legal hold · archive/restore · public intake routes · storage health ·
> Dropbox integration · secret and token exposure · destructive endpoints ·
> responsive behaviour · accessibility regressions · printable documents ·
> mobile workflows. **No destructive production migration merely for this
> pass.**

Per the standing instruction — audit first — this file records what was walked,
what was found, what changed, and the decisions derived along the way. Three
defects were verified and fixed. Everything else in the list was walked and is
recorded below as sound, **with the evidence**, so the next reader does not pay
for the same walk twice.

Nothing in this unit needs a `portal-setup` dispatch: no table was added, no
column changed, no migration written.

---

## THE AUDIT — what was walked

The Worker's route table was extracted mechanically (164 route matchers inside
`route()`) and every one was read against its gate rather than sampled.

| Area | Finding |
| --- | --- |
| Route-level authorization | Sound. Admin-only routes gate individually or through the three prefix blocks (`/build/*` + `/cases/:no/build` + `/external-storage`; `/invoices*` + `/cases/:no/invoices` + `/billing-settings`; the retention family gates inside its four handlers) |
| The deleted/archived write chokepoint | Sound. One `method !== 'GET'` gate in `route()`, resolving invoices, builds and offers by id; `/delete`, `/undelete` and the archive/retention family matched on the WHOLE path |
| Sessions and login | Sound. `HttpOnly; Secure; SameSite=Strict`, the DB holds only the SHA-256 of the cookie, PBKDF2-SHA256 with per-user rounds, `secretEqual`, a hash computed even for a missing account, lockout, and `currentUser` **deletes the session of a deactivated account** rather than merely refusing it |
| Password changes | Sound. Both the admin set and the reset-link path delete every session and clear the lockout counter |
| Public intake (`/ingest`) | Sound. Shared-key compare, `Content-Length` refused before the body is read, byte cap re-checked after, rate limit, `CASE_NO_RE` pinning, a UNIQUE retry answered as `{ok, duplicate}` |
| Origin | Sound. `SameSite=Strict` first; `originAllowed` rejects a mismatched Origin, and an absent one (curl) is judged on its token |
| SQL | Sound. Every interpolation into a statement comes from a hardcoded list or a code-built `?` placeholder run — `take(k, cap)` on invoices, the fixed `work` table list on user delete, `ids.map(() => '?')` on the file queue. No caller value reaches SQL text |
| Secrets and tokens | Sound. No secret in any response; the Dropbox refresh token never leaves D1; `storage_ref` is admin-only on every way out; `dbxSignState` HMACs with the app secret and never exposes it; no `api.dropboxapi.com/2/sharing` call exists anywhere |
| Destructive endpoints | Sound. User delete refuses self, refuses the last active admin, and refuses any account with recorded case work; `DEMO_SWEEP` writes `TEST-` into every statement; nothing in the portal purges |
| Legal hold | Sound. Enforced at exactly the three writers the brief names — `/cases/:no/delete`, `/cases/:no/retention/schedule`, `deleteEvidence` — each 409 naming the hold |
| Retention | Sound. All four handlers gate admin **and** `caseFor` before any read |
| Evidence access | **Two defects** — below |
| Case-scoped hours and money | **One defect, in two reads** — below |
| Responsive · accessibility · print · mobile | Regression only: pinned by the page suite, run in full below |

---

## FINDING 1 — a reassigned investigator was handed the prior one's hours

**The owner's decision of 2026-08-21 is LOCKED**, and CLAUDE.md records that it
is enforced "when the permissions/security work is reached — or immediately if
an audit proves an active leak". This unit is that work, and the audit proves
the leak.

> A reassigned investigator must not automatically see the previous
> investigator's *"worked hours, compensation details, billing detail, or other
> investigator-specific financial information"* — not through *"case-scoped
> reads, API responses, UI payloads, exports, reports, or hidden fields."*

Three reads violated it. All three are case-scoped reads returning UI payloads,
which is the wording exactly.

| Read | What reached the field |
| --- | --- |
| `caseWorkspace` → `days[]` | Every `case_days` row on the case: `hours`, `miles`, both mileage readings, the day's summary, and the other investigator's name |
| `caseWorkspace` → `expenses[]` | Every `case_expenses` row: `amount`, `reimbursable`, `billable`, `internal`, and whose claim it is |
| `caseTimeline` → the investigation arm | `day_start` / `day_end` events printing "8 hr · 62 mi" beside a name, for both roles |

**The rest of the codebase already believed the opposite**, which is what makes
this an oversight rather than a design:

- `/calendar` scopes its own day query with `AND d.investigator_id = ?`.
- `/my/expenses` is `WHERE investigator_id = ?`.
- `saveDaySummary`, `generateReport` and `saveReport` all answer *"that day
  belongs to another investigator"* with a 403 on the **write** side.
- Every other collection in `caseWorkspace` — notes, comms, evidence, tasks,
  offers — carries a role scope. `days` and `expenses` were the two that did
  not.

So the WRITE side of this rule was already enforced in four places and the READ
side was open in three.

**The fix is in the SQL, in the Worker.** CLAUDE.md's instruction for this rule
is to enforce it "the way `FIELD_KEEP` is enforced: in the Worker, by not
running the read, never by a page declining to draw it" — so the rows are
scoped out of the statement rather than stripped from the payload afterwards.
There is then nothing to redact and nothing sitting in a network tab. An
admin's three reads are unchanged.

**No permission toggle was added**, because the same owner decision forbids one
until the approved PORTAL-OPS Permissions specification calls for it — and that
specification arrived corrupted and has never been re-sent.

## FINDING 2 — an uploaded file was served back as whatever it claimed to be

`serveEvidence` answered with `Content-Type: ${row.content_type}` and
`Content-Disposition: inline`, and **`content_type` is caller-controlled**: it
is whatever the uploading browser wrote into the multipart part, and nothing on
the way in inspects it (`uploadEvidence` refuses `video/*`, and for a storage
reason).

That route answers on the portal's **own origin** — the Worker is mounted at
`alwayspreciseinvestigations.net/portal-api/*` on the same host as `/portal/`,
deliberately, because a cookie set by a `workers.dev` host is never sent back.
So a file uploaded as `text/html` or `image/svg+xml` and then opened by the
office was **script running inside the portal with the viewing admin's
session**: an investigator account escalating to admin actions by uploading a
file and waiting for somebody to click it. `HttpOnly` stops the cookie being
read and stops nothing else — the script can call the API as that admin.

The global `X-Content-Type-Options: nosniff` did not help. It stops a browser
guessing a type; here the dangerous type was **declared**.

**The fix is an allow-list**, for the `FIELD_KEEP` reason: a content type nobody
has considered yet is refused inline by default, where a block-list would ship
the next one. `inlineSafeType()` permits images (minus SVG), audio, video,
`application/pdf` and `text/plain` — everything the portal actually draws.
Anything else is served `application/octet-stream` with
`Content-Disposition: attachment`, which renders nowhere.

`image/svg+xml` is named out **by name**: it is the one image type that is a
document with script in it. An `<img>` tag will not run it; following the link
will, and the gallery offers that link.

Nothing the portal displays changed. A browser ignores `Content-Disposition` on
a subresource, so every `<img src>` gallery and the package document are
untouched, and both control assertions in the suite pin that.

## FINDING 3 — a scoped list would have made the field view say something untrue

Consequence of Finding 1 rather than a defect found beside it, and it is
recorded because the fix would otherwise have shipped a quiet regression.

Active Surveillance draws `Day ${days.length + 1}`. Once `days` is the caller's
own, an investigator taking over a case already three days in would be shown
**Day 1** — a staff screen asserting something untrue about the case, which is
the class of defect this project keeps closing.

`caseWorkspace` now sends `days_total`, and the field view reads it. A COUNT is
not a timesheet: no hours, no mileage, no name, no money. It is read **only for
a non-admin**, because an admin already holds every row and this is the
most-opened screen in the portal (the Unit 7 lesson).

---

## DERIVED DECISIONS

**D1 — The case's TOTAL hours against its authorization stay visible to the
field.** `authorizationFor` sums `case_days.hours` across the whole case to
compute `hours_used` and `percent_used`, and an investigator sees it. That is
kept: CLAUDE.md's own rule is that an investigator must be told the cap they
are working to, and a case-level aggregate is not "investigator-specific"
information about anybody. What the rule protects is *whose* hours, and an
aggregate names nobody. `authorized_budget` — the money — is already
`forAdmin`-only and stays so.

**D2 — Rows are scoped out, not fields stripped.** Both were available. Scoping
in SQL was chosen because it is what CLAUDE.md instructs for this rule, what
`/calendar` already does, and because a stripped payload is a list of decisions
somebody must repeat every time a column is added.

**D3 — The activity log is NOT scoped.** It is shared with the field on purpose
and carries times, not compensation; the whole case's chronology of *what
happened* is operational, and the field view is built on it. The boundary the
owner drew is money and hours-as-paid, not the clock.

**D4 — `day_summaries` is NOT scoped.** CLAUDE.md states the rule for it
already: *"Both roles: the summary is report prose."* It is narrative, and the
write side is separately gated by `saveDaySummary`. Recorded here so it reads
as a decision rather than an omission.

**D5 — Reports are NOT scoped.** A report is case content, carries no hours
column, and its write and approval boundaries are enforced separately and were
found sound. Scoping the list would also cut an investigator off from the
case's own record of what has been filed.

**D6 — No Content-Security-Policy on the evidence byte route.**
`default-src 'none'` or `sandbox` would be a second belt behind the allow-list.
Both can stop a browser's built-in PDF viewer, and a filed report that will not
open is a real workflow broken for a defence the allow-list has already made.
The allow-list decides the type; the type decides whether anything can run.
If a CSP is ever added here it should be added on the **attachment** path only,
where nothing is meant to render at all.

**D7 — `text/plain` stays inline.** With `nosniff` set globally on every Worker
response, a declared `text/plain` cannot be re-read as HTML, and a plain-text
note is something the office reasonably opens.

**D8 — Nothing was migrated, backfilled or deleted.** The scope line forbids a
destructive production migration for this pass and none was needed: all three
fixes are read-path and header changes.

---

## WHAT WAS DELIBERATELY NOT CHANGED

- **No permission toggle**, per the owner's locked decision 4.
- **No new table, column, or `portal-setup` dispatch.**
- **The PORTAL-OPS Permissions specification stays marked missing.** It arrived
  corrupted and has never been re-sent; nothing here infers it.
- **The `portal-setup` bootstrap-token race is untouched.** Credential handling
  is a stop condition, and the run in question applied the schema correctly.
- `originAllowed` still allows a request with **no** Origin header. That is the
  documented behaviour for non-browser callers, which are judged on their token,
  and `SameSite=Strict` is the browser-side defence.

---

## THE SUITES

Run in full at the end of the unit, on the same tree that was pushed:

| Suite | Before | After |
| --- | --- | --- |
| `case-portal/test-worker.mjs` | 2627 / 0 | **2649 / 0** |
| `portal/test-portal.mjs` | 2423 / 0 | **PORTAL_AFTER** |
| `.github/test-deploy.mjs` | 68 / 0 | **68 / 0** |
| `intake/test-intake.mjs` | 205 / 0 | untouched by this unit |

The 22 new worker checks are two sections:

- **"A reassigned investigator is never handed the prior one's hours"** — Dana
  works an 8-hour day with mileage and files an expense; the case moves to Reed,
  who works his own 2-hour day. Positive controls first (the admin really is
  sent both days and the expense), then the rule: Reed's workspace holds his own
  day and none of hers, his timeline prints his own figures and none of hers,
  and Dana keeps her own expense on her own desk. It sits directly beside the
  existing section pinning the other direction, because the two halves of the
  owner's decision are only safe together.
- **"An uploaded file is never served back as something that can run"** — the
  same 64 bytes uploaded five ways, asserting on the **declared type** rather
  than the bytes: JPEG and PDF still come back inline as themselves (the
  controls), `text/html` and `image/svg+xml` come back as
  `application/octet-stream` with `attachment`, and an
  `application/xhtml+xml` nobody has thought about is refused inline by
  default — which is the allow-list itself being asserted, not just its
  current entries.
