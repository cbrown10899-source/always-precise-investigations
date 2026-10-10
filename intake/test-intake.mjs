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
const HOME_ROOT = `http://127.0.0.1:${server.address().port}/`;

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
/* A FILL THAT FAILS BY NAME. The carrier door's company field has a place it
   must be — the first step — and a plain fill of a field that is not there
   crashes the run on a locator timeout, which is caught but says nothing about
   WHAT was missing. The Full Custom unit's `fillOr` lesson. */
async function need(page, k, v, where) {
  const n = await page.locator(`[data-k="${k}"]`).count();
  ok(`${where}: the ${k} field is there to fill`, n === 1, `${n} found`);
  if (n === 1) await page.locator(`[data-k="${k}"]`).fill(v);
}
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
  ok('step 2 offers the services', services.includes('Child Custody') && services.includes('Spouse / Relationship')
     && services.includes('Other Private Investigation') && services.includes('Surveillance'));
  ok('no price is attached to surveillance', !/\$\s?\d/.test(services), services);
  ok('the client is told a fee sheet comes in writing', /fee sheet/i.test(services));

  await page.locator('#opt-other').click();
  await page.waitForTimeout(80);
  ok('choosing Other Private Investigation does not add a pricing step', await dots(page) === 5);
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
  ok('step 3 is the assignment-and-claim step', await heading(page) === 'Assignment & claim information');
  /* The bare door's contact step is shared with every service, so the company
     is asked HERE — and an email already given there is not asked again. */
  ok('on the bare door the company is asked on the claim step',
     await page.locator('[data-k="k_carrier"]').count() === 1);
  ok('and an email already given on the contact step is not asked for twice',
     await page.locator('[data-k="c_email"]').count() === 0);

  await advance(page);
  ok('an assignment without a carrier is refused', (await err(page)).includes('carrier'));
  await set(page, 'k_carrier', 'Example Mutual');

  /* INTAKE-NA: the claim number is no longer a gate. An urgent assignment
     often has none yet, and the form must not invent one. */
  const claimStep = await page.locator('.card').innerText();
  ok('the claim number can be marked unavailable instead of faked',
     claimStep.includes('Claim number not available at this time'));
  ok('and it never holds up an urgent assignment', /never holds up/i.test(claimStep));
  ok('the assignment is described before the claim — its own two headings, in that order',
     claimStep.indexOf('Assignment information') > -1
     && claimStep.indexOf('Assignment information') < claimStep.indexOf('Claim information'));
  /* SERVICE REQUESTED offers only what the Insurance page already offers, and
     "not sure yet" is a real answer rather than a forced guess. */
  const offered = await page.locator('[data-k="k_service"] option').allInnerTexts();
  ok('service requested offers exactly the carrier services, plus not sure yet',
     JSON.stringify(offered.slice(1)) === JSON.stringify(['Surveillance', 'Claims investigation',
       "Workers' compensation investigation", 'Auto claim investigation', 'Other / not sure yet']),
     JSON.stringify(offered));
  ok('and nothing the public site withdrew is offered as a service',
     !/recorded statement|canvass|interview|social media/i.test(offered.join(' ')));
  ok('the start wording is the approved hedge, never a same-day guarantee',
     claimStep.includes('In many cases, we can begin as soon as the same day, depending on availability and the type of assignment.')
     && !/guarantee/i.test(claimStep));
  const urgency = await page.locator('[data-k="z_priority"] option').allInnerTexts();
  ok('urgency is Standard / Soon / Urgent, and nothing promises availability',
     JSON.stringify(urgency.slice(1)) === JSON.stringify(['Standard', 'Soon', 'Urgent / time sensitive']),
     JSON.stringify(urgency));

  await page.locator('[data-k="k_service"]').selectOption({ label: 'Surveillance' });
  await set(page, 'z_start', '2026-09-01');
  await page.locator('[data-k="z_priority"]').selectOption({ label: 'Urgent / time sensitive' });
  await set(page, 'k_claimno', 'WC-2026-88421');
  await set(page, 'k_policy', 'POL-77123');
  await page.locator('[data-k="k_type"]').selectOption({ label: "Workers' compensation" });
  await set(page, 'k_dol', '03/14/2026');
  await set(page, 'k_insured', 'Acme Staffing LLC');
  await set(page, 'k_adjuster', 'Dana Adjuster');
  await set(page, 'k_adj_email', 'dana@carrier.example');
  await page.locator('[data-k="k_prior"]').selectOption({ label: 'None' });
  await advance(page);

  ok('the subject step is headed for a claims desk', await heading(page) === 'Subject information');
  ok('and its name field says claimant',
     (await page.locator('.card').innerText()).includes('Claimant / subject name'));
  ok('the carrier subject step offers no documents box it cannot honour',
     await page.locator('#filenote').count() === 0);
  await set(page, 's_name', 'Pat Claimant');
  await set(page, 's_rel', 'Lumbar strain; no lifting over 10 lbs');
  await advance(page);
  ok('the objective step is the assignment objective', await heading(page) === 'Assignment objective');
  const objStep = await page.locator('.card').innerText();
  ok('it asks what to document or investigate — never for a conclusion',
     objStep.includes('What would you like us to document or investigate?')
     && !/prove|fraud|conclu/i.test(objStep), objStep.slice(0, 300));
  ok('it still asks for the deadline', objStep.includes('Deadline or key dates'));
  ok('the known schedule is asked in the owner\'s own words',
     await page.locator('[data-k="o_sched"]').getAttribute('placeholder')
       === 'Known appointments, work schedule, regular activity, upcoming events, or other timing information that may help with the assignment.');
  ok('special instructions / restrictions has its own section', objStep.includes('Special instructions / restrictions'));
  ok('referral documents are explained, with nothing uploaded from the form',
     /attached to the case by the office once the assignment is accepted/i.test(objStep)
     && await page.locator('input[type=file]').count() === 0);
  await set(page, 'o_goal', 'Activity level versus stated restrictions');
  await set(page, 'o_time', 'Hearing 9/12');
  await set(page, 'o_sched', 'Physical therapy Thursday at 10:00 AM');
  await set(page, 'o_notes', 'Do not approach the residence');
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
  ok('the requested start and urgency are asked once — on the claim step, not again here',
     await page.locator('[data-k="z_start_mode"]').count() === 0
     && await page.locator('[data-k="z_priority"]').count() === 0);

  await advance(page);
  ok('authorization is required', await heading(page) === 'Scheduling & authorization');
  ok('and it says so', (await err(page)).toLowerCase().includes('hours'));

  await page.locator('#opt-auth-a24').click();
  await page.waitForTimeout(80);
  await set(page, 'z_nte', '$3,600 not to exceed');
  await set(page, 'z_days', 'Any day');
  await set(page, 'z_times', '0600-1400');
  await page.locator('[data-k="z_weekend"]').selectOption({ label: 'Yes — weekends authorized' });
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

  ok('step 8 is billing', await heading(page) === 'Billing / reference information');
  const billing = await page.locator('.feebox').innerText();
  ok('billing echoes the carrier and claim number',
     billing.includes('Example Mutual') && billing.includes('WC-2026-88421'));
  /* The references are asked HERE now, beside each other, rather than echoed
     from an earlier step. */
  ok('the purchase order, billing reference and invoice reference are asked on the billing step',
     await page.locator('[data-k="b_po"]').count() === 1 && await page.locator('[data-k="k_po"]').count() === 1
     && await page.locator('[data-k="b_invref"]').count() === 1);
  ok('no consumer payment button is offered to a carrier', await page.locator('.pay-btn').count() === 0);
  await set(page, 'b_po', 'PO-5590');
  await set(page, 'k_po', 'BR-311');
  await set(page, 'b_invref', 'INV-REF-9');
  await set(page, 'b_email', 'ap@carrier.example');
  await set(page, 'b_notes', 'Upload invoices to the carrier portal');
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
    ok('the portal record carries the urgency where the field already reads priority',
       stored.priority === 'Urgent / time sensitive');
    ok('the portal record carries the service requested', stored.service_requested === 'Surveillance');
    ok('the portal record carries the insured', stored.insured_name === 'Acme Staffing LLC');
    ok('the portal record carries the known schedule',
       stored.known_schedule === 'Physical therapy Thursday at 10:00 AM' && !('known_schedule_status' in stored));
    ok('special instructions reach the notes field the field already reads',
       stored.notes === 'Do not approach the residence');
    ok('the portal record carries the purchase order', stored.po_number === 'PO-5590');
    ok('the portal record carries the billing reference', stored.billing_reference === 'BR-311');
    ok('the portal record carries the invoice reference', stored.invoice_reference === 'INV-REF-9');
    ok('special billing instructions arrive as typed, with nothing merged into them',
       stored.billing_notes === 'Upload invoices to the carrier portal');
    ok('the portal record carries the geographic limits',
       stored.geographic_limits === 'Within 50 miles of Roanoke');
    ok('the portal record carries the billing email', stored.billing_email === 'ap@carrier.example');
    ok('the portal record marks the work invoiced', stored.payment_method === 'Invoiced to carrier');
    ok('nothing is charged at assignment', stored.fee_due === 0);
    ok('the authorization signature is captured',
       typeof stored.signature === 'string' && stored.signature.startsWith('data:image/png'));
  }
  const record = await page.locator('.record').innerText();
  ok('the confirmation is an assignment receipt', record.includes('Assignment received'));
  const rc = await page.locator('.receipt').innerText();
  ok('the receipt names the request number, claim, subject, service, start and company',
     stored && rc.includes(stored.case_no) && rc.includes('WC-2026-88421') && rc.includes('Pat Claimant')
     && rc.includes('Surveillance') && rc.includes('2026-09-01') && rc.includes('Example Mutual'), rc);
  ok('the receipt promises no acceptance',
     /does not by itself constitute acceptance/i.test(rc)
     && !/has been accepted|have accepted your|your assignment is accepted|will begin on/i.test(record), rc);
  ok('and with no receipt reported by the portal, it does not claim an email went',
     !/has been emailed/i.test(record));
  ok('the full assignment is kept below the receipt', record.includes('Full assignment as submitted'));
  ok('record shows the claim identifiers',
     record.includes('WC-2026-88421') && record.includes('Example Mutual'));
  ok('record uses claimant wording', record.includes('Claimant'));
  ok('record carries every new assignment field',
     ['Known schedule / activity', 'Special instructions / restrictions', 'Insured', 'Urgency',
      'PO number', 'Billing reference', 'Invoice reference', 'Service requested']
       .every(w => record.includes(w)), record.slice(0, 600));
  ok('record shows no consumer amount due', !record.includes('Due today'));
  ok('nothing typed reaches the address bar',
     !/WC-2026|Pat|dana|Acme/i.test(page.url()), page.url());
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
  /* NEAR THE TOP, SAID ONCE: a referral document is not uploaded here, and the
     adjuster working from one learns that before retyping it. */
  ok('the first step says where a referral goes, before any field is filled',
     /Working from a referral\?/.test(await page.locator('.card').innerText())
     && /attached to the file by the office once the assignment is accepted/i.test(await page.locator('.card').innerText()));
  await set(page, 'c_name', 'Dana Adjuster');
  await need(page, 'k_carrier', 'Urgent Mutual', 'partial assignment, contact step');
  await set(page, 'c_email', 'dana@carrier.example');
  await advance(page);

  // Claim details: no claim number yet, and the date of loss genuinely unknown.
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
  // A start date nobody can commit to yet — asked on this step now.
  await page.locator('[data-k="z_start_mode"]').selectOption({ label: 'Flexible' });
  await page.waitForTimeout(120);
  ok('a flexible start needs no date at all',
     await page.locator('[data-k="z_start"]').count() === 0);
  await advance(page);

  // Claimant: named, but nobody knows the address or the vehicle yet.
  ok('the assignment reaches the claimant step without a claim number',
     await heading(page) === 'Subject information');
  await set(page, 's_name', 'Pat Claimant');
  await page.locator('[data-k="s_addr_na"]').check();
  await page.locator('[data-k="s_desc_na"]').check();
  await page.waitForTimeout(80);
  ok('an unavailable address disables its field too',
     await page.locator('[data-k="s_addr"]').isDisabled());
  await advance(page);

  await set(page, 'o_goal', 'Activity level versus stated restrictions');
  /* "I don't have this" on the known schedule: the box disables the field
     and records a status, and the value stays empty. */
  await set(page, 'o_sched', 'typed and then withdrawn');
  await page.locator('[data-k="o_sched_na"]').check();
  await page.waitForTimeout(80);
  ok('marking the schedule unknown disables its field',
     await page.locator('[data-k="o_sched"]').isDisabled());
  await advance(page);

  // Authorization pending.
  const authCard = await page.locator('.card').innerText();
  ok('Authorization pending is offered as a preset', authCard.includes('Authorization pending'));
  ok('and it promises the hours are confirmed before billable work',
     /before any billable field work/i.test(authCard));
  await page.locator('#opt-auth-pending').click();
  await page.waitForTimeout(80);
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
  ok('it names the unknown schedule', /Known schedule/i.test(review));
  ok('and says the rest can follow later', /can be provided later/i.test(review));

  await page.locator('[data-k="a_consent"]').check();
  await set(page, 'a_typed', 'Dana Adjuster');
  await sign(page);
  await advance(page);
  await page.locator('[data-k="b_email_na"]').check();
  await set(page, 'k_po', 'typed and then withdrawn');
  await page.locator('[data-k="k_po_na"]').check();
  await page.waitForTimeout(80);
  ok('a billing reference can be marked to follow, which disables its field',
     await page.locator('[data-k="k_po"]').isDisabled());
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
    ok('the known schedule is empty — what was typed before ticking is not sent',
       !stored.known_schedule);
    ok('with its own status', stored.known_schedule_status === 'not_available');
    ok('the billing reference is empty rather than what was typed', !stored.billing_reference);
    ok('and marked to follow', stored.billing_reference_status === 'not_available');
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
         'billing_reference_status', 'claim_number_status', 'date_of_loss_status', 'known_schedule_status',
         'prior_surveillance_status', 'start_date_status', 'subject_address_status',
         'subject_description_status']),
       JSON.stringify(Object.keys(stored).filter(k => k.endsWith('_status')).sort()));
  }

  const rec = await page.locator('.record').innerText();
  ok('the printed record says the claim number was not available',
     /Claim \/ reference(?: number)?[\s\S]{0,40}Not available at submission/i.test(rec), rec.slice(0, 400));
  ok('and so does the receipt above it',
     /Claim \/ reference[\s\S]{0,40}Not available at submission/i.test(await page.locator('.receipt').innerText()));
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
  await page.locator('#opt-other').click();
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
  await set(page, 'k_insured', 'Acme Staffing LLC');
  await set(page, 'k_adjuster', 'Dana Adjuster');
  await advance(page);
  await set(page, 's_name', 'Pat Coleman');
  await set(page, 's_addr', '1142 Rivermont Ave');
  await set(page, 's_desc', 'Silver Ram 1500');
  await set(page, 's_rel', 'Lumbar strain; no lifting over 10 lbs');
  await advance(page);
  await set(page, 'o_goal', 'Activity versus stated restrictions');
  await set(page, 'o_sched', 'Physical therapy Thursday at 10:00 AM');
  await set(page, 'o_notes', 'Do not approach the residence');
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
  await set(page, 'b_po', 'PO-5590');
  await set(page, 'b_invref', 'INV-REF-9');
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
      'the known schedule': 'Physical therapy',
      'the special instructions': 'approach the residence',
      'the insured': 'Acme Staffing',
      'the purchase order': 'PO-5590',
      'the invoice reference': 'INV-REF-9',
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
  /* This door's portal answers that the receipt WENT, so the confirmation
     may say so — the bare-door section above proves the opposite half. */
  await page.route('**/portal-api/ingest', route => {
    stored = JSON.parse(route.request().postData() || '{}');
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"receipt":"sent"}' });
  });
  page.on('pageerror', e => ok(`no page errors (${e.message})`, false));
  await page.goto(BASE + '?assignment=insurance');
  await page.waitForTimeout(200);

  const first = await page.locator('.card').innerText();
  ok('the carrier door opens on the adjuster / referring contact',
     await heading(page) === 'Adjuster / referring contact');
  ok('a carrier is asked for the company sending the assignment, on the first step',
     first.includes('Company / carrier / TPA / employer'));
  ok('a carrier is asked their department or team', first.includes('Department / team'));
  ok('the submitter email is marked required on the carrier door',
     /Email\s*\*/.test(first), first.slice(0, 300));
  ok('and it has no "I don\'t have this" box — the receipt goes there',
     await page.locator('[data-k="c_email_na"]').count() === 0);
  ok('the adjuster is never called a private client',
     !/private client|your spouse|relationship to you/i.test(first));
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
  await need(page, 'k_carrier', 'Blue Ridge Mutual', 'carrier door, contact step');
  await set(page, 'c_email', 'kwhitfield@carrier.example');
  await set(page, 'c_title', 'Claims Adjuster');
  await set(page, 'c_dept', 'WC Claims');
  await page.locator('[data-k="c_orgtype"]').selectOption({ label: 'Insurance carrier' });
  await advance(page);
  ok('step 2 goes straight to the claim, with no service picker',
     await heading(page) === 'Assignment & claim information');
  ok('and the company is not asked a second time',
     await page.locator('[data-k="k_carrier"]').count() === 0);

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
  ok('and it still ends in billing, not payment', await heading(page) === 'Billing / reference information');
  await advance(page);
  await page.waitForTimeout(500);

  ok('the assignment records as a claim', stored && stored.claim_number === 'WC-2026-104871');
  ok('the company asked on the first step is the carrier of record',
     stored && stored.carrier === 'Blue Ridge Mutual');
  ok('the department is recorded', stored && stored.department === 'WC Claims');
  ok('when the portal reports the receipt sent, the confirmation names where it went',
     /A confirmation has been emailed to\s*kwhitfield@carrier\.example/.test(
       await page.locator('.receipt').innerText()));
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
  /* Still a choice — now asked as the owner's own question on this door
     (2026-10-10); the bare door keeps "What do you need?". */
  ok('the service step is still a choice', await heading(page) === 'What type of private investigation do you need?');
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
  ok('the service picker is gone from the flow — seven steps with the legal service',
     await dots(page) === 7);

  // Step 1: the submitter — a paralegal, in this walk.
  await set(page, 'c_name', 'Tessa Boyd');
  await set(page, 'c_email', 'tboyd@harmonboyle.test');
  await advance(page);

  /* Step 2: the legal service (LEGAL-SERVICES.md D9) — chosen at the start of
     the legal flow, required like the main picker, and PRICE-FREE: no pricing
     is public, whatever the service costs. */
  ok('the legal-service step opens next', await heading(page) === 'What does the firm need?');
  await advance(page);
  ok('the service must be chosen, in words', (await err(page)).includes('service the firm needs'));
  const lsvcStep = await page.locator('.card').innerText();
  ok('all five services are offered, with no dollar figure anywhere on the step',
     lsvcStep.includes('Person Locate / Skip Trace') && lsvcStep.includes('Process Service')
     && lsvcStep.includes('General Investigation') && lsvcStep.includes('Surveillance')
     && lsvcStep.includes('Other / Custom Assignment') && !lsvcStep.includes('$'));
  await page.evaluate(() => pickLsvc('general'));
  await page.waitForTimeout(120);
  await advance(page);

  // Step 3: the firm.
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

