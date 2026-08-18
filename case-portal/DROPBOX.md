# Dropbox — the company App Folder connection (INTERNAL)

Built 2026-08-18 on the owner's instruction: **connect and callback, secrets
only, no file migration yet.** This file is the setup record.

## THE LIVE REDIRECT URI

```
https://alwayspreciseinvestigations.net/portal-api/dropbox/callback
```

Paste that into the Dropbox App Console → your app → **OAuth 2 → Redirect URIs**.
Dropbox matches it **exactly** — scheme, host, path, no trailing slash.

It is **derived in the Worker, never typed**: `SITE_ORIGIN` plus the Worker's own
mount prefix (`/portal-api`). A hand-copied constant that drifted from the route
would fail only in production, and Dropbox requires the same string on both the
authorize call and the token exchange.

## Setting it up, once

1. **Dropbox App Console → Create app**
   - API: **Scoped access**
   - Access type: **App folder** — the app can only ever see its own folder.
   - Name it something the firm recognises; the folder takes that name.
2. **Permissions tab** — tick and submit:
   `account_info.read`, `files.metadata.read`, `files.metadata.write`,
   `files.content.read`, `files.content.write`.
   These are asked for now because re-authorising is a manual act and asking
   twice is worse than asking once.
3. **Settings tab** — add the Redirect URI above.
4. **Two Worker secrets**, and nothing else:

   ```bash
   npx wrangler secret put DROPBOX_APP_KEY    --name api-case-portal
   npx wrangler secret put DROPBOX_APP_SECRET --name api-case-portal
   ```

5. **Run `portal-setup.yml` once** — this adds the `dropbox_auth` table.
6. **Portal → an admin opens `/portal-api/dropbox/connect`**, authorises at
   Dropbox, and lands back in the portal.

## The routes

| Route | Who | Does |
| --- | --- | --- |
| `GET /dropbox/status` | admin | connected, which account, when, and the redirect URI to copy. **Never the token.** |
| `GET /dropbox/connect` | admin | mints a CSRF state, 302s to Dropbox |
| `GET /dropbox/callback` | signed state | verifies state, exchanges the code, **proves the token**, stores it |
| `POST /dropbox/disconnect` | admin | revokes at Dropbox, then forgets it here |

**All four are admin-only**, `/status` included — it names the connected account.
The callback reaches that conclusion differently from the other three: see below.

## What is stored, and what is not

**Secrets only.** `DROPBOX_APP_KEY` and `DROPBOX_APP_SECRET` are Worker secrets.
Neither is in the Worker, the schema, the page or any response — there is a test
that greps for them.

**The refresh token is stored in `dropbox_auth`, one row, id pinned to 1** by a
CHECK — this is the firm's connection, not a per-user login. It is stored because
it is the only part that must outlive the request; **access tokens are minted
from it on demand and never written down**.

**That refresh token is a long-lived credential at rest in D1, and that is worth
saying plainly:** anyone with the database has the firm's App Folder. It is
confined to the App Folder, it can be revoked from the Dropbox account page or by
Disconnect, and **no route returns it** — `/status` reports the account and the
moment, never the token.

**A refresh token supplied as the `DROPBOX_REFRESH_TOKEN` Worker secret still
works and outranks the stored one.** That path predates this flow and an owner
who has already pasted a token is not told they are disconnected.

## How the CSRF state works, and why there is no table for it

The state rides in an **HttpOnly, Secure, SameSite=Lax cookie** scoped to
`/portal-api/dropbox`, ten minutes, cleared on **every** exit from the callback so
it is single-use. Lax is correct and deliberate: Dropbox returns the browser by a
**top-level GET navigation**, which Lax permits and which a cross-site POST could
not forge.

### The callback cannot see the session, and that is browser behaviour

**This shipped wrong and the owner found it live on 2026-08-18:** the callback
returned *"Not signed in"* to an admin who was signed in in the same tab.

`sessionCookie` is **SameSite=Strict**, and a browser does not attach a Strict
cookie to a request that a *different* site navigated to. Dropbox sending the
operator back here is precisely that, so `currentUser` saw no cookie and the
signed-in gate refused the request before the route ever ran.

The reasoning that put the gate there was: *"a state cookie without a session
would let anyone holding the URL complete a connection."* That is wrong. The
state cookie is HttpOnly, Secure and unguessable — holding the callback **URL**
gets you nothing, because the cookie is the half you cannot obtain.

**The fix is not `SameSite=Lax` on the session cookie.** That cookie is the
portal's CSRF defence for every route in the Worker (`originAllowed` describes
itself as defence in depth *behind* it), and relaxing it site-wide to serve one
OAuth return trip is a bad trade. Instead the callback carries its own
credential: the state cookie now holds

```
<random state> . <admin user id> . <expiry> . <HMAC-SHA256 over the three>
```

signed with `DROPBOX_APP_SECRET`. `/dropbox/connect` is the only thing that
mints it and it is still admin-only, so the id in there is an admin's by
construction. Dropbox is handed the **random half only**, so no staff id
reaches Dropbox's logs or the browser's history.

The signature is what makes that id worth trusting. HttpOnly stops a *page*
writing the cookie, but that is weaker than it sounds — a sibling subdomain can
set a `Domain=` cookie this Worker cannot distinguish from its own. Signed, a
forged cookie cannot name an admin it did not come from.

**The admin is re-read from `users` on the way through.** An account demoted or
deactivated between pressing Connect and coming back does not finish the
connection; it gets `unauthorised`.

Using `DROPBOX_APP_SECRET` as the HMAC key is deliberate: HMAC never exposes its
key, the flow cannot run without that secret anyway, and it means no new secret
for the owner to set and no "the key is missing" branch to get wrong.

## The connection is proven before it is claimed

After the exchange the callback reads `/2/users/get_current_account`. If that does
not answer, **the token is not stored at all** and the portal says `unverified`
rather than showing a connection nobody has tested. It is also where the account
email comes from — a connection nobody can identify is a connection nobody can
audit.

## Disconnect revokes first

The token is revoked at Dropbox **before** the row is deleted. Deleting the row
alone would leave a live token on the account with nothing left to revoke it
with — the opposite of disconnecting. If Dropbox cannot be reached the row still
goes, and the answer **says so** rather than implying the token is dead.

## What is deliberately NOT here

**No file migration.** No upload, download, list, move or migrate route exists in
this build, and nothing calls `content.dropboxapi.com` — asserted by test. The
owner's instruction was to build the connection and stop.

`token_access_type=offline` is on the authorize call. Without it Dropbox returns
a four-hour access token and the connection dies overnight.

## Owed after merge

**A manual `portal-setup.yml` dispatch** — `dropbox_auth` is a new table. Every
read is guarded through `missingTables()`: `/status` degrades to "not set up",
and `/connect` returns 503 naming the workflow.
