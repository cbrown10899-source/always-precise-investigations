# Local SEO, traffic, conversion and competitor-pricing audit — November 2026

**Internal. Not published** — `docs/` matches no line of
`.github/deploy-manifest.txt`, and the deploy suite refuses every `.md`.

Audit date: **2026-11-07**. Live site checked at build `65810ca`
(`/.well-known/build.txt`, built 2026-11-05).
**Nothing was changed on the site, in pricing, in the intake, or in the portal.**
This file is findings and recommendations only, for the owner to decide on.

Every finding carries one of three labels:

| Label | Meaning |
| --- | --- |
| **CONFIRMED** | Measured or read directly from the repo or the live site in this audit |
| **LIKELY, UNVERIFIED** | Reasoned from confirmed facts, but its effect on clicks or inquiries is not measured |
| **NEEDS DATA** | Cannot be answered without data this audit could not reach |

---

## 1. Executive summary

1. **Nobody can say yet whether Google clicks fell — the data is not in reach.**
   There is no Search Console connector in this session, and the repository holds
   one Search Console data point ever (SEO.md §12, 2026-09-14). The owner already
   has Search Console (they supplied that figure), so the answer is a
   15-minute export away. §14 gives the exact steps. **NEEDS DATA.**

2. **The 2026-10-10 redesign (#351) removed the printed phone number from the
   header on every page.** Before it, every page's header had
   `Call (434) 907-0975`. After it, **a desktop visitor landing on a city or
   service page sees no phone number and no call or intake button anywhere in the
   first screen** — measured at 1366×768 on all eight landing pages tested. Phones
   gained a sticky Call / Intake bar, so the phone experience improved while the
   desktop one regressed. **CONFIRMED** (the change); the effect on calls is
   **LIKELY, UNVERIFIED**.

3. **The redesign also replaced the homepage H1.** It was *"Private Investigator &
   Surveillance Services in Lynchburg and Surrounding Areas"* (set deliberately by
   #324 on 2026-09-14). It is now *"When you need answers, start here."*, which
   carries no service and no place. The title tag is unchanged. That is the only
   content change to an indexed page in the redesign: city and service pages
   changed only their shared header and footer. **CONFIRMED** (the change); the
   ranking effect is **NEEDS DATA**.

4. **The only written route to the firm from a landing page is the full private
   intake**, which ends in an agreement, a typed legal name and a drawn signature
   (step 5 of 5) before anything reaches the office. The short "Send a Message"
   form exists on the homepage only. **CONFIRMED** (structure); whether visitors
   abandon there is **NEEDS DATA**. The Live Visitors database records intake
   opened, started and submitted, and the owner can read it.

5. **Credibility on the page is dated.** The three reviews on the homepage are
   from Aug 2018, Jan 2019 and Mar 2019, with no count and no newer review.
   **CONFIRMED.**

6. **Competitor pricing is almost never published locally.** None of the
   Lynchburg, Forest, Bedford or Roanoke firms found publishes an hourly rate or
   a retainer in what search surfaced. The nearest published Virginia rate is a
   Chesapeake firm at **$100/hr cash, $125/hr otherwise, 4-hour minimum, no
   travel charge**, which is the same structure as ours. Our pricing therefore
   cannot be called above or below the *local* market on evidence; against the
   one comparable published Virginia rate it is **comparable**. No pricing
   change is recommended.

7. **The technical SEO base is healthy.** HTTPS redirect, canonicals, sitemap
   (13 URLs), the 2026-08-10 consolidation redirects, structured data, internal
   links (195/195 deploy checks pass) and phone page speed (LCP under 1 s in lab
   tests) are all fine. Three small defects are listed in §11.

**The two cheapest, lowest-risk changes with the most direct bearing on
inquiries** are restoring a printed phone number in the header and putting a
call/intake pair into the hero of each landing page (recommendations 1–2). Both
touch only presentation, not URLs, titles or content, so their risk to rankings
is near zero.

---

## 2. Google click-loss findings

**NEEDS DATA — and this is the most important limitation in the report.**

What was reachable, and what was not:

| Source | Status in this audit |
| --- | --- |
| Google Search Console | **Not available.** No connector is installed (`ListConnectors` returned none), and no credentials exist in the repo |
| Google Analytics / Tag Manager / Clarity | **None installed** on the site (grep of the public pages) |
| Live Visitors (`api-visitor-journeys` D1) | Exists, but its database is on the owner's Cloudflare account and **not reachable from this session**. It records landing page, referrer and intake funnel steps, which is exactly what goal 3 needs |
| `/watch/` dashboard | Passcode- and Face ID-gated; owner only |
| Repository history | Available: the deployment timeline below |

**No ranking, click or impression figure appears in this report, because none
could be supported.**

### Deployment timeline to lay against the Search Console graph

When the owner opens Search Console → Performance, these are the dates where
something on the site changed. A decline that **starts on one of them** points at
it; a decline that **starts somewhere else** points away from the site.

| Date | Change | Search-relevant? |
| --- | --- | --- |
| 2026-08-10 | 27 near-duplicate city pages consolidated to 6 (301s in `_redirects`) | Yes, deliberate, evidenced (0 clicks / 195 impressions on the retired pages) |
| 2026-09-12 → 09-15 | SEO units #315–#331: city-page de-duplication, service-area wording, homepage H1 with service and place, Infidelity and Custody authority pages | Yes |
| 2026-09-24 | #339/#340: Insurance local page, vendor page, statewide wording removed; sitemap `lastmod` set to this date | Yes |
| **2026-10-10** | **#351 public redesign**: new shared header/footer on 15 pages, **header phone number removed**, **homepage H1 and hero replaced**, homepage main copy 817 → 649 words | **Yes — the prime candidate if a drop starts here** |
| 2026-10-27 | #360: email address line-break fix | No |

### Google updates in the window

From secondary SEO sources (search result summaries, not Google's own page —
confirm on the [Google Search Status Dashboard](https://status.search.google.com/)):

- **May 2026 core update**, 21 May → 2 June 2026
  ([Search Engine Journal](https://www.searchenginejournal.com/google-begins-rolling-out-may-2026-core-update/575589/),
  [SER](https://www.seroundtable.com/google-may-2026-core-update-done-41435.html)).
- Spam updates reported in June, August and September 2026, one said to finish
  8 October 2026 ([dataslayer](https://www.dataslayer.ai/blog/google-core-update-december-2025-what-changed-and-how-to-fix-your-rankings),
  [intelegencia](https://www.intelegencia.com/blog/seo/google-core-updates-2026-what-changed-with-every-update-this-year-and-how-to-recover-your-rankings)).
- **No confirmed core update in September, October or November 2026** in the
  sources found.

**Correlation caution.** The redesign went live two days after a reported spam
update ended. If Search Console shows a drop around 8–12 October, the two are
not separable by date alone. Separate them by **which pages** lost: a spam or
core update tends to move many pages at once; the redesign changed indexed
*content* only on the homepage, so a homepage-only loss points at the redesign,
and a city-page loss points elsewhere (or at the header change, which affects
behaviour more than ranking).

---

## 3. Search query performance

**NEEDS DATA.** The only query-level data ever recorded (SEO.md §12):

| Query | Period | Impressions | Clicks | Avg position | Page |
| --- | --- | --- | --- | --- | --- |
| cheating spouse investigations virginia | 28 days to 2026-09-14 | 67 | 0 | 27.3 | 63 of 67 on `/private-investigator/bedford-va/` |

That is not enough to judge a trend. The query families to export are already
listed in SEO.md §11; §14 below says how.

---

## 4. Local market visibility

### What was checked, and how

The research tool used here is **not Google** and reports no Google positions,
so **its result order is not quoted as a ranking anywhere in this report.** It
was used only to find who competes.

For the query *private investigator Lynchburg VA*, the results returned
(unordered for our purposes): our homepage, **our Facebook page**, Superpages
and Yelp category pages, Mayhem Solutions Group's Lynchburg page, Morse PI,
TSIS (1tsis.com), Bond Investigations' Lynchburg page and Privin's Lynchburg page.

**Directories and aggregators occupy much of the space.** Superpages, Yelp,
BBB category pages, Thumbtack, Privin, eInvestigator and Bark repeatedly
surfaced for every town query. For *Forest*, *Bedford*, *Danville* and
*Farmville* the tool found **no investigator based in the town itself**. That
means the town queries are being answered by Lynchburg and Roanoke firms and by
directories — which is consistent with SEO.md §9's decision to win those towns
through the Lynchburg page rather than rebuild town pages. **LIKELY, UNVERIFIED**
until Search Console shows town-query impressions.

### Google Business Profile and Maps

**NEEDS DATA.** The profile (`maps.google.com/?cid=1285488950812777376`) could
not be opened from this session. One consistency problem is **CONFIRMED in the
repo**:

- `build-locations.py` says the site's structured data carries the NAP *"exactly
  as it appears on the Google Business Profile"*, and 13 public pages publish
  `503 Old Plantation Dr #303, Lynchburg, VA 24502` in structured data (the
  vendor page prints it as "Principal office").
- **SEO.md §10 tells the owner to run the profile as a service-area business with
  no street address**, and the visible pages show no address.

Those two internal records cannot both be right. If the profile hides the
address while 13 pages assert one in schema, the citation is inconsistent; if
the profile shows it, SEO.md §10 is out of date. **The owner should check the
profile and say which is true** — the fix is one constant either way.

### Reviews and reputation

| Source | What was seen | Label |
| --- | --- | --- |
| Homepage | 3 Google reviews shown, dated Aug 2018, Jan 2019, Mar 2019; no count, no newer review | CONFIRMED |
| Thumbtack ([listing](https://www.thumbtack.com/va/lynchburg/private-investigators/always-precise-investigations-llc/service/217090138032014364)) | 4.9 from 41 reviews, reviews dating to 2016 — **from a search snippet; the page itself could not be opened** | LIKELY, UNVERIFIED |
| Google rating | Not reachable | NEEDS DATA |
| Facebook, Yelp, BBB | Blocked by this session's network policy | NEEDS DATA |

---

## 5. Competitor comparison

**How "verified" is used here.** Every competitor site, directory, Thumbtack,
BBB, Yelp and Facebook page was **blocked by this session's network policy**, so
no competitor page was opened directly. Everything below comes from search-result
text, dated 2026-11-07, with the source URL. Treat each row as *listed in the
search index*, not *confirmed by visiting*. To upgrade a row, open its source
URL.

### Greater Lynchburg and surrounding markets

| # | Business | Where / area | Website or source | Price published? | Differentiators seen |
| --- | --- | --- | --- | --- | --- |
| 1 | **Track Surveillance & Investigative Services (TSIS)** | 519 Leesville Rd Ste E, Lynchburg 24502 | [1tsis.com](https://www.1tsis.com/), [detectivedirect](https://www.detectivedirect.com/detective/track-surveillance-and-investigative-services-tsis/519-leesville-rd-suite-e-24502-lynchburg-virginia-united-states) | NOT DISCLOSED | Two retired Lynchburg PD captains (53+ yrs police); lists infidelity, child custody, surveillance, GPS tracking, process service; formed late 2021. **The most direct local competitor found** |
| 2 | **Blue Ridge Private Investigations** | Lynchburg (Langhorne Rd) and Forest (Forest Rd), per a directory | [Claims Pages](https://www.claimspages.com/providers/virginia-detective-investigators-and-security-inc-4345288024/) | NOT DISCLOSED | Two local addresses; no website found |
| 3 | **Desert Eagle Investigations, LLC** | 3831 Old Forest Rd Ste 6, Lynchburg; NC and VA | [BBB Forest category](https://bbb.org/us/va/forest/category/investigator) | NOT DISCLOSED | BBB A+, not accredited (per listing) |
| 4 | **First Defense Security and Investigations, Inc.** | 5521 Fort Ave, Lynchburg; lists Amherst, Appomattox, Bedford, Campbell, Lynchburg, Danville, Pittsylvania | [BBB Lynchburg category](https://bbb.org/us/va/lynchburg/category/investigator), [Superpages](https://www.superpages.com/lynchburg-va/security-guard-patrol-service) | NOT DISCLOSED | Security-guard firm that also investigates; 9 yrs listed |
| 5 | **Private Investigations by Jeff Spar, LLC** | 101 Church Ave SW, Roanoke; BBB area includes Bedford County | [Thumbtack](https://thumbtack.com/va/roanoke/process-servers/private-investigations-by-jeff-spar-llc/service/529813229188718597), [NAPPS](https://napps.org/process-servers/Virginia/Roanoke) | **QUOTE REQUIRED** ("contact for price" on Thumbtack) | "Attorney choice" for 30+ years; process service focus; BBB 5 stars from 7 reviews |
| 6 | **Executive Security Concepts** | Roanoke / Daleville; press releases name Lynchburg | [executivesecurityconcepts.com](https://www.executivesecurityconcepts.com/investigators-detectives/), [press release](https://markets.financialcontent.com/worldnow/article/releasewire-2023-3-23-executive-security-concepts-offers-services-of-trained-private-detectives-in-blacksburg-and-lynchburg-virginia) | NOT DISCLOSED | Infidelity, custody, insurance fraud; heavy press-release marketing |
| 7 | **Morse Investigation Services** | Statewide; names Lynchburg and Roanoke | [morsepi.com](https://morsepi.com/) | NOT DISCLOSED | Claims DCJS licence, 22+ yrs; self-published 4.9 from 47 reviews (site markup, unverified) |
| 8 | **Bond Investigations** | Lynchburg landing page | [bondinvestigations.com/…/lynchburg](https://bondinvestigations.com/virginia-private-investigator-detective/lynchburg/) | NOT DISCLOSED | Out-of-area firm with a city page |
| 9 | **Ingram Investigations, Inc.** | BBB lists Bedford County and Danville/Pittsylvania; address unclear | [BBB Java category](https://www.bbb.org/us/va/java/category/investigator) | NOT DISCLOSED | Listing too ambiguous to rely on |
| 10 | **Privin Network** | Lynchburg, Forest and Roanoke pages | [privin.net/…/lynchburg](https://privin.net/private-investigator/virginia/lynchburg.php), [Forest](https://privin.net/private-investigator/virginia/forest.php) | ESTIMATED / THIRD-PARTY: "$300–$3000 or higher", plus "travel, mileage and report writing" fees | A referral network rather than a local firm; self-published 5.0 from 8 reviews |
| 11 | **Upscale Security LTD** | 1982 Arlington Blvd, Charlottesville | [PInow](https://www.pinow.com/moreinfo/upscale-security-ltd/10460) | NOT DISCLOSED | Free consultation offered |
| — | **Mayhem Solutions Group** | Has a Lynchburg page | [mayhemsolutionsgroup.com/…/lynchburg](https://mayhemsolutionsgroup.com/private-investigator/virginia/lynchburg.html) | NOT DISCLOSED | **Flag, not a peer:** the [SPLC](https://www.splcenter.org/resources/hatewatch/extremist-group-illegally-promotes-security-services-across-us) reports complaints and judgements for advertising unlicensed investigation services. It occupies a result slot for our main query |

Searches for *Hill City Investigations* and a separate Forest-based Thumbtack
listing found nothing that could be confirmed, so neither is included.

### Our differentiators against this field (from our own pages)

Licensed and insured with the DCJS number shown; 12 years in the market (since
2014); separate doors for private, legal and insurance clients; **no mileage or
travel charge inside the service area**, stated on every city page; free
confidential consultation; written terms before work starts. **TSIS's ex-police
credential is the strongest competing trust claim found locally.**

---

## 6. Published competitor pricing

| Business | Where | Figure | Classification | Source |
| --- | --- | --- | --- | --- |
| Blueline Investigative Services | Chesapeake, VA (Hampton Roads — **not local**) | **$100/hr cash, $125/hr other methods; 4-hour minimum per callout; no travel or mileage**; callout from $400 cash / $500 otherwise. Background, records and locate as package prices | **PUBLISHED by the firm** (seen in search text of its own page; page not opened here). Yelp shows a conflicting $170/$125 | [bluelineinvestigations.com cost page](https://www.bluelineinvestigations.com/private-investigator-cost-virginia/), [Yelp](https://www.yelp.com/biz/blueline-investigative-services-chesapeake) |
| Tradewinds Investigations | Virginia (location not confirmed) | $200/hr for Virginia investigative services | PUBLISHED by the firm (search text) | [tradewindsinvestigations.com](https://www.tradewindsinvestigations.com/retainerfees/tradewinds-investigative-services-hourly-rate) |
| American Investigation Services LLC | Carrollton, VA (Hampton Roads — **not local**) | Surveillance $45/hr; live GPS $100 per 24 h; background screening $75 | PUBLISHED on the firm's Thumbtack listing | [Thumbtack](https://www.thumbtack.com/va/carrollton/private-investigators/american-investigation-services-llc/service/293072722526421075) |
| Private Investigations by Jeff Spar | Roanoke | "Contact for price" | QUOTE REQUIRED | [Thumbtack](https://thumbtack.com/va/roanoke/process-servers/private-investigations-by-jeff-spar-llc/service/529813229188718597) |
| Privin Network | Forest page | $300–$3,000+ by depth of service, plus travel, mileage, report-writing fees | ESTIMATED / THIRD-PARTY | [privin.net Forest](https://privin.net/private-investigator/virginia/forest.php) |
| Thumbtack national guide | US | $70–$210/hr average range | ESTIMATED / THIRD-PARTY | [Thumbtack cost guide](https://thumbtack.com/p/private-investigators-cost) |
| All other firms in §5 | — | — | NOT DISCLOSED | — |

**Excluded on purpose:** a "$100 consultation / $1,500 retainer" figure that one
search attributed to a *Forest, VA* Thumbtack listing. A second search placed it
in a **Fredericksburg** Thumbtack guide. It was misattributed and is not used.
Investigator **wages** found in job postings (Lynchburg $20–25/hr, Roanoke
~$26/hr) are not client prices and are not compared.

---

## 7. Our pricing position

Ours (portal, never public): **$100/hr, 4-hour minimum per surveillance day
(6- and 8-hour options per send), retainer configurable $1,600–$4,000**, no
mileage or travel charge in the service area.

| Comparison | Finding | Label |
| --- | --- | --- |
| Against **local** published rates | **No local firm publishes one**, so above / below / comparable **cannot be determined** | NEEDS DATA |
| Against the one comparable published Virginia rate (Blueline) | Same hourly figure as their cash rate, below their card rate; same 4-hour minimum; same no-travel policy → **comparable** | CONFIRMED (against that one firm) |
| Against the one low outlier (American Investigation Services, $45/hr) | Ours is higher; a $45 rate is out of line with every other figure found | CONFIRMED |
| Against Tradewinds ($200/hr) | Ours is lower | CONFIRMED |
| Retainer | No competitor in the region publishes a retainer → **cannot be compared** | NEEDS DATA |
| All-in pricing | Privin's page says travel, mileage and report fees come on top; ours includes them. **That is a real, publishable difference** — and it is already on every city page | CONFIRMED |

**No pricing change is recommended**, and none was made.

**On "pricing expectations are unclear":** the site deliberately publishes no
price (owner decision, 2026-08-21), and so do nearly all local competitors. A
visitor is told "quoted by the hour", "no mileage or travel charge" and "free
consultation", but gets no range. Whether that costs inquiries is **NEEDS
DATA**, and changing it would reverse a standing owner decision. It is listed in
§12 as a question for the owner, not as a recommendation.

---

## 8. Homepage conversion findings

Live homepage, rendered at iPhone 13 (390×844) and desktop (1366×768),
2026-11-07, compared with the pre-redesign tree (`bedcd03^`) rendered the same
way.

| # | Finding | Label |
| --- | --- | --- |
| H1 | **The phone number is no longer printed in the first screen at any width.** Before: `CALL (434) 907-0975` in the header on phone and desktop. After: buttons say *Discreet Phone Call* / *Call Privately*. The number appears only in the contact section near the bottom and in the footer. On a desktop a `tel:` link often does nothing useful — the visitor needs digits to dial from their phone | CONFIRMED (change); effect LIKELY, UNVERIFIED |
| H2 | The hero leads with child custody and relationship questions. A visitor looking for general surveillance, insurance or legal work has to scroll to "Other Investigation Services" | CONFIRMED (layout); effect LIKELY, UNVERIFIED |
| H3 | "Free, confidential consultation" appears only in the bottom contact section; the hero says *Private · Professional · Discreet* but not *free* or *confidential consultation* | CONFIRMED |
| H4 | On a phone the **first thing read is a four-line notice of what the firm does not do** (cyber-stalking, hacking), 240px tall, above the logo. It was there before the redesign too, so it is not new | CONFIRMED; effect LIKELY, UNVERIFIED |
| H5 | Reviews shown are 2018–2019, no count, no link to read more | CONFIRMED |
| H6 | Both call and intake are in the hero and in a sticky phone bar; all tel/intake links resolve (200) and the Web3Forms contact form is wired | CONFIRMED (working) |

---

## 9. Service-page and city-page conversion findings

These are the pages search actually lands people on — 63 of 67 recorded
impressions went to Bedford.

| # | Finding | Label |
| --- | --- | --- |
| S1 | **Desktop, 1366×768: the first screen holds no phone number and no call or intake button** on all six city pages, the hub, Infidelity and Child Custody. The header's only action is *Contact / Intake*, which leaves the page for `/#contact` on the homepage. The hero text itself says "Free confidential consultation" with nothing to press. Before #351 the header carried `Call (434) 907-0975` on every one of these pages | CONFIRMED (change); effect LIKELY, UNVERIFIED |
| S2 | On phones these pages are better than before: a sticky *Call Privately / Online Intake* bar is always present | CONFIRMED |
| S3 | The header nav on a city page sends visitors to homepage anchors (`/#private`, `/#how`, `/#other`), so most header links leave the page the visitor searched for | CONFIRMED; effect LIKELY, UNVERIFIED |
| S4 | **The only written route is the full intake** (5 steps, ending in agreement + typed legal name + drawn signature). The short name-and-number "Send a Message" form is on the homepage only | CONFIRMED (structure); abandonment NEEDS DATA |
| S5 | City pages are long (Bedford ~7,250px tall on a phone). The content is substantive (Virginia adultery law, what we do not do, FAQ) and supports the rankings Bedford has; trimming it is not recommended | CONFIRMED (length); recommendation is to add actions, not cut text |
| S6 | Insurance and Legal pages do have their primary action in the first screen at both widths | CONFIRMED |

---

## 10. Mobile usability findings

Measured on the live site, iPhone 13 emulation, from this data centre (lab
figures, not real-user field data):

| Page | Load | LCP | Requests | Sideways scroll | First-screen actions |
| --- | --- | --- | --- | --- | --- |
| `/` | 1.4 s | 0.91 s | 10 | none | Discreet Phone Call, Fill Out Online Intake, sticky Call / Intake |
| Lynchburg | 0.37 s | 0.38 s | 5 | none | sticky Call / Intake |
| Bedford | 0.47 s | 0.42 s | 5 | none | sticky Call / Intake |
| Infidelity | 0.24 s | 0.24 s | 5 | none | sticky Call / Intake |
| Child Custody | 0.31 s | 0.32 s | 5 | none | sticky Call / Intake |
| Hub | 0.55 s | 0.57 s | 5 | none | sticky Call / Intake |
| Legal | 0.55 s | 0.57 s | 5 | none | sticky Call / Submit Assignment |
| Insurance | 0.51 s | 0.51 s | 5 | none | Submit an Insurance Assignment, sticky bar |

No 4xx resources on any page. **Mobile is not the problem on evidence**; the
remaining mobile notes are content ones (H1, H4 above). Real-user Core Web
Vitals are in Search Console → Experience (NEEDS DATA).

---

## 11. Technical SEO defects

| # | Defect | Severity | Label |
| --- | --- | --- | --- |
| T1 | **Homepage H1 has no service or place** since #351 (was set deliberately by #324) | Medium | CONFIRMED |
| T2 | NAP conflict between schema street address (13 pages) and SEO.md §10's service-area instruction (§4 above) | Medium, until the GBP is checked | CONFIRMED conflict; which is right NEEDS DATA |
| T3 | Sitemap `lastmod` is 2026-09-24 for every URL, though the homepage content changed 2026-10-10 (`CONTENT_REVISED` was not bumped) | Low | CONFIRMED |
| T4 | Retired city URLs **without** a trailing slash return 404 (e.g. `/private-investigator/forest-va` → 404; `/private-investigator/forest-va/` → 301 correctly). Only matters if an old link omits the slash | Low | CONFIRMED |
| T5 | `www.alwayspreciseinvestigations.net` could not be checked (blocked here). If it does not resolve or redirect, anyone typing `www.` gets nothing | Unknown | NEEDS DATA — owner: open it in a browser |

**Checked and healthy:** `http → https` 301; `/index.html` and `/privacy.html`
308 to their canonical form; every page's canonical is self-referencing and
unchanged by the redesign; 13 sitemap URLs, all 200; robots.txt allows all and
names the sitemap; all 24 retired-town redirects in `_redirects` answer 301
to their surviving page (the seven Tier-1 towns to Lynchburg, Smith Mountain
Lake to Bedford, and so on); titles and
descriptions on all 15 public pages are unchanged by the redesign;
`ProfessionalService` structured data parses on every page, with `areaServed`,
phone and `sameAs` (Facebook, GBP); `node .github/test-deploy.mjs` **195
passed, 0 failed** (internal links, sitemap, generator parity, statewide-claim
guards); `build-locations.py` regenerates byte-identical output; no
`site-health` issue opened since 2026-09-01.

---

## 12. Top 10 recommended improvements

Ranked by: impact on new-client inquiries → evidence of a real problem →
effort → risk to existing rankings. **None has been implemented.** Items 1–3
touch the owner-approved redesign, so each needs the owner's yes.

| Rank | Recommendation | Evidence | Effort | Ranking risk |
| --- | --- | --- | --- | --- |
| **1** | **Put the printed number back in the shared header** — `Call (434) 907-0975` on desktop, and the digits on the phone sticky bar's call button. One change in `site_header()` / `site_footer()`, copied to the 8 hand-written pages; the chrome guard keeps all 15 identical | CONFIRMED regression vs pre-10-10 | Low | None — no title, URL or content change |
| **2** | **Add a Call + Start Intake pair to the hero of every city and service landing page**, using each page's existing door (`?service=custody` on Custody, `relationship` on Infidelity, the private door on city pages). The hero already promises a free confidential consultation | CONFIRMED gap on desktop (S1) | Low | None |
| **3** | **Restore a keyword H1 on the homepage**, keeping the owner's line as the standfirst — the same treatment the Legal page got (SEO.md §3). E.g. H1 *"Private Investigator in Lynchburg & Central Virginia"*, standfirst *"When you need answers, start here."* | CONFIRMED change; effect NEEDS DATA | Low | Low, and in the direction of what ranked before |
| **4** | **Owner: export Search Console** (steps in §14) — 28 d vs previous, 3 mo vs previous, by query and by page, mobile vs desktop | Required to answer goal 1 at all | 15 min, owner | None |
| **5** | **Owner: read the Live Visitors funnel** for the last 28 days — landing page → intake opened → started → submitted, by referrer (Google vs direct) | Required to answer goal 3 with data | 15 min, owner | None |
| **6** | **Google Business Profile check**: category, service area vs street address (settle T2), hours, phone, website; recent photos; **ask recent satisfied clients for honest reviews** (never incentivised). The map pack outranks every on-site lever for "near me" | SEO.md §7/§10; T2 | Owner time | None |
| **7** | **Offer the short call-back form on landing pages** — the homepage's existing name-and-number "Send a Message" form (Web3Forms, already live), so a visitor not ready to sign a 5-step agreement can still reach the firm. This reuses an existing form and does not change the intake | CONFIRMED structure (S4); demand NEEDS DATA (rec. 5 answers it) | Medium | None |
| **8** | **Refresh the review block** with newer Google reviews the owner selects, plus a "Read our reviews on Google" link to the GBP. **No `AggregateRating` markup** — self-serving review schema earns no stars and risks a manual action (SEO.md §5) | CONFIRMED dated reviews | Low (needs owner's reviews) | None |
| **9** | **Hero trust line on the homepage**: put *Free, confidential consultation* in the hero, and on phones move the cyber-stalking notice below the hero or shorten it to one line. The notice's wording stays; only its position changes | CONFIRMED layout; effect LIKELY, UNVERIFIED | Low | None |
| **10** | **Technical cleanup**: bump `CONTENT_REVISED` with the next real content change (T3); add no-slash variants for the 7 retired-town redirects (T4); confirm `www.` (T5) | CONFIRMED | Low | None — redirects only add, never remove |

**Deliberately not recommended:**

- **No new location pages** for Forest, Rustburg, Madison Heights, Amherst,
  Appomattox, Altavista or Moneta. SEO.md §9's evidence stands (0 clicks from
  195 impressions), and the research found no town-based competitor in those
  towns to outrank.
- **No cutting of city-page text.** It is what Bedford's measured impressions
  rest on.
- **No pricing change and no public price.** Whether a public price range would
  lift inquiries is a fair question; it reverses a standing owner decision, so it
  is the owner's question to ask, after the funnel data is in.
- **No intake change.** If the funnel (rec. 5) shows visitors starting the
  private intake and stopping at the agreement step, *then* "submit first, sign
  when the rate sheet arrives" becomes a question worth bringing to the owner.
  Not before.

---

## 13. Expected benefit and implementation risk

| Rec | Expected benefit | Confidence | Risk |
| --- | --- | --- | --- |
| 1 | Restores the one control that every landing page had until 10-10 for desktop visitors; desktop searchers are often at work and dial from a separate phone | Medium — direction is clear, size is not | Near zero; presentation only |
| 2 | Puts an action where the visitor arrives instead of 1–2 screens down | Medium | Near zero |
| 3 | Restores the homepage's on-page match for *private investigator Lynchburg* | Low–medium; titles carry more weight than H1s | Low |
| 4–5 | Turns every "likely" in this report into measured or refuted | High (it is the evidence) | None |
| 6, 8 | Map-pack visibility and trust; the largest local lever, slowest to move | Medium, over months | None |
| 7 | Captures visitors not ready to sign | Unknown until rec. 5 | Low; adds a Web3Forms submission type the office already receives |
| 9 | Better first impression on phones | Low–medium | Low |
| 10 | Hygiene | Low | None |

**Measure before and after.** Ship 1–2 as one change and compare the Live
Visitors "call tapped" and "intake opened" counts for the two weeks after it with
the two weeks before. That is the only way to know the header change was the
problem rather than just a plausible one.

---

## 14. Missing data and how to obtain it

| Missing | Why it matters | How to get it (owner) |
| --- | --- | --- |
| **Search Console performance** | Goal 1 cannot be answered without it | search.google.com/search-console → property → **Performance → Search results**. Click **Date → Compare → "Compare last 28 days to previous period"**, then repeat with **last 3 months** and, if the property is a year old, **last 3 months year over year**. Tick **Total clicks, Total impressions, Average CTR, Average position**. Export (top-right) **Queries** and **Pages** for each comparison. Add **Country = United States**, and a second pass with **Device** (mobile vs desktop). Send the CSVs or screenshots |
| Branded vs non-branded | Separates "people who know us" from "people who found us" | In the Queries tab, filter **Query → Doesn't contain → "precise"**, then **Contains → "precise"** |
| Virginia-only traffic | Search Console has no state filter | Use the Live Visitors dashboard, which keeps referrer and landing page per visit |
| **Live Visitors funnel** | Goal 3 | `/watch/` → last 28 days: visits by landing page and referrer; intake opened / started / submitted; call taps |
| Google Business Profile insights | Map-pack calls, direction requests, searches | business.google.com → Performance → last 6 months; note **calls** and **website clicks** by month |
| GBP address setting | Settles T2 | business.google.com → Business information → Location: is the street address shown or hidden? |
| Google review count and newest review date | Credibility comparison | The GBP itself |
| `www.` behaviour | T5 | Open `https://www.alwayspreciseinvestigations.net/` in a browser |
| Competitor pages | Upgrade §5–§6 rows from search text to read pages | Allow the hosts in this environment's network settings (see below), or open the URLs in §5 directly |
| Real-user Core Web Vitals | Lab figures in §10 are not field data | Search Console → Experience → Core Web Vitals |

**Why competitor pages could not be opened here:** the cloud environment's
network policy denied every competitor, directory and social host requested —
`www.1tsis.com`, `mayhemsolutionsgroup.com`, `bondinvestigations.com`,
`morsepi.com`, `privin.net`, `www.thumbtack.com`, `www.bluelineinvestigations.com`,
`www.tradewindsinvestigations.com`, `www.covaintel.com`, `www.lasorsa.com`,
`www.bbb.org`, `www.superpages.com`, `www.yelp.com`, `www.claimspages.com`,
`business.roanokechamber.org`, `www.facebook.com` and
`www.alwayspreciseinvestigations.net`. They can be added under the environment's
Network access → Allowed domains
([steps](https://code.claude.com/docs/en/cloud-environments#network-access)), and
§5–§6 re-run against the pages themselves.

---

## Method notes

- Pre/post redesign comparison: `git show bedcd03^:<page>` vs `HEAD`, extracting
  title, description, canonical, robots, H1, main-content words, structured-data
  types, tel and intake link counts for all 15 public pages; then both trees
  rendered in Chromium at 390×844 and 1366×768 and the first-screen links read
  from the DOM.
- Live checks: `curl` status and redirect for apex, `http://`, `/index.html`,
  retired-town URLs with and without slash, `/privacy`, a non-existent path,
  `/insurance-investigations/submit/`, the intake doors, `beacon.js`,
  `site.css` and the sitemap.
- Competitor research: web search (not Google; order not used as rank),
  2026-11-07; the source URL beside every row.
- **No form was submitted, no competitor was contacted, no partial form contents
  were collected, and no confidential client data was opened.**
