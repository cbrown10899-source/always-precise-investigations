#!/usr/bin/env python3
"""Generate the Central Virginia location pages for Always Precise Investigations.

Each page targets "private investigator <place>" plus the infidelity/adultery
cluster for that locality. Content is unique per page (locality facts, nearby
areas, court venue, tailored FAQ) — near-duplicate templates get filtered by
Google rather than ranked.

Run from the repo root:  python3 build-locations.py
"""
import os, html, json

DOMAIN = "https://alwayspreciseinvestigations.net"
PHONE_DISPLAY = "(434) 907-0975"
PHONE_LINK = "+14349070975"
EMAIL = "AlwaysPreciseInvestigations@gmail.com"
LICENSE = "Va DCJS #11-9159"

# NAP exactly as it appears on the Google Business Profile — name, address and
# phone must match the listing character for character, since inconsistent
# citations are what hold a business out of the local pack. GBP_URL is the
# listing's stable cid link, which ties this site to that listing.
ADDRESS = {"@type": "PostalAddress", "streetAddress": "503 Old Plantation Dr #303",
           "addressLocality": "Lynchburg", "addressRegion": "VA",
           "postalCode": "24502", "addressCountry": "US"}
GEO = {"@type": "GeoCoordinates", "latitude": 37.309454, "longitude": -79.2683106}
HOURS = [{"@type": "OpeningHoursSpecification",
          "dayOfWeek": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
          "opens": "07:00", "closes": "22:00"}]
GBP_URL = "https://maps.google.com/?cid=1285488950812777376"

# THE DATE THE GENERATED CONTENT WAS LAST DELIBERATELY REVISED. `lastmod` is the
# one sitemap hint Google has said it actually uses (priority and changefreq it
# ignores), so it is worth carrying — but only while it stays true, which is why
# this is a constant somebody edits rather than a build date or a git date.
#
# A BUILD DATE WOULD LIE every time CI regenerates an unchanged page. A GIT DATE
# IS WORSE THAN THAT: `test-deploy.mjs` asserts the committed sitemap is
# byte-for-byte what the generator produces, and a date read from `git log` moves
# the moment this file is committed — so the sitemap generated before the commit
# would stop matching the one generated after it, and the deploy guard would
# fail on the NEXT day rather than this one. Bump this by hand when the location
# content actually changes.
CONTENT_REVISED = "2026-09-12"
FACEBOOK = "https://www.facebook.com/AlwaysPreciseInvestigations/"