/* MASTER §29 — the homepage speaks to all three audiences and offers the
   client paths, each through its OWN door of the intake. Guarded here so a
   redesign cannot quietly drop a door or point both paths at the picker.

   RE-AIMED FOR THE 2026-10-10 REDESIGN (owner brief + intake clarification),
   NOT RELAXED. The page is private-client-first now: the hero carries the
   private intake and the call, the two photo cards open that same intake on
   their own answer, and Insurance and Legal sit under "Other Investigation
   Services" with their own doors. The property is unchanged — every audience
   has its own door, every label goes where it says, nothing reaches a door
   meant for someone else — so it reads the page down to the end of the
   "Other Investigation Services" block, which is where the three doors live. */
section('The homepage leads with the private paths and keeps every door');
{
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const top = src.slice(src.indexOf('<main id="main">'), src.indexOf('<section class="sec sec-sand" id="how">'))
                 .replace(/<!--[\s\S]*?-->/g, ' ');   // comments are not content
  /* IT CHECKS THE DOORS, NOT THE WORDS — the lesson of the first widening,
     which matched the word "legal" in a comment and passed with the Legal card
     removed. Each audience is proven by its own intake door. */
  const doors = ['insurance', 'legal', 'private'].filter(k => top.includes(`/intake/?assignment=${k}`));
  ok('the top of the page offers insurance, legal and private clients their own doors',
     doors.length === 3, `doors found: ${doors.join(', ') || 'none'}`);
  const anchors = [...src.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
    .map(m => ({ href: m[1].replace(/&amp;/g, '&'), text: m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() }));
  const all = label => anchors.filter(a => a.text.includes(label));
  const insDoors = all('Submit an Insurance Assignment');
  ok('every homepage link saying Submit an Insurance Assignment goes through the carrier door',
     insDoors.length >= 1 && insDoors.every(a => a.href === '/intake/?assignment=insurance'), JSON.stringify(insDoors.map(a => a.href)));
  const legDoors = all('Submit a Legal Assignment');
  ok('Submit a Legal Assignment goes through the LEGAL door',
     legDoors.length >= 1 && legDoors.every(a => a.href === '/intake/?assignment=legal'), JSON.stringify(legDoors.map(a => a.href)));
  const fill = all('Fill Out Online Intake');
  ok('every Fill Out Online Intake opens the private door with nothing preselected',
     fill.length >= 1 && fill.every(a => a.href === '/intake/?assignment=private'), JSON.stringify(fill.map(a => a.href)));
  const starts = all('Start Intake').map(a => a.href);
  ok('the two photo cards open the SAME private intake, each on its own answer',
     JSON.stringify(starts) === JSON.stringify(['/intake/?assignment=private&service=custody', '/intake/?assignment=private&service=relationship']),
     JSON.stringify(starts));
  ok('Online Intake on the phone bar opens the private door',
     all('Online Intake').filter(a => a.text === 'Online Intake').every(a => a.href === '/intake/?assignment=private'));
  ok('and no homepage label reaches a door meant for another audience',
     [...insDoors, ...legDoors].every(a => !a.href.includes('assignment=private'))
     && [...fill, ...all('Start Intake')].every(a => a.href.startsWith('/intake/?assignment=private')));
  ok('no bare /intake/ link on the homepage either', (src.match(/href="\/intake\/"/g) || []).length === 0);
  ok('the Discreet Phone Call and the phone bar both dial the firm',
     all('Discreet Phone Call').every(a => a.href === 'tel:+14349070975') && all('Call Privately').every(a => a.href === 'tel:+14349070975')
     && all('Discreet Phone Call').length === 1 && all('Call Privately').length === 1);
  ok('contact remains', src.includes('openContact()'));
  const how = (src.match(/<section class="sec sec-sand" id="how">[\s\S]*?<\/section>/) || [''])[0];
  ok('Getting started is simple walks three steps', (how.match(/<li>/g) || []).length === 3);
  ok('and quotes nothing', !how.includes('$'));
  ok('the private paths lead, and Insurance and Legal follow as Other Investigation Services',
     src.indexOf('id="private"') > 0 && src.indexOf('id="private"') < src.indexOf('id="other"'));
  ok('while every consumer service is still on the page',
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
    /* The legal-service step is radio cards like the main picker — no labeled
       fields for the marker audit, and the walk simply chooses one. */
    await page.evaluate(() => pickLsvc('general'));
    await page.waitForTimeout(80);
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
    await need(page, 'k_carrier', 'Example Mutual', 'marker audit, contact step');
    await advance(page);
    await auditStep(page, 'ins:claim');
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
    if (door === 'insurance') await need(page, 'k_carrier', 'Required Carrier', 'insurance door, contact step');   // marked *, on this step
    await advance(page);
    if (door === 'private') { await page.locator('#opt-other').click(); await page.waitForTimeout(80); await advance(page); }
    if (door === 'legal') {
      /* The legal service is a required radio step, like the main picker —
         chosen, never defaulted (LEGAL-SERVICES.md D9). */
      await page.evaluate(() => pickLsvc('general'));
      await page.waitForTimeout(80);
      await advance(page);
      await set(page, 'lf_firm', 'Required Firm'); await set(page, 'lf_atty', 'Required Attorney');
      await advance(page);
      await set(page, 'lm_client', 'Required Client');       // one half of the pair
      await advance(page);
    }
    if (door === 'insurance') {
      await advance(page);                                   // claim step: nothing on it is required
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
  ok('the legal service blocks its own step — a service is chosen, never defaulted',
     /service the firm needs/i.test(await err(page)), await err(page));
  await page.evaluate(() => pickLsvc('general'));
  await page.waitForTimeout(80);
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

/* THE CARRIER DOOR'S OWN REQUIRED FIELDS, BLANKED ONE AT A TIME (owner,
   2026-09-24). The submitter's email is required because the assignment
   confirmation is sent there — and it is the one contact detail with no
   "I don't have this" box. The company is required because the file cannot be
   opened without knowing who sent it. Nothing else on the first two steps
   blocks. */
section('The carrier door refuses what it needs, and only that');
{
  const page = await newPage();
  await page.goto(BASE + '?assignment=insurance');
  await page.waitForTimeout(120);
  await advance(page);
  ok('the name blocks the contact step', /full name/i.test(await err(page)), await err(page));
  await set(page, 'c_name', 'A Djuster');
  await need(page, 'k_carrier', 'Example Mutual', 'required-fields walk, contact step');
  await set(page, 'c_phone', '4345550111');
  await advance(page);
  ok('a phone alone does NOT pass — the submitter email is required here',
     await heading(page) === 'Adjuster / referring contact' && /email/i.test(await err(page)), await err(page));
  await set(page, 'c_email', 'not-an-email');
  await advance(page);
  ok('and a malformed email is refused the same way',
     await heading(page) === 'Adjuster / referring contact' && /email/i.test(await err(page)), await err(page));
  await set(page, 'c_email', 'a@carrier.example');
  await set(page, 'k_carrier', '');
  await advance(page);
  ok('the company blocks the contact step', /company/i.test(await err(page)), await err(page));
  await set(page, 'k_carrier', 'Example Mutual');
  await advance(page);
  ok('with a name, a company and an email the step passes',
     await heading(page) === 'Assignment & claim information', await heading(page));
  await advance(page);
  ok('nothing on the claim step blocks the carrier door — every field there is optional',
     await heading(page) === 'Subject information', await heading(page));
  await advance(page);
  ok('the subject step wants the claimant or the claim number',
     /claimant|claim number/i.test(await err(page)), await err(page));
  await set(page, 's_name', 'C Laimant');
  await advance(page);
  await advance(page);
  ok('the assignment objective blocks its step', /sentence/i.test(await err(page)), await err(page));
  await page.close();
}

/* THE BARE DOOR: its contact step is shared with every service, so an email
   was only one of two ways to be reached there. A carrier assignment asks for
   it on the claim step — and the field stays put while the adjuster works the
   rest of that step, rather than vanishing the moment a valid address is typed
   and some other control repaints. */
section('The bare door asks a carrier for the email its shared step did not');
{
  const page = await newPage();
  await set(page, 'c_name', 'Phone Only');
  await set(page, 'c_phone', '4345550111');
  await advance(page);
  await page.locator('#opt-claims').click();
  await page.waitForTimeout(80);
  await advance(page);
  ok('the claim step draws the email field', await page.locator('[data-k="c_email"]').count() === 1);
  await set(page, 'k_carrier', 'Example Mutual');
  await advance(page);
  ok('and refuses to go on without it',
     await heading(page) === 'Assignment & claim information' && /email/i.test(await err(page)), await err(page));
  await set(page, 'c_email', 'phone.only@carrier.example');
  await page.locator('[data-k="z_start_mode"]').selectOption({ label: 'As soon as available' });
  await page.waitForTimeout(120);
  ok('the email field does not vanish when another control repaints the step',
     await page.locator('[data-k="c_email"]').count() === 1
     && await page.locator('[data-k="c_email"]').inputValue() === 'phone.only@carrier.example');
  await advance(page);
  ok('with the email given, the assignment moves on', await heading(page) === 'Subject information');
  await page.close();

  /* And a consumer on the same bare door is unaffected: phone alone still
     passes the shared step and the private flow never asks for an email. */
  const p2 = await newPage();
  await set(p2, 'c_name', 'Private Person');
  await set(p2, 'c_phone', '4345550112');
  await advance(p2);
  await p2.locator('#opt-other').click();
  await p2.waitForTimeout(80);
  await advance(p2);
  ok('a private client with only a phone still reaches the subject step',
     await heading(p2) === 'Subject of the investigation', await heading(p2));
  await p2.close();
}

/* THE OWNER'S REALISTIC ASSIGNMENT (brief 2026-09-24, Part Y), end to end on
   the public side: the Insurance page's own button, the carrier door, the
   fixture exactly as given — PO left blank, start "as soon as available" — the
   submit, and the receipt. The portal half (the intake appears, is preserved,
   and accepts in one tap) is proven in the Worker and portal suites. */
section('Jordan Smith / Example Carrier — the Insurance page to the receipt');
{
  submitted = null; stored = null;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let ingestCalls = 0;
  const shown = [];
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
  await page.route('**api.web3forms.com/**', route => {
    submitted = JSON.parse(route.request().postData() || '{}');
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
  });
  await page.route('**/portal-api/ingest', route => {
    ingestCalls++;
    stored = JSON.parse(route.request().postData() || '{}');
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"receipt":"sent"}' });
  });
  page.on('pageerror', e => ok(`no page errors (${e.message})`, false));
  await page.goto(HOME_ROOT + 'insurance-investigations/');
  await page.waitForTimeout(150);
  const ctas = await page.locator('a', { hasText: 'Submit an Insurance Assignment' }).evaluateAll(
    as => as.map(a => a.getAttribute('href')));
  ok('the Insurance page offers Submit an Insurance Assignment, and every one opens the carrier door',
     ctas.length >= 2 && ctas.every(h => h === '/intake/?assignment=insurance'), JSON.stringify(ctas));
  await page.locator('a', { hasText: 'Submit an Insurance Assignment' }).first().click();
  await page.waitForURL(/\/intake\/\?assignment=insurance$/);
  await page.waitForTimeout(150);
  ok('the button lands on the assignment intake, not the private one',
     (await page.title()).includes('Secure Assignment Intake'));

  const snap = async () => shown.push(await page.locator('#app').innerText());
  await snap();
  await set(page, 'c_name', 'Jordan Smith');
  await need(page, 'k_carrier', 'Example Carrier', 'Jordan Smith walk, contact step');
  await set(page, 'c_email', 'jordan.smith@example-carrier.test');
  await advance(page);
  await snap();
  await page.locator('[data-k="k_service"]').selectOption({ label: 'Surveillance' });
  await page.locator('[data-k="z_start_mode"]').selectOption({ label: 'As soon as available' });
  await page.waitForTimeout(120);
  await set(page, 'k_claimno', 'WC-2026-12345');
  await advance(page);
  await snap();
  await set(page, 's_name', 'Taylor Example');
  await advance(page);
  await snap();
  await set(page, 'o_goal', 'Document current physical activity and routine.');
  await set(page, 'o_sched', 'Physical therapy Thursday at 10:00 AM.');
  await advance(page);
  await snap();
  await page.locator('#opt-auth-pending').click();
  await page.waitForTimeout(80);
  await advance(page);
  await snap();
  await page.locator('[data-k="a_consent"]').check();
  await set(page, 'a_typed', 'Jordan Smith');
  await sign(page);
  await advance(page);
  await snap();
  ok('the PO is left blank, as in the fixture', await page.locator('[data-k="b_po"]').inputValue() === '');
  /* A double tap on Submit is one assignment: the button disables before the
     first request leaves, so the second tap lands on nothing. */
  await page.locator('.btn.primary').dblclick();
  await page.waitForTimeout(600);
  ok('a double tap on Submit sends ONE assignment', ingestCalls === 1, String(ingestCalls));

  const rc = await page.locator('.receipt').innerText().catch(() => '');
  ok('ASSIGNMENT RECEIVED is the confirmation', /Assignment received/i.test(rc), rc);
  ok('it carries the request number', stored && rc.includes(stored.case_no), rc);
  ok('the claim / reference', rc.includes('WC-2026-12345'));
  ok('the subject', rc.includes('Taylor Example'));
  ok('the service', rc.includes('Surveillance'));
  ok('the requested start, as the adjuster chose it', rc.includes('As soon as available'));
  ok('and the company', rc.includes('Example Carrier'));
  ok('it says the email confirmation went to the adjuster',
     rc.includes('A confirmation has been emailed to') && rc.includes('jordan.smith@example-carrier.test'));
  const status = await page.locator('.record .ok').innerText();
  ok('the confirmation sentence is the approved one',
     status.includes('Always Precise Investigations has received your assignment. We will review the referral and contact you if additional information is needed.'),
     status);
  /* A promise, not a condition: "once the assignment is accepted" and "cannot
     guarantee a particular result" are the opposite of one, so the pattern
     names what a promise would actually say. */
  const promise = /has been accepted|have accepted your|your assignment is accepted|we guarantee|guaranteed|will be assigned|work will begin|we will begin/i;
  ok('and no screen promised acceptance or availability',
     !promise.test(shown.join(' ') + rc), ((shown.join(' ') + rc).match(promise) || [''])[0]);

  /* NO PRIVATE RATE-SHEET LOGIC reached a carrier on any screen of the walk. */
  const walked = shown.join('\n') + '\n' + await page.locator('#app').innerText();
  for (const [what, re] of Object.entries({
    'a dollar figure': /\$/,
    'a retainer': /retainer/i,
    'Cash App or Venmo': /cash app|venmo/i,
    'a Full Custom agreement': /full custom/i,
    'a non-refundable portion': /non-refundable/i,
    'a private-client rate sheet': /rate sheet/i,
  })) ok(`no screen of the carrier walk shows ${what}`, !re.test(walked), (walked.match(re) || [''])[0]);

  if (stored) {
    ok('the stored assignment is the fixture',
       stored.client_name === 'Jordan Smith' && stored.carrier === 'Example Carrier'
       && stored.claim_number === 'WC-2026-12345' && stored.subject_name === 'Taylor Example'
       && stored.service_requested === 'Surveillance'
       && stored.objective === 'Document current physical activity and routine.'
       && stored.known_schedule === 'Physical therapy Thursday at 10:00 AM.', JSON.stringify(stored).slice(0, 400));
    ok('"as soon as available" is a status, never a date invented for it',
       !stored.start_date && stored.start_date_status === 'asap');
    ok('the blank PO arrives blank', stored.po_number === '');
    ok('it is invoiced, nothing is charged, and no private package rides along',
       stored.payment_method === 'Invoiced to carrier' && stored.fee_due === 0
       && !('package' in stored) && !('package_price' in stored) && !('retainer' in stored));
  }
  ok('nothing typed reaches the address bar',
     !/WC-2026|Taylor|Jordan|example-carrier/i.test(page.url()), page.url());
  if (submitted) {
    const relay = JSON.stringify(submitted);
    ok('the relay never sees the claim, the subject, the objective or the schedule',
       !/WC-2026-12345|Taylor Example|physical activity|Physical therapy/.test(relay), relay.slice(0, 300));
  }
  await ctx.close();
}

/* ============ LEGAL-SERVICES.md D9 — the door adapts to the service ========
   The same fields, the same keys — the wording leads with what the chosen
   service needs, the ONE added field is the process path's documents line,
   and the payload carries the marker the portal prices the case from. */
section('The legal door adapts to the chosen service');
{
  /* A rate-sheet email's Start Assignment lands here with &service=… */
  submitted = null; stored = null;
  let page = await newPage();
  await page.goto(BASE + '?assignment=legal&service=process');
  await page.waitForTimeout(120);
  await set(page, 'c_name', 'P Aralegal'); await set(page, 'c_email', 'p@serve.example');
  await advance(page);
  ok('the emailed link preselects the service on its step',
     await page.evaluate(() => S.lsvc) === 'process'
     && await page.locator('#opt-lsvc-process input').isChecked());
  await advance(page);
  await set(page, 'lf_firm', 'Serve Firm'); await set(page, 'lf_atty', 'S. Erver');
  await advance(page);
  await set(page, 'lm_client', 'Plaintiff P');
  await advance(page);
  ok('process service asks about the RECIPIENT and the documents',
     (await heading(page)) === 'Who is being served?'
     && (await page.locator('.card').innerText()).includes("Recipient's name")
     && await page.locator('[data-k="ls_docs"]').count() === 1);
  await set(page, 's_name', 'D. Efendant');
  await set(page, 'ls_docs', 'Summons and complaint');
  await advance(page);
  await set(page, 'o_goal', 'Serve before the return date.');
  await advance(page);
  ok('a fixed service’s terms name a fee, never a retainer — and still no figure',
     (await page.locator('.card').innerText()).includes('A flat fee, confirmed with your office in writing')
     && !(await page.locator('.card').innerText()).includes('Retainer')
     && !(await page.locator('.card').innerText()).includes('$'));
  await page.locator('[data-k="a_consent"]').check();
  await set(page, 'a_typed', 'P Aralegal');
  await sign(page);
  await advance(page);
  await page.waitForTimeout(400);
  ok('the payload carries the service marker, the documents and the mapped assignment type',
     stored && stored.legal_service === 'process'
     && stored.documents_to_serve === 'Summons and complaint'
     && stored.assignment_type === 'Process / service support', JSON.stringify(stored || {}).slice(0, 200));
  await page.close();

  /* Locate leads with identification; nothing about documents. */
  page = await newPage();
  await page.goto(BASE + '?assignment=legal&service=locate');
  await page.waitForTimeout(120);
  await set(page, 'c_name', 'P Aralegal'); await set(page, 'c_email', 'p@find.example');
  await advance(page);
  await advance(page);
  await set(page, 'lf_firm', 'Find Firm'); await set(page, 'lf_atty', 'L. Ocate');
  await advance(page);
  await set(page, 'lm_matter', 'M-9');
  await advance(page);
  ok('a locate asks who we are finding, with the last-known address wording',
     (await heading(page)) === 'Who are we locating?'
     && (await page.locator('.card').innerText()).includes('Last known address')
     && await page.locator('[data-k="ls_docs"]').count() === 0);
  await page.close();

  /* A mangled service parameter preselects nothing — the step still asks. */
  page = await newPage();
  await page.goto(BASE + '?assignment=legal&service=paralegal%20services');
  await page.waitForTimeout(120);
  ok('an unknown service in the link preselects nothing',
     await page.evaluate(() => S.lsvc) === null);
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
        await page.locator('[data-k="k_carrier"]').fill('C');
        await page.locator('.btn.primary').click(); await page.waitForTimeout(150);
      }
    }
    await ctx.close();
    return out;
  };
  const wide = await read(1200), narrow = await read(390);
  ok('the walk really reached the claim step at both widths',
     wide.some(x => x.startsWith('k_service=')) && narrow.some(x => x.startsWith('k_service=')),
     JSON.stringify(wide));
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
                            ['#opt-other', 'Client Intake']]) {
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

/* THE CARRIER DOOR ON A PHONE (owner brief 2026-09-24, Part E): at 390 and 320
   every step of an assignment keeps its labels, raises the keyboard its field
   needs, and nothing hangs past the right edge — the receipt included, with a
   claim reference long enough to have to wrap. */
section('The carrier door at 390 and 320');
for (const width of [390, 320]) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
  await page.route('**/portal-api/ingest', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: '{"ok":true,"receipt":"sent"}' }));
  page.on('pageerror', e => ok(`no page errors at ${width}px (${e.message})`, false));
  await page.goto(BASE + '?assignment=insurance');
  await page.waitForTimeout(150);
  const steps = [];
  /* Asserted AT each step, not only at the end: a step that widens the page
     can also make the next tap land on the wrong element, and a run that dies
     there never reaches a summary assertion to name what went wrong. */
  const check = async tag => {
    /* Against the DEVICE width, never `innerWidth`: in a phone-emulated
       context Chrome widens the layout viewport to fit overflowing content,
       so `scrollWidth - innerWidth` reads 0 on exactly the page that scrolls.
       Measured: an overflowing billing step reported innerWidth 569 at 390. */
    const o = await page.evaluate(w => document.documentElement.scrollWidth - w, width);
    steps.push(`${tag}:${o}`);
    ok(`${width}px: the ${tag} step does not scroll sideways`, o <= 0, String(o));
  };
  const labelsShown = () => page.evaluate(() => [...document.querySelectorAll('label.f')].every(l => {
    const sp = l.querySelector(':scope > span');
    if (!sp || !sp.textContent.trim()) return false;
    const r = sp.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }));

  ok(`${width}px: the email field raises the email keyboard`,
     await page.locator('[data-k="c_email"]').getAttribute('type') === 'email');
  ok(`${width}px: the phone field raises the phone keypad`,
     await page.locator('[data-k="c_phone"]').getAttribute('type') === 'tel');
  ok(`${width}px: every field on the contact step has a visible label`, await labelsShown());
  await check('contact');
  await set(page, 'c_name', 'Jordan Smith');
  await set(page, 'k_carrier', 'Example Carrier');
  await set(page, 'c_email', 'jordan.smith@example-carrier.test');
  await advance(page);
  await check('claim');
  ok(`${width}px: every field on the claim step has a visible label`, await labelsShown());
  ok(`${width}px: the requested start opens a date picker`,
     await page.locator('[data-k="z_start"]').getAttribute('type') === 'date');
  /* UNBROKEN on purpose: a reference with hyphens wraps at the hyphens on its
     own, so it could never show whether the record's columns can shrink. */
  await set(page, 'k_claimno', 'WC2026123450099887766SUPPLEMENTALREFERENCE0042');
  await advance(page);
  await check('subject');
  await set(page, 's_name', 'Taylor Example');
  await advance(page);
  await check('objective');
  ok(`${width}px: every field on the objective step has a visible label`, await labelsShown());
  await set(page, 'o_goal', 'Document current physical activity and routine.');
  await advance(page);
  await check('authorization');
  await page.locator('#opt-auth-pending').click();
  await page.waitForTimeout(80);
  await advance(page);
  await check('agreement');
  await page.locator('[data-k="a_consent"]').check();
  await set(page, 'a_typed', 'Jordan Smith');
  await sign(page);
  await advance(page);
  await check('billing');
  const submit = page.locator('.btn.primary');
  ok(`${width}px: the last button says what it does`, /Submit assignment/i.test(await submit.innerText()));
  const sb = await submit.boundingBox();
  ok(`${width}px: and is a whole tap target on screen`,
     !!sb && sb.height >= 44 && sb.x >= 0 && sb.x + sb.width <= width + 0.5, JSON.stringify(sb));
  await advance(page);
  await page.waitForTimeout(500);
  await check('receipt');
  ok(`${width}px: the receipt is shown`, /Assignment received/i.test(await page.locator('.receipt').innerText()));
  ok(`${width}px: the unbroken reference wraps inside the record rather than widening it`,
     await page.evaluate(w => [...document.querySelectorAll('.record dd')]
       .every(dd => dd.getBoundingClientRect().right <= w + 0.5), width));
  ok(`${width}px: nothing on any step or the receipt hangs past the right edge`,
     steps.every(s => Number(s.split(':')[1]) <= 0), steps.join(' '));
  await ctx.close();
}

