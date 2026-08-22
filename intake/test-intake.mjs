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
  /* The placeholder guard below is only as good as what this fixture touches.
     Prior surveillance offers a literal "Unknown" — the exact string the guard
     bans — and nothing here selected it, so it sailed through. Select it. */
  await page.locator('[data-k="k_prior"]').selectOption({ label: 'Unknown' });
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
    /* Its own preset LABEL is "Authorization pending" — writing that into the
       value put a placeholder beside its own status, which is the one thing
       INTAKE-NA forbids. Every other NA field asserts emptiness; this one
       did not, so it was the gap the rule fell through. */
    ok('and the hours themselves are empty, not the words "Authorization pending"',
       !stored.authorized_hours);
    ok('prior surveillance is empty rather than the word Unknown',
       !stored.prior_surveillance);
    ok('with its unavailability recorded as a status instead',
       stored.prior_surveillance_status === 'unknown');
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
         'claim_number_status', 'date_of_loss_status', 'prior_surveillance_status',
         'start_date_status', 'subject_address_status', 'subject_description_status']),
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

/* The other door (audit 2026-08-14): what the PRIVATE rate sheet emails. A
   private client still picks between the two consumer services — the step
   stays — but the carrier path is simply not offered to them, the mirror of
   the carrier door never offering the consumer picker. */
section('The private door — /intake/?assignment=private');
{
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', e => ok(`no page errors (${e.message})`, false));
  await page.goto(BASE + '?assignment=private');
  await page.waitForTimeout(200);

  ok('it is still the client intake — private clients see nothing renamed',
     (await page.locator('.name').innerText()).includes('CLIENT INTAKE'));
  await set(page, 'c_name', 'Riley Caller');
  await set(page, 'c_phone', '4345550199');
  await advance(page);
  ok('the service step is still a choice', await heading(page) === 'What do you need?');
  const services = await page.locator('.card').innerText();
  ok('surveillance is offered', services.includes('Surveillance'));
  ok('process serving is offered', services.includes('Process Serving'));
  ok('the claim assignment is NOT — a private client is never offered carrier work',
     !services.includes('Insurance Claim Assignment'));
  ok('nor a rate beside anything, as ever', !services.includes('$'));

  ok('the legal path is not offered on the private door either',
     !services.includes('Legal / Law Firm'));

  // The belt behind the missing card: even a hand-typed call cannot take it.
  await page.evaluate(() => pickSvc('claims'));
  await page.waitForTimeout(150);
  ok('the door refuses the carrier path even when asked directly',
     !(await page.locator('.card').innerText()).includes('Claim details')
     && await page.evaluate(() => S.svc) !== 'claims');
  await page.evaluate(() => pickSvc('legal'));
  await page.waitForTimeout(150);
  ok('and the legal path even when asked directly',
     await page.evaluate(() => S.svc) !== 'legal');
  await page.close();
}

/* ------------------------------------------- UNIT 6: the legal door ------ */