# Each locality carries its OWN facts and the page is COMPOSED from them, rather
# than being one template with the city name swapped in. That is not a style
# preference. Measured 2026-09-12, before this change: 28 of the 33 sentences on
# a location page were byte-identical once the city name was substituted, and
# Roanoke and Danville shared 305 of 327 words of vocabulary — which is the
# shape a search engine treats as near-duplicate and filters, so five of the six
# pages were competing to be the one that survived.
#
# Every field below is a VERIFIABLE geographic or civic fact — roads, courts,
# adjacent localities — or a statement about what this firm actually does.
# Nothing here asserts case volume, named clients, or work we cannot evidence.
# "ground" is the operational reality of working that locality and is the field
# that makes each page genuinely its own; "ins" and "legal" give the two newest
# business lines a presence in local search, which they previously had nowhere.
PLACES = [
    {
        "slug": "lynchburg-va", "place": "Lynchburg", "kind": "city",
        "county": "Central Virginia", "court": "Lynchburg Circuit Court",
        "detail": "the Hill City on the James River, bordered by Campbell, "
                  "Bedford and Amherst counties",
        "corridor": "US 29, US 460 and Route 501",
        "covers": "Campbell, Bedford, Amherst and Appomattox counties",
        "ground": "Lynchburg is our home city — the office is here — so work in "
                  "the city and the four counties around it starts without "
                  "travel time, and short notice is usually a scheduling "
                  "question rather than a distance one. The city's geography "
                  "does shape the work: the hills and the river crossings mean "
                  "there are only so many ways between two points, which helps "
                  "when a route has to be documented and hurts when a subject "
                  "doubles back.",
        "ins": "Claim assignments here are filed through Lynchburg Circuit "
               "Court or the Campbell and Bedford county courts next door, and "
               "the US 29 and 460 corridors put most of the region's warehouse, "
               "distribution and light-manufacturing employment within a short "
               "drive — which is where a good deal of Central Virginia workers' "
               "compensation activity originates.",
        "legal": "Counsel working out of Lynchburg and the surrounding county "
                 "seats can open an assignment and have an investigator on it "
                 "without a travel line on the invoice. Reports come back "
                 "dated, factual and built to go straight into the file.",
        "faq": ("Do you cover the counties around Lynchburg as well as the city?",
                "Yes. Campbell, Bedford, Amherst and Appomattox are all inside "
                "our regular service area, and there is no separate travel or "
                "mileage charge anywhere in it. A matter that starts in the "
                "city and moves into a county does not become a second case."),
    },
    {
        "slug": "bedford-va", "place": "Bedford", "kind": "town",
        "county": "Bedford County", "court": "Bedford County Circuit Court",
        "detail": "the county seat below the Peaks of Otter",
        "corridor": "US 460 and Route 122",
        "covers": "Bedford County, from the Peaks of Otter down to Smith Mountain Lake",
        "ground": "Bedford County is rural, and rural changes the method. On a "
                  "county road carrying a few dozen vehicles an hour, a parked "
                  "car is the most interesting thing in the landscape — so "
                  "distance, sightlines and the honest question of whether a "
                  "position can be held at all matter far more here than they "
                  "do in a city. Around Smith Mountain Lake the seasonal "
                  "traffic cuts both ways: more cover in summer, none at all in "
                  "February.",
        "ins": "Bedford County claim work is filed through Bedford County "
               "Circuit Court, and a great deal of the activity worth "
               "documenting here happens outdoors and on private "
               "property — which is precisely where the line between what may "
               "and may not be documented has to be understood before anyone "
               "goes out, not afterwards.",
        "legal": "Bedford is a county seat, so the courthouse is the centre of "
                 "the matter as well as its venue. Assignments for firms "
                 "working Bedford County are scheduled against the dates on the "
                 "file rather than open-ended.",
        "faq": ("Can surveillance actually work in a rural part of Bedford County?",
                "Often, but it is an honest conversation first. On a quiet "
                "county road a stationary vehicle is conspicuous, so the answer "
                "is usually a different approach rather than a longer sit — and "
                "if a location genuinely cannot be covered, we say so before "
                "you spend anything rather than after."),
    },
    {
        "slug": "roanoke-va", "place": "Roanoke", "kind": "city",
        "county": "Roanoke County", "court": "Roanoke City Circuit Court",
        "detail": "the Star City of the Roanoke Valley, the largest metro west "
                  "of Lynchburg and an easy run out Route 460 or the Blue Ridge "
                  "Parkway",
        "corridor": "I-81, US 220 and US 460",
        "covers": "Roanoke City, Roanoke County, Salem and Vinton",
        "ground": "The Roanoke Valley is the largest urban area we work, and it "
                  "is the one place in our service area where traffic is an "
                  "asset — a vehicle in moving traffic or a full parking deck "
                  "is invisible in a way it never is in a county. The "
                  "complication here is jurisdictional rather than physical: "
                  "Roanoke City, Roanoke County, Salem and Vinton sit inside "
                  "one valley and are four separate localities, so the address "
                  "decides the venue and it is worth confirming which court a "
                  "matter is actually headed for.",
        "ins": "Roanoke carries the heaviest concentration of claim activity in "
               "the western half of our service area, and I-81 makes it "
               "reachable the same day from Lynchburg. Assignments are filed "
               "through Roanoke City or Roanoke County Circuit Court depending "
               "on where the claimant actually lives — a distinction that is "
               "easy to get wrong from out of the area.",
        "legal": "Roanoke has the largest bar west of Lynchburg, and firms here "
                 "generally want the same two things: coverage that can be "
                 "scheduled against a hearing date, and a report that does not "
                 "need rewriting before it goes in the file.",
        "faq": ("Which Roanoke court will my matter be in?",
                "That depends on the address, not the mailing city. Roanoke "
                "City, Roanoke County, Salem and Vinton are separate "
                "jurisdictions sharing one valley and a lot of Roanoke mailing "
                "addresses, so a matter people assume is a city case is often a "
                "county one. Your attorney settles venue; we simply make sure "
                "the report names the right locality."),
    },
    {
        "slug": "charlottesville-va", "place": "Charlottesville", "kind": "city",
        "county": "Central Virginia", "court": "Charlottesville Circuit Court",
        "detail": "the independent city surrounded by Albemarle County and home "
                  "to the University of Virginia",
        "corridor": "US 29 and I-64",
        "covers": "Charlottesville and Albemarle County",
        "ground": "Charlottesville is an independent city completely "
                  "surrounded by Albemarle County, and that single fact causes "
                  "more confusion here than anywhere else we work: an address "
                  "with a Charlottesville postmark is frequently in the county, "
                  "which puts the matter in a different court. The university "
                  "also gives the city a traffic and population rhythm that "
                  "changes completely between term and summer — worth planning "
                  "around rather than discovering.",
        "ins": "Claim work in the area splits between Charlottesville Circuit "
               "Court and Albemarle County Circuit Court on the strength of the "
               "address, and US 29 and I-64 make it a straight run from "
               "Lynchburg. Carriers and TPAs opening a file here are quoted per "
               "assignment with no separate travel charge.",
        "legal": "Charlottesville supports a dense legal sector for a city its "
                 "size, and a good deal of what firms here need is unglamorous: "
                 "locate and process support, activity documentation, and a "
                 "factual report that holds together.",
        "faq": ("Is a Charlottesville address always in the city?",
                "No, and it catches people out regularly. Charlottesville is an "
                "independent city ringed by Albemarle County, and a great many "
                "addresses that read as Charlottesville sit in the county — "
                "which changes the court the matter belongs in. We work both "
                "and will tell you which one an address falls in."),
    },
    {
        "slug": "farmville-va", "place": "Farmville", "kind": "town",
        "county": "Prince Edward County",
        "court": "Prince Edward County Circuit Court",
        "detail": "the Prince Edward County seat and home of Longwood University",
        "corridor": "US 460 and US 15",
        "covers": "Prince Edward, Cumberland and Buckingham counties",
        "ground": "Farmville is a small town at the crossing of two US routes, "
                  "with Longwood University in the middle of it and "
                  "Hampden-Sydney just down the road. A town this size notices "
                  "an unfamiliar vehicle within a day or so — genuinely, not as "
                  "a figure of speech — so work here is planned around that "
                  "rather than against it. The student calendar also swings the "
                  "population hard enough that the same street is a different "
                  "problem in October and in July.",
        "ins": "Prince Edward, Cumberland and Buckingham are rural counties "
               "reached out US 460 and US 15, and claim files here are heard in "
               "Prince Edward County Circuit Court. Rural claim work usually "
               "means outdoor activity and long approaches, which is a planning "
               "question rather than an obstacle.",
        "legal": "Farmville is the county seat, so firms working Prince Edward "
                 "and the counties either side of it are working out of the "
                 "same courthouse. Assignments are scheduled against the dates "
                 "on the matter.",
        "faq": ("Can an investigator work discreetly in a town the size of Farmville?",
                "It takes a different approach, and we would rather say so than "
                "pretend otherwise. In a small town an unfamiliar parked "
                "vehicle is conspicuous quickly, so coverage here is built "
                "around movement and timing instead of a long static sit. Where "
                "a location cannot be worked discreetly, you are told before "
                "anything is spent."),
    },
    {
        "slug": "danville-va", "place": "Danville", "kind": "city",
        "county": "Southside Virginia", "court": "Danville Circuit Court",
        "detail": "the Dan River city on the North Carolina line",
        "corridor": "US 29 and US 58",
        "covers": "Danville and Pittsylvania County",
        "ground": "Danville sits on the North Carolina line, and that is the "
                  "single most important operational fact about working here: a "
                  "subject can be in another state in a matter of minutes, and "
                  "the authority a Virginia investigator carries stops at that "
                  "line. It is worth knowing before surveillance is planned and "
                  "before papers are issued — not as a limitation we discovered "
                  "halfway through a case.",
        "ins": "Danville and Pittsylvania County claim files are heard in "
               "Danville Circuit Court and the Pittsylvania County courts, "
               "reached out US 29 and US 58. On a claim near the state line it "
               "is worth establishing early where the claimant actually spends "
               "their time, because a file that crosses into North Carolina "
               "changes what can be done and by whom.",
        "legal": "For firms with a matter on the state line, the useful thing "
                 "we can offer is usually a straight answer about what is "
                 "workable on the Virginia side and where the limit falls, "
                 "before a plan is built on an assumption.",
        "faq": ("What happens if the subject crosses into North Carolina?",
                "Our licence is a Virginia licence and our authority stops at "
                "the state line — we do not represent otherwise. On a Danville "
                "matter that is a planning question rather than a surprise: we "
                "establish early where the subject actually spends their time, "
                "document what can properly be documented in Virginia, and tell "
                "you plainly where the boundary falls so your attorney can "
                "decide what to do about it."),
    },
]
NEARBY = {
    "lynchburg-va": ["bedford-va", "roanoke-va", "farmville-va", "charlottesville-va"],
    "bedford-va": ["lynchburg-va", "roanoke-va"],
    "roanoke-va": ["bedford-va", "lynchburg-va"],
    "charlottesville-va": ["lynchburg-va", "farmville-va"],
    "farmville-va": ["lynchburg-va", "charlottesville-va", "danville-va"],
    "danville-va": ["lynchburg-va", "farmville-va"],
}
for _p in PLACES:
    _p["nearby"] = NEARBY[_p["slug"]]