/* THE INSURANCE PAGE'S DOOR AT EVERY WIDTH (Part D): the primary action is
   there, whole, and opens the carrier door, on desktop, tablet and phone. */
section('The Insurance page CTA at 1200, 768, 390 and 320');
for (const width of [1200, 768, 390, 320]) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await ctx.newPage();
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
  page.on('pageerror', e => ok(`no insurance-page errors at ${width}px (${e.message})`, false));
  await page.goto(HOME_ROOT + 'insurance-investigations/');
  await page.waitForTimeout(150);
  const cta = page.locator('a', { hasText: 'Submit an Insurance Assignment' }).first();
  await cta.scrollIntoViewIfNeeded();
  const b = await cta.boundingBox();
  ok(`${width}px: Submit an Insurance Assignment is on screen and whole`,
     !!b && b.x >= 0 && b.x + b.width <= width + 0.5 && b.height >= 44, JSON.stringify(b));
  ok(`${width}px: it opens the carrier door`, await cta.getAttribute('href') === '/intake/?assignment=insurance');
  const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok(`${width}px: the Insurance page does not scroll sideways`, o <= 0, String(o));
  await ctx.close();
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

/* ============ THE 2026-10-10 REDESIGN — TWO PHOTO CARDS, ONE INTAKE ============

   SUPERSEDES the Unit 40 three-card hero (owner brief and intake clarification,
   2026-10-10). The properties Unit 40 pinned are kept and re-aimed rather than
   dropped: every card is one anchor and one tab stop, each reaches the door it
   names, its name is its own words and never the artwork, the title is measured
   against the PAINTED pixels behind it, the focus ring is gold, nothing scrolls
   sideways, and no price appears. What changed is the shape: two cards, both
   into the SAME private intake with their answer preselected, and Insurance and
   Legal below them with their own doors. */
