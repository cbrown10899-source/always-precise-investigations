# Search visibility — what was measured, what was changed, what to do next

**Internal. Not published** — `.github/deploy-manifest.txt` is an allow-list, so a
markdown file at the repo root cannot reach the public site. `test-deploy.mjs`
proves that on every run.

Baseline measured 2026-09-12, before the changes below.

---

## 1. There is still no search DATA, and that is the first gap to close

Nothing in this repository records rankings, impressions or clicks. The `/watch/`
beacon keeps a referrer host in KV on a **600-second TTL** — a live view, not a
history — so "how are we doing in search?" cannot be answered from the code. It
has to come from Google Search Console.

**Set it up this way (ten minutes, no code):**

1. Go to `search.google.com/search-console` and choose **Domain** property (not
   URL prefix). Domain covers www/non-www, http/https and every subdomain in one
   property, which is the better data.
2. Google shows a **TXT record**. Add it in the Cloudflare dashboard under
   **DNS → Records** for `alwayspreciseinvestigations.net`, type `TXT`, name `@`.
3. Click Verify. Wait a few minutes if it does not take the first time.
4. In Search Console, **Sitemaps → add `sitemap.xml`**. `robots.txt` already
   points at it, but submitting it directly makes the coverage report useful.

**Do not use the HTML-file verification method on this site.** The deploy stager
fails the build if a path listed in the manifest is missing, so a placeholder
entry for a `google<token>.html` file would break every deploy until the real
file landed. DNS avoids the repo entirely. The meta-tag method also works
(`<meta name="google-site-verification" content="…">` in `index.html`) and is the
fallback if DNS is awkward.

**Then give it 2–4 weeks** before drawing conclusions — Search Console backfills
nothing, so data starts from the day it is verified.

**What to look at once it fills up**, in order:
- **Pages with impressions but a low click rate** — that is a title/description
  problem and it is cheap to fix.
- **Queries where we rank 5–15** — the cheapest wins on any site; a page already
  on page one or two moves with modest work.
- **Coverage → "Duplicate, Google chose a different canonical"** on the six city
  pages. That is the diagnosis for §2 below, and it is the number that says
  whether this pass worked.

---

## 2. The city pages were near-duplicates. Measured, then fixed.

| | before | after |
| --- | --- | --- |
| visible words per page | ~700 | **~1,250** |
| sentences identical after swapping the city name (Roanoke vs Danville) | **28 of 33** | — |
| main-content words unique to that page | **~6%** | **44% average** (38–50%) |

Six pages that are one template with a name substituted compete with each other,
and Google picks one and filters the rest. `PLACES` in `build-locations.py` now
carries real per-locality facts — roads, courts, adjacent localities, and a
`ground` field describing what working that place actually involves — and the
page is **composed** from them.

**Every field in `PLACES` is a verifiable geographic or civic fact, or a
statement about what this firm does.** Nothing asserts case volume, named
clients, or work that cannot be evidenced. Keep it that way: this is a public
marketing page and the standing rule is that a page must not assert something
untrue.

**To push uniqueness higher, the owner's own knowledge is what is missing.**
Per city, these would each add genuinely unique content nothing else can supply:

- Which specific towns and neighbourhoods do you actually get called to most?
- Anything about working that area that surprises people?
- Which of the six markets sends the most insurance work? The most legal work?
- Any local landmark, road or access quirk that genuinely affects surveillance?
- Roughly how long is the drive from the Lynchburg office?

Answers go into the matching `PLACES` entry, not into the generated HTML —
`build-locations.py` is the source of truth and the committed HTML is its output.

---

## 3. Legal was the weakest-linked page on the site. Fixed.

It is the newest primary business line and it had: no link from any of the six
city pages, no `BreadcrumbList` schema (every sibling had one), sitemap priority
`0.5 / yearly` — the same as the vendor sub-page — and an H1 carrying none of its
own keywords. All four are corrected. Breadcrumbs matter here specifically:
they are one of the few rich results Google still draws, and they replace the raw
URL line in the listing.

---

## 4. Five descriptions were being truncated in results

Google shows roughly 155–160 characters. Insurance was 230 and legal 220, so on
both new pages the phone number at the end **never appeared in the result**. All
thirteen pages now fit, and the six city descriptions differ from each other
(each names what that locality covers) instead of being one sentence with a name
swapped.

---

## 5. Things that look like levers and are not