BY_SLUG = {p["slug"]: p for p in PLACES}

CSS = """
*{margin:0;padding:0;box-sizing:border-box}
:root{--navy:#13233c;--navy-2:#1a2f4e;--card:#1d3251;--line:#31517a;
--ink:#dfe6ef;--muted:#9fb0c4;--white:#fff;--teal:#3d97ad;--teal-2:#4fb3cb;--gold:#e6b54a}
html{scroll-behavior:smooth}
body{font-family:Georgia,'Times New Roman',serif;color:var(--ink);background:var(--navy);line-height:1.7;-webkit-text-size-adjust:100%}
h1,h2,h3,.sans{font-family:'Segoe UI',Arial,Helvetica,sans-serif}
h1,h2,h3{line-height:1.2;color:var(--white)}
a{color:var(--teal-2)}
img{max-width:100%;display:block}
.wrap{max-width:920px;margin:0 auto;padding:0 20px}
header{background:var(--navy-2);border-bottom:1px solid var(--line);padding:14px 0}
header .wrap{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}
header .brand{font-family:'Segoe UI',Arial,sans-serif;color:#fff;font-weight:700;letter-spacing:.02em;text-decoration:none}
header .call{background:var(--teal);color:#08131f;text-decoration:none;font-family:'Segoe UI',Arial,sans-serif;
font-weight:700;padding:9px 16px;border-radius:6px;white-space:nowrap}
.hero{padding:46px 0 30px;border-bottom:1px solid var(--line)}
.eyebrow{font-family:'Segoe UI',Arial,sans-serif;font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:var(--gold);margin-bottom:12px}
h1{font-size:clamp(28px,5vw,42px);margin-bottom:14px}
.lede{color:var(--muted);font-size:18px}
section{padding:34px 0;border-bottom:1px solid var(--line)}
h2{font-size:clamp(22px,3.4vw,28px);margin-bottom:14px}
h3{font-size:18px;margin-bottom:6px}
p{margin-bottom:14px}
ul{margin:0 0 14px 20px}
li{margin-bottom:8px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin-top:18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px}
.card p{color:var(--muted);margin:0;font-size:15px}
.cta{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px;margin-top:22px;text-align:center}
.cta a.btn{display:inline-block;background:var(--teal);color:#08131f;text-decoration:none;font-family:'Segoe UI',Arial,sans-serif;
font-weight:700;padding:13px 26px;border-radius:6px;margin-top:8px}
.faq h3{margin-top:18px}
.faq p{color:var(--muted)}
.near{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px}
.near a{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:8px 16px;
text-decoration:none;font-family:'Segoe UI',Arial,sans-serif;font-size:14px}
.near a:hover{border-color:var(--teal)}
.disclaim{color:var(--muted);font-size:14px;font-style:italic}
footer{padding:26px 0 40px;text-align:center;color:var(--muted);font-size:14px}
footer .row{margin-bottom:6px}
"""

