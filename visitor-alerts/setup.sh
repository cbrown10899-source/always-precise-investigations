#!/usr/bin/env bash
# Always Precise — one-shot setup for the live visitor alerts Worker.
#
#   cd visitor-alerts && bash setup.sh
#
# Creates the KV namespaces, generates push keys, prompts for the secrets,
# deploys the Worker, and prints the URL to paste into the two site files.
# Safe to re-run: existing namespaces are reused.
set -euo pipefail

cd "$(dirname "$0")"
echo
echo "Always Precise — visitor alerts setup"
echo "======================================"

command -v node >/dev/null || { echo "Node.js is required. Install it, then re-run."; exit 1; }

# 1. Push keys ---------------------------------------------------------------
echo
echo "1/5  Generating push keys..."
KEYS="$(node gen-vapid.mjs)"
PUB="$(echo "$KEYS"  | grep 'VAPID_PUBLIC_KEY'  | sed 's/.*= //')"
PRIV="$(echo "$KEYS" | grep 'VAPID_PRIVATE_KEY' | sed 's/.*= //')"
echo "     public key:  ${PUB:0:24}..."

# 2. KV namespaces -----------------------------------------------------------
echo
echo "2/5  Creating KV namespaces (reusing any that exist)..."
create_kv () {
  local binding="$1" out id
  out="$(npx --yes wrangler kv namespace create "$binding" 2>&1 || true)"
  id="$(echo "$out" | grep -oE '[0-9a-f]{32}' | head -1)"
  if [ -z "$id" ]; then
    out="$(npx --yes wrangler kv namespace list 2>/dev/null || true)"
    id="$(echo "$out" | node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        try{const l=JSON.parse(s);const m=l.find(n=>n.title&&n.title.includes(process.argv[1]));
        if(m)console.log(m.id);}catch(e){}
      })' "$binding")"
  fi
  echo "$id"
}
SUBS_ID="$(create_kv SUBS)"
HITS_ID="$(create_kv HITS)"
[ -n "$SUBS_ID" ] && [ -n "$HITS_ID" ] || {
  echo "     Could not determine namespace ids automatically."
  echo "     Run 'npx wrangler kv namespace list', paste the ids into wrangler.toml, then re-run."; exit 1; }
echo "     SUBS=$SUBS_ID"
echo "     HITS=$HITS_ID"

# 3. wrangler.toml -----------------------------------------------------------
echo
echo "3/5  Writing wrangler.toml..."
cp -f wrangler.toml "wrangler.toml.bak.$(date +%s)" 2>/dev/null || true
node -e '
const fs=require("fs");
let t=fs.readFileSync("wrangler.toml","utf8");
t=t.replace(/VAPID_PUBLIC_KEY = ".*"/, `VAPID_PUBLIC_KEY = "${process.argv[1]}"`);
t=t.replace(/id = "PASTE_KV_ID_FOR_SUBS"/, `id = "${process.argv[2]}"`);
t=t.replace(/id = "PASTE_KV_ID_FOR_HITS"/, `id = "${process.argv[3]}"`);
fs.writeFileSync("wrangler.toml",t);
' "$PUB" "$SUBS_ID" "$HITS_ID"
echo "     done"

# 4. Secrets -----------------------------------------------------------------
echo
echo "4/5  Setting secrets..."
printf '%s' "$PRIV" | npx --yes wrangler secret put VAPID_PRIVATE_KEY
printf '%s' "$(openssl rand -hex 16 2>/dev/null || node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')" \
  | npx --yes wrangler secret put SALT
echo
echo "     Now the passcode he will type on his phone."
read -r -s -p "     WATCH_PASSWORD: " WP; echo
[ -n "$WP" ] || { echo "     Empty passcode — aborting."; exit 1; }
printf '%s' "$WP" | npx --yes wrangler secret put WATCH_PASSWORD

# 5. Deploy ------------------------------------------------------------------
echo
echo "5/5  Deploying..."
DEPLOY_OUT="$(npx --yes wrangler deploy 2>&1)"
echo "$DEPLOY_OUT" | tail -5
URL="$(echo "$DEPLOY_OUT" | grep -oE 'https://[a-z0-9.-]+workers\.dev' | head -1)"

echo
echo "======================================"
if [ -n "$URL" ]; then
  echo "Worker URL: $URL"
  echo
  echo "Checking health..."
  curl -s "$URL/health" || true
  echo
  echo
  echo "Wiring the site to it..."
  node -e '
    const fs=require("fs");
    const url=process.argv[1];
    for (const f of ["beacon.js","../beacon.js","../watch/index.html"]) {
      try{
        let t=fs.readFileSync(f,"utf8");
        const before=t;
        t=t.replace(/https:\/\/api-visitor-alerts\.YOUR-SUBDOMAIN\.workers\.dev/g,url);
        if(t!==before){fs.writeFileSync(f,t);console.log("  updated",f);}
      }catch(e){}
    }
  ' "$URL"
  echo
  echo "Next: deploy the website itself so /watch/ and /beacon.js are live,"
  echo "then open https://alwayspreciseinvestigations.net/watch/ on the phone."
else
  echo "Deploy finished but no URL was detected — check the output above."
fi
echo
