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

# (slug, place, kind, county, courthouse venue, distinguishing detail, nearby slugs)
PLACES = [
    ("lynchburg-va", "Lynchburg", "city", "Central Virginia",
     "Lynchburg Circuit Court",
     "the Hill City on the James River, bordered by Campbell, Bedford and Amherst counties",
     ["forest-va", "madison-heights-va", "rustburg-va", "amherst-va"]),
    ("forest-va", "Forest", "community", "Bedford County",
     "Bedford County Circuit Court",
     "the residential corridor along Route 221 just west of Lynchburg",
     ["lynchburg-va", "bedford-va", "amherst-va"]),
    ("madison-heights-va", "Madison Heights", "community", "Amherst County",
     "Amherst County Circuit Court",
     "the community directly across the James River from Lynchburg",
     ["lynchburg-va", "amherst-va", "forest-va"]),
    ("bedford-va", "Bedford", "town", "Bedford County",
     "Bedford County Circuit Court",
     "the county seat below the Peaks of Otter",
     ["forest-va", "lynchburg-va", "altavista-va"]),
    ("amherst-va", "Amherst", "town", "Amherst County",
     "Amherst County Circuit Court",
     "the county seat north of the James River",
     ["madison-heights-va", "lynchburg-va", "lovingston-va"]),
    ("rustburg-va", "Rustburg", "town", "Campbell County",
     "Campbell County Circuit Court",
     "the Campbell County seat south of Lynchburg",
     ["lynchburg-va", "altavista-va", "brookneal-va"]),
    ("altavista-va", "Altavista", "town", "Campbell County",
     "Campbell County Circuit Court",
     "the Staunton River town on Route 29 south of Lynchburg",
     ["rustburg-va", "brookneal-va", "gretna-va"]),
    ("brookneal-va", "Brookneal", "town", "Campbell County",
     "Campbell County Circuit Court",
     "the Staunton River town in southern Campbell County",
     ["altavista-va", "rustburg-va", "south-boston-va"]),
    ("appomattox-va", "Appomattox", "town", "Appomattox County",
     "Appomattox County Circuit Court",
     "the county seat east of Lynchburg on Route 460",
     ["lynchburg-va", "farmville-va", "rustburg-va"]),
    ("farmville-va", "Farmville", "town", "Prince Edward County",
     "Prince Edward County Circuit Court",
     "the Prince Edward County seat and home of Longwood University",
     ["appomattox-va", "cumberland-va", "buckingham-va"]),
    ("charlottesville-va", "Charlottesville", "city", "Central Virginia",
     "Charlottesville Circuit Court",
     "the independent city surrounded by Albemarle County and home to the University of Virginia",
     ["scottsville-va", "palmyra-va", "lovingston-va"]),
    ("scottsville-va", "Scottsville", "town", "Albemarle County",
     "Albemarle County Circuit Court",
     "the James River town at the southern edge of Albemarle County",
     ["charlottesville-va", "palmyra-va", "lovingston-va"]),
    ("palmyra-va", "Palmyra", "community", "Fluvanna County",
     "Fluvanna County Circuit Court",
     "the Fluvanna County seat on the Rivanna River",
     ["charlottesville-va", "scottsville-va", "louisa-va"]),
    ("louisa-va", "Louisa", "town", "Louisa County",
     "Louisa County Circuit Court",
     "the Louisa County seat east of Charlottesville",
     ["palmyra-va", "charlottesville-va"]),
    ("lovingston-va", "Lovingston", "community", "Nelson County",
     "Nelson County Circuit Court",
     "the Nelson County seat along Route 29 between Lynchburg and Charlottesville",
     ["amherst-va", "charlottesville-va", "scottsville-va"]),
    ("buckingham-va", "Buckingham", "community", "Buckingham County",
     "Buckingham County Circuit Court",
     "the county seat at the geographic center of Virginia",
     ["farmville-va", "cumberland-va", "dillwyn-va"]),
    ("dillwyn-va", "Dillwyn", "town", "Buckingham County",
     "Buckingham County Circuit Court",
     "the Route 15 town in Buckingham County",
     ["buckingham-va", "farmville-va"]),
    ("cumberland-va", "Cumberland", "community", "Cumberland County",
     "Cumberland County Circuit Court",
     "the Cumberland County seat between Farmville and Powhatan",
     ["farmville-va", "buckingham-va", "powhatan-va"]),
    ("powhatan-va", "Powhatan", "community", "Powhatan County",
     "Powhatan County Circuit Court",
     "the county seat west of Richmond on Route 60",
     ["cumberland-va", "richmond-va"]),
    ("danville-va", "Danville", "city", "Southside Virginia",
     "Danville Circuit Court",
     "the Dan River city on the North Carolina line",
     ["chatham-va", "gretna-va", "south-boston-va"]),
    ("chatham-va", "Chatham", "town", "Pittsylvania County",
     "Pittsylvania County Circuit Court",
     "the Pittsylvania County seat on Route 29",
     ["danville-va", "gretna-va", "altavista-va"]),
    ("gretna-va", "Gretna", "town", "Pittsylvania County",
     "Pittsylvania County Circuit Court",
     "the northern Pittsylvania County town on Route 29",
     ["chatham-va", "altavista-va", "danville-va"]),
    ("south-boston-va", "South Boston", "town", "Halifax County",
     "Halifax County Circuit Court",
     "the Dan River town in Halifax County",
     ["halifax-va", "danville-va", "brookneal-va"]),
    ("halifax-va", "Halifax", "town", "Halifax County",
     "Halifax County Circuit Court",
     "the Halifax County seat",
     ["south-boston-va", "danville-va"]),
    ("richmond-va", "Richmond", "city", "Central Virginia",
     "Richmond Circuit Court",
     "the state capital on the fall line of the James River",
     ["powhatan-va", "cumberland-va"]),
]
BY_SLUG = {p[0]: p for p in PLACES}