def esc(t): return html.escape(t, quote=True)

def pick(candidates, limit):
    """First candidate within the limit; shortest if none fit."""
    for c in candidates:
        if len(c) <= limit:
            return c
    return min(candidates, key=len)

def page(p):
    slug, place, kind = p["slug"], p["place"], p["kind"]
    county, court, detail = p["county"], p["court"], p["detail"]
    corridor, covers, nearby = p["corridor"], p["covers"], p["nearby"]
    url = f"{DOMAIN}/private-investigator/{slug}/"
    # Pick the longest title/description that still fits search-display limits.
    title = pick([
        f"Private Investigator {place}, VA | Cheating & Surveillance",
        f"Private Investigator {place}, VA | Surveillance",
        f"Private Investigator {place}, VA",
    ], 62)
    # The description names what this locality actually covers, so the six
    # snippets differ from each other in the result page as well as on the page.
    desc = pick([
        f"Licensed PI covering {covers}. Surveillance, cheating spouse, custody, "
        f"insurance claims and legal support. Free consult: {PHONE_DISPLAY}.",
        f"Licensed PI serving {place}, VA — surveillance, cheating spouse, custody "
        f"and insurance claim work. Free consult: {PHONE_DISPLAY}.",
        f"Licensed private investigator serving {place}, VA. Free consult: {PHONE_DISPLAY}.",
    ], 160)
    area_line = f"{place} and {county}" if county not in ("Central Virginia", "Southside Virginia") else place

    faqs = [
        (f"How much does a private investigator cost in {place}?",
         "Cost depends on the type of case and the hours involved. Surveillance is quoted by the hour, "
         "background research is usually a flat fee, and we quote every case before any work begins — "
         f"with no mileage or travel charge anywhere in our service area, which takes in {covers}. "
         "Call for a free, confidential quote."),
        (f"Can you prove adultery for a divorce case in {place}?",
         "Virginia treats adultery as a fault ground for divorce, and courts there apply a high evidentiary "
         "standard — a spouse's own suspicion or testimony is generally not enough on its own, so "
         "independent corroboration matters. We document activity with time-stamped video and detailed "
         f"written reports prepared to be usable by your attorney and, if needed, in {court}. Work can "
         f"run anywhere across {covers} without the case being split or re-quoted. "
         "We do not give legal advice; your attorney decides how evidence is used."),
        (f"Will my spouse or the subject know I hired an investigator in {place}?",
         "No. Surveillance is covert by design, and our work with you is confidential. Investigators use "
         "unmarked vehicles and keep their distance; the goal is documentation without any change in the "
         + ("subject's behavior. In a built-up area like " + place + " that is mostly a question of "
            "blending into normal traffic."
            if kind == "city" else
            "subject's behavior. " + place + " is small enough that an unfamiliar parked vehicle gets "
            "noticed, so coverage here is planned around movement and timing rather than a long "
            "static sit.")),
        (f"How quickly can an investigator get to {place}?",
         f"{place} sits inside our regular service area and is reached on {corridor}, so most cases "
         "can be scheduled within a few days — and urgent matters sooner. Timing often matters more "
         "than people expect: patterns are easiest to document while they are still active."),
        # The locality's own question — the one thing about working here that is
        # genuinely not true of the other five pages.
        p["faq"],
        (f"Do you take insurance claim assignments in {place}?",
         "Yes. We work with carriers, third-party administrators, self-insured employers and defense "
         f"firms on claims across {covers} — surveillance, activity documentation and factual "
         f"reporting, invoiced against a written authorization. Files in this area are heard in "
         f"{court}. Assignments are submitted through the secure assignment intake and confirmed in "
         "writing before any work begins."),
        (f"Can law firms in {place} open an assignment?",
         f"Yes, and a paralegal can open it — most matters across {covers} are opened by the person "
         "running the file rather than by the attorney, so the firm, the responsible attorney and the "
         "day-to-day contact are recorded separately and all three stay on the matter. The "
         "investigator who does the work is the one who can speak to what they observed in "
         f"{court}."),
    ]
    faq_ld = {
        "@context": "https://schema.org", "@type": "FAQPage",
        "mainEntity": [{"@type": "Question", "name": q,
                        "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in faqs]
    }
    biz_ld = {
        "@context": "https://schema.org", "@type": "ProfessionalService",
        "name": "Always Precise Investigations, LLC",
        "description": f"Licensed private investigation firm serving {place}, Virginia and the surrounding area since 2014.",
        "telephone": PHONE_LINK, "email": EMAIL, "url": url,
        "areaServed": {"@type": "Place", "name": f"{place}, Virginia"},
        "address": ADDRESS, "geo": GEO, "openingHoursSpecification": HOURS,
        "foundingDate": "2014", "priceRange": "$$",
        "identifier": {"@type": "PropertyValue", "name": "Virginia DCJS license", "value": "11-9159"},
        "hasOfferCatalog": {
            "@type": "OfferCatalog", "name": f"Investigation services in {place}, Virginia",
            "itemListElement": [{"@type": "Offer", "itemOffered": {"@type": "Service", "name": n}}
                                for n in ("Surveillance", "Infidelity investigation",
                                          "Child custody documentation", "Background checks",
                                          "Insurance claim investigation",
                                          "Legal investigation support", "Process serving")]},
        "sameAs": [FACEBOOK, GBP_URL]
    }
    crumb_ld = {
        "@context": "https://schema.org", "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Service areas", "item": f"{DOMAIN}/private-investigator/"},
            {"@type": "ListItem", "position": 2, "name": f"{place}, VA", "item": url}]
    }

    near_html = "".join(
        f'<a href="{DOMAIN}/private-investigator/{n}/">{esc(BY_SLUG[n]["place"])}</a>'
        for n in nearby if n in BY_SLUG)

    faq_html = "".join(f"<h3>{esc(q)}</h3><p>{esc(a)}</p>" for q, a in faqs)

    # The card order follows what the locality's own prose emphasises: a city
    # carries more claim and litigation activity, a rural county seat more
    # domestic and custody work. Same seven services either way — only the order
    # of the first two changes, and it changes for a stated reason.
    CARDS = {
        "cheating": ("Cheating &amp; infidelity", "Discreet documentation when you need to know — time-stamped video, written timelines, and photographs."),
        "adultery": ("Adultery evidence for divorce", "Independent corroboration prepared for your attorney, meeting the standard Virginia courts expect."),
        "surv": ("Surveillance", "Covert, documented, and quoted by the hour — no hidden mileage or travel fees in our service area."),
        "custody": ("Child custody", "Documentation of conditions, conduct and third-party contact relevant to custody proceedings."),
        "bg": ("Background checks", "For employers, landlords, volunteer organizations, and personal peace of mind."),
        "ins": ("Insurance claims", "Workers' comp and liability claim surveillance for insurers, employers, and defense attorneys."),
        "legal": ("Legal support", "Surveillance, locate and process support and court-ready reporting for law firms and attorneys."),
        "serve": ("Process serving", "Prompt, documented service of legal papers throughout the area."),
    }
    order = (["ins", "legal", "surv", "cheating", "adultery", "custody", "bg", "serve"]
             if kind == "city" else
             ["cheating", "adultery", "surv", "custody", "ins", "legal", "bg", "serve"])
    cards_html = "".join(
        f'<div class="card"><h3>{CARDS[k][0]}</h3><p>{CARDS[k][1]}</p></div>' for k in order)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)}</title>
