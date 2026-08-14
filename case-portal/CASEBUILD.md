# Case Build + Dropbox Video Delivery — Continuation Handoff (INTERNAL)

**Recorded in substance from the owner's handoff on 2026-08-13.** Lives in
`case-portal/` because this directory never deploys. Do not prune — mark the
ledger instead.

**Build note:** this handoff *extends* a "Case Build" workflow the portal
does not yet have — so the build starts by creating Case Build itself
(report + selected photos + evidence index + attachments → client package →
preview → finalize → delivery center), then the storage-provider
abstraction, with Dropbox as the first external provider in NOT CONFIGURED
state until the owner connects a Dropbox app. Live Dropbox needs OAuth
credentials (owner action) and a fresh read of Dropbox's CURRENT API docs —
never assumed from memory.

Progress ledger (handoff priorities):

| Priority | Status |
| --- | --- |
| 0. Case Build core (selection → preview → finalize → delivery center) | **done** — 2026-08-13 (Package tab: mini-dashboard blocks, What's-Missing gates, client-deliverable-only selection, package types, finalize/reopen/delivered, printable document; build_events trail) |
| 1. Add Video to Package selection | **done** — 2026-08-13 (video items gated by package type; the document lists video, never embeds) |
| 2. Storage-provider abstraction (generic fields, no Dropbox-specific columns) | **done** — 2026-08-13 (external_files generic provider fields; /external-storage status endpoint) |
| 3. Dropbox Admin connection/settings (NOT CONFIGURED state first) | **done** in first form — 2026-08-13 (provider reports not configured and names the three Worker secrets that connect it; nothing blocks) |
| 4. Dropbox video upload | not started — needs owner's Dropbox app + current-docs check |
| 5. Upload progress / retry | not started |
| 6. Associate Dropbox files with case/evidence (delivery copy ≠ original) | not started |
| 7. Create / revoke delivery link (admin-intentional, never automatic) | not started |
| 8. Video Evidence section in the report | **done** — 2026-08-13 (VIDEO EVIDENCE + VIDEO DELIVERY wording in the package document) |
| 9. Evidence Index update (photos + videos, delivery column) | **done** — 2026-08-13 (Exhibit/Time/Type/Description/Delivery table) |
| 10. Case Build preview | **done** — 2026-08-13 (the document renders live in the Package tab — exactly what prints) |
| 11. Completed-case delivery section | **done** in first form — 2026-08-13 (finalized panel: print, Mark delivered, Reopen; honest Dropbox status) |
| 12. Audit / security testing | not started |

The master handoff's §13 named three things this ledger's priority 0 had not
actually covered. They were audited and closed on 2026-08-14:

| §13 gap | Status |
| --- | --- |
| Multi-day cases — "Do not assume one case = one day" | **done** — 2026-08-14. `case_builds.report_id` holds exactly one report, so a three-day case shipped its **third day alone** and dropped the first two silently. `build_reports` is now the ordered set the package carries; opening a build attaches every approved day oldest-first, a day approved later is offered rather than lost, any day can be dropped and put back, and the gate names an unapproved day **by its date**. `report_id` stays and follows a day still in the package, so every older read keeps working |
| Combined Summary | **done** — 2026-08-14. Two halves, deliberately. The facts — days, span, hours, miles, exhibit counts — are **derived at render time and never stored**, so adding a day cannot leave a stale sentence behind. The narrative paragraph above them is the admin's own, in `build_summary`; nothing writes prose on their behalf |
| Package types — the fourth one, Custom | **done** — 2026-08-14. Custom means "what I selected is what ships", so it skips the type-based video gate — and **only** that one: held-back material is still refused by name. It is a marker in `build_custom`, not a fifth value in `package_type`, because that column carries a CHECK constraint and widening a CHECK in SQLite means rebuilding the table. Editing the constraint in place would have let a **fresh** database store `custom` while the **live** one refused it — a divergence that passes every test and fails only in production |
| "Should look like a real investigative report" | **done** — 2026-08-14. The document now opens with CASE INFORMATION (case number, who it is prepared for, type, subject, claim number, date of loss, investigator, authorized hours, days of investigation), then ASSIGNMENT OBJECTIVE, then COMBINED SUMMARY where there is more than one day, then INVESTIGATION — DAY *n* per day with its own date, hours and investigator, then the photographs, the video listing and the evidence index that were already there. Absent facts are simply **absent** — no "N/A", the same rule the intake form works to |
| "Original evidence must never be overwritten by report copies or thumbnails" | **held, and now written down.** Every `<img>` in the document points at the original evidence route; the package holds no copy and writes nothing back. Building, printing and finalizing a package touch `build_*` tables only |

---

The handoff, in substance:

## CORE OBJECTIVE

Extend CASE BUILD so Admin can include large video evidence without forcing
all video to live inside the web application. After Admin selects Final
Report, Selected Photos, Evidence, Attachments — add **ADD VIDEO TO
PACKAGE**. Video may be stored externally in a connected Dropbox account.
The final client package may contain: Final Investigative Report PDF,
selected photographs, evidence index, selected attachments, video evidence
hosted in Dropbox, and a controlled video delivery link. **Optional — never
require Dropbox for a case.**

## ARCHITECTURE

Do NOT build Case Build around Dropbox. Create a reusable **EXTERNAL FILE
STORAGE PROVIDER** architecture (future: local_private_storage, dropbox,
google_drive, onedrive, s3, other; now: dropbox as the first optional
provider). Generic fields only — storage_provider, external_file_id,
external_folder_id, external_path, external_share_id, external_share_url,
share_created_at, share_expires_at, share_revoked_at, external_metadata.
No Dropbox-specific columns spread through the case tables.

## CASE BUILD — VIDEO STEP

After report images, show VIDEO EVIDENCE: every video on the case with
thumbnail (if available), filename, investigation date, activity time,
duration, size, linked chronology entry, description, current storage
location, client-eligibility status. Actions: ADD TO CLIENT PACKAGE ·
UPLOAD TO DROPBOX · INTERNAL ONLY · DO NOT USE · NEEDS REVIEW.

ADD VIDEO TO PACKAGE never embeds video in the PDF. It: associates the
video with the build version, confirms client-eligibility, stores/uploads
via the selected provider, includes it in the Evidence Index and the
package manifest, and optionally generates a controlled delivery link.

## DROPBOX UPLOAD

Admin action UPLOAD SELECTED VIDEOS TO DROPBOX shows count, total size,
case number, destination folder first. Folder naming by CASE NUMBER, never
the client's name alone:
`/Always Precise Investigations/Client Deliverables/<year>/<case_no>/Video`.
Client-facing filenames are professional (`API-2026-00142_Video_01.mp4`);
the original filename stays in internal metadata; never destroy or rename
the original evidentiary file.

## ORIGINAL EVIDENCE REQUIREMENT

Dropbox delivery copies are NOT the evidentiary master. ORIGINAL EVIDENCE
(portal storage) is distinct from CLIENT DELIVERY COPY. Never silently move
and delete the only original. Admin setting **Video Storage Strategy**:
Keep in Portal · Copy to Dropbox · **Dropbox Delivery Copy + Preserve
Portal Original (recommended default)**. Never auto-delete portal
originals. Revoking or deleting a Dropbox link must never mean the original
investigation video has disappeared.

## DROPBOX CONNECTION SETTINGS (admin-only)

External Storage → Dropbox: Connected / Not Connected; account name, root
folder, default delivery folder, status, last successful API action,
Disconnect, Test Connection. OAuth credentials server-side only — never in
browser JS, never in git. **Before implementing live Dropbox, inspect
Dropbox's CURRENT official API docs** (OAuth flow, upload limits,
large/session uploads, shared links, expiration, password protection,
revocation, scopes, permissions). If live configuration is not available:
build the provider interface and UI first; Admin sees DROPBOX INTEGRATION
NOT CONFIGURED and Case Build keeps working.

