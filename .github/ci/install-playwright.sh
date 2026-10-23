#!/usr/bin/env bash
# Installs the Playwright pinned in .playwright-version OUTSIDE the repository,
# with its Chromium, and proves the suites will load exactly that version and
# can open a page with it. Any failure here fails the job, so a browser suite
# never gets the chance to SKIP and exit 0.
#
# The suites look for Playwright with import(), then require(), then three
# fixed global folders. NODE_PATH is how require() finds a package installed
# somewhere else, so it is written to GITHUB_ENV for every later step.
set -euo pipefail

want=$(tr -d '[:space:]' < .playwright-version)
dir="${RUNNER_TEMP:?}/playwright"

npm install --prefix "$dir" --no-save --no-package-lock --no-audit --no-fund "playwright@$want"
"$dir/node_modules/.bin/playwright" install --with-deps chromium
echo "NODE_PATH=$dir/node_modules" >> "${GITHUB_ENV:?}"

# shellcheck disable=SC2016  # the single quotes hold JavaScript, not shell
NODE_PATH="$dir/node_modules" WANT="$want" node -e '
  const { createRequire } = require("node:module");
  const path = require("node:path");
  // Resolve the way a suite does, from inside the repository.
  const req = createRequire(path.resolve("intake/test-intake.mjs"));
  const where = req.resolve("playwright");
  const got = req("playwright/package.json").version;
  console.log(`Playwright ${got} from ${where} (pinned: ${process.env.WANT})`);
  if (got !== process.env.WANT) { console.log(`::error::Playwright is ${got} but .playwright-version pins ${process.env.WANT}`); process.exit(1); }
  (async () => {
    const browser = await req("playwright").chromium.launch();
    const page = await browser.newPage();
    await page.setContent("<p>ready</p>");
    const text = await page.textContent("p");
    console.log(`Chromium ${browser.version()} opened a page: ${text}`);
    await browser.close();
    if (text !== "ready") process.exit(1);
  })().catch(e => { console.log(`::error::Chromium did not launch: ${e.message.split("\n")[0]}`); process.exit(1); });
'
