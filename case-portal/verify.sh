#!/usr/bin/env bash
# Check that a deployed case portal is actually wired up correctly.
#
#   ./case-portal/verify.sh
#   ./case-portal/verify.sh https://alwayspreciseinvestigations.net
#
# Read-only: it creates nothing, changes nothing, sends no real data and writes
# nothing to the database — case-portal/test-verify.mjs runs this script
# against the real Worker and fails on any database write. Run it after setup,
# and again after any deploy that touches the Worker.
set -uo pipefail

SITE="${1:-https://alwayspreciseinvestigations.net}"
API="$SITE/portal-api"
PASS=0
FAIL=0

ok()   { printf '  PASS  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  FAIL  %s\n'   "$1"; printf '        %s\n' "$2"; FAIL=$((FAIL+1)); }
note() { printf '  ----  %s\n' "$1"; }

curljson() { curl -sS --max-time 20 "$@" 2>/dev/null; }
# A body is searched with a here-string, never `printf ... | grep -q`. Under
# pipefail that pipeline fails whenever grep finds its match and exits before
# printf has written a large page — so a MATCH early in the intake form read as
# NO match, and the placeholder and price checks passed on the very thing they
# look for. test-verify.mjs plants both near the top of the page.
#
# The body of a 200 answer, or nothing. curl hands back the body of ANY status,
# so a missing file arrives as the site's 404 page — which mentions no portal
# and carries no placeholder, and would pass the checks below without either
# file having been read. A check that reads a page uses this, and must also
# confirm the page is the one it asked for before judging what is in it.
get200()   { local o; o=$(curl -sS --max-time 20 -w '\n%{http_code}' "$@" 2>/dev/null); [ "${o##*$'\n'}" = "200" ] && printf '%s' "${o%$'\n'*}"; return 0; }
code()     { local c; c=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' "$@" 2>/dev/null); echo "${c:-000}"; }

printf '\nChecking %s\n\n' "$SITE"

# 1. The Worker answers on the site's own domain. If this fails nothing else
#    matters — a portal on a workers.dev hostname cannot hold a session.
#    ANY ANSWER IS NOT THE WORKER'S ANSWER. With the route detached, Pages
#    answers /portal-api/health itself with the site's 404 page — a body, so a
#    non-empty test passed on exactly the failure this check exists to name.
#    The Worker's health always carries "configured", so that is the test.
HEALTH=$(curljson "$API/health")
if [ -z "$HEALTH" ]; then
  bad "the Worker answers at /portal-api/" \
      "No response. The route in wrangler.toml is not attached — run 'npx wrangler deploy' from case-portal/."
elif ! grep -q '"configured":' <<<"$HEALTH"; then
  bad "the Worker answers at /portal-api/" \
      "something answered, but not the portal Worker's health — the route in wrangler.toml is not attached, or another service holds /portal-api/."
else
  ok "the Worker answers at /portal-api/ on the site's own domain"

  # 2. Its bindings are present.
  if grep -q '"configured":true' <<<"$HEALTH"; then
    ok "the D1 binding and INGEST_KEY are both set"
  else
    bad "the D1 binding and INGEST_KEY are both set" \
        "health says configured:false — check database_id in wrangler.toml and 'wrangler secret put INGEST_KEY'."
  fi

  # 2b. EVERY TABLE THIS BUILD EXPECTS IS ACTUALLY THERE.
  #
  #     `/health` has always returned `missing_tables` for exactly this reason —
  #     schema.sql arrives by a MANUAL portal-setup dispatch while the Worker
  #     deploys on push, so between the two a table can be absent and every
  #     route that touches it answers 503. Nothing was reading the field. This
  #     probe fetched it, checked `configured`, and threw the rest away.
  #
  #     It costs no extra request: $HEALTH is already in hand.
  #
  #     THE ABSENT KEY IS NOT AN EMPTY LIST. A Worker old enough not to send
  #     `missing_tables` at all would match an empty-array test and report a
  #     clean schema — the reassuring direction, which is the one this must
  #     never fail in. So the key's presence is checked first.
  #     Since 2026-09-02 the anonymous answer is the COUNT (`schema_missing`);
  #     the table NAMES go only to a signed-in admin, because the list was a
  #     partial map of the schema handed to anyone who asked. Same rule about
  #     absence: no key means unknown, never clean.
  if ! grep -q '"schema_missing"' <<<"$HEALTH"; then
    bad "every table this build expects is on the database" \
        "health did not report schema_missing at all — this Worker predates the check, so the schema state is unknown rather than clean."
  else
    MISSING=$(sed -n 's/.*"schema_missing":\([0-9][0-9]*\).*/\1/p' <<<"$HEALTH")
    if [ "$MISSING" = "0" ]; then
      ok "every table this build expects is on the database"
    else
      bad "every table this build expects is on the database" \
          "$MISSING expected table(s) missing — sign in as an admin to see which, then run the portal-setup workflow (Actions → Set up the case portal → Run workflow). It is idempotent."
    fi
  fi
fi

# 3. Authentication is answering — and nothing here writes to the database.
#
#    The probe that stood here posted a wrong password for "__verify__". That
#    name is inside the account alphabet, so the Worker did what it must with a
#    failed sign-in and recorded it in login_fails: every run of this
#    "read-only" script wrote a production row. A wrong password for a name an
#    account COULD have cannot be probed without that write — recording it is
#    the lockout working — so that path is covered by the Worker suite, and the
#    three probes below cover what can be checked live without leaving anything
#    behind. Do not add a probe here that the Worker would remember.

# 3a. A session the server never issued is refused. The cookie is 32 random
#     bytes, so it matches no session row: the Worker reads sessions and users,
#     finds nothing, and answers 401 — a read, never a write (the only write on
#     that path removes a REAL session that has expired). The same read is the
#     schema check the old probe made: with those tables missing it answers 503.
#     The cookie name must stay the Worker's SESSION_COOKIE, or the Worker
#     ignores the cookie and this quietly becomes check 5; test-verify.mjs pins
#     the two together.
FORGED=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
SESS=$(code "$API/auth/me" -H "Cookie: api_portal=$FORGED")
case "$SESS" in
  401) ok "a session the server never issued is refused" ;;
  503) bad "a session the server never issued is refused" \
           "503 — the database is missing tables. Run the portal-setup workflow (Actions → Set up the case portal → Run workflow); it is idempotent." ;;
  000) bad "a session the server never issued is refused" "no response from $API/auth/me" ;;
  2*)  bad "a session the server never issued is refused" "got $SESS — STOP, a forged session cookie was accepted." ;;
  *)   bad "a session the server never issued is refused" "expected 401, got $SESS" ;;