<meta name="description" content="{esc(desc)}">
<link rel="canonical" href="{url}">
<meta name="robots" content="max-image-preview:large">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Always Precise Investigations">
<meta property="og:locale" content="en_US">
<meta property="og:url" content="{url}">
<meta property="og:title" content="{esc(title)}">
<meta property="og:description" content="{esc(desc)}">
<meta property="og:image" content="{DOMAIN}/assets/banner1.webp">
<meta property="og:image:alt" content="Always Precise Investigations — licensed private investigators in Virginia">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{esc(title)}">
<meta name="twitter:description" content="{esc(desc)}">
<meta name="twitter:image" content="{DOMAIN}/assets/banner1.webp">
<meta name="theme-color" content="#0e1a2c">
<link rel="icon" href="/assets/logo-white.webp">
<script type="application/ld+json">{json.dumps(biz_ld)}</script>
<script type="application/ld+json">{json.dumps(faq_ld)}</script>
<script type="application/ld+json">{json.dumps(crumb_ld)}</script>
<style>{CSS}</style>
</head>
<body>
<header><div class="wrap">
  <a class="brand" href="{DOMAIN}/" aria-label="Always Precise Investigations home" style="background:#fff;border-radius:12px;padding:8px 14px;display:inline-flex;align-items:center"><img src="/assets/logo-lockup.svg" alt="Always Precise Investigations" style="height:48px;width:auto" width="240" height="68"></a>
  <a class="call" href="tel:{PHONE_LINK}">Call {PHONE_DISPLAY}</a>
</div></header>

<div class="hero"><div class="wrap">
  <p class="eyebrow">Serving {esc(place)}, Virginia</p>
  <h1>Private Investigator in {esc(place)}, VA</h1>
  <p class="lede">Licensed, insured, and working in {esc(area_line)} since 2014 — surveillance,
  cheating-spouse and adultery evidence, background checks, custody documentation, insurance claim
  work and investigative support for law firms. Covering {esc(covers)}. Free confidential
  consultation.</p>
</div></div>

<section><div class="wrap">
  <h2>Investigations in {esc(place)}</h2>
  <p>{esc(place)} is {esc(detail)}, reached on {esc(corridor)}. We work this area regularly, which
  matters more than it sounds: effective surveillance depends on knowing the roads, the traffic
  patterns, and where a vehicle can sit without drawing attention. Cases here are typically filed
  through {esc(court)}, and every report we produce is written to be usable there.</p>
  <div class="grid">
    {cards_html}
  </div>
</div></section>

