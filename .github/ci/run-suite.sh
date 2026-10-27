#!/usr/bin/env bash
# One test suite, run for a pull-request check, and the verdict on it.
#
#   .github/ci/run-suite.sh <label> <output-file> <command> [args...]
#
# A suite is reported as PASSING only when every one of these holds:
#   1. it exited 0;
#   2. it printed no SKIP line. The Playwright suites print SKIP and exit 0
#      when Playwright cannot be found, which in CI would be a green check
#      that tested nothing;
#   3. it reported no crash ("... then the run crashed");
#   4. its LAST line is its own totals line, with zero failures and at least
#      one pass: "N passed, 0 failed", or the CEO gate's
#      "N PASS, W WARN, 0 FAIL". A run that stopped part-way never prints one.
#
# The output goes to a FILE, never a pipe: every suite ends in process.exit(),
# which drops piped output that has not drained yet (CLAUDE.md).
set -uo pipefail

if [ "$#" -lt 3 ]; then
  echo "usage: $0 <label> <output-file> <command> [args...]" >&2
  exit 2
fi
label=$1; out=$2; shift 2
mkdir -p "$(dirname "$out")"

start=$(date +%s)
"$@" > "$out" 2>&1
rc=$?
secs=$(( $(date +%s) - start ))

# A workflow command's message must have %, CR and LF escaped.
esc() { local s=${1//'%'/'%25'}; s=${s//$'\r'/'%0D'}; printf '%s' "${s//$'\n'/'%0A'}"; }

last=$(grep -v '^[[:space:]]*$' "$out" | tail -n 1 || true)
fails=$(grep -E '^[[:space:]]*(FAIL|CRASH)[[:space:]]' "$out" || true)
totals='^[1-9][0-9]* passed, 0 failed$|^[1-9][0-9]* PASS, [0-9]+ WARN, 0 FAIL$'

problem=''
if grep -qE '^SKIP' "$out"; then
  problem='the suite SKIPPED because a dependency is missing; a skipped suite is not a pass'
elif grep -q 'then the run crashed' "$out"; then
  problem="the suite crashed part-way (exit $rc)"
elif [ "$rc" -ne 0 ]; then
  problem="the suite exited $rc"
elif ! printf '%s\n' "$last" | grep -qE "$totals"; then
  problem='its last line is not a passing totals line ("N passed, 0 failed"), so it did not finish cleanly'
fi

echo "---- $label: last 60 lines (full output: $out) ----"
tail -n 60 "$out"
if [ -n "$fails" ]; then
  echo "---- $label: every failing assertion ----"
  printf '%s\n' "$fails"
fi
echo "---- $label: ${last:-no output} (${secs}s, exit $rc) ----"

if [ -n "$problem" ]; then
  echo "::error title=$(esc "$label")::$(esc "$problem")"
  # One annotation per failing assertion, up to ten (GitHub shows ten per step).
  printf '%s\n' "$fails" | sed -n '1,10p' | while IFS= read -r line; do
    [ -n "$line" ] && echo "::error title=$(esc "$label")::$(esc "$(printf '%s' "$line" | sed 's/^[[:space:]]*//')")"
  done
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    if [ -n "$problem" ]; then printf '### ❌ %s\n\n%s.\n\n' "$label" "$problem"
    else printf '### ✅ %s\n\n' "$label"; fi
    # shellcheck disable=SC2016  # the backticks are Markdown, not a command
    printf -- '- Result: `%s`\n- Time: %ss, exit code %s\n\n' "${last:-no output}" "$secs" "$rc"
    if [ -n "$fails" ]; then
      printf 'Failing assertions (first 50; the full output is in the artifact):\n\n~~~~\n'
      printf '%s\n' "$fails" | sed -n '1,50p'
      printf '~~~~\n\n'
    fi
  } >> "$GITHUB_STEP_SUMMARY"
fi

[ -z "$problem" ]