const CARDS = [['custody', 'Child Custody', 'Concerns about care or well-being?', 'Family Matters'],
               ['relationship', 'Spouse / Relationship', 'Looking for clarity and answers?', 'Personal Matters']];

section('Redesign — two photo cards into one private intake');
{
  const { ctx, page } = await homePage(1280);
  const cards = await page.evaluate(() => [...document.querySelectorAll('.art-grid a.art')].map(a => ({
    href: a.getAttribute('href'), tag: a.tagName,
    title: (a.querySelector('.art-title') || {}).textContent || '',
    focusables: a.querySelectorAll('a, button, input, select, textarea, [tabindex]').length,
    art: (a.querySelector('.art-img') || {}).getAttribute ? a.querySelector('.art-img').getAttribute('aria-hidden') : null,
    imgs: a.querySelectorAll('img').length,
  })));
  ok('there are exactly two photo cards', cards.length === 2, JSON.stringify(cards.map(c => c.href)));
  ok('Child Custody first, then Spouse / Relationship (the brief\'s order)',
     cards.map(c => c.title).join(' | ') === 'Child Custody | Spouse / Relationship', cards.map(c => c.title).join(' | '));
  for (const [k, title] of CARDS) {
    const c = cards.find(x => x.title === title) || {};
    ok(`"${title}" opens the private intake with its own answer chosen`,
       c.href === `/intake/?assignment=private&service=${k}`, c.href);
  }
  ok('each card is a real anchor with nothing focusable inside it', cards.every(c => c.tag === 'A' && c.focusables === 0));
  ok('the artwork is decorative on both, and no meaning rides on an <img>',
     cards.length === 2 && cards.every(c => c.art === 'true' && c.imgs === 0), JSON.stringify(cards));
  /* THE NAME THE BROWSER REPORTS, not the markup — kicker, title, line and the
     action, and never the development badge or an arrow glyph. */
  for (const [k, title, line, kicker] of CARDS) {
    const h = await page.locator(`a.art-${k}`).elementHandle();
    const snap = await page.accessibility.snapshot({ root: h });
    const want = `${kicker} ${title} ${line} Start Intake`;
    ok(`the ${title} card announces itself as a link named by its own words`,
       snap && snap.role === 'link' && snap.name.replace(/\s+/g, ' ').trim().toLowerCase() === want.toLowerCase(), JSON.stringify(snap && snap.name));
  }
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const artUrls = [...src.matchAll(/--art:url\('([^']+)'\)/g)].map(m => m[1]);
  ok('each card names a local asset, never an external host', artUrls.length === 2
     && artUrls.every(u => /^\/assets\/(child-custody|spouse-relationship)-photo\.webp\?v=\d+$/.test(u)), JSON.stringify(artUrls));
  ok('and each carries a cache-busting version token (assets are cached seven days)', artUrls.every(u => /\?v=\d+$/.test(u)));
  ok('the rejected silhouette illustrations are not used', !/silhouette|card-custody\.svg|card-relationship\.svg/i.test(src));
  await ctx.close();
}

section('Redesign — each action opens the door it names');
{
  for (const [k, title] of CARDS) {
    const { ctx, page } = await homePage(1280);
    await page.locator(`a.art-${k}`).click();
    await page.waitForLoadState('networkidle');
    const landed = await page.evaluate(() => ({ url: location.pathname + location.search, svc: S.svc,
      h1: ((document.querySelector('h1') || {}).textContent || '').trim(),
      dollars: (document.body.innerText.match(/\$\s?\d[\d,]*/g) || []).slice(0, 3) }));
    ok(`"${title}" lands on the private intake with ${k} chosen`,
       landed.url === `/intake/?assignment=private&service=${k}` && landed.svc === k && landed.h1 === 'Client Intake', JSON.stringify(landed));
    ok('  with no price anywhere on the door it opened', landed.dollars.length === 0, JSON.stringify(landed.dollars));
    await set(page, 'c_name', 'Card Visitor');
    await set(page, 'c_phone', '4345550177');
    await advance(page);
    const q = await page.evaluate((k) => ({ head: (document.querySelector('#app h2') || {}).textContent || '',
      ticked: !!(document.querySelector(`#opt-${k} input`) || {}).checked }), k);
    ok(`  and the private question is shown with ${title} already ticked`,
       q.head.trim() === 'What type of private investigation do you need?' && q.ticked, JSON.stringify(q));
    await ctx.close();
  }
  for (const [label, url, heading] of [
        ['Fill Out Online Intake', '/intake/?assignment=private', 'Client Intake'],
        ['Submit an Insurance Assignment', '/intake/?assignment=insurance', 'Secure Assignment Intake'],
        ['Submit a Legal Assignment', '/intake/?assignment=legal', 'Legal Investigation Assignment']]) {
    const { ctx, page } = await homePage(1280);
    await page.getByRole('link', { name: label, exact: true }).first().click();
    await page.waitForLoadState('networkidle');
    const landed = await page.evaluate(() => ({ url: location.pathname + location.search, svc: S.svc,
      h1: ((document.querySelector('h1') || {}).textContent || '').trim(), title: document.title,
      dollars: (document.body.innerText.match(/\$\s?\d[\d,]*/g) || []).slice(0, 3) }));
    ok(`"${label}" lands on ${url}, which names itself "${heading}"`,
       landed.url === url && landed.h1 === heading && landed.title.startsWith(heading), JSON.stringify(landed));
    if (label === 'Fill Out Online Intake')
      ok('  with no answer preselected', landed.svc === null || landed.svc === undefined, String(landed.svc));
    ok('  with no price anywhere on it', landed.dollars.length === 0, JSON.stringify(landed.dollars));
    await ctx.close();
  }
  const { ctx, page } = await homePage(1280);
  await page.getByRole('link', { name: 'Submit a Legal Assignment', exact: true }).first().click();
  await page.waitForLoadState('networkidle');
  const legal = await page.evaluate(() => ((document.querySelector('h1') || {}).textContent || '').trim());
  ok('a legal visitor is never routed through the private-client intake',
     legal !== 'Client Intake' && legal !== 'Secure Assignment Intake', legal);
  await ctx.close();
}

section('Redesign — the homepage at 320, 360, 390, 430, 768, 1024 and 1280');
for (const [w, h] of [[320, 568], [360, 740], [390, 844], [430, 932], [768, 1024], [1024, 768], [1280, 800]]) {
  const { ctx, page } = await homePage(w, h);
  const m = await page.evaluate(() => {
    const R = el => el ? el.getBoundingClientRect() : null;
    const cards = [...document.querySelectorAll('.art-grid a.art')].map(R);
    const hero = [...document.querySelectorAll('.hero-actions .btn')].map(R);
    const logo = R(document.querySelector('.site-head .brand img'));
    const bar = document.querySelector('.mobile-actions');
    const barShown = bar && getComputedStyle(bar).display !== 'none';
    return { vw: innerWidth, doc: document.documentElement.scrollWidth - innerWidth,
      cardTops: cards.map(r => Math.round(r.top)), cardLefts: cards.map(r => Math.round(r.left)),
      cardRight: Math.max(...cards.map(r => r.right)), cardW: cards.map(r => Math.round(r.width)),
      heroH: hero.map(r => Math.round(r.height)), heroRight: Math.max(...hero.map(r => r.right)),
      logo: logo && { w: logo.width, h: logo.height },
      barShown, barH: barShown ? Math.round(R(bar).height) : 0,
      barBtns: barShown ? [...bar.querySelectorAll('a')].map(a => Math.round(R(a).height)) : [],
      bodyPad: parseFloat(getComputedStyle(document.body).paddingBottom) };
  });
  ok(`${w}px: the page does not scroll sideways`, m.doc <= 0, String(m.doc));
  ok(`${w}px: both cards are whole on screen`, m.cardRight <= m.vw + 0.5 && m.cardW.every(x => x > 120), JSON.stringify(m.cardW));
  if (w < 360) ok(`${w}px: the cards stack`, m.cardTops[0] < m.cardTops[1] && m.cardLefts[0] === m.cardLefts[1], JSON.stringify(m));
  else ok(`${w}px: the cards sit side by side, the same size`, m.cardTops[0] === m.cardTops[1] && m.cardW[0] === m.cardW[1], JSON.stringify(m));
  ok(`${w}px: the hero's two actions clear the 44px floor and stay on screen`,
     m.heroH.length === 2 && m.heroH.every(x => x >= 44) && m.heroRight <= m.vw + 0.5, JSON.stringify(m.heroH));
  ok(`${w}px: the logo keeps its own 500x116 proportions`, m.logo && Math.abs(m.logo.w / m.logo.h - 500 / 116) < 0.03, JSON.stringify(m.logo));
  if (w <= 720) {
    ok(`${w}px: the Call Privately / Online Intake bar is shown, both targets ≥44px`,
       m.barShown && m.barBtns.length === 2 && m.barBtns.every(x => x >= 44), JSON.stringify(m.barBtns));
    ok(`${w}px: and the page is padded by the bar's height, so it covers nothing at the bottom`,
       m.bodyPad >= m.barH - 0.5, `${m.bodyPad} vs ${m.barH}`);
  } else ok(`${w}px: the phone bar is not drawn`, !m.barShown);
  await ctx.close();
}

section('Redesign — contrast, focus and keyboard on the homepage');
{
  /* THE TITLE'S BACKDROP IS PAINTED: hide the copy, photograph the strip each
     title occupied, and take the LIGHTEST pixel — the one white text is least
     visible against. With the development gradient today; with the approved
     photographs once they land, which is when this check matters most. On its
     own page because hiding text removes it from the accessibility tree. */
  for (const [k, title] of CARDS) {
    for (const w of [1280, 390]) {
      const { ctx: c4, page: p4 } = await homePage(w, w === 390 ? 844 : 900);
      await p4.locator(`a.art-${k}`).scrollIntoViewIfNeeded();
      const box = await p4.evaluate(k => {
        const r = document.querySelector(`a.art-${k} .art-title`).getBoundingClientRect();
        return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
      }, k);
      await p4.addStyleTag({ content: '.art-copy,.art-dev{visibility:hidden!important}' });
      const strip = (await p4.screenshot({ clip: { x: box.x, y: box.y, width: box.w, height: box.h } })).toString('base64');
      const worst = await p4.evaluate(async b64 => {
        const img = new Image();
        await new Promise(res => { img.onload = res; img.src = 'data:image/png;base64,' + b64; });
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        c.getContext('2d').drawImage(img, 0, 0);
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        let hi = -1;
        for (let i = 0; i < d.length; i += 4) hi = Math.max(hi, 0.2126 * f(d[i]) + 0.7152 * f(d[i + 1]) + 0.0722 * f(d[i + 2]));
        return 1.05 / (hi + 0.05);
      }, strip);
      ok(`${w}px: the ${title} title clears 4.5:1 against the LIGHTEST pixel behind it`, worst >= 4.5, `${worst.toFixed(2)}:1`);
      await c4.close();
    }
  }
  const { ctx, page } = await homePage(1280);
  /* TABBED FOR REAL: each card takes one stop, in order, under the gold ring. */
  const stops = [];
  await page.evaluate(() => (document.activeElement || document.body).blur());
  for (let i = 0; i < 60 && stops.length < 3; i++) {
    await page.keyboard.press('Tab');
    const f = await page.evaluate(() => {
      const a = document.activeElement;
      if (!a || !a.classList || !a.classList.contains('art')) return null;
      const s = getComputedStyle(a);
      return { href: a.getAttribute('href'), ring: s.outlineWidth + ' ' + s.outlineStyle + ' ' + s.outlineColor };
    });
    if (f) stops.push(f); else if (stops.length) break;
  }
  ok('tabbing reaches each card exactly once, Child Custody then Spouse / Relationship',
     stops.map(s => s.href).join('|') === '/intake/?assignment=private&service=custody|/intake/?assignment=private&service=relationship',
     JSON.stringify(stops.map(s => s.href)));
  ok('and the ring that appears is the 3px gold one', stops.length === 2 && stops.every(s => s.ring === '3px solid rgb(220, 186, 126)'),
     JSON.stringify(stops.map(s => s.ring)));
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ok('the card hover lift is switched off under reduced motion', /prefers-reduced-motion:reduce\)\{\.art\{transition:none\}\.art:hover\{transform:none\}/.test(src));
  const kept = await page.evaluate(() => ({
    notice: (document.querySelector('.notice') || {}).textContent || '',
    contact: !!document.querySelector('[onclick*="openContact"]'),
    skip: !!document.querySelector('a.skip[href="#main"]') && !!document.getElementById('main'),
    h1s: document.querySelectorAll('h1').length,
    text: document.body.innerText }));
  ok('the standing notice is kept (no cyber-stalking, nothing from anyone else\'s phone)', /cyber-stalking/.test(kept.notice) && /strictly within the law/.test(kept.notice));
  ok('Contact Us is still there and still wired', kept.contact);
  ok('a skip link reaches the main content, and there is exactly one h1', kept.skip && kept.h1s === 1, String(kept.h1s));
  ok('the homepage introduces no dollar figure', !/\$\s?\d/.test(kept.text), (kept.text.match(/\$\s?\d[\d,]*/g) || []).join(' '));
  ok('and no rate-sheet or pricing language', !/rate sheet|pricing sheet|view rates|our rates|price list/i.test(kept.text));
  await ctx.close();
}


/* ==========================================================================
   CLOSEOUT HARDENING (2026-09-03). Two public-form defects the audit proved:
   a claim number typed and then marked unavailable still satisfied the
   identity rule while the payload stored it blank, and the form carried a
   file input that uploaded nothing at all. */

/* ============================================================================
   THE WAY BACK TO THE MAIN SITE (owner, 2026-09-06).

   A client opens this page from a link in an email or a text, so there is no
   browser history to go back to. Both controls are ordinary absolute links to
   the public site — never history.back() — and they are asserted on every
   door, cold, at desktop and phone width, with the leaving click proving that
   nothing was submitted on the way out.
   ========================================================================= */
section('Every intake door offers a way back to the main site');
{
  const HOME = 'https://alwayspreciseinvestigations.net/';
  for (const door of ['', '?assignment=private', '?assignment=legal', '?assignment=insurance']) {
    for (const width of [1200, 390]) {
      const tag = `${door || 'bare /intake/'} @ ${width}`;
      const ctx = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await ctx.newPage();
      let relay = null, portal = null, left = null;
      await page.route('**api.web3forms.com/**', r => { relay = 'hit'; r.fulfill({ status: 200, body: '{}' }); });
      await page.route('**/portal-api/ingest', r => { portal = 'hit'; r.fulfill({ status: 200, body: '{}' }); });
      /* The destination is answered locally: the test must never reach the
         real site, and a fulfilled navigation is what proves the click LEFT. */
      await page.route(url => url.href.startsWith(HOME), r => {
        left = r.request().url();
        r.fulfill({ status: 200, contentType: 'text/html', body: '<title>home</title>' });
      });
      await page.goto(BASE + door);
      await page.waitForTimeout(150);
      const m = await page.evaluate(() => {
        const a = document.querySelector('.top a.home');
        const b = document.querySelector('.foot a.home2');
        if (!a || !b) return { a: !!a, b: !!b };
        const box = el => el.getBoundingClientRect();
        const overlap = (p, q) => !(p.right <= q.left || q.right <= p.left
                                    || p.bottom <= q.top || q.bottom <= p.top);
        const r = box(a), rb = box(b);
        const mark = box(document.querySelector('.mark'));
        const meta = box(document.querySelector('.top .meta'));
        const name = box(document.querySelector('.top .name'));
        return { a: true, b: true, hrefA: a.href, hrefB: b.href,
          text: a.textContent.replace(/\s+/g, ' ').trim(),
          textB: b.textContent.replace(/\s+/g, ' ').trim(),
          h: Math.round(r.height), hB: Math.round(rb.height),
          left: Math.round(r.left), markLeft: Math.round(mark.left),
          aboveMark: r.bottom <= mark.top + 1,
          overlap: overlap(r, mark) || overlap(r, meta) || overlap(r, name),
          onclickA: a.getAttribute('onclick'), onclickB: b.getAttribute('onclick'),
          inApp: !!(a.closest('#app') || b.closest('#app')),
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          headerH: Math.round(box(document.querySelector('.top')).height) };
      });
      ok(`${tag}: both links exist`, m.a && m.b, JSON.stringify(m));
      if (!(m.a && m.b)) { await ctx.close(); continue; }
      ok(`${tag}: the header link reads "Back to Always Precise"`,
         /^← Back to Always Precise$/.test(m.text), m.text);
      ok(`${tag}: the footer link reads "Return to Always Precise Investigations"`,
         m.textB === 'Return to Always Precise Investigations', m.textB);
      ok(`${tag}: both go to the main site's home page, by absolute URL, on the production domain`,
         m.hrefA === HOME && m.hrefB === HOME, JSON.stringify([m.hrefA, m.hrefB]));
      ok(`${tag}: neither is wired to history.back()`, m.onclickA === null && m.onclickB === null);
      ok(`${tag}: the header link overlaps neither the logo, the name nor the contact block`,
         m.overlap === false && m.aboveMark === true, JSON.stringify(m));
      ok(`${tag}: it sits top-left, on the logo's own left edge`,
         Math.abs(m.left - m.markLeft) <= 2, `${m.left} vs ${m.markLeft}`);
      ok(`${tag}: neither link lives inside the form region`, m.inApp === false);
      ok(`${tag}: no sideways scroll`, m.overflow === false);
      if (width === 390) {
        ok(`${tag}: the header link meets the 44px tap floor`, m.h >= 44, String(m.h));
        ok(`${tag}: and so does the footer link`, m.hB >= 44, String(m.hB));
        /* COMPACT: the band did not grow by a whole tap target. The bound is
           arithmetic, not taste: the identity row measures 71 at 390 and the
           paddings 24, so the link row may add at most ~30 including its gap
           — the 44px floor overdraws into the padding rather than stacking on
           top of it. 103 was the band before the link existed. */
        ok(`${tag}: and the header stays compact — under 128px tall`, m.headerH < 128, String(m.headerH));
      }
      /* LEAVING MID-FORM SUBMITS NOTHING. Type into the first field the door
         offers, then leave through the header link. */
      const first = page.locator('#app input[type=text]').first();
      if (await first.count()) await first.fill('Leaving Early');
      await page.locator('.top a.home').click();
      await page.waitForTimeout(400);
      ok(`${tag}: clicking the header link leaves for the main site`, left === HOME, String(left));
      ok(`${tag}: and leaving sent nothing to the relay or the portal`,
         relay === null && portal === null, JSON.stringify([relay, portal]));
      await ctx.close();
    }
  }
  /* THE FOOTER LINK LEAVES TOO, and by the same route. One door, one width —
     it is the same anchor markup on every door, and the loop above has already
     pinned its destination eight times. */
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    let left = null, relay = null;
    await page.route('**api.web3forms.com/**', r => { relay = 'hit'; r.fulfill({ status: 200, body: '{}' }); });
    await page.route(url => url.href.startsWith(HOME), r => {
      left = r.request().url();
      r.fulfill({ status: 200, contentType: 'text/html', body: '<title>home</title>' });
    });
    await page.goto(BASE + '?assignment=legal');
    await page.waitForTimeout(150);
    await page.locator('.foot a.home2').scrollIntoViewIfNeeded();
    await page.locator('.foot a.home2').click();
    await page.waitForTimeout(400);
    ok('the footer link leaves for the main site as well', left === HOME, String(left));
    ok('and it submitted nothing either', relay === null);
    await ctx.close();
  }
  /* THE FORM STILL NAVIGATES. Adding two anchors must not have changed what
     Continue and Back do — one door walked one step forward and back. */
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.route('**api.web3forms.com/**', r => r.fulfill({ status: 200, body: '{}' }));
    await page.route('**/portal-api/ingest', r => r.fulfill({ status: 200, body: '{}' }));
    await page.goto(BASE + '?assignment=private');
    await page.waitForTimeout(150);
    const before = await heading(page);
    await set(page, 'c_name', 'Nav Check');
    await set(page, 'c_phone', '5405551212');
    await advance(page);
    const after = await heading(page);
    ok('Continue still advances the private door', after !== before, `${before} -> ${after}`);
    await page.locator('.btn.ghost', { hasText: 'Back' }).first().click();
    await page.waitForTimeout(90);
    ok('and Back still returns', (await heading(page)) === before);
    ok('with the way-back links still on the page after navigating',
       (await page.locator('.top a.home').count()) === 1 && (await page.locator('.foot a.home2').count()) === 1);
    await ctx.close();
  }
}