<section><div class="wrap">
  <h2>What working {esc(place)} actually involves</h2>
  <p>{esc(p["ground"])}</p>
</div></section>

<section><div class="wrap">
  <h2>Insurance claim investigations in {esc(place)}</h2>
  <p>{esc(p["ins"])}</p>
  <p>We take assignments from carriers, third-party administrators, self-insured employers and
  defense firms — surveillance, activity documentation and factual investigative reporting, worked
  to a written authorization and invoiced against it. {esc(place)} is reached on {esc(corridor)},
  so coverage here does not carry a travel line. Nothing is charged at assignment, and rates
  are confirmed with you before the work is accepted.
  <a href="{DOMAIN}/insurance-investigations/">How we work claims</a> &middot;
  <a href="{DOMAIN}/intake/?assignment=insurance">Submit an assignment</a></p>
</div></section>

<section><div class="wrap">
  <h2>Support for {esc(place)} law firms and attorneys</h2>
  <p>{esc(p["legal"])}</p>
  <p>Attorneys, paralegals and legal departments open a matter through the legal assignment intake,
  which records the firm, the responsible attorney and the day-to-day contact separately and issues
  a request number immediately. Firms are billed by invoice.
  <a href="{DOMAIN}/legal-investigations/">How we support counsel</a> &middot;
  <a href="{DOMAIN}/intake/?assignment=legal">Submit a legal assignment</a></p>
</div></section>

<section><div class="wrap">
  <h2>Suspecting a cheating spouse in {esc(place)}</h2>
  <p>Most people who call us about infidelity in {esc(place)} have already been sure for a while —
  what they lack is something other than their own certainty. That gap matters in Virginia, because
  adultery is a fault ground for divorce here and courts apply a demanding evidentiary standard: a
  spouse's testimony alone is generally not treated as sufficient, and independent corroboration is
  what makes the difference.</p>
  <p>What we provide is documentation, not opinion — dated, time-stamped video and a written report of
  what was observed, prepared so your attorney can use it. What we do not do is trespass, record private
  conversations we have no right to record, place tracking devices on vehicles we have no authority to
  touch, or access accounts. Evidence gathered improperly can be excluded and can create legal exposure
  for the client who asked for it; a licensed investigator is worth having precisely because the
  documentation holds up.</p>
  <p class="disclaim">Nothing here is legal advice. Questions about grounds for divorce, custody, or how
  evidence will be treated in your case belong with a Virginia family-law attorney.</p>
</div></section>

<section><div class="wrap faq">
  <h2>Common questions — {esc(place)}</h2>
  {faq_html}
</div></section>

<section><div class="wrap">
  <h2>Nearby areas we serve</h2>
  <div class="near">{near_html}<a href="{DOMAIN}/private-investigator/">All service areas</a></div>
  <div class="cta">
    <h2>Talk it through, confidentially</h2>
    <p>A first conversation costs nothing and commits you to nothing. We will tell you honestly
    whether an investigation is likely to get you what you need.</p>
    <a class="btn" href="tel:{PHONE_LINK}">Call {PHONE_DISPLAY}</a>
  </div>
</div></section>

<footer><div class="wrap">
  <div class="row"><strong>Always Precise Investigations, LLC</strong></div>
  <div class="row"><a href="tel:{PHONE_LINK}">{PHONE_DISPLAY}</a> &middot; <a href="mailto:{EMAIL}">{EMAIL}</a></div>
  <div class="row">{LICENSE} &middot; Licensed and Insured &middot; Serving Virginia since 2014</div>
  <div class="row"><a href="{DOMAIN}/">Home</a> &middot; <a href="{DOMAIN}/private-investigator/">Service areas</a> &middot; <a href="{DOMAIN}/infidelity-investigations/">Infidelity</a> &middot; <a href="{DOMAIN}/child-custody-investigations/">Child custody</a> &middot; <a href="{DOMAIN}/insurance-investigations/">Insurance claims</a> &middot; <a href="{DOMAIN}/legal-investigations/">Legal</a> &middot; <a href="{DOMAIN}/privacy">Privacy</a></div>
