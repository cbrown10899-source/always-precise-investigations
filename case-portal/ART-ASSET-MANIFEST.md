# ART-ASSET-MANIFEST — the portal's action-card artwork

**Status: THE SEVEN PRIMARY CARDS ARE INSTALLED** (owner's approved hybrid art
pack, 2026-09-07). It cost exactly what this file promised it would: one asset
file, one name in `CARD_ART`, one line in `.github/deploy-manifest.txt`, and a
single `object-position` nudge on one card. **No layout change, no geometry
change, no code change beyond that.**

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

### Installed — the seven primary cards

Source PNGs are 1254×1254; each was resized to **1024×1024 LANCZOS** and saved
as **WebP q82, method 6**. Quality was chosen against the rendered size: the
largest a card ever draws is 244×134, so the source is heavily downscaled and
q88 bought nothing visible for 30% more bytes.

| Card | Source PNG (owner's pack) | Asset | Size | Ground token |
| --- | --- | --- | --- | --- |
| Rate Sheet | `elegant_contract_desk_still_life` | `rate-sheet.webp` | 46 KB | `--art-sheet` |
| New Intake | `golden_hour_executive_file_tray` | `new-intake.webp` | 53 KB | `--art-intake` |
| Private Intake | `cinematic_executive_office_at_sunset` | `private-intake.webp` | 33 KB | `--art-private` |
| View Intakes | `signed_approval_on_marble_desk` | `signed-intakes.webp` | 52 KB | `--art-signed` |
| Active Surveillance | `cinematic_surveillance_camera_interior` | `surveillance.webp` | 45 KB | `--art-field` |
| Timestamp Photo | `cinematic_camera_on_marble_tabletop` | `timestamp-photo.webp` | 60 KB | `--art-photo` |
| Timestamp Video | `cinematic_camera_in_golden_studio_light` | `timestamp-video.webp` | 53 KB | `--art-video` |

**368 KB total**, cached seven days.

**The grounds are still live and still matter.** They are what paints if an
image fails to load, and what a future card with no asset draws — so the CIE76
separation between them is still asserted even though a photograph now covers
each one.

### One crop adjustment, and it was measured

**`timestamp-photo` carries `--art-pos: center 65%`.** Centred, its golden
light on marble put the brightest part of the frame directly under the title:
painted white contrast **4.54:1** at the desktop crop — above the 4.5 bar, but
by 0.04, which is the razor-thin margin this project already rejected once.
Swept against the real render at the desktop crop: 0% 4.72, 20% 4.84, 35% 5.99,
**65% 7.87**, 80% 6.83, 100% 5.16. `center 65%` is the best of both surfaces
(phone 5.97) and keeps the camera in frame at every width.

**The other six needed nothing** and carry no `pos`. Adjust one only against a
measurement, never by eye.

### The scrim was retuned to these photographs

`.14 → .82 at 84%`, and the two stops were swept **separately** because they do
different jobs.

- The **bottom** stop protects the text and cannot move: at `.74` the worst card
  measures 4.82 desktop / 4.65 phone — passing by 0.15, the thin-margin trap.
- The **top** stop only dims the part of the card the text never reaches, and
  was at `.28` for no measured reason. Halving it to `.14` makes the artwork
  roughly twice as bright where it is actually visible and costs almost nothing
  at the text.

Painted contrast with the real photographs in place, all seven cards:

| | worst card | desktop | phone | 320 |
| --- | --- | --- | --- | --- |
| before (`.28`) | Private Intake / Timestamp Photo | 6.20 | 5.97 | 6.32 |
| **after (`.14`)** | Private Intake / Timestamp Photo | **5.27** | **5.01** | **5.44** |

Full set after: 5.87 / 6.55 / 5.27 / 5.54 / 9.94 / 7.04 / 5.75 desktop.
**The binding card is not the same on both surfaces** — Private Intake on
desktop, Timestamp Photo on a phone — so re-run the sweep over all seven before
touching either stop.

### Reserved — specified, not installed

`signed-intake-wide.webp` is a **different file** from `signed-intakes.webp`:
2.4:1 and 1:1 are different crops of a different composition. The owner's pack
contains no wide asset, and §5 of the install brief says the wide signed-intake
alert keeps its existing behaviour and hierarchy — so **it stays on its green
ground with no photograph**, and a test pins that.

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
| the seven primary cards | ✅ **INSTALLED 2026-09-07** |
| `signed-intake-wide` (the wide alert) | not supplied; alert keeps its green ground by §5 |
| the reserved slots | not drawn; needs an owner decision first |
| `retainer-paid`, `close-case`, the secondary set | **retired — do not commission** |

The card system and the artwork are both shipping.
