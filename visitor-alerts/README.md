# Live visitor alerts — setup

A private dashboard at `/watch/` that shows who is on the website right now,
and pushes a notification to your phone when someone arrives.

**How it works.** Each page fires a tiny beacon at a Cloudflare Worker. The
Worker keeps a short rolling log and sends a Web Push "tickle" to your phone;
your phone's service worker then fetches the detail and shows the notification.
Push messages carry no payload, so no visitor information ever passes through
Google's or Apple's push servers.

**Cost:** free. Cloudflare's Workers and KV free tiers cover this many times over.

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
npx wrangler secret put WATCH_PASSWORD      # the passcode he'll type (e.g. TGB1940)
npx wrangler secret put SALT                # any random string
```

Pick a passcode that is not guessable. A short numeric PIN can be brute-forced;
the Worker locks a client out after 8 failed attempts for 15 minutes, which
raises the cost enormously, but length still matters. Mixed letters and digits
(e.g. `TGB1940`) is the minimum worth using.

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

Runs the real Worker against an in-memory KV and a stubbed push service —
33 checks covering origin locking, body limits, path sanitising, bot
filtering, the alert debounce, the auth lockout, beacon rate limiting, push
endpoint validation, CORS behaviour, and error handling. Run it after any
change to `worker.js`; it needs no deployment and no network.

## Behaviour

- **Debounced:** at most one alert per visitor per 15 minutes, so a person
  browsing six pages does not buzz the phone six times.
- **Always alerts** for `/intake` and contact pages, regardless of the debounce —
  those are the high-intent moments worth interrupting for.
- **Dashboard** shows who is on the site now (last 3 minutes), visits today, and
  the recent trail with page, city, referrer, and whether they are returning.
- Alerts collapse under one notification tag, so a burst does not stack up.

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

- Stores page path, referring hostname, coarse city/region from Cloudflare, and
  a **daily-rotating pseudonymous hash** used only to debounce alerts.
- Does **not** store IP addresses or user agents, does not set cookies, does not
  track anyone across sites, and captures **nothing** from the intake form's
  fields — not even keystrokes, and not partial input.
- Honours Do Not Track and Global Privacy Control: those visitors are not logged.
- The log is a small rolling window (120 visits) that overwrites itself; it is
  not an archive.

**Two things to do before this goes live:**

1. Add a line to the site's privacy policy — something like: *"We record
   anonymous page-visit information (page, approximate city, and referring site)
   so we can respond promptly to enquiries. We do not use cookies and do not
   track visitors across other websites."*
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