section('Closeout: an unavailable claim number cannot identify the file');
{
  const page = await (await browser.newContext()).newPage();
  await page.goto(BASE + '?assignment=insurance');
  await page.waitForTimeout(120);
  await set(page, 'c_name', 'Dana Adjuster');
  await need(page, 'k_carrier', 'Urgent Mutual', 'closeout, contact step');
  await set(page, 'c_email', 'dana@carrier.example');
  await advance(page);

  /* TYPE the number, THEN mark it unavailable. The control keeps what was
     typed so un-ticking restores it — which is right — but buildPayload
     stores it blank, so it must not count as identifying the file either. */
  await set(page, 'k_claimno', 'WC-2026-0001');
  await page.locator('[data-k="k_claimno_na"]').check();
  await page.waitForTimeout(80);
  await advance(page);
  ok('the assignment still reaches the claimant step',
     await heading(page) === 'Subject information');

  await advance(page);
  ok('but it will NOT pass the claimant step with no name and no live claim number',
     await heading(page) === 'Subject information');
  const msg = await page.locator('.err, #err').first().innerText().catch(() => '');
  ok('and it says which of the two it needs', /claimant|claim number/i.test(msg), msg);

  await set(page, 's_name', 'Pat Claimant');
  await advance(page);
  ok('naming the claimant moves it on', await heading(page) !== 'Subject information');
  await page.close();
}