Worth knowing before spending money on any of them:

- **Review stars in search results.** Google stopped showing self-serving
  `LocalBusiness`/`ProfessionalService` review markup in 2019. Adding
  `AggregateRating` to our own pages produces no stars and risks a manual action.
  Real stars come from **Google Business Profile** reviews.
- **More FAQ schema.** Google restricted FAQ rich results to government and
  health sites in 2023. The FAQ *content* still earns "People also ask" placement
  and gets picked up by AI Overviews, so it is worth keeping and worth writing
  well — but the markup will not draw a rich result for this vertical.
- **`priority` and `changefreq` in the sitemap.** Google has said it ignores
  both. `lastmod` it does use, which is why that was added and why
  `CONTENT_REVISED` is a constant somebody edits rather than a build date.

---

## 6. The service-area hierarchy (owner, 2026-09-13)

| Level | Value |
| --- | --- |
| Primary umbrella | Central Virginia |
| Core local region | Greater Lynchburg Region |
| Core communities | Lynchburg, Forest, Rustburg, Bedford, Amherst, Appomattox, Altavista, Smith Mountain Lake / Moneta |
| Extended | Roanoke, Farmville, Danville, Charlottesville, Staunton, Waynesboro |

**Brand line:** *Serving Greater Lynchburg and Central Virginia since 2014.* The
old "serving all of Virginia" is retired and a deploy guard fails if it returns.
The region is never called the "Lynchburg Metropolitan Area".

**Radii differ by service, deliberately** — insurance runs roughly 100 miles from
Lynchburg, investigation and legal work travel across Central Virginia, and
**process service is a named list of markets**. Do not write one radius over all
three.

**Process markets** (and nowhere else): Lynchburg, Forest, Rustburg, Bedford,
Amherst, Appomattox, Altavista, Smith Mountain Lake / Moneta, Roanoke, Farmville.
**Not process markets:** Charlottesville, Danville — they keep every other
service, stay in the firm-wide `areaServed`, and **say the exclusion out loud**.

**Process service wording**, used on every page that offers it:

> Process service is available throughout Greater Lynchburg and nearby Central
> Virginia communities, with additional locations considered based on distance
> and availability.

The earlier "about an hour of Lynchburg" is retired: a hard travel-time number
invites argument about localities a few minutes either side of it.

**Exclusion wording**, on the two city pages that are not process markets — the
whole of what those pages say about process service, and never beside the
sentence above:

> Process service is not currently offered in this market. Other investigative
> services may still be available.

It deliberately offers no case-by-case door. Both sentences are picked by the
same `p["process"]` flag in `build-locations.py`, so the visible paragraph, the
visible FAQ and the FAQPage schema always answer together; a deploy guard fails
if the two copies of that FAQ ever disagree.

**Full service-area paragraph**, on the homepage and the service-area hub:

> Always Precise Investigations serves Lynchburg and surrounding Central Virginia
> communities, including Forest, Rustburg, Bedford, Amherst, Appomattox,
> Altavista, and the Smith Mountain Lake area. Process service is available
> throughout Greater Lynchburg and nearby Central Virginia communities, with
> additional locations considered based on distance and availability.

**Richmond is out** of every `areaServed` list. **Staunton and Waynesboro** stay
in the firm's `areaServed` as broader Central Virginia geography, carry no
process-service claim, and deliberately have **no city pages** — thin pages for
distant cities are the thing this site already consolidated away from.

Extended markets keep their pages and their coverage, and are never described as
Greater Lynchburg. `PLACES` carries a `region` field; the placement sentence is
composed from it.

**Open questions for the owner:** whether Charlottesville and Danville are inside
the process hour (both currently carry no process card), and whether Richmond
should stay in the homepage `areaServed` list — it is pre-existing, plausibly
Central Virginia, and was not in the owner's named extended list.

---

## 7. The biggest lever is not in this repository

For a local investigation firm the **map pack** drives most calls, and it is
driven by **Google Business Profile**: correct primary category, service areas
covering all six markets, the insurance and legal services listed as services,
photos, and a steady flow of reviews. The profile is already linked from the
pages as `GBP_URL`. Nothing in the code can move it — that is an account the
owner logs into.

## 8. The page map — who owns which search (2026-09-14)

Three pages could compete for *private investigator Lynchburg VA*, so each is
given one job. **The roles are enforced by the titles, not by intention.**

