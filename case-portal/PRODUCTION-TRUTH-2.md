# PRODUCTION TRUTH AUDIT — ROUND 2, the owner's brief verbatim

**Recorded 2026-08-22.** The owner's own message, unedited, from the bundle of
three that also carried the optional-field rule (shipped as Unit 36) and the
Case Workspace Simplification (`CASE-WORKSPACE.md`).

**Queued as UNIT 37**, ahead of the workspace unit, in the order the owner
sent them.

**This unit changes no files.** The brief says so in its own words, and its
stop condition is explicit: a BLOCKER or HIGH finding ends the audit with a
correction queue rather than a fix.

Round 1 is `FINAL-LEDGER.md` PART 6B and the Units 28–33 correction queue.
Round 2 re-walks the same ground after Units 34, 35 and 36 shipped.

---

## THE BRIEF, VERBATIM

```
FINAL PRODUCTION TRUTH AUDIT — ROUND 2.

Audit the deployed Always Precise site from the perspective of a real user. Do not trust completion labels alone.

Verify normal navigation, visible UI, correct routing and working actions for:
- Private / Insurance / Legal public entry
- all three intake forms
- every optional intake field label
- Legal Rate Sheet and pre-case Legal send
- Send Private / Insurance / Legal Intake
- no public pricing
- no visible canvass/interview/recorded-statement wording anywhere
- Dashboard
- Search
- Cases
- Tasks
- Intakes
- Clients & Firms
- Calendar
- File Queue
- Reports & Packages
- Rate Sheets
- Billing
- Staff
- Audit Trail
- Settings
- Invoice Defaults
- Case Types
- Storage Health
- Active Surveillance
- Timestamp Photo
- Timestamp Video
- Client Delivery
- retention/legal hold
- report/package/payment workflows

For each item classify:
LIVE + REACHABLE + WORKING
VISIBLE BUT BROKEN
IMPLEMENTED BUT NOT EXPOSED
PARTIAL
MISSING
DEFERRED
REQUIRES REAL CASE/DATA

Do not change files during the audit.

If any BLOCKER or HIGH issue is found, stop and give the exact correction queue.
If none are found, report:
FINAL PRODUCTION TRUTH AUDIT PASSED
and list only remaining owner-live-verification and deferred items.
```


---

# ROUND 2 — RESULT, 2026-08-22, master `ee39cb2`

## FINAL PRODUCTION TRUTH AUDIT — **NOT PASSED**

**One HIGH finding.** Per the brief's own stop condition the audit stops here
and hands over the exact correction queue rather than fixing anything.

## How this was verified

The live domain cannot be reached from this container — the agent proxy refuses
`alwayspreciseinvestigations.net` with a 403 on CONNECT, which `NEXT.md` already
records as a standing limitation. So "deployed" was established three ways, and
each is stated rather than implied:

1. **The published bytes.** `.github/stage-site.mjs` — the same script
   `deploy.yml` runs — was executed and produced **40 files**. Every public
   assertion below is against those staged bytes, and both
   `intake/index.html` and `portal/index.html` were confirmed byte-identical
   to the repository copies.
2. **The deployed commit.** `Deploy site to Cloudflare Pages` run
   **32540154210** at `b34ccda` — success. The two commits since are
   documentation only and stage no file.
3. **The running system.** Four purpose-written probes drove the REAL page
   against the REAL Worker against real SQLite — signing in as an admin, then
   issuing an invitation and signing in as the investigator who accepted it —
   and walked every named surface, clicked its door, and performed an action.

**No repository file was changed to reach any of this.** The probes live
outside the working tree.

## THE FINDING — HIGH

### Global Search cannot find a case by its subject's name or address

`GET /search`'s subject arm reads **`case_subjects`** — the companion table an
admin fills in on the Subject panel. The **public intake writes
`submissions.subject_name`** and creates no `case_subjects` row. `subject_name`
appears in the search only as a *display* column and in the subtitle fallback;
it is in no `WHERE` clause.

