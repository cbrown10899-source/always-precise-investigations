# ART-ASSET-MANIFEST — the portal's action-card artwork

**Status: CUSTOM ARTWORK PENDING.** Every card listed here is built and working
today with a restrained placeholder. Dropping the final art in must cost **one
asset file, one name in `CARD_ART`, and one line in
`.github/deploy-manifest.txt`** — never a layout change, never a code change
beyond an `object-position` nudge.

This file is the **approved art sheet of 2026-09-07** written down as
specifications. Where this file and an older note disagree, this file wins: the
sheet changed the dimensions, added three filenames and named the guidelines.

---

## What the placeholder actually is, and why it is not a photograph

Each of the seven primary Home cards draws a **deep family-coloured ground**
from `:root` (`--art-sheet`, `--art-intake`, `--art-private`, `--art-signed`,
`--art-field`, `--art-photo`, `--art-video`), with the title and subtitle in
the same lower-left cluster the artwork must keep quiet.

**The scrim is a property of the ART, not of the card.** With no photograph
there is nothing to scrim, so none is painted — that is the correction that
makes this work. An earlier build painted the scrim unconditionally and turned
every card near-black, which is why the art system was previously switched off
entirely. Now: no art → the ground at full strength; art → the same ground,
under the photograph, under the scrim. **The type does not move and does not
need re-measuring when the photographs land.**

---

## Where the files live

```
portal/cards/<name>.webp
```

**`portal/`, not `assets/`.** `assets/` is the PUBLIC marketing site's image
folder. Portal artwork is staff-facing and belongs beside the page that uses
it, the way `portal/icon-192.png` already does.

**Each file must be named in `.github/deploy-manifest.txt`.** That file is an
allow-list of file patterns and a bare directory entry is forbidden — a test
fails if one appears.

**And each must be added to `CARD_ART` in `portal/index.html`.** A file that
exists but is not named there is not drawn; a name there without the file
beside it draws a card with a missing image. The two go in together.

---

## The two card shapes, from the approved sheet

| Shape | Where | Aspect | Pixels |
| --- | --- | --- | --- |
| **Primary** | Home grid — 2 across on a phone, 3 on a tablet, 4 on desktop | **1:1** | **1024 × 1024** |
| **Wide** | the signed-intake alert | **2.4:1** | **1440 × 600** |

**The card's rendered proportion is not always the asset's.** The phone card is
near-square (155×142 at 390px, 120×122 at 320px) and the desktop card is
landscape (244×134). `background-size:cover` crops a 1:1 source to all of them
without distorting it — which is exactly why the source is square and generous.

The 390px card is **capped at 142** rather than a true 155 square: at 155 the
last card's top lands at 869 on an 844-tall screen when a signed intake sits
above the strip, which puts Timestamp Video off the first screen and breaks the
owner's 2026-09-07 lock. Compose for a square and expect the top ~8% to be
cropped on a phone.

---

## The text-safe zone — the one rule that matters

**The lower-left of the frame carries the icon, the title and the subtitle**,
as one cluster. Keep it free of detail the text would fight.

**Put the subject in the CENTRAL 60% and never in the left third.** This is the
public site's own hard-won rule: two of the three homepage cards had to be
mirrored because their subject sat where the headline goes, and the owner
reported one as "not the van image" while it *was* the van image.

**A badge may sit top-right** (the waiting-intake count). Leave that corner
quiet.

**On desktop the card is landscape**, so a composition that only works square
will crop badly. Check a candidate at both 1:1 and 1.82:1.

---

## The cards

### Live slots — these seven draw art the moment the file lands

| Card | File | Ground token | Family (owner §4) |
| --- | --- | --- | --- |
| Rate Sheet | `rate-sheet.webp` | `--art-sheet` | navy / teal |
| New Intake | `new-intake.webp` | `--art-intake` | green / teal |
| Private Intake | `private-intake.webp` | `--art-private` | muted navy / charcoal |
| View Intakes | `signed-intakes.webp` | `--art-signed` | green |
| Active Surveillance | `surveillance.webp` | `--art-field` | dark navy / slate |
| Timestamp Photo | `timestamp-photo.webp` | `--art-photo` | blue / charcoal |
| Timestamp Video | `timestamp-video.webp` | `--art-video` | deep blue / indigo |
| New Signed Intake (wide) | `signed-intake-wide.webp` | `--art-signed` | green |

`signed-intake-wide.webp` is a **different file** from `signed-intakes.webp` —
2.4:1 and 1:1 are different crops of a different composition, and the sheet
names both.

### Reserved slots — specified, not drawn

The owner's §2 keeps these as plain controls: Cases has the bottom navigation,
the CEO Bot and the Assistant have persistent launchers, Reports & Packages and
the two extra intake kinds live under More. **They are Home cards without a
ground, so they draw light and ignore any art.** Giving one artwork means
giving it a `ground` first, which is an owner decision, not a file drop.

`cases.webp` · `ceo-bot.webp` · `reports.webp` · `insurance-intake.webp` ·
`legal-intake.webp` · `assistant.webp` (wide) · `open-cases-wide.webp` (wide)

### Retired slots — do not commission these

`retainer-paid.webp` and `close-case.webp` were specified before the 2026-09-07
brief. **§3 names Retainer Paid and Close Case as screens that must stay clean
operational surfaces**, and they are `.uibtn` controls on the case action row —
there is no art card for either. Commissioning them would buy nothing.

The sheet's secondary set (`calendar.webp`, `billing.webp`, `settings.webp`) is
in the same position: those destinations are rail items, not Home cards.

---

## Art direction (the sheet's own guidelines, verbatim in substance)

- Realistic, professional, on-brand imagery
- Keep text areas clear — **bottom-left preferred**
- Dark/light overlay as needed for readability
- No stock-watermark images
- Consistent style, colour grading and composition across the set
- Each image should tell the story of the action
- Cinematic, trustworthy, professional, discreet
- **Avoid clichés, cartoons, or law-enforcement appearance** — the firm is a
  licensed private investigator, and implying law-enforcement status is a
  regulatory problem, not a taste one
- No magnifying glasses. Not on one card, and certainly not on every card.

**Check a new image against the OTHER cards in its row**, never on its own.

---

## Cache busting is REQUIRED

`_headers` caches these seven days and the files will be replaced **in place at
stable URLs**. The public site paid a full round for this: one card was three
different photographs at one URL inside an hour, every deploy was green, and
the owner correctly reported the site as not updating.

**`CARD_ART_V` in `portal/index.html` is the one version number** on every card
URL. Bump it whenever any card asset changes. A test fails if a card URL is
emitted without it.

---

## Readiness

| Card | Final artwork |
| --- | --- |
| the eight live slots above | **PENDING — placeholder ground in use** |
| the reserved slots | not drawn; needs an owner decision first |
| `retainer-paid`, `close-case`, the secondary set | **retired — do not commission** |

The card SYSTEM is built and shipping. The artwork is not.
