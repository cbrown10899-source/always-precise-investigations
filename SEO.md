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
**process service is about an hour of Lynchburg**. Do not write one radius over
all three.

**Process service wording**, used on every page that offers it:

> Process service is available throughout the Greater Lynchburg region and
> surrounding Central Virginia communities, generally within about an hour of
> Lynchburg. Contact us to confirm availability for locations farther out.

**Full service-area paragraph**, on the homepage and the service-area hub:

> Always Precise Investigations serves Lynchburg and surrounding Central Virginia
> communities, including Forest, Rustburg, Bedford, Amherst, Appomattox,
> Altavista, and the Smith Mountain Lake area. Process service is generally
> available throughout this Greater Lynchburg region, with additional locations
> considered based on distance and availability.

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