So a case that arrived the ordinary way — through the intake form, before
anyone has curated it — **is not findable by the subject's or claimant's name.**

Reproduced end to end against the real Worker:

| Search for | Result |
| --- | --- |
| the case number | ✅ found |
| the client's name | ✅ found |
| **the subject's name** | ❌ **0 hits** |
| **the subject's address** | ❌ **0 hits** |
| the subject's name, *after* a `case_subjects` row is added by hand | ✅ found |

**Why this is HIGH and not MEDIUM:**

- Search is a named item in this brief, and the subject's name, alias and
  address are its documented promise in `CLAUDE.md` and the Unit 8 brief.
- It fails on the **default case shape** — every case from the public form,
  which is the firm's primary intake path — not on an edge case.
- It fails **silently, in the reassuring direction.** "No results" reads as
  "we have no such case". That is the exact class of untruth this project
  refuses elsewhere: `loadSends()`'s empty history, `casesEmptyHtml()`'s three
  states, the audit trail's `missing_sources`.
- An adjuster rings about a claimant by name; an investigator looks for the
  person they are watching. Both get nothing.

**Why every suite is green over it.** The search test ingests a case and then
**immediately adds a structured subject row** before searching. The test was
right about what it tested; **no test ever crossed the boundary between what
the intake writes and what the search reads.** Same shape as the `client_token`
column that never reached the live database, and precisely what this audit
exists to catch.

**Partial mitigation, which does not close it.** The Cases list has its own
client-side filter that *does* match `subject_name` — but it filters only the
page of cases already loaded, it is a different screen, and an investigator's
door is Search.

### Correction queue — **UNIT 37A**

Named `37A` rather than `39` because this project already uses that shape for a
correction that must jump the queue (Hotfix 17A). **It comes before Unit 38.**

1. Add a search arm over **`submissions.subject_name`**, scoped exactly as the
   existing subject arm is — `mine` for an investigator, `notDeleted`,
   `SEARCH_ARM_CAP`. It is a substring `LIKE`, so state in `SEARCH.md`/comments
   that it cannot seek, the way the other substring arms already do.
2. Add an arm over the intake payload's **subject address** only if it can be
   done without a JSON scan per row; otherwise record it as deliberately not
   covered rather than implying it is.
3. **De-duplicate against the existing arm** — a curated case has the name in
   both places and must return one result, not two. `add()` already keys by
   `case:${case_no}` / `subject:${id}`; check that a submissions-side hit
   merges into the same key rather than creating a second row.