## LARGE UPLOADS

Use the provider's recommended chunked/session upload for large video —
never ordinary request bodies the stack cannot safely carry. Upload UI:
Uploading · % complete · Uploaded · Failed · Retry. On failure: do not
finalize as delivered, preserve the original, show a clear failure state,
allow retry, record the error internally, never expose raw API
credentials/errors: "Video upload failed. Original evidence remains
preserved. Retry the upload before finalizing the client package."

## DELIVERY LINK

CREATE VIDEO DELIVERY LINK is an intentional admin act — never automatic
after upload. Show videos included, case #, link status, created,
expiration if supported, last access if available. Actions: COPY LINK ·
REVOKE LINK · REGENERATE LINK. Prefer (where the plan/API supports):
expiration, password protection, view/download restrictions, revocable.
Show limitations honestly; never label a standard public link "Secure" —
call it **Dropbox Delivery Link**.

## PACKAGE OPTIONS

REPORT ONLY · REPORT + PHOTOS · REPORT + PHOTOS + VIDEO LINK (report,
photos, evidence index, video listing, delivery instructions/link) · FULL
CLIENT PACKAGE (report PDF, evidence index PDF, photos, documents, video
link, manifest).

## VIDEO SECTION IN THE FINAL PDF

"VIDEO EVIDENCE": per video — time, description, duration, related
observation. Bottom: "VIDEO DELIVERY — Selected video evidence is provided
through the accompanying electronic evidence link." Optionally "Video
Package Reference: <case_no>". No huge raw URLs breaking layout; a "View
Video Evidence" hyperlink is fine. QR code to the approved link: optional,
OFF by default, admin-enabled only.