| Page | Primary intent | Owns | Title today |
| --- | --- | --- | --- |
| `/` | brand + regional entity | Always Precise Investigations, Greater Lynchburg, Central Virginia | Private Investigator Lynchburg VA \| Licensed PI Since 2014 |
| `/private-investigator/` | the service, region-wide | "private investigator near me", Central Virginia coverage | Private Investigator Near Me \| Central Virginia |
| `/private-investigator/lynchburg-va/` | local Lynchburg intent | cheating / surveillance in Lynchburg | Private Investigator Lynchburg, VA \| Cheating & Surveillance |

The homepage and the Lynchburg page both carry "Lynchburg" and are separated by
their TAILS — *Licensed PI Since 2014* is brand and trust, *Cheating &
Surveillance* is intent. That is a deliberate, narrow overlap: the homepage is
the entity, the city page is the query. **If a future unit makes those two tails
alike, the two pages start competing** — which is what §11 of the brief calls
cannibalization, and there is no automated guard for it because "these two
titles mean the same thing" is a judgement a test cannot make.

The six city pages, the hub and the four service pages each hold a distinct
title and description; a deploy guard fails if any two city pages collide.

**Where the Tier-1 communities are answered.** Forest, Rustburg, Madison
Heights, Amherst, Appomattox and Altavista have **no page of their own** — they
301 to `/private-investigator/lynchburg-va/` (see §9). That page is therefore
the one that has to answer for them, and it now does in three places: the
visible coverage sentence, the `areaServed` in its structured data, and the
redirect itself.

## 9. Do not rebuild the retired city pages without reading this first

`_redirects` carries the record: on **2026-08-10, 27 near-duplicate city pages
became 6 real markets**, and the comment states the evidence —

> Every page below earned **0 clicks from 195 impressions at avg position
> 37.5**, so the pages were costing crawl budget and diluting the surviving
> ones.

The pages 301'd into Lynchburg are exactly the Tier-1 towns: Forest, Madison
Heights, Rustburg, Amherst, Altavista, Brookneal and Appomattox.

**So "add a page for Forest" is not a new idea — it is an undo.** Recreating
them would remove redirects that currently consolidate signal into Lynchburg,
rebuild pages that measurably earned nothing, and dilute the page §10 of the
brief says must stay strongest.

And the duplication problem is still live. Measured 2026-09-14 over main
content with the city name normalised out, header and footer stripped: the six
surviving pages share **78–87% of their sentences** — unique main content is
**13–22%**. Five more pages off the same template makes that worse, not better.

The honest way to win those towns is the one the architecture already supports:
**strengthen the page they redirect to.** That is what this unit did.

## 10. Google Business Profile — the owner's checklist

**Nothing in this repository can change GBP, and nothing here has.** This is a
list for Corey, in an account only Corey can sign into. It matters more than
anything in this file for *private investigator near me*, because the map pack
is driven by GBP rather than by the website.

- [ ] **Primary category: Private Investigator.** One primary; do not stack
      near-synonyms as additional categories unless they are real services.
- [ ] **Service area, not a street address.** This is a service-area business —
      the site deliberately publishes no residential address, and GBP should be
      set the same way. List the real markets: Lynchburg, Forest, Rustburg,
      Madison Heights, Amherst, Appomattox, Altavista, Bedford, Moneta / Smith
      Mountain Lake, and Roanoke and Farmville as the wider two.
- [ ] **Services list = the real services only** — surveillance, infidelity,
      child custody documentation, background checks, insurance claim
      investigation, legal investigation support, process service, person
      locate. Nothing the site does not offer publicly.
- [ ] **Hours** matching the site's structured data (07:00–22:00 daily).
- [ ] **Phone (434) 907-0975 and the website URL**, character-for-character the
      same as the site, so the entity resolves to one business.
- [ ] **Reviews: ask real clients, honestly.** Never incentivise, never write
      one, never post on a client's behalf. Given the work, many clients will
      not want to be publicly associated with it — a smaller number of genuine
      reviews is the only acceptable outcome here.
- [ ] **Posts / photos** are optional and low-priority next to the four above.

Do not invent an office location, a second city address, or an award.

## 11. Search Console — the owner's checklist

Still the first gap (§1): **there is no search data in this repository**, so
nothing in this file may be read as a ranking claim.