4. **Tests that cross the boundary**, which is the actual gap:
   - ingest a case the way the public form does, add no companion row, and
     assert it is findable by the subject's name;
   - assert the investigator scoping still holds on the new arm — a case they
     are not on stays invisible;
   - assert a curated case returns exactly one result, not two;
   - assert the widest bind count is still bounded (Unit 7's rule).
5. No schema. No `portal-setup` dispatch.

## The two lesser findings — reported, not blocking

### L1 — the legal door announces itself as "Client Intake" — MEDIUM

`/intake/?assignment=legal` identifies itself correctly **twice**: the browser
tab reads *Legal Investigation Assignment* and the masthead reads
*INVESTIGATIONS · LEGAL ASSIGNMENT*. But its `<h1 class="sr-page-title">` — the
visually-hidden heading that is the page's identity to a screen reader — is the
private branch's, and reads **"Client Intake"**.

The carrier door sets its own (*Secure Assignment Intake*); the legal door
falls through to the consumer branch's `<h1>`. So a screen-reader user on the
legal door hears the private-client name, on the page whose whole purpose
(owner decision 1) is that a legal visitor is never routed through the
private-client intake. Nothing is mis-routed and no action breaks.

**Fix:** give the legal path its own `sr-page-title`, the way the claims path
has one. One line, plus an assertion per door.

### L2 — `_headers` has no cache rule for `/legal-investigations/*` — LOW

Its four sibling content routes each carry
`Cache-Control: public, max-age=3600`; the legal page has none and falls through
to `/*`, which sets the security headers but no caching. Not a correctness or
security defect — a consistency and performance gap.

**Fix:** one stanza in `_headers`.

## Everything else — classified

**LIVE + REACHABLE + WORKING**

*Public:* Private, Insurance and Legal entry, each routed to its own door and
never the consumer picker (homepage → private + insurance; the Legal page,
linked twice from the homepage nav and once from the Insurance page, → the
legal door; `/insurance-investigations/submit/` → the carrier door). All three
intake forms render and walk end to end with **zero page errors**. **87 field
labels across the three doors each carry exactly one requiredness marker**, with
no duplicate wording. **No dollar figure appears on any public page.** **No
retired terminology appears in any rendered public markup** — the only matches
in the 40 staged files are inside `portal/index.html`'s `<script>`, and a
mechanical strip of every `<script>` body confirms **none is rendered**;
`robots.txt` names neither `/portal/` nor `/watch/`, and the sitemap names
none of portal, watch or intake.

*Portal, all fourteen nav surfaces reached by clicking their own door and each
returning real content:* Dashboard, Search, Cases, Tasks, Intakes,
Clients & Firms, Calendar, File Queue, Reports & Packages, Rate Sheets,
Billing, Staff, Audit Trail, Settings — plus **Invoice Defaults**, **Case
Types** and **Storage Health** as real panels with real controls inside
Settings.

*Sends:* Rate Sheets shows **three cards** — Private, Insurance and **Legal** —
the Legal sheet opens and carries **no Cash App or Venmo**, and
**Send to someone new** offers all three pre-case doors. The door pairing is
asserted three ways with negatives in the Worker suite.

*Tools:* Active Surveillance, Timestamp Video and Timestamp Photo each open and
draw, for **both roles**, from the navigation foot.

*Workflows:* the case workspace draws four sections and every tab
(Overview · Intake details · Subject | Field work · Activity log · Timeline |
Reports · Case media · Package | Edit case · Assignment · Authorization ·
Expenses · Internal notes · Comm log · Tasks · Billing & closing). Report,
Package, Billing/payment, Retention/legal hold and Closeout all reachable and
drawing. The Delivery Centre renders and carries **no send or email control**,
as the owner requires.

*Role boundary:* an investigator's nav carries Search, My assignments, Tasks,
File queue, Today, Calendar, Reports, Expenses and the three field tools — and
**no** Dashboard, Billing, Staff, Audit trail, Settings, Clients & Firms, Rate
Sheets or Reports & Packages. Accounts still exist only by invitation.

*Every documented search field* was tried against a case carrying all of them
and **all seventeen matched**: case, claim and matter number, client, carrier,
client phone, subject name, alias, address and phone, vehicle make, model,
colour and plate, firm, attorney. (The investigator arm returned nothing only
because that probe case was unassigned — correct behaviour.)

**REQUIRES REAL CASE/DATA** — not defects; the probe environment has no
production credential:

- **Email sending.** `/intake-link/email` returns
  `502 not_configured` with *"Add RESEND_API_KEY"* — the Worker correctly
  refusing to claim a send it cannot make. The composer, the door pairing and
  the wording are all verified; only the delivery leg needs the live key.
- **The Dropbox quota line** on Storage Health reads *"Account usage could not
  be read just now (…) — unknown, not zero."* That is Unit 14's designed
  degrade with fake credentials, and the panel keeping its three states apart.
- Unit 23's consolidated sweep, and every LIVE VERIFY OPEN row, unchanged.

**DEFERRED** — unchanged, and none silently converted: the deferred list in
`NEXT.md`.

**MISSING** — nothing beyond the finding above.