</div></footer>
<script src="/beacon.js" defer></script>
</body>
</html>
"""
def hub():
    url = f"{DOMAIN}/private-investigator/"
    title = "Private Investigator Near Me | Central Virginia"
    desc = ("Licensed private investigators in Lynchburg, Roanoke, Charlottesville, Danville and "
            "nearby Virginia counties. Free consult: " + PHONE_DISPLAY + ".")
    # The hub used to be a bare row of city names — 221 words and an ItemList,
    # the thinnest page on the site, on the URL aimed at "private investigator
    # near me". Each area now carries what it actually covers and where its
    # cases are heard, so the link says something and the page has a reason to
    # rank on its own rather than only as a signpost.
    items = "".join(
        f'<div class="card"><h3><a href="{DOMAIN}/private-investigator/{q["slug"]}/">'
        f'{esc(q["place"])}, VA</a></h3>'
        f'<p>{esc(q["covers"])}. Reached on {esc(q["corridor"])}; cases heard in '
        f'{esc(q["court"])}.</p></div>'
        for q in PLACES)
    hub_faqs = [
        ("What areas of Virginia do you cover?",
         "Our regular service area runs from Roanoke east to Charlottesville and south to the North "
         "Carolina line — Lynchburg, Bedford, Roanoke, Charlottesville, Farmville and Danville, plus "
         "the counties around each. There is no separate mileage or travel charge anywhere inside "
         "it. Work outside the area is quoted and agreed before the assignment is accepted."),
        ("Do you charge travel or mileage to reach my area?",
         "No. Anywhere in the service area listed on this page, travel and mileage are inside the "
         "quoted price rather than added afterwards. The same applies to tolls, parking, database "
         "and record fees, video review and report preparation — the quoted price is the invoiced "
         "price."),
        ("Do you work for insurance carriers and law firms as well as private clients?",
         "Yes — those are three separate intake paths, deliberately. Carriers, third-party "
         "administrators and self-insured employers submit claim assignments; law firms, attorneys "
         "and paralegals open legal matters; private clients start with a free confidential "
         "consultation. Each is handled under its own terms and billing arrangement."),
        ("How soon can someone be out?",
         "Most matters can be scheduled within a few days, and urgent ones sooner. Timing tends to "
         "matter more than people expect: patterns are easiest to document while they are still "
         "active, so it is worth calling before a situation settles."),
    ]
    faq_html = "".join(f"<h3>{esc(q)}</h3><p>{esc(a)}</p>" for q, a in hub_faqs)
    ld = {"@context": "https://schema.org", "@type": "ItemList",
          "name": "Central Virginia service areas",
          "itemListElement": [{"@type": "ListItem", "position": i + 1, "name": f'{q["place"]}, VA',
                               "url": f'{DOMAIN}/private-investigator/{q["slug"]}/'}
                              for i, q in enumerate(PLACES)]}
    # The hub carried an ItemList and nothing else — no business entity and no
    # breadcrumb, the only page in this set missing both.
    hub_biz = {
        "@context": "https://schema.org", "@type": "ProfessionalService",
        "name": "Always Precise Investigations, LLC",
        "description": "Licensed private investigation firm serving Central Virginia since 2014.",
        "telephone": PHONE_LINK, "email": EMAIL, "url": url,
        "areaServed": [{"@type": "Place", "name": f'{q["place"]}, Virginia'} for q in PLACES],
        "address": ADDRESS, "geo": GEO, "openingHoursSpecification": HOURS,
        "foundingDate": "2014", "priceRange": "$$",
        "identifier": {"@type": "PropertyValue", "name": "Virginia DCJS license", "value": "11-9159"},
        "sameAs": [FACEBOOK, GBP_URL]}
    hub_faq_ld = {"@context": "https://schema.org", "@type": "FAQPage",
                  "mainEntity": [{"@type": "Question", "name": q,
                                  "acceptedAnswer": {"@type": "Answer", "text": a}}
                                 for q, a in hub_faqs]}
    hub_crumb = {"@context": "https://schema.org", "@type": "BreadcrumbList",
                 "itemListElement": [
                     {"@type": "ListItem", "position": 1, "name": "Always Precise Investigations",
                      "item": f"{DOMAIN}/"},
                     {"@type": "ListItem", "position": 2, "name": "Service areas", "item": url}]}
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)}</title>
<meta name="description" content="{esc(desc)}">
<link rel="canonical" href="{url}">
<meta name="robots" content="max-image-preview:large">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Always Precise Investigations">
<meta property="og:locale" content="en_US">
<meta property="og:url" content="{url}">
<meta property="og:title" content="{esc(title)}">
<meta property="og:description" content="{esc(desc)}">
<meta property="og:image" content="{DOMAIN}/assets/banner1.webp">
<meta property="og:image:alt" content="Always Precise Investigations — licensed private investigators in Virginia">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{esc(title)}">
<meta name="twitter:description" content="{esc(desc)}">
<meta name="twitter:image" content="{DOMAIN}/assets/banner1.webp">
<meta name="theme-color" content="#0e1a2c">
<link rel="icon" href="/assets/logo-white.webp">
<script type="application/ld+json">{json.dumps(ld)}</script>
<script type="application/ld+json">{json.dumps(hub_biz)}</script>
<script type="application/ld+json">{json.dumps(hub_faq_ld)}</script>
<script type="application/ld+json">{json.dumps(hub_crumb)}</script>
<style>{CSS}</style>
</head>
<body>
<header><div class="wrap">
  <a class="brand" href="{DOMAIN}/" aria-label="Always Precise Investigations home" style="background:#fff;border-radius:12px;padding:8px 14px;display:inline-flex;align-items:center"><img src="/assets/logo-lockup.svg" alt="Always Precise Investigations" style="height:48px;width:auto" width="240" height="68"></a>
  <a class="call" href="tel:{PHONE_LINK}">Call {PHONE_DISPLAY}</a>
</div></header>

<div class="hero"><div class="wrap">
  <p class="eyebrow">Central Virginia</p>
  <h1>Looking for a private investigator near you?</h1>
  <p class="lede">We are licensed and insured in Virginia and have worked Central Virginia since 2014 —
  from Lynchburg and Roanoke to Charlottesville, Danville, Farmville and the counties in between. Pick
  your area below, or simply call; the first conversation is free and confidential.</p>
</div></div>

<section><div class="wrap">
  <h2>What we handle</h2>
  <p>Infidelity and adultery documentation, covert surveillance, child-custody evidence, background
  checks, <a href="{DOMAIN}/insurance-investigations/">workers' compensation and auto-claim investigation</a>,
  and process serving. Surveillance is quoted
  by the hour with no hidden mileage or travel fees anywhere in the service area below.</p>
  <p>We also work two sides of the business that are not private-client matters at all:
  <a href="{DOMAIN}/insurance-investigations/">insurance claim assignments</a> for carriers,
  third-party administrators, self-insured employers and defense firms, and
  <a href="{DOMAIN}/legal-investigations/">investigative support for law firms and attorneys</a>.
  Each has its own intake and its own billing arrangement.</p>
  <p>Virginia treats adultery as a fault ground for divorce and holds it to a demanding evidentiary
  standard, which is why independent documentation matters so much more here than a spouse's own
  certainty. Every report is written to be usable by your attorney.</p>
  <p class="disclaim">Nothing on this site is legal advice — questions about your case belong with a
  Virginia attorney.</p>
</div></section>

<section><div class="wrap">
  <h2>Service areas</h2>
  <p>Every area below is inside the regular service area — no separate travel or mileage charge
  anywhere in it. Pick the one nearest you for local detail, or call and we will tell you which
  applies.</p>
  <div class="grid">{items}</div>
</div></section>

<section><div class="wrap faq">
  <h2>Common questions</h2>
  {faq_html}
</div></section>

<section><div class="wrap">
  <div class="cta">
    <h2>Not sure whether you need an investigator?</h2>
    <p>Call and describe the situation. We will tell you honestly whether an investigation is likely to
    get you what you need — and if it is not, we will say so.</p>
    <a class="btn" href="tel:{PHONE_LINK}">Call {PHONE_DISPLAY}</a>
  </div>
</div></section>

<footer><div class="wrap">
  <div class="row"><strong>Always Precise Investigations, LLC</strong></div>
  <div class="row"><a href="tel:{PHONE_LINK}">{PHONE_DISPLAY}</a> &middot; <a href="mailto:{EMAIL}">{EMAIL}</a></div>
  <div class="row">{LICENSE} &middot; Licensed and Insured &middot; Serving Virginia since 2014</div>
  <div class="row"><a href="{DOMAIN}/">Home</a> &middot; <a href="{DOMAIN}/infidelity-investigations/">Infidelity</a> &middot; <a href="{DOMAIN}/child-custody-investigations/">Child custody</a> &middot; <a href="{DOMAIN}/insurance-investigations/">Insurance claims</a> &middot; <a href="{DOMAIN}/legal-investigations/">Legal</a> &middot; <a href="{DOMAIN}/privacy">Privacy</a></div>
</div></footer>
<script src="/beacon.js" defer></script>
</body>
</html>
"""