section('The legal door — /intake/?assignment=legal');
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
  await page.goto(BASE + '?assignment=legal');
  await page.waitForTimeout(200);

  ok('the page titles itself the Legal Investigation Assignment',
     (await page.title()).includes('Legal Investigation Assignment'));
  ok('and the masthead says legal assignment',
     (await page.locator('.name').innerText()).includes('LEGAL ASSIGNMENT'));
  ok('the service picker is gone from the flow — six steps', await dots(page) === 6);

  // Step 1: the submitter — a paralegal, in this walk.
  await set(page, 'c_name', 'Tessa Boyd');
  await set(page, 'c_email', 'tboyd@harmonboyle.test');
  await advance(page);

  // Step 2: the firm.
  ok('the firm step asks a law office\'s questions', await heading(page) === 'Law firm & contacts');
  const firmStep = await page.locator('.card').innerText();
  ok('a paralegal is not required and says so',
     firmStep.includes('if one is on this file'));
  await advance(page);
  ok('the firm is required, in words', (await err(page)).includes('law firm'));
  await set(page, 'lf_firm', 'Harmon & Boyle PLC');
  await advance(page);
  ok('the attorney is required, in words', (await err(page)).includes('attorney'));
  await set(page, 'lf_atty', 'R. Harmon');
  await set(page, 'lf_atty_email', 'rharmon@harmonboyle.test');
  await set(page, 'lf_para', 'Tessa Boyd');
  await advance(page);

  // Step 3: the matter.
  ok('the matter step opens', await heading(page) === 'The matter');
  await advance(page);
  ok('the file must be identifiable — client OR matter number',
     (await err(page)).includes('matter number'));
  await set(page, 'lm_client', 'Estate of L. Byrd');
  await set(page, 'lm_matter', 'M-2211');
  await set(page, 'lm_court', 'Roanoke County Circuit Court');
  await page.locator('[data-k="lm_type"]').selectOption('Witness locate');
  await set(page, 'lm_deadline', '2026-09-15');
  const matterStep = await page.locator('.card').innerText();
  ok('the dates say no deadline is invented from another date',
     matterStep.includes('never invent a deadline'));
  ok('documents are exchanged after acceptance — nothing must be attached',
     matterStep.includes('once the assignment is accepted'));
  await advance(page);

  // Steps 4–5: subject and objective, the shared machinery.
  await set(page, 's_name', 'J. Q. Adverse');
  await page.locator('[data-k="s_addr_na"]').check();
  await advance(page);
  await set(page, 'o_goal', 'Locate and interview the witness before the hearing.');
  await advance(page);

  // Step 6: the agreement — arrangement, terms, signature; never a payment.
  const agree = await page.locator('.card').innerText();
  ok('the retainer is arranged with the firm — no figure anywhere',
     agree.includes('Arranged with the firm') && !agree.includes('$'));
  ok('the four legal arrangements are offered',
     agree.includes('BILL.com invoice / ACH') && agree.includes('pick up at your office')
     && agree.includes('by mail') && agree.includes('Existing billing arrangement'));
  ok('no consumer payment method is on the page',
     !agree.includes('Venmo') && !agree.includes('Cash App'));
  ok('choosing is said plainly not to be paying',
     agree.includes('nothing is marked paid by choosing'));
  ok('the pickup wording is the owner\'s',
     agree.includes('we will arrange pickup at your office'));
  await page.evaluate(() => pickArr('check_pickup'));
  await page.waitForTimeout(120);
  await page.locator('[data-k="a_consent"]').check();
  await set(page, 'a_typed', 'Tessa Boyd');
  await sign(page);
  await advance(page);
  await page.waitForTimeout(400);

  /* The submission's proof is the intercepted ingest itself — page wording is
     secondary, and 'received' also appears in the agreement terms, which is
     how a stuck walk once read as a submitted one. */
  ok('the assignment submits and is recorded', stored !== null,
     (await page.locator('.record, .card').first().innerText()).slice(0, 120));
  ok('the final record says the assignment was submitted',
     /Assignment submitted|Intake submitted/.test(await page.locator('.record').innerText()));
  ok('the portal record is marked legal', stored && stored.assignment === 'legal');
  ok('with the firm, the attorney and the matter',
     stored.firm_name === 'Harmon & Boyle PLC' && stored.attorney_name === 'R. Harmon'
     && stored.matter_number === 'M-2211');
  ok('the firm\'s client is the case\'s client; the submitter is the contact',
     stored.client_name === 'Estate of L. Byrd' && stored.contact_name === 'Tessa Boyd'
     && stored.client_email === 'tboyd@harmonboyle.test');
  ok('the arrangement rides as a request', stored.payment_arrangement === 'check_pickup');
  ok('the NA state rides as status, never a placeholder',
     stored.subject_address === '' && stored.subject_address_status === 'not_available');

  /* THE RELAY BOUNDARY, legal edition: the notice says an assignment arrived
     and who to call back — the firm's matter never leaves the building. */
  ok('the relay is told the type and the submitter',
     submitted && submitted.subject.includes('Legal investigation assignment')
     && submitted.contact_name === 'Tessa Boyd');
  const relay = JSON.stringify(submitted);
  ok('and receives no firm, client, matter, court, subject or arrangement',
     !relay.includes('Harmon') && !relay.includes('Byrd') && !relay.includes('M-2211')
     && !relay.includes('Adverse') && !relay.includes('check_pickup')
     && !relay.includes('Roanoke County'), relay.slice(0, 200));
  await page.close();
}

