#!/usr/bin/env bash
# Check that a deployed case portal is actually wired up correctly.
#
#   ./case-portal/verify.sh
#   ./case-portal/verify.sh https://alwayspreciseinvestigations.net
#
# Read-only: it creates nothing, changes nothing, and sends no real data. Run it
# after setup, and again after any deploy that touches the Worker.
set -uo pipefail

SITE="${1:-https://alwayspreciseinvestigations.net}"
API="$SITE/portal-api"
PASS=0
FAIL=0

ok()   { printf '  PASS  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  FAIL  %s\n'   "$1"; printf '        %s\n' "$2"; FAIL=$((FAIL+1)); }
note() { printf '  ----  %s\n' "$1"; }

curljson() { curl -sS --max-time 20 "$@" 2>/dev/null; }
code()     { local c; c=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' "$@" 2>/dev/null); echo "${c:-000}"; }

printf '\nChecking %s\n\n' "$SITE"

# 1. The Worker answers on the site's own domain. If this fails nothing else
#    matters — a portal on a workers.dev hostname cannot hold a session.
HEALTH=$(curljson "$API/health")
if [ -z "$HEALTH" ]; then
  bad "the Worker answers at /portal-api/" \
      "No response. The route in wrangler.toml is not attached — run 'npx wrangler deploy' from case-portal/."
else
  ok "the Worker answers at /portal-api/ on the site's own domain"

  # 2. Its bindings are present.
  if printf '%s' "$HEALTH" | grep -q '"configured":true'; then
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
  if ! printf '%s' "$HEALTH" | grep -q '"missing_tables"'; then
    bad "every table this build expects is on the database" \
        "health did not report missing_tables at all — this Worker predates the check, so the schema state is unknown rather than clean."
  else
    MISSING=$(printf '%s' "$HEALTH" \
      | sed -n 's/.*"missing_tables":\[\([^]]*\)\].*/\1/p' \
      | tr -d '"' | tr ',' ' ' | tr -s ' ' | sed 's/^ *//; s/ *$//')
    if [ -z "$MISSING" ]; then
      ok "every table this build expects is on the database"
    else
      bad "every table this build expects is on the database" \
          "missing: $MISSING — run the portal-setup workflow (Actions → Set up the case portal → Run workflow). It is idempotent."
    fi
  fi
fi

# 3. The database really has its tables. A missing schema shows up as a 500
#    here rather than at the moment a client submits something.
LOGIN=$(code -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"__verify__","password":"__not-a-real-password__"}')
case "$LOGIN" in
  401) ok "the schema is applied and login is answering" ;;
  500) bad "the schema is applied and login is answering" \
           "500 — the tables are missing. Run: npx wrangler d1 execute api-case-portal --remote --file=case-portal/schema.sql" ;;
  000) bad "the schema is applied and login is answering" "no response from $API/auth/login" ;;
  *)   bad "the schema is applied and login is answering" "expected 401 for bad credentials, got $LOGIN" ;;
esac

# 4. Ingest is closed to anyone without the key.
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

# 6. The portal page is served and is not indexable.
PORTAL_HDRS=$(curl -sS --max-time 20 -D - -o /dev/null "$SITE/portal/" 2>/dev/null)
if printf '%s' "$PORTAL_HDRS" | grep -qi '^HTTP.*200'; then
  ok "the portal page is served at /portal/"
else
  bad "the portal page is served at /portal/" "not returning 200 — has the site deployed since merging?"
fi
if printf '%s' "$PORTAL_HDRS" | grep -qi 'x-robots-tag:.*noindex'; then
  ok "the portal is marked noindex by header"
else
  bad "the portal is marked noindex by header" "_headers is not being applied to /portal/*."
fi
if printf '%s' "$PORTAL_HDRS" | grep -qi 'content-security-policy'; then
  ok "the portal carries a Content-Security-Policy"
else
  bad "the portal carries a Content-Security-Policy" "_headers is not being applied to /portal/*."
fi

# 7. The intake form is wired to the portal.
INTAKE=$(curljson "$SITE/intake/")
if [ -z "$INTAKE" ]; then
  bad "the intake form is wired to the portal" "could not fetch $SITE/intake/ — nothing was checked."
elif printf '%s' "$INTAKE" | grep -q 'PORTAL_INGEST_KEY = "PASTE_INGEST_KEY"'; then
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
if [ -n "$INTAKE" ]; then
  if printf '%s' "$INTAKE" | grep -qE '\$[0-9]'; then
    bad "the intake form publishes no price" \
        "a dollar figure is in the served intake page — pricing belongs in the portal's rate sheets."
  else
    ok "the intake form publishes no price"
  fi
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
ROBOTS=$(curljson "$SITE/robots.txt")
if printf '%s' "$ROBOTS" | grep -qi 'portal'; then
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