- [ ] **Verify the property by DNS TXT.** Not the HTML-file method — the stager
      fails the build when a manifest path is missing, so a placeholder entry
      for `google<token>.html` would freeze every deploy until the real file
      landed. §1 explains this at length.
- [ ] **Submit** `https://alwayspreciseinvestigations.net/sitemap.xml`.
- [ ] **URL-inspect and request indexing**, in this order, after this unit:
      1. `/` (title, description and social metadata changed)
      2. `/private-investigator/lynchburg-va/` (coverage sentence + areaServed)
      3. `/legal-investigations/` and `/insurance-investigations/` (new links)
      4. the remaining four city pages (areaServed only)
- [ ] **Watch these query families** in Performance, 28-day, Virginia filtered:

      private investigator near me           private investigator Lynchburg VA
      private investigator Bedford VA        private investigator Forest VA
      private investigator Rustburg VA       private investigator Amherst VA
      private investigator Madison Heights   private investigator Appomattox VA
      private investigator Central Virginia  surveillance investigator Lynchburg VA
      infidelity investigator Lynchburg VA   child custody investigator Lynchburg VA

- [ ] **Check the Tier-1 towns specifically.** Forest, Rustburg, Madison
      Heights, Amherst, Appomattox and Altavista have no page of their own by
      design (§9). If any of them shows impressions on the Lynchburg page,
      that is the redirect working. If one shows real impressions and a poor
      position for months, THAT is the evidence that would justify reopening
      the §9 decision — and it is the only thing that should.

**The distinction this file is held to** (brief §40):

| | |
| --- | --- |
| **Known** | the repository, the markup, the redirects, the measurements above |
| **Inferred** | which queries are likely worth having — reasoned, not observed |
| **Unknown until Search Console** | impressions, clicks, average position, CTR — every one of them |

No ranking, traffic or click claim appears anywhere in this file, because none
could be supported.

## 12. The first real Search Console data, and what it actually showed (2026-09-14)

**§1 of this file has said since it was written that there is no search data in
this repository. There is now, for one query, and it changed a decision.**

| | |
| --- | --- |
| Query | `cheating spouse investigations virginia` |
| Last 28 days | **67 impressions, 0 clicks, average position 27.3** |
| Attributed to | **63 of 67 on `/private-investigator/bedford-va/`** |

**THE OBVIOUS READ WAS WRONG.** "Google picked the wrong page, so the Infidelity
page must be missing the keywords" — except that page's H1 was *literally*
"Cheating Spouse Investigations in Virginia", the query almost verbatim. A page
holding the exact phrase was losing to a city page. So the gap was never
vocabulary, and adding more of it would have been keyword-stuffing a page that
already had the words.

**WHAT THE AUDIT FOUND INSTEAD, and it is the durable lesson: the city pages'
only link to the Infidelity page was in the FOOTER.** Anchor text "Infidelity",
in the row beside Privacy. Meanwhile Bedford carries a *Cheating & infidelity*
card, an *Adultery evidence for divorce* card and an adultery FAQ — 26
cheating-related terms in all. It is a place page that is also a substantial
cheating-spouse page, **and it pointed nowhere better**. A boilerplate footer
link is not a topical signal; Google had no reason to prefer the authority page
because nothing on the topically-rich page said one existed.

So the fix was a contextual link from the card that is already about that
topic, with an anchor naming the city — six links that differ from each other
rather than one sentence repeated six times.

**THE SECOND FINDING WAS GEOGRAPHY, AND IT WAS A STANDING INCONSISTENCY.** The
Infidelity page's title, H1 and description all said flat **"Virginia"** — the
statewide framing five units have removed everywhere else, still sitting on a
primary service page. Its own H2 already said *Serving Greater Lynchburg and
Central Virginia*, so the page disagreed with itself. The geography did not get
deleted from the headline so much as MOVED to where it can be specific.

| | before | after |
| --- | --- | --- |
| Title | Cheating Spouse & Adultery Investigator in Virginia | Infidelity & Cheating Spouse Investigator \| Lynchburg VA |
| H1 | Cheating Spouse Investigations in Virginia | Infidelity & Cheating Spouse Investigations |

**BEDFORD WAS NOT TOUCHED, AND THAT WAS THE POINT.** It is the page currently
earning the impressions; retargeting or thinning it would destroy the only
measured asset in this whole exercise to chase a page with none. Its title, H1,
canonical and all 26 cheating-related terms are unchanged — it gained one line,
the contextual link.