section('Bare /intake/ offers the three businesses');
{
  const page = await newPage();
  await set(page, 'c_name', 'Walk In');
  await set(page, 'c_phone', '5405550100');
  await advance(page);
  const services = await page.locator('.card').innerText();
  ok('private client work is offered', services.includes('Surveillance') && services.includes('Process Serving'));
  ok('the insurance assignment is offered', services.includes('Insurance Claim Assignment'));
  ok('the legal / law firm path is offered', services.includes('Legal / Law Firm'));
  ok('with no figure beside anything', !services.includes('$'));
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

/* MASTER §29 — the homepage speaks to all three audiences and offers the two
   client paths, each through its OWN door of the intake. Guarded here so a
   redesign cannot quietly drop a door or point both paths at the picker. */
section('The homepage leads with the two client paths');
{
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const h1 = (src.match(/<h1>([^<]+)<\/h1>/) || [])[1] || '';
  ok('the hero names insurance, legal and private clients',
     /insurance/i.test(h1) && /legal/i.test(h1) && /private/i.test(h1), h1);
  /* WIDENED AND LOOSENED IN UNIT 40, on purpose.

     These asserted the LABEL immediately followed the href — `href="…">Submit
     an Insurance Assignment`. That is a claim about markup shape, not about
     routing, and the hero CTA cards broke it while routing correctly: the
     label now sits in a nested span. The guard fired, which is what it is for.

     What it should pin is the PAIRING — this label goes to this door — so it
     reads the anchor's whole inner markup instead, and covers all THREE doors
     now that the homepage offers Legal as well. */
  const anchors = [...src.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
    .map(m => ({ href: m[1], text: m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() }));
  const doorFor = label => (anchors.find(a => a.text.includes(label)) || {}).href;
  ok('Submit an Insurance Assignment goes through the carrier door',
     doorFor('Submit an Insurance Assignment') === '/intake/?assignment=insurance',
     String(doorFor('Submit an Insurance Assignment')));
  ok('Submit a Legal Assignment goes through the LEGAL door',
     doorFor('Submit a Legal Assignment') === '/intake/?assignment=legal',
     String(doorFor('Submit a Legal Assignment')));
  ok('Request a Private Investigation goes through the private door',
     doorFor('Request a Private Investigation') === '/intake/?assignment=private',
     String(doorFor('Request a Private Investigation')));
  ok('and no homepage label reaches a door meant for another audience',
     doorFor('Submit a Legal Assignment') !== '/intake/?assignment=private'
     && doorFor('Submit a Legal Assignment') !== '/intake/?assignment=insurance');
  ok('no bare /intake/ link on the homepage either',
     (src.match(/href="\/intake\/"/g) || []).length === 0);
  ok('phone and contact remain, one row down',
     src.includes('tel:+14349070975') && src.includes('openContact()'));
  const how = (src.match(/<section id="how-it-works">[\s\S]*?<\/section>/) || [''])[0];
  ok('How an Assignment Works walks four steps', (how.match(/<h3>/g) || []).length === 4);
  ok('and quotes nothing', !how.includes('$'));
  ok('the services grid leads with the claims work',
     src.indexOf("Workers' Comp &amp; Auto Claims") < src.indexOf('<h3>Surveillance</h3>'));
  ok('while every consumer service is still on it',
     ['Infidelity', 'Child Custody', 'Surveillance', 'Process Serving']
       .every(t => src.includes(`<h3>${t}</h3>`)));
}


/* ==================================================================
   OPTIONAL / REQUIRED FIELD LABELS (owner rule, 2026-08-21)

   "Every field that is genuinely optional must visibly say (optional) in its
   field label ... audit requiredness from the actual server-side validation
   first. Do not guess from the current UI."

   THE SERVER-SIDE ANSWER FOR THIS FORM IS THE POINT OF THESE TESTS.
   `handleIngest` validates exactly one thing — `case_no`, which the page mints
   and no person types — because the portal write is fire-and-forget so a Worker
   outage can never cost the firm a client. So every field a person fills in is
   optional to the Worker, and `validate()` in the page IS the firm's own
   requiredness rule. That makes `validate()` the thing the labels must agree
   with, and these tests compare the two BEHAVIOURALLY rather than against a
   second hand-written table: a table would just be a third place to get it
   wrong.

   Three markers, because requiredness has three shapes and only two of them
   are a yes/no. A field with no marker at all fails here. */

section('Field labels say what validate() actually enforces');
{
  const MARK_OPT  = /\(optional\)/;
  const MARK_REQ  = /\*/;
  const MARK_PAIR = /\((?:phone or email|client name or matter number|claimant name or claim number)[^)]*\)/;

  /* The first `> span` of a label is the label; a `.hint` sibling inside the
     same label is help text, not the marker. */
  const labels = page => page.evaluate(() => [...document.querySelectorAll('label.f')].map(l => {
    const sp = l.querySelector(':scope > span');
    const ctl = l.querySelector('input, select, textarea');
    return { text: sp ? sp.textContent.replace(/\s+/g, ' ').trim() : '',
             key: ctl ? (ctl.getAttribute('data-k') || ctl.id || '') : '' };
  }));

  const seen = [];
  async function auditStep(page, tag) {
    for (const l of await labels(page)) {
      seen.push(`${tag}/${l.key}`);
      const marks = [MARK_REQ.test(l.text), MARK_OPT.test(l.text), MARK_PAIR.test(l.text)]
        .filter(Boolean).length;
      ok(`${tag}: "${l.text}" carries exactly one requiredness marker`, marks === 1, l.text);
      ok(`${tag}: "${l.text}" does not say optional twice`,
         (l.text.match(/optional/gi) || []).length <= 1, l.text);
    }
  }

  /* ---- the legal door ---- */
  {
    const page = await newPage();
    await page.goto(BASE + '?assignment=legal');
    await page.waitForTimeout(120);
    await auditStep(page, 'legal:info');
    await set(page, 'c_name', 'P Aralegal'); await set(page, 'c_email', 'p@firm.example');
    await advance(page);
    await auditStep(page, 'legal:firm');
    await set(page, 'lf_firm', 'Smith Law'); await set(page, 'lf_atty', 'J Smith');
    await advance(page);
    await auditStep(page, 'legal:matter');
    await set(page, 'lm_client', 'Client X');
    await advance(page);
    await auditStep(page, 'legal:subject');
    await advance(page);
    await auditStep(page, 'legal:objective');
    await set(page, 'o_goal', 'Locate the witness.');
    await advance(page);
    await auditStep(page, 'legal:agreement');
    await page.close();
  }

  /* ---- the carrier door, including the billing step past the agreement ---- */
  {
    const page = await newPage();
    await page.goto(BASE + '?assignment=insurance');
    await page.waitForTimeout(120);
    await auditStep(page, 'ins:info');
    await set(page, 'c_name', 'A Djuster'); await set(page, 'c_email', 'a@carrier.example');
    await advance(page);
    await auditStep(page, 'ins:claim');
    await set(page, 'k_carrier', 'Example Mutual');
    await advance(page);
    await auditStep(page, 'ins:subject');
    await set(page, 's_name', 'C Laimant');
    await advance(page);
    await auditStep(page, 'ins:objective');
    await set(page, 'o_goal', 'Activity against stated restrictions.');
    await advance(page);
    await auditStep(page, 'ins:authorization');
    /* The custom box only exists once Custom is chosen, and it IS required
       then — so it is audited in the state where it can be seen. */
    await page.locator('#opt-auth-custom').click();
    await page.waitForTimeout(100);
    const custom = (await labels(page)).find(l => l.key === 'z_custom');
    ok('the custom authorization box is marked required, because it is',
       !!custom && MARK_REQ.test(custom.text) && !MARK_OPT.test(custom.text),
       custom ? custom.text : 'absent');
    await page.locator('#opt-auth-a24').click();
    await page.waitForTimeout(100);
    await advance(page);
    await auditStep(page, 'ins:agreement');
    await page.locator('[data-k="a_consent"]').check();
    await set(page, 'a_typed', 'A Djuster');
    await sign(page);
    await advance(page);
    await auditStep(page, 'ins:billing');
    await page.close();
  }

  /* ---- the private door ---- */
  {
    const page = await newPage();
    await page.goto(BASE + '?assignment=private');
    await page.waitForTimeout(120);
    await auditStep(page, 'priv:info');
    await set(page, 'c_name', 'J Client'); await set(page, 'c_phone', '4345550111');
    await advance(page);
    await page.locator('#opt-process').click(); await page.waitForTimeout(80);
    await advance(page);
    await auditStep(page, 'priv:subject');
    await advance(page);
    await auditStep(page, 'priv:objective');
    await page.close();
  }

  ok('the audit actually walked the form rather than finding nothing',
     seen.length > 60, `${seen.length} labels`);
  ok('and it covered all three doors',
     ['legal:', 'ins:', 'priv:'].every(p => seen.some(s => s.startsWith(p))));
}

/* THE CLAIM THE LABELS MAKE, TESTED AS A CLAIM. Fill ONLY the fields whose
   label does NOT say "(optional)" and submit. If any (optional) label is a
   lie, the form refuses and this fails — which is a stronger check than
   comparing the markup against a list, because the list would be mine. */
section('Every field marked (optional) really can be left blank');
{
  for (const door of ['legal', 'insurance', 'private']) {
    submitted = null; stored = null;
    const page = await newPage();
    await page.goto(BASE + '?assignment=' + door);
    await page.waitForTimeout(120);

    // info — one contact method is a pair, so one of the two is filled.
    await set(page, 'c_name', 'Only Required');
    await set(page, 'c_email', 'only@required.example');
    await advance(page);
    if (door === 'private') { await page.locator('#opt-surveillance').click(); await page.waitForTimeout(80); await advance(page); }
    if (door === 'legal') {
      await set(page, 'lf_firm', 'Required Firm'); await set(page, 'lf_atty', 'Required Attorney');
      await advance(page);
      await set(page, 'lm_client', 'Required Client');       // one half of the pair
      await advance(page);
    }
    if (door === 'insurance') {
      await set(page, 'k_carrier', 'Required Carrier');
      await advance(page);
      await set(page, 's_name', 'Required Claimant');        // one half of the pair
      await advance(page);
    } else {
      await advance(page);                                   // subject step, nothing required
    }
    await set(page, 'o_goal', 'One line is all that is required.');
    await advance(page);
    if (door === 'insurance') {
      await page.locator('#opt-auth-a24').click(); await page.waitForTimeout(80);
      await advance(page);
    }
    ok(`${door}: filling only the non-optional fields reaches the agreement`,
       /Agreement|Assignment terms/.test(await heading(page)), await heading(page));
    await page.locator('[data-k="a_consent"]').check();
    await set(page, 'a_typed', 'Only Required');
    await sign(page);
    await advance(page);
    if (door === 'insurance') await advance(page);            // billing step: nothing on it is required
    await page.waitForTimeout(500);
    ok(`${door}: and it submits — nothing marked (optional) was actually needed`,
       !!stored, JSON.stringify(await heading(page)));
    await page.close();
  }
}

/* AND THE OTHER DIRECTION: a marker that says required has to BE required,
   or the marker is decoration. Each of these is blanked on a form that is
   otherwise complete for that step. */
section('Every field marked * really does block the step');
{
  const page = await newPage();
  await page.goto(BASE + '?assignment=legal');
  await page.waitForTimeout(120);
  await advance(page);
  ok('the name blocks the contact step', /full name/i.test(await err(page)), await err(page));
  await set(page, 'c_name', 'P Aralegal');
  await advance(page);
  ok('and so does having neither phone nor email — the pair is real',
     /phone number or email/i.test(await err(page)), await err(page));
  await set(page, 'c_email', 'p@firm.example');
  await advance(page);

  await advance(page);
  ok('the law firm blocks the firm step', /law firm/i.test(await err(page)), await err(page));
  await set(page, 'lf_firm', 'Smith Law');
  await advance(page);
  ok('and so does the attorney', /attorney/i.test(await err(page)), await err(page));
  await set(page, 'lf_atty', 'J Smith');
  await advance(page);

  await advance(page);
  ok('neither half of the client/matter pair alone is optional',
     /matter number/i.test(await err(page)), await err(page));
  await set(page, 'lm_matter', 'M-1');           // the OTHER half satisfies it
  await advance(page);
  ok('and either half satisfies it', (await heading(page)).includes('Subject'), await heading(page));
  await advance(page);
  await advance(page);
  ok('the objective blocks the objective step — the * this unit added',
     /documented/i.test(await err(page)), await err(page));
  await page.close();
}

/* THE MARKER IS A MARKER, NOT A CARD. `.opt` in this file is the big
   service-picker card — display:block, 1.5px border, 14px padding,
   cursor:pointer — and `<span class="opt">optional</span>` inside a label
   inherited all of it: measured at 602x53 with a pointer cursor on the firm
   step, a clickable-looking box in the middle of a field label. That is the
   class-name contest CLAUDE.md records for .qgrid, .dlg and the burger rule.
   The marker has its own class now, and this is what stops it drifting back. */
section('The optional marker draws as text, at every width');
{
  for (const width of [1200, 768, 390, 320]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    await page.route('**api.web3forms.com/**', r => r.fulfill({ status: 200, body: '{}' }));
    await page.route('**/portal-api/ingest', r => r.fulfill({ status: 200, body: '{}' }));
    await page.goto(BASE + '?assignment=legal');
    await page.waitForTimeout(150);
    const m = await page.evaluate(() => {
      const sp = document.querySelector('label.f > span .optn');
      if (!sp) return null;
      const cs = getComputedStyle(sp), lab = sp.parentElement;
      const r = sp.getBoundingClientRect(), lr = lab.getBoundingClientRect();
      return { display: cs.display, border: parseFloat(cs.borderTopWidth),
               pad: parseFloat(cs.paddingTop), cursor: cs.cursor,
               size: parseFloat(cs.fontSize), weight: cs.fontWeight,
               labelSize: parseFloat(getComputedStyle(lab).fontSize),
               labelWeight: getComputedStyle(lab).fontWeight,
               sameLine: Math.abs(r.top - lr.top) < 6 };
    });
    ok(`${width}px: the marker is inline text, not a bordered box`,
       m && m.display === 'inline' && m.border === 0 && m.pad === 0, JSON.stringify(m));
    ok(`${width}px: it is not styled as something to click`,
       m && m.cursor !== 'pointer', JSON.stringify(m));
    ok(`${width}px: it sits on the label's own line, lighter and smaller than it`,
       m && m.sameLine && m.size < m.labelSize && Number(m.weight) < Number(m.labelWeight),
       JSON.stringify(m));
    await ctx.close();
  }
}

/* Consistency across widths is the owner's own line. The same fields must
   carry the same markers on a phone as on a desktop — a marker that a
   media query drops is a marker nobody on a phone ever sees. */
section('Desktop and mobile show the same markers');
{
  const read = async width => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    await page.route('**api.web3forms.com/**', r => r.fulfill({ status: 200, body: '{}' }));
    await page.route('**/portal-api/ingest', r => r.fulfill({ status: 200, body: '{}' }));
    await page.goto(BASE + '?assignment=insurance');
    await page.waitForTimeout(150);
    const out = [];
    for (const step of ['info', 'claim']) {
      out.push(...await page.evaluate(() => [...document.querySelectorAll('label.f')].map(l => {
        const sp = l.querySelector(':scope > span');
        const ctl = l.querySelector('input, select, textarea');
        const t = sp ? sp.textContent.replace(/\s+/g, ' ').trim() : '';
        const vis = sp ? getComputedStyle(sp.querySelector('.optn, .req') || sp).display : '';
        return `${ctl ? (ctl.getAttribute('data-k') || '') : ''}=${
          /\(optional\)/.test(t) ? 'opt' : /\*/.test(t) ? 'req' : /\(/.test(t) ? 'pair' : 'NONE'}/${vis}`;
      })));
      if (step === 'info') {
        await page.locator('[data-k="c_name"]').fill('A'); await page.locator('[data-k="c_email"]').fill('a@b.co');
        await page.locator('.btn.primary').click(); await page.waitForTimeout(150);
      }
    }
    await ctx.close();
    return out;
  };
  const wide = await read(1200), narrow = await read(390);
  ok('the same fields carry the same markers at 1200px and 390px',
     JSON.stringify(wide) === JSON.stringify(narrow),
     `${JSON.stringify(wide)}\n${JSON.stringify(narrow)}`);
  ok('and none of them is unmarked at either width',
     !wide.some(x => x.includes('=NONE')) && !narrow.some(x => x.includes('=NONE')),
     JSON.stringify(wide.filter(x => x.includes('=NONE'))));
}