esac

# 3b. Sign-in answers, and refuses a name no account can have. "verify probe"
#     contains a space, which is outside the account alphabet, so the Worker
#     refuses it before reading or writing login_fails — the guard that stops
#     anonymous callers filling that table with invented names. Never use a
#     name the alphabet accepts here; test-verify.mjs fails if one appears.
LOGIN=$(code -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"verify probe","password":"not-a-password"}')
case "$LOGIN" in
  401) ok "sign-in answers and refuses a name no account can have" ;;
  500|503) bad "sign-in answers and refuses a name no account can have" \
           "$LOGIN — the sign-in route is failing. Check the Worker's logs." ;;
  000) bad "sign-in answers and refuses a name no account can have" "no response from $API/auth/login" ;;
  *)   bad "sign-in answers and refuses a name no account can have" "expected 401, got $LOGIN" ;;
esac

# 3c. A sign-in from another site is refused before any route runs. The
#     Worker answers a foreign Origin with 403 without reaching the sign-in
#     code. It carries the same impossible name, so even a Worker that let the
#     origin through would write nothing.
XSITE=$(code -X POST "$API/auth/login" -H 'Origin: https://verify.invalid' \
  -H 'Content-Type: application/json' -d '{"username":"verify probe","password":"not-a-password"}')
if [ "$XSITE" = "403" ]; then
  ok "a sign-in from another site is refused"
else
  bad "a sign-in from another site is refused" "expected 403, got $XSITE — the Worker's origin check is not answering."
fi

# 4. Ingest is closed to anyone without the key. It is refused at the key
#    check, before the body is read or anything is written.
NOKEY=$(code -X POST "$API/ingest" -H 'Content-Type: application/json' -d '{"case_no":"VERIFY-0000"}')
if [ "$NOKEY" = "401" ]; then
  ok "ingest refuses a submission with no key"
else
  bad "ingest refuses a submission with no key" "expected 401, got $NOKEY — do not go live until this is 401."
fi

# 5. Case data is never readable without a session.
SUBS=$(code "$API/submissions")
if [ "$SUBS" = "401" ]; then
  ok "case data is refused to anyone not signed in"
else
  bad "case data is refused to anyone not signed in" "expected 401, got $SUBS — STOP, this is exposing cases."
fi

# 6. The portal page is served and is not indexable. A 200 is not the portal:
#    a host falling back to its homepage answers 200 at any path, and _headers
#    matches by PATH, so the two header checks below pass over that page too.
#    So the page is read and its title checked.
PORTAL_HDRS=$(curl -sS --max-time 20 -D - -o /dev/null "$SITE/portal/" 2>/dev/null)
PORTAL_PAGE=$(get200 "$SITE/portal/")
if [ -z "$PORTAL_PAGE" ]; then
  bad "the portal page is served at /portal/" "not returning 200 — has the site deployed since merging?"
elif ! grep -q '<title>Case Portal' <<<"$PORTAL_PAGE"; then
  bad "the portal page is served at /portal/" "/portal/ answered 200, but not with the case portal page."
else
  ok "the portal page is served at /portal/"