section('Closeout: the form offers no upload it cannot honour');
{
  const page = await (await browser.newContext()).newPage();
  await page.goto(BASE);
  await page.waitForTimeout(120);
  const html = await page.content();
  ok('no file input anywhere on the form',
     !/type="file"/i.test(html) && await page.locator('input[type=file]').count() === 0);
  ok('and no pickFiles handler survives',
     await page.evaluate(() => typeof pickFiles === 'undefined'));
  ok('the note says what actually happens to documents',
     /attached to the case by the office/i.test(html));
  ok('and the payload carries no attachments field',
     await page.evaluate(() => !('attachments' in buildPayload())));
  await page.close();
}

/* ------------------------------------------------- Child Custody, private */

/* Owner, 2026-09-14: "It is simply a service-selection label." So what this
   section proves is BOTH halves — that the label can be chosen, submitted,
   stored and read back, AND that choosing it changes nothing else. The second
   half is the one worth the run: a service that quietly added a step, a fee or
   a different agreement would be the thing the brief ruled out, and it would
   look perfect on the screen that shows the label. */
section('Child Custody is a private service the public form offers');
{
  submitted = null; stored = null;
  const page = await newPage();

  await set(page, 'c_name', 'Dana Parent');
  await set(page, 'c_phone', '4345550144');
  await advance(page);

  const services = await page.locator('.card').innerText();
  ok('the service step offers Child Custody', services.includes('Child Custody'));
  ok('and still offers the other private answers beside it',
     services.includes('Spouse / Relationship') && services.includes('Other Private Investigation') && services.includes('Process Serving'));
  ok('it is offered exactly once',
     await page.locator('#opt-custody').count() === 1);
  ok('and no price is attached to it', !/\$\s?\d/.test(services), services);

  /* THE VISIBLE LABEL AND THE STORED ONE ARE ONE STRING, for every PRIVATE
     service. They were two literals until this unit, and a negative test proved
     it: renaming FEES.custody.label alone changed what the portal receives
     while the card on screen went on saying something else. The class is scoped
     to the private services on purpose — the legal card deliberately says
     "Legal / Law Firm" (the door) over a stored "Legal Investigation
     Assignment" (the product), and that difference is not drift. */
  const labelDrift = await page.evaluate(() => PRIVATE_SVCS
    .map(k => [k, (document.querySelector('#opt-' + k + ' b') || {}).innerText, FEES[k].label])
    .filter(([, shown, stored]) => shown !== stored));
  ok('every private service shows the label it stores',
     Array.isArray(labelDrift) && labelDrift.length === 0, JSON.stringify(labelDrift));

  /* The card must not promise an outcome or an admissibility the firm cannot
     promise — the same rule the public custody page is held to. */
  /* READ IT WITHOUT ASSUMING IT EXISTS. A removed option must make every
     assertion about it FAIL, not throw and take the rest of the run with it —
     which is what the first draft of this section did, and why the suite
     carries a crash handler at all. */
  const custodyCard = await page.evaluate(() =>
    (document.querySelector('#opt-custody') || {}).innerText || '');
  ok('the Child Custody card promises no custody outcome',
     !/\b(win|guarantee|guaranteed|prove unfit|award|ensure)\b/i.test(custodyCard), custodyCard);
  ok('and claims nothing about admissibility',
     !/admissib/i.test(custodyCard), custodyCard);

  await page.evaluate(() => pickSvc('custody'));
  await page.waitForTimeout(80);
  ok('choosing it checks its own radio and nothing else',
     await page.evaluate(() =>
       document.querySelectorAll('input[name="svc"]:checked').length === 1
       && !!(document.querySelector('#opt-custody input') || {}).checked));
  ok('it adds no step to the flow', await dots(page) === 5);
  await advance(page);

  ok('the next step is the ordinary subject step',
     await heading(page) === 'Subject of the investigation');
  await set(page, 's_name', 'Other Parent');
  await advance(page);
  await set(page, 'o_goal', 'Document the exchanges and who is present for them.');
  await advance(page);

  ok('and the step after that is the ordinary agreement',
     (await heading(page)).includes('Agreement'));
  const fees = await page.locator('.feebox').innerText();
  ok('the fee box is the ordinary private one, quoting nothing',
     !/\$\s?\d/.test(fees) && /sent to you in writing/i.test(fees), fees);
  ok('no retainer is named', !/retainer/i.test(fees), fees);
  const terms = await page.locator('.agree').innerText();
  ok('the terms are the ordinary private terms',
     /work begins only once the client has agreed/i.test(terms));
  ok('and they add no custody-specific legal wording',
     !/\b(court will|judge will|custody will|admissib)/i.test(terms), terms);

  await page.locator('[data-k="a_consent"]').check();
  await set(page, 'a_typed', 'Dana Parent');
  await sign(page);
  await advance(page);
  await page.waitForTimeout(500);

  ok('the intake reached the portal', stored !== null);
  ok('the stored service is exactly "Child Custody"',
     stored && stored.service === 'Child Custody', stored && String(stored.service));
  ok('it is stored as an ordinary private intake — no carrier, no claim',
     stored && !stored.carrier && !stored.claim_number);
  ok('and it is not a legal assignment',
     stored && stored.assignment !== 'legal');
  ok('nothing is charged at intake', stored && stored.fee_due === 0);
  ok('the signature is on the record', stored && !!stored.signature);

  /* The relay boundary is unchanged: the notice names the service and the
     contact, and nothing about the subject. */
  ok('the third-party notice names the service', submitted && submitted.service === 'Child Custody');
  ok('and still carries no subject name',
     submitted && !JSON.stringify(submitted).includes('Other Parent'),
     submitted && JSON.stringify(submitted));

  const rec = await page.locator('.record').innerText();
  ok('the signed record reads back Child Custody', rec.includes('Child Custody'));
  ok('and it is titled Client Intake, not a new kind of form', rec.includes('Client Intake'));
  await page.close();
}