## EVIDENCE INDEX

Includes video: Exhibit · Time · Type · Description · Delivery
(Report / Video Link).

## PREVIEW + FINALIZATION RULE

CLIENT PACKAGE PREVIEW (report included, photo count, video count, video
storage, upload progress, link status, attachments, index) with PREVIEW
PDF · COPY VIDEO LINK · TEST VIDEO LINK · BACK AND EDIT · FINALIZE. Do NOT
allow Finalize if: selected Dropbox videos have not uploaded; selected
videos are Internal Only; required report review is incomplete; an expected
link has not been created; external storage has an unresolved failure —
show exactly what needs attention.

## COMPLETED CASE / DELIVERY CENTER

CLIENT DELIVERABLES: Final Report (download), Evidence Index (download),
Video Evidence (open Dropbox delivery), Client Package (download), Dropbox
link status ACTIVE with COPY / REVOKE. CLIENT DELIVERY panel: case, report
ready, photos, videos, link active, invoice sent, delivery status. Future:
COPY DELIVERY MESSAGE · MARK DELIVERED · SEND THROUGH CLIENT PORTAL. Never
auto-email evidence.

## RECOMMENDED SPLIT

PORTAL: case records, logs, reports, PDFs, evidence metadata, package
config, billing, audit. DROPBOX: large client video copies and large
downloadable packages, optionally. The portal stays the brains.

## AUDIT

Track: video selected, upload started/completed/failed, link
created/copied/revoked, package finalized, package rebuilt — user,
date/time, case, action, external reference. No access tokens in logs.

## PERMISSIONS

INVESTIGATOR: upload original evidence, link video to activity, submit —
never create/revoke client links, never finalize, never select final
deliverables. ADMIN: everything.

## FINAL EXPERIENCE

Review Report → Select Photos → ADD VIDEO TO PACKAGE → Upload to Dropbox →
Create Video Delivery Link → Preview → FINALIZE. Completed case offers
DOWNLOAD FINAL REPORT PDF and COPY VIDEO DELIVERY LINK — one organized
package, not a pile of files.
