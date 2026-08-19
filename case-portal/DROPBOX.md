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

## Case file storage — where a new file goes

Since 2026-08-18 (owner) **new case photos and generated reports go to the
Dropbox App Folder**, in per-case folders:

```
/<case number>/Photos      images
/<case number>/Reports      documents, and the Final Report PDF
/<case number>/Video        for timestamped copies saved by hand
```

The folder is chosen by the file's **content type**, so a report does not land
among the photographs because of how it happened to be sent. All three folders
are created on a case's first upload, including `Video` — a folder that appears
only once something is in it is a folder nobody trusts.

### The rules this rests on

**New bytes go to Dropbox or nowhere.** There is no R2 fallback and no
double-write. An upload that cannot reach Dropbox is refused and names which of
three conditions it is: `provider_not_configured`, `dropbox_not_connected`, or
`dropbox_unreachable`. A fallback would split one case across two stores, and
nobody would find out until they went looking for the half that moved.

**Nothing was migrated and nothing was deleted.** Every file uploaded before
this change still lives in R2, still serves, and is still what the storage
meter counts. `serveEvidence` — the only place evidence bytes leave the Worker —
reads from whichever store the row names.

**Files are proxied, never linked.** The Worker streams the bytes so the case's
own permission checks stay in front of them. A Dropbox share link would work for
anyone holding it, for as long as it existed, with none of that in front. Do not
add one.

**D1 keeps the structured record; Dropbox keeps the bytes.** There is no
companion table: `case_evidence.r2_key` already means "where the bytes are", so
a Dropbox row records `dropbox:<path>` and that prefix is the whole
discriminator. A second table would be a second place to fall out of step, and —
because `schema.sql` only arrives on a manual `portal-setup` dispatch — a reason
no upload could work until someone ran a workflow.

**The stored filename carries a short random token.** Delete a photo and upload
another of the same name and Dropbox sees no conflict to autorename around, so
the path would repeat and `r2_key`'s UNIQUE constraint would reject the row. The
operator still downloads under the real name; `filename` is untouched.

**The R2 free-tier failsafe now counts only what is in Cloudflare.** Its job is
to stop the R2 free tier ever billing. Counting Dropbox bytes would drive the
storage card toward a cap those files can never reach and eventually refuse
uploads for space nothing was using. The per-file size limit is kept for both —
it is also comfortably inside Dropbox's single-request upload limit.

**Video is still refused by the ordinary upload.** The device-first decision of
2026-08-17 is untouched by this.

## The Final Report PDF

The report is a **real file**, not print-only (owner, 2026-08-18). The completed
package offers **Download PDF** and **Save PDF to Dropbox**, with **Print** kept
as a secondary action.

**The PDF is built on the operator's machine**, from the package document
already rendered on their screen — the same device-first shape as the video
timestamping, and for the same two reasons: this Worker's CPU budget is small
enough that signing in already strains it, and a second server-side rendering of
a document that exists in front of the operator is a second thing to drift.

It is built from **the rendered document**, not from the data behind it, because
`#pkgdoc` is already the one place that decides what a client may see. A PDF
assembled independently would be a second renderer of the same rules, and the
day they disagreed the wrong one would be the one that got posted. The package
is **re-read before the PDF is made**, the same rule printing already follows —
if the re-read fails, no PDF is produced at all.

**No library.** Text in the base-14 fonts plus JPEG images needs no font
embedding and no compression, so the file is written directly rather than
pulling a megabyte of dependency into a page that is deliberately
dependency-free. Line breaking is measured with the browser's own Helvetica
metrics and wrapped to 97% of the column, so a small font substitution shortens
a line rather than running it into the margin.

`POST /portal-api/build/:id/report-pdf` files it in the case's `Reports` folder.
**No R2 copy** (owner, explicit), and **it is not filed as case evidence** — a
report of the case is not material in it, and filing it there would list it in
the gallery and put it under the client-deliverable gate that governs exhibits.
The record is a `build_events` row (`report_pdf_saved`), an existing audit trail
whose `action` column is free text, so nothing had to be widened or added.
Filing twice keeps both files; a corrected report written over the one already
sent to a client would leave no trace that they differ.

## The timestamped video, optionally saved to Dropbox

Owner, Part 2, 2026-08-18. A successfully generated timestamped copy can be sent
to the case's `Video` folder by an explicit action on the video panel. Everything
about that sentence is load-bearing:

- **Optional and explicit.** Nothing uploads by itself. The copy is generated on
  the device and saved to the device exactly as before; this is a second button
  beside that, not a step in the same flow.
- **The original is never touched and never sent.** What goes up is the
  derivative that was just made. The Worker never sees the source clip.
- **The ordinary evidence upload still refuses video by name.** This is a second
  door, not a way around the device-first decision of 2026-08-17. There is a
  test that fails if that refusal ever stops working.
- **No R2 copy, at any size.** The bytes go to the case's `Video` folder and
  nowhere else — which is also why the free-plan failsafe is not consulted here:
  it defends the Cloudflare free tier and nothing on this path goes near it.
- **Not admin-only.** The investigator who shot the footage is the one holding
  it; `caseFor` scopes them to their own cases, which is the boundary that
  matters.

### Why an upload session

`POST /cases/:no/video-stamp/:id/dropbox/{start,append,finish}`.