CSS = """
*{margin:0;padding:0;box-sizing:border-box}
:root{--navy:#0e1a2c;--navy-2:#13273f;--card:#16283f;--line:#26405c;
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

def page(slug, place, kind, county, court, detail, nearby):
    url = f"{DOMAIN}/private-investigator/{slug}/"
    # Pick the longest title/description that still fits search-display limits.
    title = pick([
        f"Private Investigator {place}, VA | Cheating & Surveillance",
        f"Private Investigator {place}, VA | Surveillance",
        f"Private Investigator {place}, VA",
    ], 62)
    desc = pick([
        f"Licensed PI serving {place}, VA. Surveillance, cheating spouse and adultery evidence, "
        f"background checks. Free confidential consult: {PHONE_DISPLAY}.",
        f"Licensed PI serving {place}, VA. Surveillance, adultery evidence, background checks. "
        f"Free consult: {PHONE_DISPLAY}.",
        f"Licensed private investigator serving {place}, VA. Free consult: {PHONE_DISPLAY}.",
    ], 160)
    area_line = f"{place} and {county}" if county not in ("Central Virginia", "Southside Virginia") else place

    faqs = [
        (f"How much does a private investigator cost in {place}?",
         "Cost depends on the type of case and the hours involved. Surveillance is quoted by the hour, "
         "background research is usually a flat fee, and we quote every case before any work begins — "
         "with no hidden mileage or travel charges anywhere in our service area. Call for a free, "
         "confidential quote."),
        (f"Can you prove adultery for a divorce case in {place}?",
         "Virginia treats adultery as a fault ground for divorce, and courts there apply a high evidentiary "
         "standard — a spouse's own suspicion or testimony is generally not enough on its own, so "
         "independent corroboration matters. We document activity with time-stamped video and detailed "
         "written reports prepared to be usable by your attorney and, if needed, in " + court + ". "
         "We do not give legal advice; your attorney decides how evidence is used."),
        (f"Will my spouse or the subject know I hired an investigator in {place}?",
         "No. Surveillance is covert by design, and our work with you is confidential. Investigators use "
         "unmarked vehicles and keep their distance; the goal is documentation without any change in the "
         "subject's behavior."),
        (f"How quickly can an investigator get to {place}?",
         f"{place} sits inside our regular Central Virginia service area, so most cases can be scheduled "
         "within a few days — and urgent matters sooner. Timing often matters more than people expect: "
         "patterns are easiest to document while they are still active."),
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
        "telephone": "+14349070975", "email": EMAIL, "url": url,
        "areaServed": {"@type": "Place", "name": f"{place}, Virginia"},
        "address": {"@type": "PostalAddress", "addressRegion": "VA", "addressCountry": "US"},
        "foundingDate": "2014", "priceRange": "$$",
        "sameAs": ["https://www.facebook.com/AlwaysPreciseInvestigations/"]
    }
    crumb_ld = {
        "@context": "https://schema.org", "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Service areas", "item": f"{DOMAIN}/private-investigator/"},
            {"@type": "ListItem", "position": 2, "name": f"{place}, VA", "item": url}]
    }

    near_html = "".join(
        f'<a href="{DOMAIN}/private-investigator/{n}/">{esc(BY_SLUG[n][1])}</a>'
        for n in nearby if n in BY_SLUG)

    faq_html = "".join(f"<h3>{esc(q)}</h3><p>{esc(a)}</p>" for q, a in faqs)

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
<link rel="icon" href="{DOMAIN}/assets/logo-white.webp">
<script type="application/ld+json">{json.dumps(biz_ld)}</script>
<script type="application/ld+json">{json.dumps(faq_ld)}</script>
<script type="application/ld+json">{json.dumps(crumb_ld)}</script>
<style>{CSS}</style>
</head>
<body>
<header><div class="wrap">
  <a class="brand" href="{DOMAIN}/">Always Precise Investigations</a>
  <a class="call" href="tel:{PHONE_LINK}">Call {PHONE_DISPLAY}</a>
</div></header>

<div class="hero"><div class="wrap">
  <p class="eyebrow">Serving {esc(place)}, Virginia</p>
  <h1>Private Investigator in {esc(place)}, VA</h1>
  <p class="lede">Licensed, insured, and working in {esc(area_line)} since 2014 — surveillance,
  cheating-spouse and adultery evidence, background checks, custody documentation and process serving.
  Free confidential consultation.</p>
</div></div>

<section><div class="wrap">
  <h2>Investigations in {esc(place)}</h2>
  <p>{esc(place)} is {esc(detail)}. We work this area regularly, which matters more than it sounds:
  effective surveillance depends on knowing the roads, the traffic patterns, and where a vehicle can sit
  without drawing attention. Cases here are typically filed through {esc(court)}, and every report we
  produce is written to be usable there.</p>
  <div class="grid">
    <div class="card"><h3>Cheating &amp; infidelity</h3><p>Discreet documentation when you need to know — time-stamped video, written timelines, and photographs.</p></div>
    <div class="card"><h3>Adultery evidence for divorce</h3><p>Independent corroboration prepared for your attorney, meeting the standard Virginia courts expect.</p></div>
    <div class="card"><h3>Surveillance</h3><p>Covert, documented, and quoted by the hour — no hidden mileage or travel fees in our service area.</p></div>
    <div class="card"><h3>Child custody</h3><p>Documentation of conditions, conduct and third-party contact relevant to custody proceedings.</p></div>
    <div class="card"><h3>Background checks</h3><p>For employers, landlords, volunteer organizations, and personal peace of mind.</p></div>
    <div class="card"><h3>Process serving</h3><p>Prompt, documented service of legal papers throughout the area.</p></div>
  </div>
</div></section>

<section><div class="wrap">
  <h2>Suspecting a cheating spouse in {esc(place)}</h2>
  <p>Most people who call us about infidelity have already been sure for a while — what they lack is
  something other than their own certainty. That gap matters in Virginia, because adultery is a fault
  ground for divorce here and courts apply a demanding evidentiary standard: a spouse's testimony alone
  is generally not treated as sufficient, and independent corroboration is what makes the difference.</p>
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
  <div class="row"><a href="{DOMAIN}/">Home</a> &middot; <a href="{DOMAIN}/private-investigator/">Service areas</a> &middot; <a href="{DOMAIN}/privacy">Privacy</a></div>
</div></footer>
<script src="/beacon.js" defer></script>
</body>
</html>
"""