def main():
    os.makedirs("private-investigator", exist_ok=True)
    open("private-investigator/index.html", "w").write(hub())
    for p in PLACES:
        d = os.path.join("private-investigator", p["slug"])
        os.makedirs(d, exist_ok=True)
        open(os.path.join(d, "index.html"), "w").write(page(p))

    # Dropping a place from PLACES has to remove its page too — otherwise the
    # folder stays behind and keeps serving a service area we no longer cover,
    # invisibly, because it is gone from the sitemap and the hub.
    for name in sorted(os.listdir("private-investigator")):
        d = os.path.join("private-investigator", name)
        if os.path.isdir(d) and name not in BY_SLUG:
            for f in os.listdir(d):
                os.remove(os.path.join(d, f))
            os.rmdir(d)
            print(f"removed retired location page: {name}")
    # sitemap
    # The sitemap is regenerated wholesale below, so every non-generated page has
    # to be listed here too — otherwise a rebuild silently drops it. The three
    # service pages are hand-written and live outside PLACES.
    urls = [(f"{DOMAIN}/", "1.0", "monthly", "2026-09-04"),
            (f"{DOMAIN}/infidelity-investigations/", "0.9", "monthly", CONTENT_REVISED),
            (f"{DOMAIN}/child-custody-investigations/", "0.9", "monthly", CONTENT_REVISED),
            (f"{DOMAIN}/insurance-investigations/", "0.9", "monthly", CONTENT_REVISED),
            (f"{DOMAIN}/insurance-investigations/vendor-information/", "0.5", "yearly", CONTENT_REVISED),
            # Legal is hand-written like the three service pages above it, and it is
            # MEANT TO BE INDEXED (Unit 37A). It was added to sitemap.xml by hand and
            # never added here, so the next regeneration would have dropped it — and
            # test-deploy.mjs asserts it is present, so the FAILING GUARD WOULD HAVE
            # FROZEN THE WHOLE SITE DEPLOY, exactly as on 2026-08-14. A page that is
            # not in this list is not in the sitemap after the next rebuild.
            (f"{DOMAIN}/legal-investigations/", "0.9", "monthly", CONTENT_REVISED),
            (f"{DOMAIN}/private-investigator/", "0.9", "monthly", CONTENT_REVISED)]
    urls += [(f'{DOMAIN}/private-investigator/{q["slug"]}/', "0.8", "monthly", CONTENT_REVISED)
             for q in PLACES]
    body = "".join(
        f"  <url>\n    <loc>{u}</loc>\n    <lastmod>{m}</lastmod>\n"
        f"    <changefreq>{c}</changefreq>\n    <priority>{p}</priority>\n  </url>\n"
        for u, p, c, m in urls)
    open("sitemap.xml", "w").write(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + body + "</urlset>\n")
    print(f"built hub + {len(PLACES)} location pages; sitemap has {len(urls)} urls")

if __name__ == "__main__":
    main()
