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

