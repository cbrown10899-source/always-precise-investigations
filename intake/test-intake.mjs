/**
 * Tests for the client intake form.
 *
 * Drives the real page in a headless browser over both paths — the consumer
 * flow (surveillance / process serving, paid up front) and the carrier flow
 * (insurance claim assignment, invoiced) — and asserts on what actually gets
 * submitted. Form delivery is intercepted, so running this never sends
 * anything to the firm's inbox.
 *
 *   node intake/test-intake.mjs
 *
 * Unlike the Worker tests this one needs Playwright, which is not vendored:
 *
 *   npm i -g playwright && npx playwright install chromium
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------ dependencies */

async function loadChromium() {
  const require_ = createRequire(import.meta.url);
  for (const spec of ['playwright', 'playwright-core']) {
    try { return (await import(spec)).chromium; } catch { /* try next */ }
    try { return require_(spec).chromium; } catch { /* try next */ }
  }
  for (const dir of ['/opt/node22/lib/node_modules', '/usr/lib/node_modules', '/usr/local/lib/node_modules']) {
    const p = path.join(dir, 'playwright', 'index.mjs');
    if (fs.existsSync(p)) return (await import(p)).chromium;
  }
  return null;
}

const chromium = await loadChromium();
if (!chromium) {
  console.log('SKIP  Playwright is not installed — cannot run the intake tests.');
  console.log('      npm i -g playwright && npx playwright install chromium');
  process.exit(0);
}

/* ------------------------------------------------------------ test harness */

