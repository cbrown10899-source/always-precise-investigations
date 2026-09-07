# ART-ASSET-MANIFEST — the portal's action-card artwork

**Status: CUSTOM ARTWORK PENDING OWNER/CHATGPT.** Every card listed here is
built and working today with a neutral placeholder. Dropping the final art in
must cost **one asset file plus one line in `.github/deploy-manifest.txt`** —
never a layout change, never a code change beyond an `object-position` nudge.

This file exists so the artwork can be produced without guessing. It is the
owner brief of 2026-09-06 §AF written down as specifications.

---

## Where the files live, and why

```
portal/cards/<name>.webp
```

**`portal/`, not `assets/`.** `assets/` is the PUBLIC marketing site's image
folder — `banner1.webp`, the three homepage door cards, the review
screenshots. Portal artwork is staff-facing and belongs beside the page that
uses it, the way `portal/icon-192.png` already does.

**Each file must be named ONE BY ONE in `.github/deploy-manifest.txt`.** That
file is an allow-list of file patterns, and a bare directory entry is
forbidden — a test fails if one appears. `portal/cards/*.webp` is acceptable
under the same rule the existing `portal/vendor/mp4-muxer.js` line follows
only if it stays a FILE pattern; prefer naming each file, as
`assets/card-*.webp` already does.

**A missing file must not break the card.** The art is a CSS `background-image`
over a token-coloured ground, so a card whose art has not arrived draws its
family colour and its title exactly as it does today. There is no `<img>` to
show a broken icon and no layout that collapses.

---

## The three card shapes

| Shape | Where | Aspect | Recommended pixels |
| --- | --- | --- | --- |
| **Primary quick action** | phone Home grid, 2 across | near-square, ~1.15:1 | **720 × 620** |
| **Wide action** | View Signed Intakes, Retainer Paid, Close Case | ~3:1 on a phone, wider on desktop | **1200 × 400** |
| **Desktop feature** | desktop Home, where a card gets a landscape slot | 3:2 | **960 × 640** |

**Source at the largest size and let CSS crop.** The same file serves all three
breakpoints through `background-size: cover` plus a controlled
`background-position`; nothing is ever distorted, because `cover` preserves
the aspect ratio. Supply a separate `-wide` variant **only** where the
square crop genuinely loses the subject — the public site's own card artwork
proved a 3:2 source crops acceptably to 1.40:1, so start with one file.

---

## The text-safe zone — the one rule that matters

**The lower-left 60% of the frame is where the title and subtitle sit.** Keep
it free of detail the text would fight. The card paints a scrim over it (a
transparent-to-dark gradient from the top down), so the artwork's own contrast
does not have to carry the text — but a busy subject there still reads as
noise behind the words.

**Put the subject in the CENTRAL 60% of the frame, and never in the left
third.** This is the public site's own hard-won rule, recorded in CLAUDE.md:
two of the three homepage cards had to be mirrored because their subject sat
where the headline goes and where the crop bites first, and the owner reported
one of them as "not the van image" while it *was* the van image. Check a new
image against the other cards in its row, not on its own.

**A badge may sit top-right** (a count, a status). Leave that corner quiet.

---

## Cards, and what each one needs

Aspect and pixels are the shape's, from the table above.

| Card | File | Shape | Safe zone | Title / subtitle | Family |
| --- | --- | --- | --- | --- | --- |
| Rate Sheet | `rate-sheet.webp` | primary | lower-left | **Rate Sheet** / Prepare & send | teal |
| New Intake | `new-intake.webp` | primary | lower-left | **New Intake** / Choose the type | green |
| Private Intake | `private-intake.webp` | primary | lower-left | **Private Intake** / Client matter | green |
| Insurance Intake | `insurance-intake.webp` | primary | lower-left | **Insurance Intake** / Carrier matter | green |
| Law Firm Intake | `legal-intake.webp` | primary | lower-left | **Law Firm Intake** / Legal matter | green |
| View Signed Intakes | `signed-intakes.webp` | **wide** | left | **New signed intake** / the client's name | green |
| Open Cases | `cases.webp` | primary | lower-left | **Cases** / All open work | navy |
| Retainer Paid | `retainer-paid.webp` | **wide** | left or lower-left | **Retainer paid** | green |
| Close Case | `close-case.webp` | **wide** | lower-left | **Close case** | red |
| Active Surveillance | `surveillance.webp` | primary | lower-left | **Active Surveillance** / Start or resume | navy |
| Reports & Evidence | `reports.webp` | primary | lower-left | **Reports & Packages** / View all | teal |
| Timestamp Photo | `timestamp-photo.webp` | primary | lower-left | **Timestamp Photo** / Burn the moment | purple |
| Timestamp Video | `timestamp-video.webp` | primary | lower-left | **Timestamp Video** / Burn the moment | purple |
| AI Assistant | `assistant.webp` | primary | lower-left | **Assistant** / Operate the business | teal |
| CEO Bot | `ceo-bot.webp` | primary | lower-left | **CEO Bot** / Improve the portal | gold |

**Scrim:** every card carries a dark scrim, so supply artwork that reads on
the **light** side. `close-case.webp` is the exception worth stating twice:
**do not make it alarming.** It is a routine end-of-matter action the owner
performs on most cases, not an emergency. Restrained, quiet, final.

---

## Art direction

Premium, professional, investigative, modern, trustworthy — and **visually
distinct between actions**, because the artwork's job is navigation.

**Avoid:** magnifying glasses (on any card, let alone every card), cartoon
styling, generic corporate stock-photo feel, overly dark crime imagery, and
**anything resembling police or law-enforcement imagery** — the firm is a
licensed private investigator, and implying law-enforcement status is a
regulatory problem, not a taste one.

**Check a new image against the OTHER cards in its row**, the public site's
rule: three doors that read as one pair and an outlier is a worse row than
three plain cards.

---

## Cache busting is REQUIRED

`_headers` caches static assets for seven days, and these files will be
replaced **in place at stable URLs**. The public site paid a full round for
this: `card-insurance.webp` was three different photographs at one URL inside
an hour, every deploy was green, and the owner correctly reported the site as
not updating — a stale asset behind fresh markup is indistinguishable from a
deploy that never ran.

**Every card URL carries `?v=<n>`. Bump it whenever a file changes.**

---

## Readiness

| Card | Final artwork needed |
| --- | --- |
| all fifteen above | **YES — CUSTOM ARTWORK PENDING OWNER/CHATGPT** |

The card SYSTEM is built and shipping. The artwork is not, and the placeholder
is deliberately neutral rather than a permanent gradient — a gradient that
looks finished is how a placeholder stops being replaced.