/* One writer for the wording. Five places in this file used to spell the
   marker by hand, in three different phrasings; the suite would then be
   asserting on whichever one it happened to reach. */
section('The markers have one writer');
{
  const src = fs.readFileSync(path.join(ROOT, 'intake', 'index.html'), 'utf8');
  /* The constants themselves and the comment that explains them are the one
     place the words are allowed to appear. Everything else is markup. */
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '')
                  .replace(/const (REQ|OPT|PAIR|ONE_[A-Z]+)\b[^\n]*\n/g, '');
  ok('no hand-written required marker outside the constant',
     !/<b class="req">\*<\/b>/.test(body), (body.match(/<b class="req">[^<]*<\/b>/) || [''])[0]);
  ok('no hand-written "(optional)" outside the constant',
     (body.match(/\(optional\)/g) || []).length === 0,
     JSON.stringify((body.match(/.{0,40}\(optional\).{0,20}/g) || []).slice(0, 3)));
  /* Read off the comment-stripped source: the CSS comment beside `.optn`
     quotes the broken markup on purpose, and that quote is the explanation,
     not a use. */
  const markup = src.replace(/\/\*[\s\S]*?\*\//g, '');
  ok('the label marker class is not the service-picker card class',
     !/<span class="opt">/.test(markup),
     (markup.match(/.{0,60}<span class="opt">/) || [''])[0]);
}