A surveillance clip is the largest thing this portal moves. A single request
would have to hold the whole file at once — in the browser, in the Worker, and
in one HTTP request that fails as a whole. A session moves it in parts: the
Worker holds **one chunk at a time**, an interrupted upload resumes from its own
offset, and a chunk larger than the agreed size is refused so a caller cannot
decide how much this Worker holds.

**Dropbox is the authority on where a session has got to.** A part sent at the
wrong offset is refused rather than written in the wrong place, and the error
carries the offset so the client can carry on from the right one.

**Cancel needs nothing torn down.** Nothing exists at the destination until
`finish` is called, so an abandoned session leaves no half a file in the case
folder and expires on Dropbox's side. Cancel is a flag the upload loop reads
between parts.

`video_stamp.dropbox_path` records where it went. That column was **reserved
when the table was written and nothing had filled it until now**, so this needed
no new column, no companion table and no `portal-setup` dispatch.

The chunk size is 8 MB, overridable with `DBX_CHUNK_BYTES` for the same reason
the storage caps are overridable: a test that moves a real multi-chunk file
through the real session code proves more than one that moves eight megabytes to
prove the same thing slowly.

## The visible half — what an admin can see and open

Owner, 2026-08-18: *"add visible Dropbox portal UI for Admin: connection status,
account, Open Dropbox Folder, and case links for Photos Reports Video. Use
existing Dropbox backend; do not build a file manager."*

Everything above this section was plumbing the portal never mentioned. An admin
could not tell whether the connection was alive, which account it was, or how to
reach the files outside the portal. **No storage behaviour changed here** — the
routes, the folders and the refusals are exactly as they were.

| Where | What |
| --- | --- |
| Settings → *Dropbox — where case files are stored* | connection state, account, when and by whom, **Open Dropbox**, the App Folder name |
| A case → Case media → *In Dropbox* | one link each to that case's `Photos`, `Reports` and `Video` |

**It is not a file manager, deliberately.** Nothing lists, renames, moves,
deletes or downloads a file. Case media is already in the gallery, proxied
through `serveEvidence` where the case's permission checks are. What this adds
is the one thing the portal genuinely could not do: get you to the folder.

### A Dropbox web link is not a shared link

This is the whole safety of the feature. `https://www.dropbox.com/home/...`
opens **the firm's own Dropbox** in the browser of whoever clicks it: signed in
to that account they see the folder, signed in to any other account they see
nothing. It carries no token and no bytes.

`create_shared_link_with_settings` would be the opposite — a URL that hands the
case files to anyone holding it — and it is **not called anywhere in this
Worker**. A test asserts no `api.dropboxapi.com/2/sharing` call exists at all,
matched on the API URL rather than on the words, so the warning above can name
the endpoint without failing its own guard. Do not add it.

`rel="noopener noreferrer"` is on every one of these links: the portal URL
carries the case number, and it must not ride to Dropbox in a `Referer`.

### The App Folder name cannot be derived, so it is asked for

This app has **App-folder access**, so every path the API returns is relative to
that folder — `/API-1234/Photos`, never `/Apps/<name>/API-1234/Photos`. Dropbox
does not tell an app-folder app what its own folder was called, and the web URL
needs it.

So an admin records it once. It lives in **`app_config`** under `dropbox_folder`
— an existing table, so this needed no schema change and **no `portal-setup`
dispatch stands between the merge and it working**.

**Until it is answered there is no per-case link at all.** `case_url_template`
is `null` rather than a guess, and **Open Dropbox** falls back to
`https://www.dropbox.com/home/Apps`, which is correct plus one click. Sending
someone to a path that may not exist is worse.

**The name builds a web URL and nothing else.** Uploads address the App Folder
root, which needs no name, so a name typed wrong costs a link that lands in the
wrong place in the admin's *own* Dropbox — never a misplaced file. A test
asserts the upload path cannot read the value.

A name carrying `\ / : ? * < > " |` is **refused and named**, not silently
stripped: Dropbox refuses those in a folder name, so a value with one was
mistyped, and quietly editing what an admin typed is how a wrong value looks
right. An empty value **clears** it, and the links go with it.

### One writer for the URL shape

`dropboxWebUrls()` in the Worker is the only place the shape is written. It
returns `web_url` and a `case_url_template` carrying `{case}` and `{folder}`;
the page **substitutes** into that template and assembles no path of its own.
The three folder names are sent in `folders` from `DBX_FOLDERS` — the same list
`dropboxFolderFor` chooses an upload's destination from — so a fourth folder
cannot appear in one place and not the other.

### Admin only, and a failed check is not "disconnected"

`/dropbox/folder` joins the other four as admin-only. An investigator gets 403
from it and from `/status`, and the case panel renders **no** Dropbox links for
them — asserted by a test that also checks no `dropbox.com` address appears in
that panel's markup at all.

The Settings card keeps the three states this project keeps everywhere apart:
**checking**, **loaded**, and **the check failed** — which says so and says
plainly that it means nothing about whether Dropbox is connected.

A connection held as `DROPBOX_REFRESH_TOKEN` carries a token and nothing about
whose account it is. The card says the account is **not recorded** and why,
rather than leaving a blank, and offers no Disconnect it could not honour.