**67 IMPRESSIONS IS ENOUGH TO ALIGN A QUERY TO A PAGE AND NOT ENOUGH TO REBUILD
ANYTHING.** No page was created, no URL changed, no city page retargeted. What
to watch next is whether the attribution moves from Bedford to
`/infidelity-investigations/` and whether position 27.3 changes — **and that is
a question only Search Console can answer**, not this file.


## 13. Child custody is now the authority page for its own intent (2026-09-14)

Owner brief: make `/child-custody-investigations/` the clear primary page for
child-custody investigation intent, **without** damaging the local city pages
or the other service pages. **There is no Search Console data for this query
family yet** — this is the infidelity unit's diagnosis applied ahead of the
data, not a response to a measured loss.

**THE PAGE HAD THE SAME TWO DEFECTS THE INFIDELITY PAGE HAD.**

**One — its geography was flat "Virginia", and its H2 disagreed with its H1.**
Title, H1 and the `Service` schema all said *Virginia* or *Central Virginia*
while the section heading said *"Serving all of Central Virginia and beyond"* —
an unbounded claim of exactly the shape five units have removed elsewhere.
**"Greater Lynchburg" appeared zero times on the page**, and "Lynchburg" twice,
both inside a city-links row. The page selling custody work in the firm's core
region named that region nowhere.

| | before | after |
| --- | --- | --- |
| Title | Child Custody Investigator Virginia \| Court-Ready Evidence (58) | Child Custody Investigator & Surveillance \| Lynchburg VA (56) |
| H1 | Child Custody Investigations in Virginia | Child Custody Investigator in Lynchburg & Central Virginia |
| Description | Contested custody? Licensed Virginia investigators document parenting time, exchanges and the child's environment. Free consult: (434) 907-0975. (144) | Child custody investigations in Greater Lynchburg and Central Virginia. Licensed, discreet documentation of parenting time and exchanges. (434) 907-0975. (153) |
| H2 | Serving all of Central Virginia and beyond | Serving Greater Lynchburg and Central Virginia |
| `Service.areaServed` | Central Virginia | Greater Lynchburg + Central Virginia |

**"COURT-READY" CAME OUT OF THE TITLE BECAUSE IT WAS THE GENERIC USE.** All
three occurrences on the page were `title` / `og:title` / `twitter:title` —
metadata, not family-court reporting copy. The brief rules out the generic use
and keeps the genuine legal-context ones, which is what the Legal page, the
homepage's legal `Offer` and the Infidelity page's reporting line still carry
untouched.

**TWO — THE ONLY LINK FROM THE SIX CITY PAGES WAS THE FOOTER.** Identical
shape to the infidelity finding, and identically invisible to the orphan guard,
which answered "linked" throughout. Each city page carries a **Child custody**
card; that card now carries the one contextual link, with a city-named anchor
so the six differ from each other. The hub's *What we handle* paragraph already
had the words *child-custody evidence* sitting unlinked beside a linked
insurance phrase — that phrase is the link now.

**AND THE GUARD WRITTEN FOR THIS FOUND THAT THE INFIDELITY UNIT HAD MISSED THE
HUB.** The new assertion is a CLASS over both consumer authority pages —
*every local page links to it from its BODY, not only its footer* — and it went
red on `/private-investigator/` for infidelity on its first run. One phrase was
linked; the guard was not narrowed. This is why the property is written as a
class rather than as the one link the brief asked for.

**WHAT WAS DELIBERATELY NOT DONE.** No duplicate custody page, no city-by-city
custody doorway pages, no URL or canonical change, no city page retargeted away
from *private investigator + location*, no change to the process-service
geography, and no legal conclusion or custody-outcome promise added to the copy.

**QUERY FAMILIES TO WATCH IN SEARCH CONSOLE** (none of these has data yet):

- `child custody investigator lynchburg va`, `child custody private investigator virginia`
- `custody surveillance lynchburg`, `private investigator for custody case`
- `prove parent unfit virginia investigator`, `child custody evidence private investigator`
- `custody exchange documentation investigator`
- and the attribution question the infidelity unit raised: whether these land on
  `/child-custody-investigations/` or get absorbed by a city page.


### The page now has a door into the intake (2026-09-14, same day)

The authority work above is discovery; this is what happens after it. The
`.cta` box carries **Request a Child Custody Investigation** →
`/intake/?assignment=private&service=custody`, beside the unchanged Call button.