def hub():
    url = f"{DOMAIN}/private-investigator/"
    title = "Private Investigator Near Me | Central Virginia"
    desc = ("Licensed private investigators across Central Virginia — Lynchburg, Charlottesville, "
            "Danville, Farmville and nearby counties. Free consult: " + PHONE_DISPLAY + ".")
    items = "".join(
        f'<a href="{DOMAIN}/private-investigator/{s}/">{esc(p)}</a>' for s, p, *_ in PLACES)
    ld = {"@context": "https://schema.org", "@type": "ItemList",
          "name": "Central Virginia service areas",
          "itemListElement": [{"@type": "ListItem", "position": i + 1, "name": f"{p}, VA",
                               "url": f"{DOMAIN}/private-investigator/{s}/"}
                              for i, (s, p, *_) in enumerate(PLACES)]}
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
<link rel="icon" href="{DOMAIN}/assets/logo-white.webp">
<script type="application/ld+json">{json.dumps(ld)}</script>
<style>{CSS}</style>
</head>
<body>
<header><div class="wrap">
  <a class="brand" href="{DOMAIN}/">Always Precise Investigations</a>
  <a class="call" href="tel:{PHONE_LINK}">Call {PHONE_DISPLAY}</a>
</div></header>

<div class="hero"><div class="wrap">
  <p class="eyebrow">Central Virginia</p>
  <h1>Looking for a private investigator near you?</h1>
  <p class="lede">We are licensed and insured in Virginia and have worked Central Virginia since 2014 —
  from Lynchburg and Charlottesville to Danville, Farmville and the counties in between. Pick your area
  below, or simply call; the first conversation is free and confidential.</p>
