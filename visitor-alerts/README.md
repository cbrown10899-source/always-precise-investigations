# Live visitor alerts — setup

A private dashboard at `/watch/` that shows who is on the website right now,
and pushes a notification to your phone when someone arrives.

**How it works.** Each page fires a tiny beacon at a Cloudflare Worker. The
Worker keeps a short rolling log and sends a Web Push "tickle" to your phone;
your phone's service worker then fetches the detail and shows the notification.
Push messages carry no payload, so no visitor information ever passes through
Google's or Apple's push servers.

**Journeys (Live Visitors V2, 2026-10-10).** Beside the rolling log the Worker
keeps each visitor's journey in a D1 database of its own, `api-visitor-journeys`
(binding `VDB`): visits, pages with engaged time, button presses, and — after an
intake is submitted — its request number. The dashboard turns that into a card
per visitor, an explainable interest score, and a journey with exact times. The
full record is `LIVE-VISITORS.md` beside this file.

**Cost:** free. The KV free tier allows 1,000 writes a day, which is why the
journey's check-ins go to D1 (100,000 row writes a day) instead.

---

## 1. Generate push keys

```bash
node visitor-alerts/gen-vapid.mjs
```

Copy the two values it prints.

## 2. Create the two KV namespaces

```bash
cd visitor-alerts
npx wrangler kv namespace create SUBS
npx wrangler kv namespace create HITS
```

Paste the returned ids into `wrangler.toml`, and paste `VAPID_PUBLIC_KEY` into
the `[vars]` block there.

## 3. Set the secrets

```bash
npx wrangler secret put VAPID_PRIVATE_KEY   # from step 1
npx wrangler secret put WATCH_PASSWORD      # the passcode he'll type
npx wrangler secret put SALT                # any random string
```

**Type the secret NAME exactly.** The live Worker's salt was created as
`SALT ` — with a trailing space — so for as long as the Worker existed it read
no salt at all and fell back to a constant this public repository prints
(found 2026-10-10). The Worker now reads the salt by its trimmed name, so the
live secret works as it is; leave it. Renaming it means choosing a new value
(Cloudflare never shows a secret again), and a new salt makes every returning
visitor look new once.

Pick a passcode that is not guessable, and do not write the real one down in
this file — it is committed to a repository. A short numeric PIN can be
brute-forced; the Worker locks a client out after 8 failed attempts for 15
minutes, which raises the cost enormously, but length still matters. Twelve or
more mixed characters from a password manager is the right answer.

## 3b. Journeys: run visitors-setup.yml once

Actions → **Set up Live Visitors journeys** → Run workflow. It creates (or finds)
the D1 database, applies `schema.sql`, uploads the Worker, and attaches the
database as `VDB` while re-listing every existing binding as `inherit`, so the
passcode, the push keys and both KV namespaces carry over by name. It checks
`/health` afterwards and rolls the Worker back to the version it recorded if
anything is missing. Until it has run, everything works exactly as before and
the dashboard shows the page-view log.

## 4. Deploy the Worker

```bash
npx wrangler deploy
```

It prints a URL like `https://api-visitor-alerts.<subdomain>.workers.dev`.
Test it: `curl https://api-visitor-alerts.<subdomain>.workers.dev/health`

## 5. Point the site at the Worker

Replace `YOUR-SUBDOMAIN` with the real value in **both** files:

- `visitor-alerts/beacon.js` — the `API` constant
- `watch/index.html` — the `API` constant near the top of the script

## 6. Deploy the site

`beacon.js` must be served from the site root, and `watch/` must ship as-is.
The beacon `<script>` tag is already on every page.

## 7. Set it up on his phone

1. Open `https://alwayspreciseinvestigations.net/watch/`
2. Enter the passphrase (remembered on that device afterwards)
3. **iPhone:** Share → **Add to Home Screen**, then open it from the home-screen
   icon. iOS only allows web notifications for installed pages — this step is
   required, not optional.
   **Android:** works from the browser; installing is still nicer.
4. Tap **Turn on alerts** and allow notifications
5. Tap **Turn on Face ID** when offered — after that the passcode is only a
   fallback; Face ID (or Touch ID) opens it
6. Visit the site from another device to confirm an alert arrives

---

## Tests

```bash
node visitor-alerts/test-worker.mjs
```