**IT IS THE FIRST SERVICE PAGE ON THIS SITE WITH AN INTAKE LINK.** Every other
one ends at the phone number, and the homepage's three door cards were the only
public links into `/intake/`. That is worth watching rather than copying: if
this page's own conversion behaves differently from Infidelity's, the phone-only
CTA on the other service pages is the variable, and **that comparison needs
Search Console and the office's own record of where enquiries came from** — it
cannot be read off this repository.

## 14. Insurance becomes a local authority page, and the statewide lines go (2026-09-24)

Owner brief 2026-09-24, *"Overnight local SEO + insurance adjuster assignment
UX — Greater Lynchburg / Central Virginia only."* **No ranking, traffic or click
claim is made here, because none can be.** What follows is what changed in the
markup and why; §11's distinction between known, inferred and unknown still
governs every line.

### The baseline, captured before anything moved

Every priority page was measured first — title, H1, description, canonical,
robots, structured-data types, `areaServed`, internal and intake links, and
main-content words — and the same instrument was run afterwards. **The
homepage and the PI hub did not move at all**, Infidelity and Custody kept their
title, H1, description and FAQ, and no canonical or robots value changed
anywhere on the site.

| Page | What changed | What did not |
| --- | --- | --- |
| `/insurance-investigations/` | title *Insurance Investigations & Surveillance in Virginia* → *…\| Lynchburg VA*; H1 *Insurance Investigation Services That Deliver Results* → *Insurance Investigations & Surveillance in Central Virginia*; description names Greater Lynchburg and Central Virginia and ends in the phone number; `areaServed` added (it had none); FAQ 11 questions, visible and schema from one list | URL, canonical, the 100-mile coverage statement the owner approved on 2026-09-13 |
| `/insurance-investigations/vendor-information/` | *Serving Virginia since* row and footer → Greater Lynchburg and Central Virginia; `areaServed: State Virginia` → the regions and markets the page names; a body link to the Insurance page; both buttons read *Submit an Insurance Assignment* | title, H1, description, the travel terms (see Owner review) |
| `/legal-investigations/` | title → *Legal Investigator for Law Firms & Attorneys \| Lynchburg VA*; H1 → *…in Lynchburg and Central Virginia*; description and social tags de-statewided; `areaServed: State Virginia` → the regions it names; the process offer carries the eleven process markets instead of inheriting the state; the billing FAQ says *retainer or flat fee* | URL, every CTA, no figure anywhere, the flat-fee unit's own wording |
| six city pages | the insurance and legal links name the city (*How we work insurance claims in Bedford*, *How we support law firms in Bedford*), and the carrier button reads *Submit an insurance assignment* | titles, H1s, descriptions, schema, every other sentence — Bedford included |
| Infidelity, Custody | the footer's *Serving Virginia since 2014*; Infidelity's og/twitter titles, which still said *…in Virginia* under a page title that said Lynchburg | title, H1, description, FAQ, links |

### Why the Insurance page, and why its H1 was allowed to move

The owner's own intent map gives `/insurance-investigations/` the insurance
authority role, and its H1 was the one on the site carrying **no service noun,
no geography and no search term at all** — a slogan. The homepage H1 is pinned
by the owner; this one was not, and no Search Console data exists for the
insurance query family, so there was no measured asset to protect. The title,
H1, description and schema now say *insurance investigations*, *Lynchburg* and
*Central Virginia* once each, in sentences, with no city list stuffed into a
title.

### The statewide lines were a CLASS, and it was hiding in three shapes

The 2026-09-13 guard caught *"serving all of Virginia"* and missed its shorter
sibling, *"Serving Virginia since 2014"*, which was still the footer of four
pages and a row of the vendor table. The same claim was in **structured data**
on two pages as `areaServed: {State: Virginia}` — on the Legal page beside a
process-service offer with no geography of its own, so the schema offered
process service statewide while the visible copy carried the approved coverage
sentence. And it was in **social titles**, where a shared link said *in
Virginia* under a page title that said Lynchburg. Three deploy guards now hold
each shape as a class over the staged bytes.

**Licensing stays statewide on purpose.** *Va DCJS #11-9159*, *Licensed
Virginia investigators* and Virginia law are facts about the licence and the
law, not claims about where the firm travels, and none of them was touched.

### Links — the infidelity lesson applied to the two B2B pages