</div></div>

<section><div class="wrap">
  <h2>What we handle</h2>
  <p>Infidelity and adultery documentation, covert surveillance, child-custody evidence, background
  checks, workers' compensation and auto-claim investigation, and process serving. Surveillance is quoted
  by the hour with no hidden mileage or travel fees anywhere in the service area below.</p>
  <p>Virginia treats adultery as a fault ground for divorce and holds it to a demanding evidentiary
  standard, which is why independent documentation matters so much more here than a spouse's own
  certainty. Every report is written to be usable by your attorney.</p>
  <p class="disclaim">Nothing on this site is legal advice — questions about your case belong with a
  Virginia attorney.</p>
</div></section>

<section><div class="wrap">
  <h2>Service areas</h2>
  <div class="near">{items}</div>
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
  <div class="row"><a href="{DOMAIN}/">Home</a></div>
</div></footer>
<script src="/beacon.js" defer></script>
</body>
</html>
"""

def main():
    os.makedirs("private-investigator", exist_ok=True)
    open("private-investigator/index.html", "w").write(hub())
    for p in PLACES:
        d = os.path.join("private-investigator", p[0])
        os.makedirs(d, exist_ok=True)
        open(os.path.join(d, "index.html"), "w").write(page(*p))
    # sitemap
    urls = [(f"{DOMAIN}/", "1.0", "monthly"),
            (f"{DOMAIN}/private-investigator/", "0.9", "monthly")]
    urls += [(f"{DOMAIN}/private-investigator/{s}/", "0.8", "monthly") for s, *_ in PLACES]
    body = "".join(
        f"  <url>\n    <loc>{u}</loc>\n    <changefreq>{c}</changefreq>\n    <priority>{p}</priority>\n  </url>\n"
        for u, p, c in urls)
    open("sitemap.xml", "w").write(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + body + "</urlset>\n")
    print(f"built hub + {len(PLACES)} location pages; sitemap has {len(urls)} urls")

if __name__ == "__main__":
    main()