fi
if grep -qi 'x-robots-tag:.*noindex' <<<"$PORTAL_HDRS"; then
  ok "the portal is marked noindex by header"
else
  bad "the portal is marked noindex by header" "_headers is not being applied to /portal/*."
fi
if grep -qi 'content-security-policy' <<<"$PORTAL_HDRS"; then
  ok "the portal carries a Content-Security-Policy"
else
  bad "the portal carries a Content-Security-Policy" "_headers is not being applied to /portal/*."
fi

# 7. The intake form is wired to the portal. A page with no placeholder in it
#    is only evidence when it is the intake form — the site's 404 page has no
#    placeholder either — so the form's own key assignment must be present.
INTAKE=$(get200 "$SITE/intake/")
if [ -z "$INTAKE" ]; then
  bad "the intake form is wired to the portal" "could not fetch $SITE/intake/ — nothing was checked."
elif ! grep -q 'PORTAL_INGEST_KEY = "' <<<"$INTAKE"; then
  INTAKE=""
  bad "the intake form is wired to the portal" "$SITE/intake/ answered, but not with the intake form — nothing was checked."
elif grep -q 'PORTAL_INGEST_KEY = "PASTE_INGEST_KEY"' <<<"$INTAKE"; then
  # Match the placeholder AS THE ASSIGNED VALUE. The bare string also appears in
  # the page's own guard (`=== "PASTE_INGEST_KEY"`), which made this check fail
  # on a perfectly wired form for as long as the guard has existed.
  bad "the intake form is wired to the portal" \
      "intake/index.html still has the placeholder — submissions will email but record nothing."
else
  ok "the intake form is wired to the portal"
fi

# 8. No price is published anywhere a visitor can reach. Quotes go out from
#    the portal as rate sheets; a figure on the public site is a leak.
#    Only the intake form itself can answer this: a page check 7 could not
#    read, or could not recognise, carries no price and proves nothing.
if [ -z "$INTAKE" ]; then
  bad "the intake form publishes no price" "the intake form was not read (check 7) — nothing was checked."
elif grep -qE '\$[0-9]' <<<"$INTAKE"; then
  bad "the intake form publishes no price" \
      "a dollar figure is in the served intake page — pricing belongs in the portal's rate sheets."
else
  ok "the intake form publishes no price"
fi

# 9. Internal files must 404 on the live site. Each of these was served
#    publicly at some point, which is why each is pinned here.
for f in CLAUDE.md case-portal/PRICING.md case-portal/worker.js \
         portal/test-portal.mjs intake/test-intake.mjs; do
  C=$(code "$SITE/$f")
  case "$C" in
    404) ok "internal file is not served: /$f" ;;
    000) bad "internal file is not served: /$f" "no response — nothing was checked." ;;
    *)   bad "internal file is not served: /$f" "got $C — anything but 404 here needs explaining." ;;
  esac
done

# 10. The admin-only endpoints refuse an unauthenticated caller. Rates and the
#     rate sheets are quotes the firm has not chosen to make yet.
for p in pricing sheets summary users invites; do
  C=$(code "$API/$p")
  if [ "$C" = "401" ]; then
    ok "/portal-api/$p is closed to anyone not signed in"
  else
    bad "/portal-api/$p is closed to anyone not signed in" "expected 401, got $C."
  fi
done

# 11. The portal is hidden, not advertised: robots.txt must not mention it.
#     A file that was never read mentions nothing, so an unreachable site, a
#     404 page or an empty answer must fail here rather than pass: the file is
#     read only from a 200, and only once it carries a User-agent line, as this
#     site's own robots.txt does.
ROBOTS=$(get200 "$SITE/robots.txt")
if [ -z "$ROBOTS" ]; then
  bad "robots.txt does not advertise the portal" \
      "could not fetch $SITE/robots.txt (no 200, or an empty file) — nothing was checked."
elif ! grep -qi '^user-agent:' <<<"$ROBOTS"; then
  bad "robots.txt does not advertise the portal" \
      "$SITE/robots.txt answered, but not with a robots file (no User-agent line) — nothing was checked."
elif grep -qi 'portal' <<<"$ROBOTS"; then
  bad "robots.txt does not advertise the portal" \
      "a portal path is in robots.txt — that hides nothing and points straight at it."
else
  ok "robots.txt does not advertise the portal"
fi

printf '\n  %s passed, %s failed\n\n' "$PASS" "$FAIL"
if [ "$FAIL" -eq 0 ]; then
  note "Two things this cannot check for you:"
  note "  - that BOOTSTRAP_TOKEN was deleted after creating your admin account"
  note "    (a wrong token and a deleted one both answer 401, so probing tells you nothing)"
  note "  - that you are on the Workers Paid plan; on the free plan sign-in can"
  note "    exceed the 10ms CPU limit while everything else keeps working"
  printf '\n'
fi
exit $((FAIL == 0 ? 0 : 1))