let passed = 0, failed = 0;
const results = [];
function ok(name, cond, detail = '') {
  if (cond) { passed++; results.push(`  PASS  ${name}`); }
  else { failed++; results.push(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(name) { results.push(`\n${name}`); }

/* ------------------------------------------------------------ static server */

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  let p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'text/plain' });
  res.end(fs.readFileSync(p));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/intake/`;

/* ------------------------------------------------------------ browser setup */

const launch = {};
const bundled = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
if (fs.existsSync(bundled)) launch.executablePath = bundled;
const browser = await chromium.launch(launch);

let submitted = null;

async function newPage() {
  const page = await (await browser.newContext()).newPage();
  // Intercept delivery. A test run must never reach the real inbox.
  await page.route('**api.web3forms.com/**', route => {
    submitted = JSON.parse(route.request().postData() || '{}');
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
  });
  await page.route('**formsubmit.co/**', route => route.abort());
  page.on('pageerror', e => ok(`no page errors (${e.message})`, false));
  await page.goto(BASE);
  return page;
}

const dots = page => page.locator('#progress i').count();
const heading = page => page.locator('#app h2').first().innerText();
const set = (page, k, v) => page.locator(`[data-k="${k}"]`).fill(v);
const err = page => page.locator('#err').innerText();
async function advance(page) { await page.locator('.btn.primary').click(); await page.waitForTimeout(90); }
async function sign(page) {
  const c = page.locator('#sig');
  await c.scrollIntoViewIfNeeded();   // the canvas sits below the fold, and a
  await page.waitForTimeout(60);      // pointer event outside the viewport is lost
  const b = await c.boundingBox();
  await page.mouse.move(b.x + 30, b.y + 90);
  await page.mouse.down();
  await page.mouse.move(b.x + 120, b.y + 60);
  await page.mouse.move(b.x + 200, b.y + 100);
  await page.mouse.up();
  await page.waitForTimeout(60);
}

/* ------------------------------------------------------- consumer path */

section('Consumer path — surveillance');
{
  submitted = null;
  const page = await newPage();
  ok('progress bar shows the 6 consumer steps', await dots(page) === 6);

  await set(page, 'c_name', 'Jane Client');
  await set(page, 'c_phone', '4345550111');
  await advance(page);
  await page.locator('#opt-surveillance').click();
  await page.waitForTimeout(80);
  await advance(page);

  ok('step 3 is the subject step', await heading(page) === 'Subject of the investigation');
  ok('consumer keeps the "relationship to you" field',
     await page.locator('[data-k="s_rel"]').getAttribute('placeholder') !== null);
  await set(page, 's_name', 'John Subject');
  await advance(page);
  ok('step 4 is the objective step', await heading(page) === 'Your objective');
  await advance(page);

  ok('step 5 is the agreement', (await heading(page)).includes('Agreement'));
  const fees = await page.locator('.feebox').innerText();
  ok('fee box shows the $1,500 retainer due today', fees.includes('$1,500') && fees.includes('Due today'));
  await page.locator('[data-k="a_consent"]').check();
  await set(page, 'a_typed', 'Jane Client');
  await sign(page);
  await advance(page);

  ok('step 6 is the payment step', await heading(page) === 'Payment');
  await page.locator('.pay-opt .opt').first().click();
  await page.waitForTimeout(80);
  await advance(page);
  await page.waitForTimeout(400);

  ok('payload bills the consumer retainer', submitted && submitted.fee_due === 1500);
  ok('payload carries no claim fields', submitted && !('claim_number' in submitted));
  ok('record is titled Client Intake', (await page.locator('.record').innerText()).includes('Client Intake'));
  await page.close();
}

/* ---------------------------------------------------------- carrier path */

section('Carrier path — insurance claim assignment');
{
  submitted = null;
  const page = await newPage();
  await set(page, 'c_name', 'Dana Adjuster');
  await set(page, 'c_email', 'dana@carrier.example');
  await advance(page);
  await page.locator('#opt-claims').click();
  await page.waitForTimeout(80);
  ok('choosing a claim assignment expands the flow to 7 steps', await dots(page) === 7);
  await advance(page);
  ok('step 3 is the claim-details step', await heading(page) === 'Claim details');

  await advance(page);
  ok('an assignment without a carrier is refused', (await err(page)).includes('carrier'));
  await set(page, 'k_carrier', 'Example Mutual');
  await advance(page);
  ok('an assignment without a claim number is refused', (await err(page)).includes('claim number'));

  await set(page, 'k_claimno', 'WC-2026-88421');
  await set(page, 'k_policy', 'POL-77123');
  await page.locator('[data-k="k_type"]').selectOption({ label: "Workers' compensation" });
  await set(page, 'k_dol', '03/14/2026');
  await set(page, 'k_adjuster', 'Dana Adjuster');
  await set(page, 'k_adj_email', 'dana@carrier.example');
  await set(page, 'k_po', 'PO-5590');
  await page.locator('[data-k="k_prior"]').selectOption({ label: 'None' });
  await advance(page);

  ok('the subject step is relabelled for a claimant', await heading(page) === 'The claimant');
  await set(page, 's_name', 'Pat Claimant');
  await set(page, 's_rel', 'Lumbar strain; no lifting over 10 lbs');
  await advance(page);
  ok('the objective step becomes scope and deadline', (await heading(page)).includes('Scope'));
  await set(page, 'o_goal', 'Activity level versus stated restrictions');
  await set(page, 'o_hours', '8 hours authorized');
  await set(page, 'o_time', 'Hearing 9/12');
  await advance(page);

  ok('step 6 states assignment terms', (await heading(page)).includes('Assignment terms'));
  const fees = await page.locator('.feebox').innerText();
  ok('terms say the work is invoiced to the carrier', fees.includes('Invoiced to the carrier'));
  ok('no rate is published to the carrier', !fees.includes('$'));
  const terms = await page.locator('.agree').innerText();
  ok('carrier terms cover billing and reporting', terms.includes('Billing') && terms.includes('Reporting'));
  ok('the consumer-only cyber-stalking clause is not shown', !terms.includes('cyber-stalking'));

  await page.locator('[data-k="a_consent"]').check();
  await set(page, 'a_typed', 'Dana Adjuster');
  await sign(page);
  await advance(page);

  ok('step 7 is billing', await heading(page) === 'Billing');
  const billing = await page.locator('.feebox').innerText();
  ok('billing echoes the carrier and claim number',
     billing.includes('Example Mutual') && billing.includes('WC-2026-88421'));
  ok('billing echoes the purchase-order reference', billing.includes('PO-5590'));
  ok('no consumer payment button is offered to a carrier', await page.locator('.pay-btn').count() === 0);
  await set(page, 'b_email', 'ap@carrier.example');
  await advance(page);
  await page.waitForTimeout(400);

  ok('the assignment was submitted', submitted !== null);
  if (submitted) {
    ok('payload carries the claim number', submitted.claim_number === 'WC-2026-88421');
    ok('payload carries the carrier', submitted.carrier === 'Example Mutual');
    ok('payload carries the claim type', submitted.claim_type === "Workers' compensation");
    ok('payload carries the date of loss', submitted.date_of_loss === '03/14/2026');
    ok('payload carries the authorized hours', submitted.authorized_hours === '8 hours authorized');
    ok('payload carries the billing email', submitted.billing_email === 'ap@carrier.example');
    ok('payload marks the work invoiced', submitted.payment_method === 'Invoiced to carrier');
    ok('nothing is charged at assignment', submitted.fee_due === 0);
    ok('the authorization signature is captured',
       typeof submitted.signature === 'string' && submitted.signature.startsWith('data:image/png'));
  }
  const record = await page.locator('.record').innerText();
  ok('record is titled Claim Assignment', record.includes('Claim Assignment'));
  ok('record shows the claim identifiers',
     record.includes('WC-2026-88421') && record.includes('Example Mutual'));
  ok('record uses claimant wording', record.includes('Claimant'));
  ok('record shows no consumer amount due', !record.includes('Due today'));
  await page.close();
}

/* ------------------------------------------------- switching between paths */

section('Switching service after the flow has branched');
{
  const page = await newPage();
  await set(page, 'c_name', 'Switcher');
  await set(page, 'c_phone', '4345550000');
  await advance(page);
  await page.locator('#opt-claims').click();
  await page.waitForTimeout(80);
  ok('claim assignment gives 7 steps', await dots(page) === 7);
  await page.locator('#opt-process').click();
  await page.waitForTimeout(80);
  ok('switching back to a consumer service restores 6 steps', await dots(page) === 6);
  ok('the switch leaves you on the service step', (await heading(page)).includes('What do you need'));
  await advance(page);
  ok('the consumer flow resumes correctly', await heading(page) === 'Subject of the investigation');
  await page.close();
}

/* ------------------------------------------------------------------ report */

await browser.close();
server.close();

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