The city pages already linked the Insurance and Legal pages from their bodies;
the anchors said *How we work claims* and *How we support counsel* on all six,
one sentence repeated. They now name the city, the way the infidelity and
custody links do, so the six differ. The body-link class guard now covers
`/insurance-investigations/` and `/legal-investigations/` as well, so the next
rewrite of the city template cannot move them into the footer unnoticed.

### What was deliberately not created

No insurance-city or legal-city page, no *near me* page, no rebuilt retired city
page (§9 still holds, and `_redirects` is untouched), no new URL of any kind.
The sitemap is the same thirteen URLs; `CONTENT_REVISED` moved to 2026-09-24
because city-page content changed, with the one-constant imprecision recorded
in CLAUDE.md.

### Google Business Profile — alignment to recommend (nothing here changed GBP)

The §10 checklist stands. What this unit adds:

- **Primary category stays Private Investigator.**
- **Service area: Greater Lynchburg plus the nearby Central Virginia markets the
  site names** — Lynchburg, Forest, Rustburg, Madison Heights, Amherst, Bedford,
  Appomattox, Altavista, Moneta / Smith Mountain Lake, Roanoke, Farmville. No
  statewide area.
- **Services: list Insurance Investigations** — it is a real, published service
  with its own page, accepted from carriers, TPAs, self-insured employers and
  defense counsel — alongside the ones §10 already names. Nothing the site does
  not offer publicly, and **no recorded statements, canvassing, interviewing or
  social-media investigation**, which the site withdrew on 2026-08-21.
- **No residential street address**, as §10 says.

### Search Console — the watch list for this unit

Watch 28-day Performance, Virginia filtered, for these families. Each maps to the
page that owns the intent; a query landing on a different page is the §12
diagnosis to run again, not a reason to add a page.

| Family | Queries | Owner page |
| --- | --- | --- |
| Private | private investigator Lynchburg VA · private investigator Bedford VA · private investigator Forest VA · private investigator Rustburg VA · private investigator Amherst VA · private investigator Madison Heights VA · private investigator Appomattox VA · private investigator near me | homepage, `/private-investigator/lynchburg-va/`, `/private-investigator/bedford-va/`; the Tier-1 towns resolve to Lynchburg by design (§9) |
| Insurance | insurance investigator Lynchburg VA · insurance investigations Lynchburg VA · insurance claim investigator Lynchburg · workers comp investigator Lynchburg VA · insurance surveillance Lynchburg VA · insurance investigator Bedford VA · insurance investigator Roanoke VA · insurance investigator Central Virginia | `/insurance-investigations/` |
| Legal | legal investigator Lynchburg VA · investigator for law firms Lynchburg VA · legal investigations Central Virginia | `/legal-investigations/` |
| Child custody | child custody investigator Lynchburg VA · private investigator child custody Lynchburg | `/child-custody-investigations/` |
| Infidelity | infidelity investigator Lynchburg VA · cheating spouse investigator Lynchburg VA | `/infidelity-investigations/` (Bedford keeps its measured *cheating spouse investigations virginia* traffic, §12) |

**URL-inspect and request indexing** after this merge, in this order:
`/insurance-investigations/`, `/legal-investigations/`,
`/insurance-investigations/vendor-information/`, then the six city pages.

### Owner decisions on the review items (2026-09-24, same day)

- **Vendor page geography.** The coverage lede's *"an hour's drive of
  Lynchburg"* became the Insurance page's footprint: *"Insurance assignments are
  accepted within roughly 100 miles of Lynchburg, Virginia, including Central
  Virginia and surrounding markets"*, with the published carve-out kept (travel
  beyond it is quoted before accepting). Process service is not mentioned there.
  A deploy guard holds both carrier pages to the footprint and no public page to
  a drive time.
- **References** came off the vendor packet — nothing on record supports it.
  A guard fails on any public references offer.
- **Homepage claims card** reads *Submit an Insurance Assignment* and goes to
  the carrier door. **Watch item:** that was the homepage's one contextual BODY
  link to `/insurance-investigations/`; the page is still linked from the
  homepage navigation and from every city page's body. If the Insurance family
  in the watch list above softens after this, a body link from the homepage is
  the first thing to put back — an owner call, since the card's wording is the
  owner's.
- **Referral upload** stays unbuilt, and **claimant phone** stays out of the
  form. Neither is an SEO change; both are recorded in `CLAUDE.md`.