Runs the real Worker against an in-memory KV, real SQLite standing in for D1,
and a stubbed push service — origin locking, body limits, path sanitising, bot
filtering, the alerts, the auth lockout, rate limiting, push endpoint
validation, CORS, error handling, and the journeys: identity, visits, reloads,
engagement caps, the action vocabulary, the intake link, scoring, alerts,
retention and fail-open. Needs Node 22 (node:sqlite), no deployment and no
network.

```bash
node watch/test-watch.mjs
```

The beacon on the real public pages, the intake's hooks and the dashboard at
390, 320 and 1280, in Playwright, against the same Worker in-process.

## Behaviour

With journeys set up:

- **Alerts:** once when a visit starts, once when a visitor crosses into HIGH
  INTENT (at most once a week), and once per submitted intake — never for a
  refresh, another page or a heartbeat.
- **Dashboard** shows the 30-day ticker, who is on the site now (activity in
  the last 3 minutes), visits today, and a card per visitor; tapping one opens
  the journey with exact Eastern times, the score and its reasons.
- **Your own browser** is marked as not counted when you unlock the dashboard
  in it (the toggle is at the bottom of the page).

Without them (before visitors-setup.yml has run):

- **Debounced:** at most one alert per visitor per 15 minutes, so a person
  browsing six pages does not buzz the phone six times.
- **Always alerts** for `/intake` and contact pages, regardless of the debounce.
- **Dashboard** shows the recent page-view trail.

Alerts collapse under one notification tag, so a burst does not stack up.

## Tuning

In `worker.js`: `QUIET_MINUTES` (debounce), `HIGH_INTENT` (always-alert paths),
`MAX_LOG` (visits retained).

## Security

- **Auth:** a shared passcode, compared as a SHA-256 digest in constant time, so
  neither the value nor its length leaks through timing.
- **Lockout:** 8 failed attempts locks that client out for 15 minutes. Without
  this a short passcode would fall to a brute-force script in minutes.
- **Face ID / Touch ID:** after one correct passcode entry the device can
  register a platform authenticator; later opens need only the biometric.
  Stated plainly — this is a convenience lock on an already-trusted device, not
  a second secret: the passcode remains in that device's local storage and
  biometrics gate the interface rather than encrypting it. The protections
  against anyone *else* are the passcode and the server-side lockout.
- **Beacon endpoint:** requires the site's exact `Origin`, caps the body at 2 KB,
  rate-limits to 20 hits per visitor per minute, and normalises the reported
  path so an absolute or protocol-relative URL can never enter the log.
- **Push endpoints** are validated against the known push services, so a stolen
  passcode cannot turn the Worker into a request proxy; devices are capped at 10.
- **CORS** never falls back to a wildcard on an authenticated route.
- **Errors** return a generic message; details go to the Worker log only.

If the passcode is ever exposed: `npx wrangler secret put WATCH_PASSWORD`, then
he re-enters the new one once.

## Privacy

Deliberately minimal, which matters on a site where visitors are often in
sensitive situations:

- The rolling log stores page path, referring hostname, coarse city/region from
  Cloudflare, and a **daily-rotating pseudonym**.
- A journey stores a **salted hash of a random token** the visitor's own browser
  keeps in local storage (never the token itself), the pages and engaged time,
  the buttons pressed, each visit's source and approximate location, and only
  after Submit the intake's request number. Journeys older than 90 days are
  deleted automatically.
- Does **not** store IP addresses or user agents, does not set cookies, does not
  fingerprint, does not track anyone across sites, and captures **nothing**
  typed into the intake form — not values, not field names, not keystrokes.
- Honours Do Not Track and Global Privacy Control: those visitors are not
  recorded at all, and no token is made for them.

**Two things to do before this goes live:**

1. The privacy policy states what is recorded (done 2026-10-10, and
   `.github/test-deploy.mjs` pins it to what the beacon and Worker do).
2. Never extend this to capture form contents. Visitors type case details into
   the intake form; that is confidential client information and capturing it
   before they choose to submit would be a serious breach of trust — and
   plausibly of law.

## If alerts stop arriving

- **iPhone:** confirm it is opened from the home-screen icon, not Safari. iOS
  drops web push permission if the page is removed from the home screen.
- Re-open `/watch/` and tap **Turn on alerts** again — browsers expire push
  subscriptions periodically; the Worker prunes dead ones automatically.
- Check the Worker is alive: `curl <worker-url>/health`
- Confirm the beacon is firing: open the site, then check the dashboard.