section('Child Custody on the private door, and the preselect');
{
  const page = await newPage();
  await page.goto(BASE + '?assignment=private');
  await page.waitForTimeout(120);
  await set(page, 'c_name', 'Dana Parent');
  await set(page, 'c_phone', '4345550144');
  await advance(page);
  const svc = await page.locator('.card').innerText();
  ok('the private door offers Child Custody', svc.includes('Child Custody'));
  ok('and still refuses the carrier and legal paths',
     !svc.includes('Insurance Claim Assignment') && !svc.includes('Legal / Law Firm'), svc);
  await page.close();

  /* ?service= is the parameter the LEGAL door has used since 2026-09-02. On the
     private door it resolves a PRIVATE service — same parameter, no new
     routing. It is an OPENING CHOICE: the picker still renders and the visitor
     can still change it. */
  const p2 = await newPage();
  await p2.goto(BASE + '?assignment=private&service=custody');
  await p2.waitForTimeout(120);
  ok('?service=custody opens the form on Child Custody',
     await p2.evaluate(() => S.svc === 'custody'));
  await set(p2, 'c_name', 'Dana Parent');
  await set(p2, 'c_phone', '4345550144');
  await advance(p2);
  ok('and the picker is still shown, already on that choice',
     await p2.evaluate(() => !!(document.querySelector('#opt-custody input') || {}).checked)
     && await p2.locator('#opt-other').count() === 1);
  ok('the visitor can still change it',
     await p2.evaluate(async () => { pickSvc('other'); return S.svc === 'other'; }));
  await p2.close();

  /* THE SET IS DERIVED BY SUBTRACTION, so the two halves are asserted: every
     private service preselects, and no billed one can. A parameter that could
     open the private door on a carrier or legal service would be a route past
     `pickSvc`'s own refusal. */
  /* `surveillance` was a service of its own until the owner's three-answer
     question (2026-10-10) folded it into Other; a link still carrying it opens
     on Other rather than on nothing. */
  for (const [q, want] of [['surveillance', 'other'], ['process', 'process'], ['relationship', 'relationship'], ['other', 'other'],
                           ['custody', 'custody'], ['CUSTODY', 'custody'],
                           ['claims', null], ['legal', null], ['nonsense', null]]) {
    const p3 = await newPage();
    await p3.goto(BASE + '?assignment=private&service=' + q);
    await p3.waitForTimeout(80);
    ok(`?service=${q} opens on ${want === null ? 'nothing' : want}`,
       await p3.evaluate(() => S.svc) === want);
    await p3.close();
  }

  /* And the carrier and legal doors are untouched by it: their service is
     fixed by the door itself and the parameter means what it always meant. */
  const p4 = await newPage();
  await p4.goto(BASE + '?assignment=insurance&service=custody');
  await p4.waitForTimeout(80);
  ok('the carrier door ignores it and stays a claim assignment',
     await p4.evaluate(() => S.svc) === 'claims');
  await p4.close();

  const p5 = await newPage();
  await p5.goto(BASE + '?assignment=legal&service=custody');
  await p5.waitForTimeout(80);
  ok('the legal door stays legal, and the parameter still means a legal service',
     await p5.evaluate(() => S.svc) === 'legal'
     && await p5.evaluate(() => S.lsvc) === null);
  await p5.close();
}

section('Child Custody reads and fits on a phone');
{
  for (const w of [390, 320]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 760 } });
    const page = await ctx.newPage();
    await page.route('**api.web3forms.com/**', r => r.fulfill({ status: 200, body: '{}' }));
    await page.route('**/portal-api/ingest', r => r.fulfill({ status: 200, body: '{"ok":true}' }));
    await page.goto(BASE);
    await page.waitForTimeout(120);
    await set(page, 'c_name', 'Dana Parent');
    await set(page, 'c_phone', '4345550144');
    await advance(page);

    const m = await page.evaluate(() => {
      const el = document.querySelector('#opt-custody');
      const r = el ? el.getBoundingClientRect() : { right: 1e6, width: 0, height: 0 };
      const b = el && el.querySelector('b');
      const label = b ? b.getBoundingClientRect() : { height: 0 };
      return { right: r.right, w: r.width, h: r.height,
               labelH: label.height, doc: document.documentElement.clientWidth,
               scroll: document.documentElement.scrollWidth,
               opts: document.querySelectorAll('.opt').length,
               custody: document.querySelectorAll('#opt-custody').length };
    });
    ok(`at ${w} the Child Custody card stays inside the viewport`,
       m.right <= m.doc + 0.5, JSON.stringify(m));
    ok(`at ${w} the page does not scroll sideways`, m.scroll <= m.doc + 0.5, JSON.stringify(m));
    ok(`at ${w} the card clears the 44px tap floor`, m.h >= 44, String(m.h));
    ok(`at ${w} its label is on one line and readable`, m.labelH > 0 && m.labelH < 44, String(m.labelH));
    /* The BARE door offers all six — the four private answers (Child Custody,
       Spouse / Relationship, Other, Process Serving) plus the carrier and legal
       doors. It was five until the owner's private question of 2026-10-10 added
       Spouse / Relationship and folded Surveillance into Other. */
    ok(`at ${w} the bare door still offers all six services`, m.opts === 6, String(m.opts));
    ok(`at ${w} Child Custody appears exactly once`, m.custody === 1, String(m.custody));
    await page.close(); await ctx.close();
  }
}

/* The portal's Quick private intake has offered this since Unit 36. The brief
   says not to duplicate it, so the assertion is that it is still exactly one
   option there — a second one added here would be two writers of one choice. */
section('The portal picker was already right and stays single');
{
  const portal = fs.readFileSync(path.join(ROOT, 'portal/index.html'), 'utf8');
  /* `["Surveillance", …]` alone matches the LEGAL assignment-type list as well,
     which is a different control on a different form. Pin the private lead's
     own list by its own members. */
  const PICKER = '["Surveillance", "Child custody", "Process serving", "Other"]';
  ok('the portal private-lead picker exists exactly once',
     portal.split(PICKER).length - 1 === 1, String(portal.split(PICKER).length - 1));
  ok('and it already carried the child-custody option before this unit',
     portal.includes(PICKER));
  ok('no second child-custody option was added to the portal',
     (portal.match(/Child custody/g) || []).length === 1,
     String((portal.match(/Child custody/g) || []).length));
}

/* ------------------------------ the Child Custody page's door to the intake */

