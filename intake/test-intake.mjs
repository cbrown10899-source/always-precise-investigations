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

/* A crashed run must still say what it saw. An uncaught Playwright timeout
   otherwise swallows the whole report — including the page-error FAILs that
   name the exception being debugged. (Same fix the portal suite carries.) */
function crash(e) {
  results.push(`\n  CRASH  ${e && e.message ? e.message : e}`);
  console.log(results.join('\n'));
  console.log(`\n${passed} passed, ${failed} failed, then the run crashed`);
  process.exit(1);
}
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);

/* ------------------------------------------------------------ static server */

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  let p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end('not found'); }
  let out = fs.readFileSync(p);
  if (p.endsWith('intake/index.html')) {
    // The committed page carries a placeholder, which short-circuits the portal
    // write. Swap in a test key so the real submission path is exercised.
    out = Buffer.from(String(out).replace('"PASTE_INGEST_KEY"', '"test-ingest-key"'));
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'text/plain' });
  res.end(out);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/intake/`;

/* ------------------------------------------------------------ browser setup */

const launch = {};
const bundled = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
if (fs.existsSync(bundled)) launch.executablePath = bundled;
const browser = await chromium.launch(launch);

let submitted = null;   // what the third-party relay receives
let stored = null;      // what the case portal receives

async function newPage() {
  const page = await (await browser.newContext()).newPage();
  // Intercept delivery. A test run must never reach the real inbox.
  await page.route('**api.web3forms.com/**', route => {
    submitted = JSON.parse(route.request().postData() || '{}');
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
  });
  await page.route('**formsubmit.co/**', route => route.abort());
  await page.route('**/portal-api/ingest', route => {
    stored = JSON.parse(route.request().postData() || '{}');
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
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

section('Consumer path — no price is ever shown');
{
  submitted = null; stored = null;
  const page = await newPage();
  ok('the consumer flow is 5 steps, ending at the agreement', await dots(page) === 5);

  await set(page, 'c_name', 'Jane Client');
  await set(page, 'c_phone', '4345550111');
  await advance(page);

  const services = await page.locator('.card').innerText();
  ok('step 2 offers the services', services.includes('Surveillance'));
  ok('no price is attached to surveillance', !/\$\s?\d/.test(services), services);
  ok('the client is told a fee sheet comes in writing', /fee sheet/i.test(services));

  await page.locator('#opt-surveillance').click();
  await page.waitForTimeout(80);
  ok('choosing surveillance does not add a pricing step', await dots(page) === 5);
  await advance(page);

  ok('step 3 is the subject step', await heading(page) === 'Subject of the investigation');
  await set(page, 's_name', 'John Subject');
  await advance(page);
  ok('step 4 is the objective step', await heading(page) === 'Your objective');

  /* INTAKE-NA's firm line: contact plus a basic case purpose. Everything else
     may arrive later, but an essentially empty form must not submit. */
  await advance(page);
  ok('a private intake with no objective at all is refused',
     (await err(page)).toLowerCase().includes('documented'));
  await set(page, 'o_goal', 'Document whether he is living at the address.');
  await advance(page);

  ok('step 5 is the agreement', (await heading(page)).includes('Agreement'));
  const fees = await page.locator('.feebox').innerText();
  ok('the fee box quotes nothing', !/\$\s?\d/.test(fees), fees);
  ok('it says the fee is sent in writing', /sent to you in writing/i.test(fees));
  ok('it says nothing is due now', /nothing/i.test(fees));
  const terms = await page.locator('.agree').innerText();
  ok('the terms name no figure', !/\$\s?\d/.test(terms), terms);
  ok('the terms say work starts only after the fee is agreed',
     /work begins only once the client has agreed/i.test(terms));
  ok('the terms promise no additional fees', /No additional fees apply/i.test(terms));
  ok('submitting does not itself create a charge',
     /does not by itself start work or create a charge/i.test(terms));

  await page.locator('[data-k="a_consent"]').check();
  await set(page, 'a_typed', 'Jane Client');
  await sign(page);
  ok('the last button submits rather than going to payment',
     (await page.locator('.btn.primary').innerText()).includes('Submit'));
  await advance(page);
  await page.waitForTimeout(500);

  ok('the intake was recorded', stored !== null);
  ok('nothing is charged at intake', stored && stored.fee_due === 0);
  ok('no package is recorded', stored && !('package' in stored));
  ok('no payment method is recorded', stored && !stored.payment_method);

  const rec = await page.locator('.record').innerText();
  ok('record is titled Client Intake', rec.includes('Client Intake'));
  ok('the record quotes no price', !/\$\s?\d/.test(rec), rec);
  ok('the record says the fee comes in writing', /sent to you in writing/i.test(rec));
  await page.close();
}

/* The whole point of moving pricing into the portal: a visitor to the website
   never sees a number the firm has not chosen to quote them. */
section('The public form carries no pricing at all');
{
  const src = fs.readFileSync(path.join(ROOT, 'intake/index.html'), 'utf8');
  ok('no dollar figure appears anywhere in the intake source',
     !/\$\s?\d/.test(src), (src.match(/\$\s?\d[^\n]{0,40}/) || [''])[0]);
  ok('the old consumer rate card is gone', !src.includes('PACKAGES'));
  ok('the hourly constant is gone', !/const HOURLY/.test(src));
  ok('no payment step remains', !src.includes('pay-btn'));

  for (const f of ['index.html', 'insurance-investigations/index.html',
                   'insurance-investigations/vendor-information/index.html',
                   'infidelity-investigations/index.html',
                   'child-custody-investigations/index.html']) {
    const page = fs.readFileSync(path.join(ROOT, f), 'utf8');
    ok(`${f} publishes no price`, !/\$\s?\d{2,}/.test(page),
       (page.match(/\$\s?\d{2,}[^\n]{0,30}/) || [''])[0]);
  }
}

/* The owner withdrew Social Media Search / Research from what the firm offers
   (MASTER-HANDOFF §30). It has to stay gone from the copy AND from the
   structured data, which is the half that quietly keeps advertising a service
   long after the visible card is deleted. Background research stays. */
section('Social media research is not offered anywhere public');
{
  const files = ['index.html', 'insurance-investigations/index.html',
                 'insurance-investigations/vendor-information/index.html',
                 'infidelity-investigations/index.html',
                 'child-custody-investigations/index.html',
                 'intake/index.html', 'sitemap.xml'];
  for (const f of files) {
    const full = path.join(ROOT, f);
    if (!fs.existsSync(full)) continue;
    const page = fs.readFileSync(full, 'utf8');
    ok(`${f} does not offer social media research`, !/social\s*media/i.test(page),
       (page.match(/[^\n]{0,40}social\s*media[^\n]{0,40}/i) || [''])[0]);
  }
  const ins = fs.readFileSync(path.join(ROOT, 'insurance-investigations/index.html'), 'utf8');
  ok('background research is still offered', /Background\s*&amp;\s*Public-Record Research/i.test(ins));
}

/* ---------------------------------------------------------- carrier path */

section('Carrier path — insurance claim assignment');
{
  submitted = null; stored = null;
  const page = await newPage();
  await set(page, 'c_name', 'Dana Adjuster');
  await set(page, 'c_email', 'dana@carrier.example');
  await advance(page);
  await page.locator('#opt-claims').click();
  await page.waitForTimeout(80);
  ok('choosing a claim assignment expands the flow to 8 steps', await dots(page) === 8);
  await advance(page);
  ok('step 3 is the claim-details step', await heading(page) === 'Claim details');

  await advance(page);
  ok('an assignment without a carrier is refused', (await err(page)).includes('carrier'));
  await set(page, 'k_carrier', 'Example Mutual');

  /* INTAKE-NA: the claim number is no longer a gate. An urgent assignment
     often has none yet, and the form must not invent one. */
  const claimStep = await page.locator('.card').innerText();
  ok('the claim number can be marked unavailable instead of faked',
     claimStep.includes('Claim number not available at this time'));
  ok('and it never holds up an urgent assignment', /never holds up/i.test(claimStep));

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
  await set(page, 'o_time', 'Hearing 9/12');
  await advance(page);

  /* Section 9 of the handoff: surveillance is authorized in hours, with the
     8-hour minimum day and the 24-hour initial authorization as presets. The
     rate behind them is internal and must not appear on this public page. */
  ok('step 6 is scheduling and authorization', await heading(page) === 'Scheduling & authorization');
  const auth = await page.locator('.card').innerText();
  ok('the 8-hour day is offered', auth.includes('8 hours — 1 day'));
  ok('the 16-hour authorization is offered', auth.includes('16 hours — 2 days'));
  ok('the 24-hour initial authorization is offered', auth.includes('24 hours — 3 days'));
  ok('a custom authorization is offered', auth.includes('Custom authorization'));
  ok('the 8-hour day is described as the minimum', /minimum surveillance day/i.test(auth));
  ok('NO CARRIER RATE IS PUBLISHED on the authorization step', !auth.includes('$'), auth);
  ok('the page says rates are confirmed before acceptance',
     /confirmed before the assignment is accepted/i.test(auth));
  ok('the authorization step promises no additional fees', /No additional fees/i.test(auth));
  ok('it names what is included', /mileage, travel time/i.test(auth));

  await advance(page);
  ok('authorization is required', await heading(page) === 'Scheduling & authorization');
  ok('and it says so', (await err(page)).toLowerCase().includes('hours'));

  await page.locator('#opt-auth-a24').click();
  await page.waitForTimeout(80);
  await set(page, 'z_nte', '$3,600 not to exceed');
  await set(page, 'z_start', '2026-09-01');
  await set(page, 'z_days', 'Any day');
  await set(page, 'z_times', '0600-1400');
  await page.locator('[data-k="z_weekend"]').selectOption({ label: 'Yes — weekends authorized' });
  await page.locator('[data-k="z_priority"]').selectOption({ label: 'Expedited' });
  await set(page, 'z_geo', 'Within 50 miles of Roanoke');
  await advance(page);

  ok('step 7 states assignment terms', (await heading(page)).includes('Assignment terms'));
  const fees = await page.locator('.feebox').innerText();
  ok('terms say the work is invoiced to the carrier', fees.includes('Invoiced to the carrier'));
  ok('no rate is published to the carrier', !fees.includes('$'));
  const terms = await page.locator('.agree').innerText();
  ok('carrier terms cover billing and reporting', terms.includes('Billing') && terms.includes('Reporting'));
  ok('the consumer-only cyber-stalking clause is not shown', !terms.includes('cyber-stalking'));
  ok('the carrier is promised no additional fees', /No additional fees/.test(terms));
  ok('mileage is named as included for a carrier', /Mileage, travel time/.test(terms));
  ok('nothing is added to an invoice after the work',
     /nothing is added to an invoice after the work is done/i.test(terms));
  ok('out-of-area travel is still quoted before acceptance',
     /before the assignment is accepted/.test(terms));

  await page.locator('[data-k="a_consent"]').check();
  await set(page, 'a_typed', 'Dana Adjuster');
  await sign(page);
  await advance(page);

  ok('step 8 is billing', await heading(page) === 'Billing');
  const billing = await page.locator('.feebox').innerText();
  ok('billing echoes the carrier and claim number',
     billing.includes('Example Mutual') && billing.includes('WC-2026-88421'));
  ok('billing echoes the purchase-order reference', billing.includes('PO-5590'));
  ok('no consumer payment button is offered to a carrier', await page.locator('.pay-btn').count() === 0);
  await set(page, 'b_email', 'ap@carrier.example');
  await advance(page);
  await page.waitForTimeout(400);

  ok('the assignment was submitted', stored !== null);
  if (stored) {
    ok('the portal record carries the claim number', stored.claim_number === 'WC-2026-88421');
    ok('the portal record carries the carrier', stored.carrier === 'Example Mutual');
    ok('the portal record carries the claim type', stored.claim_type === "Workers' compensation");
    ok('the portal record carries the date of loss', stored.date_of_loss === '03/14/2026');
    ok('the portal record carries the authorized hours', stored.authorized_hours === '24 hours — 3 days');
    ok('the portal record carries the not-to-exceed', stored.not_to_exceed === '$3,600 not to exceed');
    ok('the portal record carries the start date', stored.start_date === '2026-09-01');
    ok('the portal record carries the permitted times', stored.permitted_times === '0600-1400');
    ok('the portal record carries the weekend authorization',
       stored.weekend_authorized === 'Yes — weekends authorized');
    ok('the portal record carries the priority', stored.priority === 'Expedited');
    ok('the portal record carries the geographic limits',
       stored.geographic_limits === 'Within 50 miles of Roanoke');
    ok('the portal record carries the billing email', stored.billing_email === 'ap@carrier.example');
    ok('the portal record marks the work invoiced', stored.payment_method === 'Invoiced to carrier');
    ok('nothing is charged at assignment', stored.fee_due === 0);
    ok('the authorization signature is captured',
       typeof stored.signature === 'string' && stored.signature.startsWith('data:image/png'));
  }
  const record = await page.locator('.record').innerText();
  ok('record is titled Claim Assignment', record.includes('Claim Assignment'));
  ok('record shows the claim identifiers',
     record.includes('WC-2026-88421') && record.includes('Example Mutual'));
  ok('record uses claimant wording', record.includes('Claimant'));
  ok('record shows no consumer amount due', !record.includes('Due today'));
  await page.close();
}

/* INTAKE-NA: "send us what you know now". A carrier with an urgent assignment
   and half the file missing must still be able to submit — and nothing they
   left blank may reach the record as a fabricated value. */
section('A partial assignment submits, and nothing is invented');
{
  submitted = null; stored = null;
  const page = await (await browser.newContext()).newPage();
  await page.route('**api.web3forms.com/**', route => {
    submitted = JSON.parse(route.request().postData() || '{}');
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
  });
  await page.route('**formsubmit.co/**', route => route.abort());
  await page.route('**/portal-api/ingest', route => {
    stored = JSON.parse(route.request().postData() || '{}');
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  page.on('pageerror', e => ok(`no page errors (${e.message})`, false));
  await page.goto(BASE + '?assignment=insurance');
  await page.waitForTimeout(120);

  ok('the carrier door says what you know now is enough',
     /can be provided later/i.test(await page.locator('.card').innerText()));
  await set(page, 'c_name', 'Dana Adjuster');
  await set(page, 'c_email', 'dana@carrier.example');
  await advance(page);

  // Claim details: no claim number yet, and the date of loss genuinely unknown.
  await set(page, 'k_carrier', 'Urgent Mutual');
  await page.locator('[data-k="k_claimno_na"]').check();
  await page.waitForTimeout(80);
  ok('marking the claim number unavailable disables the field',
     await page.locator('[data-k="k_claimno"]').isDisabled());
  await page.locator('[data-k="k_dol_mode"]').selectOption({ label: 'Unknown' });
  await page.waitForTimeout(120);
  ok('an unknown date of loss removes the date box rather than asking for a fake one',
     await page.locator('[data-k="k_dol"]').count() === 0);
  await advance(page);

  // Claimant: named, but nobody knows the address or the vehicle yet.
  ok('the assignment reaches the claimant step without a claim number',
     await heading(page) === 'The claimant');
  await set(page, 's_name', 'Pat Claimant');
  await page.locator('[data-k="s_addr_na"]').check();
  await page.locator('[data-k="s_desc_na"]').check();
  await page.waitForTimeout(80);
  ok('an unavailable address disables its field too',
     await page.locator('[data-k="s_addr"]').isDisabled());
  await advance(page);

  await set(page, 'o_goal', 'Activity level versus stated restrictions');
  await advance(page);

  // Authorization pending, and a start date nobody can commit to yet.
  const authCard = await page.locator('.card').innerText();
  ok('Authorization pending is offered as a preset', authCard.includes('Authorization pending'));
  ok('and it promises the hours are confirmed before billable work',
     /before any billable field work/i.test(authCard));
  await page.locator('#opt-auth-pending').click();
  await page.waitForTimeout(80);
  await page.locator('[data-k="z_start_mode"]').selectOption({ label: 'Flexible' });
  await page.waitForTimeout(120);
  ok('a flexible start needs no date at all',
     await page.locator('[data-k="z_start"]').count() === 0);
  await advance(page);

  /* The review, before signing: the form says out loud that it accepted the
     gaps on purpose (INTAKE-NA's review screen). */
  const review = await page.locator('.card').innerText();
  ok('the review lists what is not available yet', /Not available yet/i.test(review));
  ok('it names the claim number', /Claim number/i.test(review));
  ok('it names the unknown date of loss', /Date of loss/i.test(review));
  ok('it names the missing address', /address/i.test(review));
  ok('it names the pending authorization', /Authorization/i.test(review));
  ok('it names the flexible start', /Requested start/i.test(review));
  ok('and says the rest can follow later', /can be provided later/i.test(review));

  await page.locator('[data-k="a_consent"]').check();
  await set(page, 'a_typed', 'Dana Adjuster');
  await sign(page);
  await advance(page);
  await page.locator('[data-k="b_email_na"]').check();
  await advance(page);
  await page.waitForTimeout(500);

  ok('the partial assignment submitted', stored !== null);
  if (stored) {
    /* THE RULE: value and availability are separate, and no field carries a
       typed placeholder. */
    ok('the claim number is empty, not "N/A"', !stored.claim_number);
    ok('and its unavailability is recorded as a status',
       stored.claim_number_status === 'not_available');
    ok('the date of loss is empty rather than a fake date', !stored.date_of_loss);
    ok('and is recorded as unknown', stored.date_of_loss_status === 'unknown');
    ok('the claimant address is empty', !stored.subject_address);
    ok('with its own status', stored.subject_address_status === 'not_available');
    ok('the vehicle description is empty', !stored.subject_description);
    ok('with its own status', stored.subject_description_status === 'not_available');
    ok('the authorization is marked pending', stored.authorized_hours_status === 'pending');
    ok('no start date was invented', !stored.start_date);
    ok('and the flexible choice is recorded', stored.start_date_status === 'flexible');
    ok('the billing contact is empty', !stored.billing_email);
    ok('with its status', stored.billing_email_status === 'not_available');
    ok('what WAS given still arrives whole',
       stored.carrier === 'Urgent Mutual' && stored.subject_name === 'Pat Claimant'
       && stored.objective === 'Activity level versus stated restrictions');
    /* The scan is over the VALUE fields only. A status field is allowed to
       say "unknown" — that is the whole point of keeping them apart — but no
       field a human filled in may carry a placeholder standing in for one. */
    const values = Object.fromEntries(
      Object.entries(stored).filter(([k]) => !k.endsWith('_status')));
    const blob = JSON.stringify(values);
    for (const fake of ['"N/A"', '"n/a"', '"Unknown"', '"unknown"', '0000', '01/01/1900']) {
      ok(`no fabricated ${fake} in any data field`, !blob.includes(fake), blob.slice(0, 200));
    }
    ok('the statuses are the only place unavailability is spelled out, one per gap',
       JSON.stringify(Object.keys(stored).filter(k => k.endsWith('_status')).sort())
       === JSON.stringify(['authorized_hours_status', 'billing_email_status',
         'claim_number_status', 'date_of_loss_status', 'start_date_status',
         'subject_address_status', 'subject_description_status']),
       JSON.stringify(Object.keys(stored).filter(k => k.endsWith('_status')).sort()));
  }

  const rec = await page.locator('.record').innerText();
  ok('the printed record says the claim number was not available',
     /Claim number[\s\S]{0,40}Not available at submission/i.test(rec), rec.slice(0, 400));
  ok('and that the authorization is pending', /Authorization pending/i.test(rec));
  await page.close();
}

/* The private side of the same rule. */
section('A private client who knows only the basics');
{
  submitted = null; stored = null;
  const page = await newPage();
  await set(page, 'c_name', 'Jane Client');
  await set(page, 'c_phone', '4345550111');
  await advance(page);
  await page.locator('#opt-surveillance').click();
  await page.waitForTimeout(80);
  await advance(page);

  await set(page, 's_name', 'John Subject');
  await page.locator('[data-k="s_addr_na"]').check();
  await page.locator('[data-k="s_desc_na"]').check();
  await page.waitForTimeout(80);
  ok('a private client can say they do not have the address',
     await page.locator('[data-k="s_addr"]').isDisabled());
  await advance(page);
  await set(page, 'o_goal', 'Whether he is living at the address he claims.');
  await advance(page);

  const review = await page.locator('.card').innerText();
  ok('the private review also lists what is missing', /Not available yet/i.test(review));
  ok('and says it is fine', /can be provided later/i.test(review));

  await page.locator('[data-k="a_consent"]').check();
  await set(page, 'a_typed', 'Jane Client');
  await sign(page);
  await advance(page);
  await page.waitForTimeout(500);

  ok('the sparse private intake submitted', stored !== null);
  if (stored) {
    ok('no address was invented', !stored.subject_address
       && stored.subject_address_status === 'not_available');
    ok('no vehicle was invented', !stored.subject_description
       && stored.subject_description_status === 'not_available');
    ok('and the objective carried', stored.objective.includes('living at the address'));
  }
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
  ok('claim assignment gives 8 steps', await dots(page) === 8);
  await page.locator('#opt-process').click();
  await page.waitForTimeout(80);
  ok('switching back to a consumer service restores 5 steps', await dots(page) === 5);
  ok('the switch leaves you on the service step', (await heading(page)).includes('What do you need'));
  await advance(page);
  ok('the consumer flow resumes correctly', await heading(page) === 'Subject of the investigation');
  await page.close();
}

section('The relay never receives what was typed');
{
  submitted = null; stored = null;
  const page = await newPage();
  // Point the page at a configured ingest key so the portal write is attempted.
  await page.addInitScript(() => {
    Object.defineProperty(window, '__forceKey', { value: true });
  });
  await page.evaluate(() => {}).catch(() => {});

  await set(page, 'c_name', 'Dana Adjuster');
  await set(page, 'c_email', 'dana@carrier.example');
  await advance(page);
  await page.locator('#opt-claims').click();
  await page.waitForTimeout(80);
  await advance(page);
  await set(page, 'k_carrier', 'Example Mutual');
  await set(page, 'k_claimno', 'WC-2026-88421');
  await set(page, 'k_policy', 'POL-77123');
  await set(page, 'k_adjuster', 'Dana Adjuster');
  await advance(page);
  await set(page, 's_name', 'Pat Coleman');
  await set(page, 's_addr', '1142 Rivermont Ave');
  await set(page, 's_desc', 'Silver Ram 1500');
  await set(page, 's_rel', 'Lumbar strain; no lifting over 10 lbs');
  await advance(page);
  await set(page, 'o_goal', 'Activity versus stated restrictions');
  await advance(page);
  await page.locator('#opt-auth-a24').click();
  await page.waitForTimeout(80);
  await set(page, 'z_nte', '$3,600 not to exceed');
  await advance(page);
  await page.locator('[data-k="a_consent"]').check();
  await set(page, 'a_typed', 'Dana Adjuster');
  await sign(page);
  await advance(page);
  await set(page, 'b_email', 'ap@carrier.example');
  await advance(page);
  await page.waitForTimeout(500);

  ok('the firm is still notified', submitted !== null);
  if (submitted) {
    const blob = JSON.stringify(submitted);
    const secrets = {
      "the claimant's name": 'Pat Coleman',
      "the claimant's address": 'Rivermont',
      'the vehicle description': 'Silver Ram',
      'the alleged injury': 'Lumbar strain',
      'the objective': 'stated restrictions',
      'the claim number': 'WC-2026-88421',
      'the policy number': 'POL-77123',
      'the signature image': 'data:image/png',
      'what the carrier authorized spending': '3,600',
    };
    for (const [what, needle] of Object.entries(secrets)) {
      ok(`the relay never sees ${what}`, !blob.includes(needle));
    }
    ok('the relay does get the case number', blob.includes(submitted.case_no));
    ok('the relay does get a contact name', String(submitted.contact_name || '').length > 0);
    ok('the relay is told where to read the details instead',
       String(submitted.where_to_read_it || '').includes('portal'));
  }
}

/* An adjuster arriving from the insurance pages must never be shown the
   consumer side. Landing on the shared picker would offer them domestic
   surveillance with a private-client price beside it. */
section('The carrier door — /intake/?assignment=insurance');
{
  submitted = null; stored = null;
  const page = await (await browser.newContext()).newPage();
  await page.route('**api.web3forms.com/**', route => {
    submitted = JSON.parse(route.request().postData() || '{}');
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
  });
  await page.route('**formsubmit.co/**', route => route.abort());
  await page.route('**/portal-api/ingest', route => {
    stored = JSON.parse(route.request().postData() || '{}');
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  page.on('pageerror', e => ok(`no page errors (${e.message})`, false));
  await page.goto(BASE + '?assignment=insurance');
  await page.waitForTimeout(200);

  const first = await page.locator('.card').innerText();
  ok('the carrier door opens on the assigning contact', await heading(page) === 'Assigning contact');
  ok('it identifies itself as an assignment intake',
     (await page.locator('.name').innerText()).includes('ASSIGNMENT INTAKE'));
  ok('the page title is the assignment intake',
     (await page.title()).includes('Secure Assignment Intake'));
  ok('the service picker is gone from the flow', await dots(page) === 7);
  ok('a carrier is asked their title', first.includes('Title'));
  ok('a carrier is asked their organization type', first.includes('Organization type'));
  ok('a carrier is NOT asked for a mailing address', !first.includes('Mailing address'));
  ok('a carrier is NOT asked the best time to reach them', !first.includes('Best time'));

  // The whole point: none of the consumer business is ever put on screen.
  //
  // This checks rendered text, not page source. The consumer step markup does
  // still sit in the shared file's <script> — a carrier who opened View Source
  // could read it. Isolating that too means splitting the form into two pages,
  // which is a structural change, not a copy change. What is asserted here is
  // what an adjuster actually sees.
  const seen = await page.evaluate(() => document.body.innerText);
  for (const [what, needle] of Object.entries({
    'domestic surveillance': 'personal or legal matters',
    'the relationship-to-you framing': 'relationship to you',
    'the consumer half-day price': '$400',
    'the consumer two-day price': '$1,500',
    'process serving': 'Process Serving',
    'any consumer price at all': '$',
  })) ok(`the carrier never sees ${what}`, !seen.includes(needle), seen.slice(0, 200));

  await set(page, 'c_name', 'Karen Whitfield');
  await set(page, 'c_email', 'kwhitfield@carrier.example');
  await set(page, 'c_title', 'Claims Adjuster');
  await page.locator('[data-k="c_orgtype"]').selectOption({ label: 'Insurance carrier' });
  await advance(page);
  ok('step 2 goes straight to the claim, with no service picker',
     await heading(page) === 'Claim details');

  await set(page, 'k_carrier', 'Blue Ridge Mutual');
  await set(page, 'k_claimno', 'WC-2026-104871');
  await advance(page);
  await set(page, 's_name', 'Marcus Ellery');
  await advance(page);
  await set(page, 'o_goal', 'Activity against stated restrictions');
  await advance(page);
  ok('the authorization step is still reached', await heading(page) === 'Scheduling & authorization');
  await page.locator('#opt-auth-a24').click();
  await page.waitForTimeout(80);
  await advance(page);
  await page.locator('[data-k="a_consent"]').check();
  await set(page, 'a_typed', 'Karen Whitfield');
  await sign(page);
  await advance(page);
  ok('and it still ends in billing, not payment', await heading(page) === 'Billing');
  await advance(page);
  await page.waitForTimeout(500);

  ok('the assignment records as a claim', stored && stored.claim_number === 'WC-2026-104871');
  ok('the contact title is recorded', stored && stored.contact_title === 'Claims Adjuster');
  ok('the organization type is recorded', stored && stored.organization_type === 'Insurance carrier');
  ok('nothing was charged', stored && stored.fee_due === 0);
  await page.close();
}

/* Bare /intake/ is unchanged for anyone who did not come via the insurance
   pages — all three services still offered. */
section('Bare /intake/ still offers everything');
{
  const page = await newPage();
  ok('it is still the client intake',
     (await page.locator('.name').innerText()).includes('CLIENT INTAKE'));
  await set(page, 'c_name', 'Jane Client');
  await set(page, 'c_phone', '4345550111');
  await advance(page);
  const services = await page.locator('.card').innerText();
  ok('surveillance is offered', services.includes('Surveillance'));
  ok('process serving is offered', services.includes('Process Serving'));
  ok('the claim assignment is still offered here too',
     services.includes('Insurance Claim Assignment'));
  await page.close();
}

/* Every carrier-facing button has to go through the door, or the isolation is
   decorative — one stale link puts an adjuster back on the consumer picker. */
section('Carrier pages link to the carrier door');
{
  for (const f of ['insurance-investigations/index.html',
                   'insurance-investigations/vendor-information/index.html']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const bare = (src.match(/href="\/intake\/"/g) || []).length;
    const door = (src.match(/href="\/intake\/\?assignment=insurance"/g) || []).length;
    ok(`${f.split('/')[1] === 'index.html' ? 'the insurance page' : 'the vendor page'} sends carriers through the door`, door > 0);
    ok(`${f.split('/')[1] === 'index.html' ? 'the insurance page' : 'the vendor page'} has no bare /intake/ link left`, bare === 0, `${bare} left`);
  }
  const red = fs.readFileSync(path.join(ROOT, '_redirects'), 'utf8');
  ok('the old /submit/ URL lands on the carrier door',
     /\/insurance-investigations\/submit\/\*\s+\/intake\/\?assignment=insurance/.test(red));
}

/* ------------------------------------------------------------------ report */

await browser.close();
server.close();

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