/* ==================================================================
   UNIT 37A — EACH DOOR ANNOUNCES ITSELF (Production Truth Round 2, MEDIUM)

   The visually-hidden <h1> is the page's identity to a screen reader, and the
   legal door used to fall through to the private branch's and announce
   "Client Intake" — the private-client name, on the door whose whole purpose
   is that a legal visitor is never routed through the private-client intake.
   The browser tab and the masthead were already right, which is exactly why
   nobody looking at the screen ever saw it.

   Verified per door, independently, because two of the three were already
   correct and a check that only looked at one of them would have passed. */

section('Each intake door announces its own name');
{
  const EXPECT = {
    private:   { name: 'Client Intake',                  kind: 'INVESTIGATIONS · CLIENT INTAKE' },
    insurance: { name: 'Secure Assignment Intake',       kind: 'INVESTIGATIONS · ASSIGNMENT INTAKE' },
    legal:     { name: 'Legal Investigation Assignment', kind: 'INVESTIGATIONS · LEGAL ASSIGNMENT' },
  };
  for (const [door, want] of Object.entries(EXPECT)) {
    const page = await newPage();
    await page.goto(BASE + '?assignment=' + door);
    await page.waitForTimeout(150);
    const got = await page.evaluate(() => ({
      h1: (document.querySelector('.sr-page-title') || {}).textContent,
      title: document.title,
      kind: (document.getElementById('m-kind') || {}).textContent,
      h1count: document.querySelectorAll('.sr-page-title').length,
      hidden: (() => { const e = document.querySelector('.sr-page-title'); if (!e) return null;
        const r = e.getBoundingClientRect(); return r.width <= 2 && r.height <= 2; })(),
    }));
    ok(`${door}: the accessible page name is "${want.name}"`, got.h1 === want.name, JSON.stringify(got));
    ok(`${door}: the browser tab agrees with it`, (got.title || '').startsWith(want.name), got.title);
    ok(`${door}: the masthead agrees with it`, got.kind === want.kind, got.kind);
    ok(`${door}: there is exactly one accessible page name`, got.h1count === 1, String(got.h1count));
    ok(`${door}: and it stays visually hidden`, got.hidden === true, JSON.stringify(got));
    await page.close();
  }

  /* The bare door has no fixed product, so it renames itself when one is
     chosen — a heading that said one thing while the tab said another would
     be the same defect one layer along. */
  const page = await newPage();
  await page.goto(BASE);
  await page.waitForTimeout(150);
  ok('the bare door opens as the client intake',
     (await page.evaluate(() => document.querySelector('.sr-page-title').textContent)) === 'Client Intake');
  await set(page, 'c_name', 'A Person');
  await set(page, 'c_email', 'a@example.test');
  await advance(page);
  for (const [id, want] of [['#opt-legal', 'Legal Investigation Assignment'],
                            ['#opt-claims', 'Secure Assignment Intake'],
                            ['#opt-surveillance', 'Client Intake']]) {
    await page.locator(id).click();
    await page.waitForTimeout(120);
    const t = await page.title();
    const k = await page.locator('#m-kind').innerText();
    ok(`choosing ${id} renames the page to "${want}"`, t.startsWith(want), `${t} / ${k}`);
  }
  /* And the name survives the next step, where the h1 is drawn again. */
  await page.locator('#opt-legal').click();
  await page.waitForTimeout(120);
  await advance(page);
  ok('and it holds after advancing', (await page.title()).startsWith('Legal Investigation Assignment'),
     await page.title());
  await page.close();

  /* One writer, so the three names cannot drift apart. */
  const src = fs.readFileSync(path.join(ROOT, 'intake', 'index.html'), 'utf8');
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '');
  ok('the accessible name has one writer',
     (body.match(/sr-page-title">\$\{pageName\(\)\}/g) || []).length === 2
       && !/sr-page-title">[A-Za-z]/.test(body),
     (body.match(/sr-page-title">[^<]*/g) || []).join(' | '));
  ok('and document.title is set from it in one place',
     (body.match(/document\.title\s*=/g) || []).length === 1,
     String((body.match(/document\.title\s*=/g) || []).length));
}

/* ------------------------------------------------------------------ report */

/* ============ UNIT 40 — THE THREE HERO CTA CARDS ============

   The owner's approved direction: three equal image-style cards in place of
   the two hero buttons, routing to the three intake doors. Tested in a real
   browser against the real page, at the three widths the layout changes at.

   THE ORIGIN OF THIS SUITE'S SERVER IS THE REPO ROOT, so `/` is the homepage
   exactly as it will be served. */
const HOME = `http://127.0.0.1:${server.address().port}/`;

async function homePage(width, height = 900) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  page.on('pageerror', e => ok(`no homepage errors at ${width}px (${e.message})`, false));
  await page.goto(HOME);
  await page.waitForTimeout(200);
  return { ctx, page };
}

section('Unit 40 — three cards, three doors');
{
  const { ctx, page } = await homePage(1280);

  const cards = await page.evaluate(() =>
    [...document.querySelectorAll('.cta-cards .cta-card')].map(a => ({
      href: a.getAttribute('href'),
      name: (a.textContent || '').replace(/\s+/g, ' ').trim(),
      tag: a.tagName,
    })));
  ok('there are exactly three cards', cards.length === 3, JSON.stringify(cards.map(c => c.href)));

  /* ROUTING — the whole point of the unit, and the one thing that must not be
     got wrong: a law firm routed through the private door lands somewhere
     `pickSvc` refuses outright. */
  ok('the Insurance card reaches the carrier door',
     cards[0].href === '/intake/?assignment=insurance', cards[0].href);
  ok('the Legal card reaches the LEGAL door',
     cards[1].href === '/intake/?assignment=legal', cards[1].href);
  ok('the Private card reaches the private door',
     cards[2].href === '/intake/?assignment=private', cards[2].href);
  ok('and the Legal card is NOT routed through private or carrier',
     cards[1].href !== '/intake/?assignment=private'
     && cards[1].href !== '/intake/?assignment=insurance', cards[1].href);

  /* Each is a real link, not a div with a handler. */
  ok('each card is a real anchor', cards.every(c => c.tag === 'A'));

  /* ACCESSIBLE NAMES. The title carries the meaning; "Get Started" is
     aria-hidden so it does not pad every name with the same two words, and the
     icons and artwork are decorative. */
  const names = await page.evaluate(() =>
    [...document.querySelectorAll('.cta-cards .cta-card')].map(a => {
      const clone = a.cloneNode(true);
      clone.querySelectorAll('[aria-hidden="true"]').forEach(n => n.remove());
      return clone.textContent.replace(/\s+/g, ' ').trim();
    }));
  ok('the Insurance card announces itself', names[0] === 'Submit an Insurance Assignment', names[0]);
  ok('the Legal card announces itself', names[1] === 'Submit a Legal Assignment', names[1]);
  ok('the Private card announces itself', names[2] === 'Request a Private Investigation', names[2]);

  /* NOT RELIANT ON THE BACKGROUND IMAGE. The art is a CSS background on an
     aria-hidden span; strip every decorative node and the meaning survives,
     which the assertion above already proves. This pins the mechanism. */
  const decorative = await page.evaluate(() => ({
    art: [...document.querySelectorAll('.cta-art')].every(n => n.getAttribute('aria-hidden') === 'true'),
    icons: [...document.querySelectorAll('.cta-icon')].every(n => n.getAttribute('aria-hidden') === 'true'),
    inImg: document.querySelectorAll('.cta-cards img').length,
  }));
  ok('the artwork and icons are marked decorative', decorative.art && decorative.icons,
     JSON.stringify(decorative));
  ok('and no meaning is carried by an <img> in a card', decorative.inImg === 0);

  /* ONE TAB STOP PER CARD — a button nested in a link would give two, for one
     destination. */
  const stops = await page.evaluate(() =>
    document.querySelectorAll('.cta-cards a, .cta-cards button, .cta-cards [tabindex]').length);
  ok('one focusable control per card, not two', stops === 3, String(stops));

  await ctx.close();
}

section('Unit 40 — the layout at three widths');
{
  /* DESKTOP: one balanced row. Measured, not assumed — three cards on one row
     means three distinct x positions and one shared y. */
  const { ctx, page } = await homePage(1280);
  const desk = await page.evaluate(() => {
    const r = [...document.querySelectorAll('.cta-cards .cta-card')].map(a => a.getBoundingClientRect());
    return { tops: r.map(x => Math.round(x.top)), lefts: r.map(x => Math.round(x.left)),
             widths: r.map(x => Math.round(x.width)), heights: r.map(x => Math.round(x.height)),
             doc: Math.round(document.documentElement.scrollWidth - window.innerWidth) };
  });
  ok('desktop draws all three on one row', new Set(desk.tops).size === 1, JSON.stringify(desk.tops));
  ok('in three distinct columns', new Set(desk.lefts).size === 3, JSON.stringify(desk.lefts));
  ok('at equal widths', new Set(desk.widths).size === 1, JSON.stringify(desk.widths));
  ok('and equal heights', new Set(desk.heights).size === 1, JSON.stringify(desk.heights));
  ok('with no horizontal overflow', desk.doc <= 0, String(desk.doc));
  await ctx.close();

  /* PHONE: one column, in the owner's order, still no sideways scroll. */
  for (const w of [390, 360, 320]) {
    const { ctx: c2, page: p2 } = await homePage(w, 844);
    const m = await p2.evaluate(() => {
      const els = [...document.querySelectorAll('.cta-cards .cta-card')];
      const r = els.map(a => a.getBoundingClientRect());
      return { lefts: r.map(x => Math.round(x.left)), tops: r.map(x => Math.round(x.top)),
               order: els.map(a => a.getAttribute('href')),
               go: [...document.querySelectorAll('.cta-go')].map(n => Math.round(n.getBoundingClientRect().height)),
               doc: Math.round(document.documentElement.scrollWidth - window.innerWidth),
               widest: Math.max(...r.map(x => Math.round(x.right))), vw: window.innerWidth };
    });
    ok(`${w}px: the cards stack in one column`, new Set(m.lefts).size === 1, JSON.stringify(m.lefts));
    ok(`${w}px: each below the last`, m.tops[0] < m.tops[1] && m.tops[1] < m.tops[2], JSON.stringify(m.tops));
    ok(`${w}px: Insurance, Legal, Private in that order`,
       m.order.join('|') === '/intake/?assignment=insurance|/intake/?assignment=legal|/intake/?assignment=private',
       m.order.join('|'));
    /* THE CARDS' OWN EDGE, not the whole document, and the difference matters.
       At 320px this page ALREADY overflowed by 15px before Unit 40 — measured
       against the committed homepage — from a "Call for a Free Consultation"
       button in a section this brief forbids redesigning. These cards reduced
       that to 5px; they did not cause it and may not fix it.

       So the assertion is what this unit owns: no card crosses the viewport
       edge. The document-level check runs at 390px, where the page is genuinely
       clean, and the residue is reported to the owner rather than silently
       absorbed into a passing test. */
    ok(`${w}px: no card crosses the viewport edge`, m.widest <= m.vw + 1, JSON.stringify(m));
    if (w >= 360) ok(`${w}px: and the page does not scroll sideways`, m.doc <= 0, String(m.doc));
    ok(`${w}px: the Get Started target clears Apple's 44px floor`,
       m.go.every(h => h >= 44), JSON.stringify(m.go));
    await c2.close();
  }

  /* TABLET: two across rather than three squeezed or one wasted. */
  const { ctx: c3, page: p3 } = await homePage(820, 1100);
  const tab = await p3.evaluate(() => {
    const r = [...document.querySelectorAll('.cta-cards .cta-card')].map(a => a.getBoundingClientRect());
    return { rows: new Set(r.map(x => Math.round(x.top))).size,
             doc: Math.round(document.documentElement.scrollWidth - window.innerWidth) };
  });
  ok('820px puts them on two rows rather than three-across', tab.rows === 2, String(tab.rows));
  ok('and still does not scroll sideways', tab.doc <= 0, String(tab.doc));
  await c3.close();
}

section('Unit 40 — contrast, focus, and what the hero kept');
{
  const { ctx, page } = await homePage(1280);

  /* CONTRAST. The overlay is a separate layer above the art precisely so the
     text does not depend on the image — so the check is that the overlay is
     there and the title is white on a dark card. */
  const look = await page.evaluate(() => {
    const card = document.querySelector('.cta-card');
    const art = card.querySelector('.cta-art');
    const title = card.querySelector('.cta-title');
    const go = card.querySelector('.cta-go');
    const over = getComputedStyle(art, '::after');
    return { titleColor: getComputedStyle(title).color,
             goBg: getComputedStyle(go).backgroundColor,
             goColor: getComputedStyle(go).color,
             overlay: over.backgroundImage, art: getComputedStyle(art).backgroundImage };
  });
  ok('the card carries a dark overlay above its artwork',
     /gradient/.test(look.overlay), look.overlay.slice(0, 80));
  /* getComputedStyle RESOLVES the url to absolute, so every background reads
     as `http://…` under a local server and a naive "does not start with http"
     check fails on a perfectly local file. The rendered value proves it
     RESOLVED to our own assets path; the SOURCE proves it was written
     relative, which is the half that would catch a hotlink. */
  ok('the artwork resolves to this site\'s own assets path',
     /\/assets\/card-[a-z]+\.svg"\)$/.test(look.art), look.art.slice(0, 90));
  const cssSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const artUrls = [...cssSrc.matchAll(/--cta-art:\s*url\('([^']+)'\)/g)].map(m => m[1]);
  ok('and every card names a RELATIVE local asset, never an external host',
     artUrls.length === 3 && artUrls.every(u => /^assets\/card-/.test(u)), JSON.stringify(artUrls));
  ok('the title is white', look.titleColor === 'rgb(255, 255, 255)', look.titleColor);
  ok('and Get Started is the site teal on white', look.goColor === 'rgb(255, 255, 255)'
     && look.goBg === 'rgb(61, 151, 173)', JSON.stringify(look));

  /* KEYBOARD. Focus must land on each card and be visibly marked. */
  const focus = await page.evaluate(() => {
    const out = [];
    for (const a of document.querySelectorAll('.cta-cards .cta-card')) {
      a.focus();
      const s = getComputedStyle(a);
      out.push({ focused: document.activeElement === a,
                 outline: s.outlineWidth, style: s.outlineStyle });
    }
    return out;
  });
  ok('every card takes keyboard focus', focus.every(f => f.focused), JSON.stringify(focus));
  const rule = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ok('and a focus-visible ring is defined for them',
     /\.cta-card:focus-visible\{[^}]*outline:\s*3px/.test(rule));

  /* WHAT THE BRIEF SAID NOT TO TOUCH. */
  const kept = await page.evaluate(() => ({
    h1: (document.querySelector('.hero h1') || {}).textContent || '',
    lede: (document.querySelector('.hero p') || {}).textContent || '',
    contact: !!document.querySelector('.hero [onclick*="openContact"]'),
    call: !!document.querySelector('.hero a[href="tel:+14349070975"]'),
    stars: (document.querySelector('.hero .stars') || {}).textContent || '',
    nav: document.querySelectorAll('nav a').length,
  }));
  ok('the hero headline is unchanged',
     /Surveillance & Investigation Services for Insurance, Legal and Private Clients/.test(kept.h1), kept.h1);
  ok('the hero description is unchanged', /Licensed, insured, and discreet/.test(kept.lede));
  ok('Contact Us is still there and still wired', kept.contact === true);
  ok('Call (434) 907-0975 is still there', kept.call === true);
  ok('the 5-star / DCJS line is still there',
     /5-Star Rated/.test(kept.stars) && /11-9159/.test(kept.stars), kept.stars);
  ok('and the navigation is untouched', kept.nav >= 4, String(kept.nav));

  /* NO PUBLIC PRICING INTRODUCED — the standing rule, checked on the rendered
     page rather than only on the source. */
  const text = await page.evaluate(() => document.body.innerText);
  ok('the new cards introduce no dollar figure', !/\$\s?\d/.test(text),
     (text.match(/\$\s?\d[\d,]*/g) || []).slice(0, 3).join(' '));
  ok('and no rate-sheet or pricing language',
     !/rate sheet|pricing sheet|view rates|our rates|price list/i.test(text));
  await ctx.close();
}

await browser.close();
server.close();

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