/* Owner, 2026-09-14: from the public Child Custody page, give the visitor a way
   into the EXISTING private intake with Child Custody already selected. The
   mechanism is the one that already existed — ?assignment=private&service=
   — so what this section proves is the whole chain end to end, because every
   link in it was built separately and a preselect with a broken caller is worth
   nothing. */
const ORIGIN = new URL(BASE).origin;
const CUSTODY = ORIGIN + '/child-custody-investigations/';

section('Child Custody page → CTA → private intake, preselected');
{
  submitted = null; stored = null;
  const page = await newPage();
  await page.goto(CUSTODY);
  await page.waitForTimeout(120);

  /* READ THE DOOR WITHOUT ASSUMING IT IS THERE. A removed door must fail every
     assertion about it rather than throwing on the first one and taking the
     rest of the chain with it — the lesson the section above already paid for. */
  const door = await page.evaluate(() => {
    const a = document.querySelector('.cta a[href*="/intake/"]');
    return { n: document.querySelectorAll('.cta a[href*="/intake/"]').length,
             href: a ? a.getAttribute('href') : null,
             text: a ? a.innerText : '',
             tel: document.querySelectorAll('.cta a[href^="tel:"]').length };
  });
  ok('the page carries exactly one door into the intake', door.n === 1, String(door.n));
  ok('and it is the PRIVATE door, carrying the custody preselect',
     door.href === '/intake/?assignment=private&service=custody', String(door.href));
  ok('the label names the action in client language',
     /child custody/i.test(door.text), door.text);
  ok('the Call button is still there beside it', door.tel === 1, String(door.tel));

  if (door.n) { await page.locator('.cta a[href*="/intake/"]').first().click(); }
  else { await page.goto(BASE + '?assignment=private'); }
  await page.waitForTimeout(200);
  ok('it lands on the intake', page.url().includes('/intake/'));
  ok('the family is the private intake, not the carrier or legal door',
     await page.evaluate(() => PRIVATE_ONLY === true
                            && CARRIER_ONLY === false && LEGAL_ONLY === false));
  ok('with Child Custody already the chosen service',
     await page.evaluate(() => S.svc) === 'custody');

  /* It is a preselect and not a lock: the picker still renders and still
     offers the other private services. */
  await set(page, 'c_name', 'Dana Parent');
  await set(page, 'c_phone', '4345550144');
  await advance(page);
  ok('the service step still renders, already on Child Custody',
     await page.evaluate(() => !!(document.querySelector('#opt-custody input') || {}).checked));
  ok('and the visitor can still choose something else',
     await page.locator('#opt-other').count() === 1
     && await page.locator('#opt-process').count() === 1);
  ok('the carrier and legal doors are not offered on this path',
     await page.locator('#opt-claims').count() === 0
     && await page.locator('#opt-legal').count() === 0);

  /* The preselect is asserted above. Choose it explicitly before walking on, so
     that a BROKEN preselect fails exactly the assertions about the preselect
     and the rest of the chain — submit, store, read back — still runs and still
     says whether IT is right. A walk that stalls proves nothing about the half
     it never reached. */
  await page.evaluate(() => pickSvc('custody'));
  await page.waitForTimeout(80);
  await advance(page);
  ok('the flow is the ordinary private one', await dots(page) === 5);
  await set(page, 's_name', 'Other Parent');
  await advance(page);
  await set(page, 'o_goal', 'Document the exchanges and who is present for them.');
  await advance(page);
  await page.locator('[data-k="a_consent"]').check();
  await set(page, 'a_typed', 'Dana Parent');
  await sign(page);
  await advance(page);
  await page.waitForTimeout(500);

  ok('the intake reached the portal', stored !== null);
  ok('stored as exactly "Child Custody"',
     stored && stored.service === 'Child Custody', stored && String(stored.service));
  ok('and as an ordinary private case — no carrier, no claim, not legal',
     stored && !stored.carrier && !stored.claim_number && stored.assignment !== 'legal');
  const rec = await page.locator('.record').innerText();
  ok('the review the client signs displays Child Custody', rec.includes('Child Custody'));
  await page.close();
}

/* ============ THE PRIVATE QUESTION (owner, 2026-10-10) ============
   "Add one simple required question near the top of the existing private-client
   intake: What type of private investigation do you need? Child Custody /
   Spouse / Relationship / Other Private Investigation … extend the existing
   service-type field rather than creating duplicate questions." It IS the
   existing service step: same field (`S.svc`), same payload key (`service`),
   same `?service=` preselect — three answers in the owner's words, kept through
   a validation error and a reload, and stored with the submission. */
section('The private question: three answers, preselected, kept, stored');
{
  const qPage = async (q) => {
    const page = await newPage();
    await page.goto(BASE + '?assignment=private' + q);
    await page.waitForTimeout(120);
    return page;
  };
  /* The general door: the question is asked, nothing is chosen, and an empty
     answer is refused in the question's own words. */
  {
    const page = await qPage('');
    ok('the general private door opens with no answer chosen', await page.evaluate(() => S.svc) === null);
    await set(page, 'c_name', 'Quinn Visitor');
    await set(page, 'c_phone', '4345550188');
    await advance(page);
    const step = await page.evaluate(() => ({
      head: ((document.querySelector('#app h2') || {}).textContent || '').trim(),
      opts: [...document.querySelectorAll('.opt')].map(o => o.id),
      labels: [...document.querySelectorAll('.opt b')].map(b => b.textContent.trim()),
      ticked: [...document.querySelectorAll('.opt input')].filter(i => i.checked).length }));
    ok('the step asks "What type of private investigation do you need?"', step.head === 'What type of private investigation do you need?', step.head);
    ok("the owner's three answers lead, in the owner's order",
       JSON.stringify(step.labels.slice(0, 3)) === JSON.stringify(['Child Custody', 'Spouse / Relationship', 'Other Private Investigation']),
       JSON.stringify(step.labels));
    ok('no answer is ticked yet', step.ticked === 0, String(step.ticked));
    ok('the carrier and legal answers are not on the private door', !step.opts.includes('opt-claims') && !step.opts.includes('opt-legal'), JSON.stringify(step.opts));
    await advance(page);
    const err = await page.evaluate(() => ((document.querySelector('#err') || {}).textContent || '').trim());
    ok('Continue with no answer is refused in the question\'s own words', err === 'Please choose the type of private investigation you need.', err);
    ok('and the visitor is still on the question', (await heading(page)) === 'What type of private investigation do you need?');
    await page.close();
  }
  /* Preselected, changeable, and kept through a reload and a validation error. */
  {
    const page = await qPage('&service=relationship');
    ok('?service=relationship opens on Spouse / Relationship', await page.evaluate(() => S.svc) === 'relationship');
    await advance(page);    // step 1 is empty: a validation error
    ok('a validation error on the first step keeps the answer', await page.evaluate(() => S.svc) === 'relationship'
       && ((await page.evaluate(() => (document.querySelector('#err') || {}).textContent || '')).length > 0));
    await page.reload(); await page.waitForTimeout(120);
    ok('a reload keeps it', await page.evaluate(() => S.svc) === 'relationship');
    await set(page, 'c_name', 'Rae Visitor');
    await set(page, 'c_phone', '4345550199');
    await advance(page);
    ok('the question shows it already ticked', await page.evaluate(() => !!(document.querySelector('#opt-relationship input') || {}).checked));
    await page.locator('#opt-other').click();
    await page.waitForTimeout(80);
    ok('the visitor can change it', await page.evaluate(() => S.svc) === 'other');
    ok('and the address follows the answer, so a reload keeps the NEW one',
       new URL(page.url()).searchParams.get('service') === 'other' && new URL(page.url()).searchParams.get('assignment') === 'private', page.url());
    await page.reload(); await page.waitForTimeout(120);
    ok('after that reload the answer is still Other', await page.evaluate(() => S.svc) === 'other');
    await page.close();
  }
  /* Stored with the submission, exactly as the owner's portal will read it. */
  for (const [k, label] of [['relationship', 'Spouse / Relationship'], ['other', 'Other Private Investigation']]) {
    submitted = null; stored = null;
    const page = await qPage('&service=' + k);
    await set(page, 'c_name', 'Sam Stored');
    await set(page, 'c_phone', '4345550122');
    await advance(page);
    await page.evaluate((k) => pickSvc(k), k);
    await page.waitForTimeout(80);
    await advance(page);
    ok(`${label}: the flow is the ordinary private one (no new step, no price)`, await dots(page) === 5);
    await set(page, 's_name', 'Some Subject');
    await advance(page);
    await set(page, 'o_goal', 'Understand what is happening.');
    await advance(page);
    await page.locator('[data-k="a_consent"]').check();
    await set(page, 'a_typed', 'Sam Stored');
    await sign(page);
    await advance(page);
    await page.waitForTimeout(500);
    ok(`${label}: the intake reached the portal`, stored !== null);
    ok(`${label}: stored as exactly "${label}" in the existing service field`, stored && stored.service === label, stored && String(stored.service));
    ok(`${label}: an ordinary private case — no carrier, no claim, not legal`,
       stored && !stored.carrier && !stored.claim_number && stored.assignment !== 'legal');
    const rec = await page.locator('.record').innerText();
    ok(`${label}: the review the client signs names it`, rec.includes(label));
    await page.close();
  }
}

section('The Child Custody door at 1200, 390 and 320');
{
  for (const w of [1200, 390, 320]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 800 } });
    const page = await ctx.newPage();
    await page.route('**api.web3forms.com/**', r => r.fulfill({ status: 200, body: '{}' }));
    await page.route('**/portal-api/ingest', r => r.fulfill({ status: 200, body: '{"ok":true}' }));
    await page.goto(CUSTODY);
    await page.waitForTimeout(140);

    const m = await page.evaluate(() => {
      const a = document.querySelector('.cta a[href*="/intake/"]');
      const r = a ? a.getBoundingClientRect() : { left: -1e6, right: 1e6, height: 0 };
      const tel = document.querySelector('.cta a[href^="tel:"]');
      const t = tel ? tel.getBoundingClientRect() : null;
      return { left: r.left, right: r.right, h: r.height,
               telH: t ? t.height : 0,
               overlap: !!(t && r.bottom > t.top + 0.5 && r.top < t.bottom - 0.5
                           && r.right > t.left + 0.5 && r.left < t.right - 0.5),
               doc: document.documentElement.clientWidth,
               scroll: document.documentElement.scrollWidth };
    });
    ok(`at ${w} the door sits inside the viewport`,
       m.left >= -0.5 && m.right <= m.doc + 0.5, JSON.stringify(m));
    ok(`at ${w} the page does not scroll sideways`, m.scroll <= m.doc + 0.5, JSON.stringify(m));
    ok(`at ${w} the door clears the 44px tap floor`, m.h >= 44, String(m.h));
    ok(`at ${w} it does not overlap the Call button`, !m.overlap, JSON.stringify(m));
    ok(`at ${w} the Call button also clears the floor`, m.telH >= 44, String(m.telH));

    /* Follow it through at this width too — a door that is only measured is a
       door nobody has opened. */
    const present = await page.locator('.cta a[href*="/intake/"]').count() === 1;
    if (present) { await page.locator('.cta a[href*="/intake/"]').click(); await page.waitForTimeout(200); }
    ok(`at ${w} following it opens the intake on Child Custody`,
       present && page.url().includes('/intake/')
       && await page.evaluate(() => typeof S !== 'undefined' && S.svc === 'custody'));
    await page.close(); await ctx.close();
  }
}

await browser.close();
server.close();

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
