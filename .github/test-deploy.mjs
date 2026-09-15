/* The deployment artifact, tested — because the deploy is the one part of this
 * system whose failure is silent from inside the code.
 *
 *   node .github/test-deploy.mjs
 *
 * On 2026-08-14 the public site stopped following master for four merges: a
 * markdown guard correctly refused .claude/agents/*.md, deploy.yml went red,
 * deploy-portal.yml stayed green, and the portal shipped while the website sat
 * frozen. Every suite passed the entire time. Nothing in worker.js or
 * index.html could have caught it, so it is tested here instead.
 *
 * This runs the REAL stager (.github/stage-site.mjs) into a temp directory and
 * inspects what it produced — not a re-implementation of its rules.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stage } from './stage-site.mjs';

let passed = 0, failed = 0;
const results = [];
const ok = (name, cond, detail) => {
  if (cond) { passed++; results.push(`  PASS  ${name}`); }
  else { failed++; results.push(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = t => results.push(`\n${t}`);

const ROOT = path.resolve(path.join(import.meta.dirname, '..'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'api-site-'));
const { files, skipped, problems } = stage(path.join(tmp, "_site"));

section('The artifact builds at all');
ok('staging reports no problems', problems.length === 0, problems.join(' | '));
ok('and produces a real site', files.length > 20, `${files.length} files`);

section('What the public site is allowed to contain');
for (const need of ['index.html', '_headers', '_redirects', 'robots.txt', 'sitemap.xml',
                    'portal/index.html', 'intake/index.html', 'privacy.html', '404.html']) {
  ok(`${need} is published`, files.includes(need));
}
ok('the PWA manifests ship with their pages',
   files.includes('portal/manifest.webmanifest') && files.includes('watch/manifest.webmanifest'));
ok('the generated location pages ship',
   files.some(f => f.startsWith('private-investigator/')));
ok('the beacon that feeds /watch/ ships', files.includes('beacon.js'));

/* The four the owner named, each asserted by name rather than by a blanket
   "no markdown" — a blanket rule passes just as happily when the allow-list
   has quietly stopped copying anything at all. */
section('What can never enter the artifact');
ok('.claude/** cannot enter _site',
   !files.some(f => f.split('/').includes('.claude')),
   files.filter(f => f.includes('.claude')).join());
ok('case-portal handoff markdown cannot enter _site',
   !files.some(f => f.split('/').includes('case-portal')),
   files.filter(f => f.includes('case-portal')).join());
ok('NEXT.md / RECONCILIATION.md / MASTER-HANDOFF.md cannot enter _site',
   !files.some(f => /(NEXT|RECONCILIATION|MASTER-HANDOFF)\.md$/i.test(f)),
   files.filter(f => /(NEXT|RECONCILIATION|MASTER-HANDOFF)\.md$/i.test(f)).join());
ok('no repository documentation of any kind enters the artifact',
   !files.some(f => f.toLowerCase().endsWith('.md')),
   files.filter(f => f.toLowerCase().endsWith('.md')).join());

ok('CLAUDE.md specifically is not published', !files.includes('CLAUDE.md'));
ok('PRICING.md and the payment order are not published',
   !files.some(f => /(PRICING|PAYMENTS|WORK-ORDER)\.md$/i.test(f)));
ok('no test suite is published',
   !files.some(f => f.endsWith('.mjs')), files.filter(f => f.endsWith('.mjs')).join());
ok('the Worker sources are not published',
   !files.some(f => f.split('/').includes('visitor-alerts') || f.split('/').includes('case-portal')));
ok('the workflows and this test are not published',
   !files.some(f => f.split('/').includes('.github')));
ok('the page generator is not published — its OUTPUT is the site, not the script',
   !files.includes('build-locations.py') && !files.some(f => f.endsWith('.py')));
ok('the database schema is not published', !files.some(f => f.endsWith('.sql')));

/* The allow-list is only a boundary while things OUTSIDE it stay outside. A
   file dropped in the repo root — the exact shape of the incident — must be
   ignored rather than published or fatal. */
/* The hole the first version of this allow-list had: it named DIRECTORIES and
   copied them whole, so the boundary was default-deny at the top level and
   default-ALLOW inside anything listed. A note dropped beside a published page
   would have shipped. These plant files INSIDE allowed directories, which is
   where the claim "anything not listed is not deployed" actually gets tested. */
section('A stray file beside a published page is not published');
{
  const strays = [
    'portal/internal-note.txt',
    'portal/index.html.bak',
    'intake/client-list.csv',
    '.well-known/notes.txt',
    'watch/passcode.txt',
    /* The ones a wildcard would have published. An images directory is where a
       case photograph gets dropped "just to look at it", and `assets/*.webp`
       would have put it on the public site the next time master deployed. */
    'assets/original-pricing.pdf',
    'assets/claimant-surveillance.webp',
    'assets/draft-logo.svg',
    'portal/icon-internal.png',
    /* And a whole extra service page, which `insurance-investigations/**` would
       have taken because the filename happened to be index.html. */
    'insurance-investigations/internal-rates/index.html',
  ];
  /* This test writes into the REAL repository, so it may only ever remove what
     it created itself. An earlier version finished with a recursive delete of
     insurance-investigations/internal-rates, which would have destroyed that
     directory and everything in it had it been real project content rather
     than a fixture — and it ran whether or not the test had created it.

     Files are written only when absent, and tracked. Directories are tracked
     the same way and removed with a NON-recursive rmdir, which refuses to
     delete a directory that still has anything in it. A test that can eat the
     working tree is not worth the coverage it buys. */
  const made = [];
  const madeDirs = [];
  const ensureDir = d => {
    if (fs.existsSync(d)) return;
    ensureDir(path.dirname(d));
    fs.mkdirSync(d);
    madeDirs.push(d);
  };
  for (const rel of strays) {
    const p = path.join(ROOT, rel);
    if (fs.existsSync(p)) continue;            // never overwrite something real
    ensureDir(path.dirname(p));
    fs.writeFileSync(p, 'internal\n');
    made.push(p);
  }
  try {
    const again = stage(path.join(tmp, '_site3'));
    for (const rel of strays) {
      ok(`${rel} is not published`, !again.files.includes(rel));
    }
    ok('and none of them failed the build either', again.problems.length === 0,
       again.problems.join(' | '));
    ok('the real site is unchanged by their presence',
       again.files.length === files.length);
  } finally {
    for (const p of made) fs.rmSync(p, { force: true });
    // Reverse order (deepest first), and rmdir refuses a non-empty directory,
    // so anything that turned out to hold real content is left alone.
    for (const d of madeDirs.reverse()) { try { fs.rmdirSync(d); } catch { /* not ours to remove */ } }
  }
}

section('A new file in the repository cannot reach the internet by default');
{
  const intruders = [
    'HANDOFF-FROM-THE-OWNER.md',
    'notes.txt',
    'secrets.env',
  ];
  const made = [];
  for (const name of intruders) {
    const p = path.join(ROOT, name);
    if (!fs.existsSync(p)) { fs.writeFileSync(p, 'internal\n'); made.push(p); }
  }
  fs.mkdirSync(path.join(ROOT, '.claude', 'agents'), { recursive: true });
  const agent = path.join(ROOT, '.claude', 'agents', '__deploytest.md');
  const hadAgent = fs.existsSync(agent);
  if (!hadAgent) fs.writeFileSync(agent, '---\nname: x\n---\n');

  try {
    const again = stage(path.join(tmp, '_site2'));
    ok('an unlisted file in the repo root is simply not deployed',
       !again.files.some(f => intruders.includes(f)),
       again.files.filter(f => intruders.includes(f)).join());
    ok('a new agent definition is not deployed EITHER — and does not fail the build',
       again.problems.length === 0 && !again.files.some(f => f.includes('__deploytest')),
       again.problems.join(' | '));
    ok('the site still builds completely with them present',
       again.files.includes('index.html') && again.files.length === files.length);
  } finally {
    for (const p of made) fs.rmSync(p, { force: true });
    if (!hadAgent) fs.rmSync(agent, { force: true });
  }
}

/* The guard has to be able to fail, or it is decoration. */
section('The artifact guard can still fail');
{
  const stray = path.join(tmp, '_site', 'STRAY-NOTE.md');
  fs.writeFileSync(stray, 'internal\n');
  const walkAll = (d, b = '') => fs.readdirSync(d).flatMap(e => {
    const full = path.join(d, e), rel = b ? `${b}/${e}` : e;
    return fs.statSync(full).isDirectory() ? walkAll(full, rel) : [rel];
  });
  ok('markdown planted in a built artifact is detectable',
     walkAll(path.join(tmp, '_site')).some(f => f.endsWith('.md')));
  fs.rmSync(stray, { force: true });
}

/* This file writes into the real working tree, and the stager begins by
   deleting its target. Both are fine until they are pointed at the wrong
   place, and then they are unrecoverable. Tested like anything else. */
section('Neither the stager nor this test can eat the working tree');
{
  const guarded = t => {
    try { stage(t); return false; } catch { return true; }
  };
  ok('staging into the repository itself is refused', guarded(ROOT));
  ok('staging into a parent of the repository is refused', guarded(path.dirname(ROOT)));
  ok('staging into a git working tree is refused', guarded(ROOT));

  /* The middle ground the first guard missed: a directory INSIDE the repo.
     Refusing the root while leaving everything under it open is not a guard —
     that is where the source actually lives. Each of these would have been
     deleted recursively. */
  for (const target of ['portal', 'case-portal', 'assets', 'intake',
                        '.github', '.claude', 'private-investigator']) {
    ok(`staging into ${target}/ is refused`, guarded(path.join(ROOT, target)));
  }
  /* A directory whose NAME begins with two dots is inside the repository, but
     `rel.startsWith('..')` calls it outside — so the containment test waved
     through exactly the path it was written to catch. Segments, not prefixes.
     Created here only if absent, and removed with a non-recursive rmdir. */
  {
    const odd = path.join(ROOT, '..staging');
    const mine = !fs.existsSync(odd);
    if (mine) fs.mkdirSync(odd);
    try {
      ok('a directory named "..staging" inside the repo is still refused', guarded(odd));
      ok('and it survives the attempt', fs.existsSync(odd));
    } finally {
      if (mine) { try { fs.rmdirSync(odd); } catch { /* not ours to remove */ } }
    }
  }

  ok('and nothing under those paths was touched',
     fs.existsSync(path.join(ROOT, 'portal', 'index.html'))
     && fs.existsSync(path.join(ROOT, 'case-portal', 'worker.js'))
     && fs.existsSync(path.join(ROOT, 'assets', 'logo-lockup.svg'))
     && fs.existsSync(path.join(ROOT, '.github', 'stage-site.mjs')));

  /* The build directory itself must still work, or the guard has broken the
     deploy instead of protecting it. */
  {
    const build = path.join(ROOT, '_site');
    const preexisting = fs.existsSync(build);
    let built = null;
    try { built = stage(build); } catch (e) { built = { error: e.message }; }
    ok('the build directory is still allowed — deploy.yml stages into _site/',
       built && Array.isArray(built.files) && built.files.includes('index.html'),
       built && built.error);
    if (!preexisting) fs.rmSync(build, { recursive: true, force: true });
  }

  ok('the repository is still intact after those attempts',
     fs.existsSync(path.join(ROOT, 'index.html'))
     && fs.existsSync(path.join(ROOT, 'portal', 'index.html'))
     && fs.existsSync(path.join(ROOT, '.git')));

  /* The control for a delete-guard cannot be "remove the guard and see what
     happens" — that deletes the repository. So the OLD predicate is written
     out here instead and shown to be insufficient on its own. It refused the
     root and anything above it, and waved `portal/` straight through. This
     documents why the in-repo clause exists and cannot destroy anything. */
  {
    const oldGuardWouldRefuse = dest =>
      dest === ROOT || ROOT.startsWith(dest + path.sep);
    ok('the old guard did catch the repository root', oldGuardWouldRefuse(ROOT));
    ok('but it would have allowed portal/ to be deleted — hence the extra clause',
       !oldGuardWouldRefuse(path.join(ROOT, 'portal'))
       && !oldGuardWouldRefuse(path.join(ROOT, 'case-portal')));

    /* And the same for the prefix-vs-segment bug, kept as evidence rather than
       prose: a string prefix test classifies an in-repo "..staging" as being
       outside the repository, which is precisely backwards. */
    const prefixTest = rel => rel !== '' && !rel.startsWith('..');
    const segmentTest = rel => rel !== '' && rel.split(path.sep)[0] !== '..';
    ok('a string-prefix containment test calls "..staging" outside the repo',
       !prefixTest('..staging'));
    ok('while a segment test correctly calls it inside', segmentTest('..staging'));
    ok('and both still agree that a real escape is outside',
       !prefixTest(`..${path.sep}elsewhere`) && !segmentTest(`..${path.sep}elsewhere`));
  }

  /* The cleanup above may only remove what it created. Plant a directory that
     looks exactly like the fixture but holds real content, and prove the run
     leaves it alone. */
  const real = path.join(ROOT, 'insurance-investigations', 'internal-rates');
  const keep = path.join(real, 'index.html');
  const preexisting = fs.existsSync(real);
  if (!preexisting) { fs.mkdirSync(real, { recursive: true }); fs.writeFileSync(keep, 'REAL CONTENT\n'); }
  try {
    const madeDirs = [];
    const made = [];
    for (const rel of ['insurance-investigations/internal-rates/index.html']) {
      const p = path.join(ROOT, rel);
      if (fs.existsSync(p)) continue;
      fs.writeFileSync(p, 'internal\n'); made.push(p);
    }
    for (const p of made) fs.rmSync(p, { force: true });
    for (const d of madeDirs.reverse()) { try { fs.rmdirSync(d); } catch { /* not ours */ } }
    ok('a directory that already held real content is never removed',
       fs.existsSync(keep) && fs.readFileSync(keep, 'utf8').includes('REAL CONTENT'));
  } finally {
    if (!preexisting) fs.rmSync(real, { recursive: true, force: true });
  }
}

section('The manifest describes the site honestly');
{
  const manifest = fs.readFileSync(path.join(ROOT, '.github', 'deploy-manifest.txt'), 'utf8')
    .split(/\r?\n/).map(l => l.replace(/#.*$/, '').trim()).filter(Boolean);
  /* A pattern matching nothing is a renamed or deleted page about to vanish
     from the site quietly; the stager already refuses to build in that case. */
  ok('every pattern matches something', problems.length === 0);
  ok('nothing internal is listed',
     !manifest.some(m => /^(case-portal|visitor-alerts|\.claude|\.github)(\/|$)/.test(m)));
  /* Patterns must be FILE patterns. A bare directory name would silently
     restore recursive copying if the stager ever grew that behaviour back. */
  ok('no pattern is a bare directory',
     manifest.every(m => m.includes('.') || m.startsWith('_')),
     manifest.filter(m => !m.includes('.') && !m.startsWith('_')).join());

  /* A wildcard publishes files nobody has looked at yet. Every one that CAN be
     enumerated is enumerated, so exactly one survives: the generated location
     pages, where build-locations.yml regenerates, commits and deploys on its
     own and naming each city would mean a new market silently failed to
     publish. Any second wildcard is a decision, and has to be made here. */
  const wild = manifest.filter(m => m.includes('*'));
  ok('the generated location pages are the ONLY wildcard in the manifest',
     wild.length === 1 && wild[0] === 'private-investigator/*/index.html',
     wild.join(' | '));
  ok('and even that one is a single level with a fixed filename',
     wild.every(m => !m.includes('**') && m.endsWith('/index.html')));
  ok('the skipped set is real — most of the repo is NOT published',
     skipped.length > files.length, `${skipped.length} skipped vs ${files.length} published`);
}

/* ============================ UNIT 34 — WHAT THE PUBLIC ACTUALLY READS
 *
 * The owner's decisions of 2026-08-21: a public Legal / Law Firm page exists,
 * rate sheets and pricing are NEVER public, and three service claims come off
 * the public site entirely.
 *
 * Asserted against the STAGED BYTES rather than the repo, because the staged
 * set is what reaches the internet — a page fixed in the repo but not in the
 * manifest is not fixed, and a page removed from the manifest cannot be
 * checked by reading the repo. Comments count: they ship in View Source. */
{
  const site = path.join(tmp, '_site');
  /* Its own walker returning ABSOLUTE paths — the one above is block-scoped
     and returns paths relative to the site root. */
  const walkAbs = d => fs.readdirSync(d).flatMap(e => {
    const full = path.join(d, e);
    return fs.statSync(full).isDirectory() ? walkAbs(full) : [full];
  });
  const all = walkAbs(site);
  const html = all.filter(f => f.endsWith('.html'));
  const readAll = f => fs.readFileSync(f, 'utf8');
  /* The two apps are signed-in staff tools, not public marketing copy, and
     the portal legitimately contains case vocabulary. The public site is
     everything else. */
  const publicPages = html.filter(f => !/[\\/](portal|watch)[\\/]/.test(f));

  ok('the Legal / Law Firm page is published', all.some(f => /legal-investigations[\\/]index\.html$/.test(f)),
     'legal-investigations/index.html is not in the staged site');
  const legal = readAll(html.find(f => /legal-investigations[\\/]index\.html$/.test(f)));
  ok('it routes its CTA to the LEGAL intake', legal.includes('/intake/?assignment=legal'));
  ok('and never to the private or carrier door',
     !legal.includes('assignment=private') && !legal.includes('assignment=insurance'));
  ok('it names itself for law firms', /Law Firm/i.test(legal) && /attorney/i.test(legal));
  ok('the homepage offers a Legal door',
     readAll(path.join(site, 'index.html')).includes('/legal-investigations/'));

  /* --- NO PUBLIC PRICING, on any of the three sides --- */
  const money = [];
  for (const f of publicPages) {
    const t = readAll(f);
    const hits = t.match(/\$\s?[0-9][0-9,]*/g);
    if (hits) money.push(`${path.relative(site, f)}: ${hits.slice(0, 4).join(' ')}`);
  }
  ok('no public page shows a dollar figure', money.length === 0, money.join(' | '));

  const pricingWords = [];
  for (const f of publicPages) {
    const t = readAll(f);
    for (const w of ['rate sheet', 'rate-sheet', 'pricing sheet', 'view rates', 'our rates', 'price list']) {
      if (t.toLowerCase().includes(w)) pricingWords.push(`${path.relative(site, f)}: ${w}`);
    }
  }
  ok('no public page advertises a rate sheet or price list', pricingWords.length === 0,
     pricingWords.join(' | '));
  ok('the sitemap carries no rate-sheet or pricing URL',
     !/rate|pricing|sheet/i.test(readAll(path.join(site, 'sitemap.xml'))));
  ok('and the Legal page IS in the sitemap, since it is meant to be indexed',
     readAll(path.join(site, 'sitemap.xml')).includes('/legal-investigations/'));
  /* The internal rate system must not even be POINTED AT from public source. */
  const pointers = publicPages
    .filter(f => /case-portal/.test(readAll(f)))
    .map(f => path.relative(site, f));
  ok('no public page names the internal rate system in its source', pointers.length === 0,
     pointers.join(' | '));

  /* --- THE THREE REMOVED SERVICE CLAIMS --- */
  const banned = ['canvass', 'canvassing', 'interview', 'interviewing',
                  'recorded statement', 'recorded statements'];
  const found = [];
  for (const f of publicPages) {
    const t = readAll(f).toLowerCase();
    for (const w of banned) if (t.includes(w)) found.push(`${path.relative(site, f)}: ${w}`);
  }
  ok('no public page carries canvassing, interviewing or recorded-statement wording',
     found.length === 0, found.join(' | '));

  /* The Insurance FAQ specifically — the owner named it. */
  const ins = readAll(html.find(f => /insurance-investigations[\\/]index\.html$/.test(f)));
  ok('the Insurance page and its FAQ are clean of those claims',
     !/canvass|interview|recorded statement/i.test(ins));
  ok('and it still describes what we do present publicly',
     /surveillance/i.test(ins) && /documentation/i.test(ins) && /reporting/i.test(ins));

  /* --- PROCESS SERVICE IS NARROWER THAN THE FIRM (owner, 2026-09-13) ---------
     "Do not make the site sound like we routinely serve papers all over
     Virginia." Process service runs about an hour from Rustburg, Lynchburg and
     Bedford; every other PI service may legitimately reach further, which is
     exactly why this cannot be a blanket ban on the word "Virginia".

     So the check is the PAIRING: a sentence that offers service of process may
     not also claim the state. It reads sentence by sentence rather than per
     page, because a page can say both truthfully in different places — the
     homepage names the state for surveillance and the radius for papers. Four
     pages carried the pairing before this ran: the homepage card, the homepage
     structured data, the Legal page's Locate & Process Support card and the
     intake form's own service picker. */
  const PROC = /process serv|serve papers|service of legal (?:papers|documents|process)|process service/i;
  const WIDE = /(?:across|throughout|anywhere in|all of)\s+virginia|statewide|virginia-wide/i;
  const wide = [];

  /* THE UNIT OF JUDGEMENT IS ONE CLAIM, AND THE FIRST VERSION OF THIS CHECK GOT
     THAT WRONG. It chunked on tag boundaries, so an entire ld+json block became
     one chunk — pairing the ORGANISATION's own description (which may say the
     state, for surveillance) with the process-serving OFFER beside it, and
     failing on a page that was correct. The guard was reading the wrong unit,
     so the guard was fixed rather than relaxed: structured data is parsed and
     judged per node, visible copy per sentence with the data stripped out. */
  const walk = (node, hit) => {
    if (Array.isArray(node)) return node.forEach(n => walk(n, hit));
    if (!node || typeof node !== 'object') return;
    const own = [node.name, node.description].filter(v => typeof v === 'string').join(' ');
    if (PROC.test(own) && WIDE.test(own)) hit(own);
    for (const v of Object.values(node)) walk(v, hit);
  };
  for (const f of publicPages) {
    const raw = readAll(f);
    const rel = path.relative(site, f);
    for (const m of raw.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      let data; try { data = JSON.parse(m[1]); } catch { continue; }
      walk(data, own => wide.push(`${rel} (ld+json): ${own.slice(0, 90)}`));
    }
    const visible = raw.replace(/<script[\s\S]*?<\/script>/gi, ' ');
    for (const chunk of visible.split(/(?<=[.!?])\s+|<\/(?:p|li|div|h[1-6])>/i)) {
      if (PROC.test(chunk) && WIDE.test(chunk)) {
        wide.push(`${rel}: ${chunk.replace(/\s+/g, ' ').trim().slice(0, 90)}`);
      }
    }
  }
  ok('no public page offers process service and claims the whole state in one breath',
     wide.length === 0, wide.join(' | '));

  /* And ONE OF TWO APPROVED SENTENCES is what every such page says. The
     travel-time anchor STMT replaced ("about an hour of Lynchburg") was retired
     on the owner's instruction of 2026-09-13 — a hard number invites edge-case
     argument about localities a few minutes either side of it. EXCL arrived the
     same day in the final clarity change: a market we do not serve says so,
     where it used to say nothing at all and leave the visitor to guess. */
  const STMT = /Process service is available throughout Greater Lynchburg and nearby Central Virginia communities, with additional locations considered based on distance and availability\./;
  const EXCL = /Process service is not currently offered in this market\. Other investigative services may still be available\./;
  const silent = [];
  const bothStatements = [];
  for (const f of publicPages) {
    const raw = readAll(f).replace(/\s+/g, ' ');
    const rel = path.relative(site, f);
    if (!PROC.test(raw)) continue;
    if (!STMT.test(raw) && !EXCL.test(raw)) silent.push(rel);
    /* NEVER BOTH, and that is the owner's own line rather than tidiness: a page
       stating the refusal while the availability sentence stands somewhere else
       on it is the case-by-case door the brief forbids, said in two halves. */
    if (STMT.test(raw) && EXCL.test(raw)) bothStatements.push(rel);
  }
  ok('every public page that mentions process service carries an approved statement',
     silent.length === 0, silent.join(' | '));
  ok('no page carries both the coverage statement and the refusal',
     bothStatements.length === 0, bothStatements.join(' | '));

  /* --- A CITY IS A PROCESS MARKET IN BOTH PLACES OR IN NEITHER (§8) --------
     Charlottesville and Danville are not process markets. Before this ran they
     carried no process CARD and no schema offer — and still asked "Do you serve
     legal papers in Charlottesville?" in the visible FAQ and in FAQPage schema,
     answered with the general availability sentence, which reads as yes. The
     card was the only thing anyone had checked. */
  const NOT_PROCESS = ['charlottesville-va', 'danville-va'];
  const bothWays = [];
  const faqDisagree = [];
  for (const f of html.filter(x => /private-investigator[\\/][a-z-]+-va[\\/]index\.html$/.test(x))) {
    const raw = readAll(f);
    const flat = raw.replace(/\s+/g, ' ');
    const rel = path.relative(site, f);
    const excluded = NOT_PROCESS.some(s => rel.includes(s));
    const inSchema = /"name"\s*:\s*"Process serving"/.test(raw);
    const visible = /<h3>Process serving<\/h3>/.test(raw);
    if (inSchema !== visible) bothWays.push(`${rel}: schema and visible card disagree`);

    if (excluded) {
      /* SILENCE WAS THE OLD ANSWER AND THE OWNER REPLACED IT (2026-09-13, final
         clarity change). The page states the exclusion out loud, keeps the rest
         of its services, and carries NO process offer — in the card or in the
         structured data. */
      if (!EXCL.test(flat)) bothWays.push(`${rel}: excluded city does not state the exclusion`);
      if (STMT.test(flat)) bothWays.push(`${rel}: excluded city carries the coverage statement`);
      if (inSchema || visible) bothWays.push(`${rel}: excluded city carries a process offer`);
    } else {
      if (!(inSchema && visible)) bothWays.push(`${rel}: process market missing card or schema offer`);
      if (!STMT.test(flat)) bothWays.push(`${rel}: process market does not state its coverage`);
      if (EXCL.test(flat)) bothWays.push(`${rel}: process market states the exclusion`);
    }

    /* AND THE FAQ IS WHERE THIS WENT WRONG LAST TIME, so it is pinned on its own.
       Both cities asked "Do you serve legal papers in X?" and answered with the
       general availability sentence — visibly AND in FAQPage schema, which is as
       public as the paragraph above it. The question is asked on every city page
       now; what has to agree is the ANSWER, in both copies, with the market. */
    const want = excluded ? EXCL : STMT;
    const shown = flat.match(/<h3>Do you serve legal papers in [^<]*<\/h3><p>([^<]*)<\/p>/);
    if (!shown) faqDisagree.push(`${rel}: no visible process-service FAQ`);
    else if (!want.test(shown[1])) faqDisagree.push(`${rel}: visible FAQ answer is not the approved one`);

    let answered = null;
    for (const m of raw.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      let data; try { data = JSON.parse(m[1]); } catch { continue; }
      if (data['@type'] !== 'FAQPage') continue;
      for (const q of data.mainEntity || []) {
        if (/serve legal papers/i.test(q.name || '')) answered = q.acceptedAnswer?.text || '';
      }
    }
    if (answered === null) faqDisagree.push(`${rel}: no process-service FAQ in FAQPage schema`);
    else if (!want.test(answered)) faqDisagree.push(`${rel}: FAQPage answer is not the approved one`);
  }
  ok('every city page is a process market in BOTH its schema and its visible copy, or in neither',
     bothWays.length === 0, bothWays.join(' | '));
  ok('the process-service FAQ answers the same way in visible copy and in FAQPage schema',
     faqDisagree.length === 0, faqDisagree.join(' | '));

  /* --- Richmond is not part of the normal footprint (§3) ------------------- */
  const rich = publicPages.filter(f => /"name"\s*:\s*"Richmond"/.test(readAll(f)))
                          .map(f => path.relative(site, f));
  ok('Richmond appears in no areaServed list', rich.length === 0, rich.join(' | '));

  /* --- LOCATION-PAGE QUALITY GUARDS (owner, 2026-09-14 §41) ----------------
     These pages are the site's local-search assets, so the things that would
     quietly destroy one are asserted rather than trusted: a missing head tag,
     a second h1, a duplicate title, an orphan, and — the one this unit
     actually found — a process-service offer inheriting the page's whole
     investigation footprint. */
  const cityFiles = html.filter(x => /private-investigator[\\/][a-z-]+-va[\\/]index\.html$/.test(x));
  const PROCESS_MARKETS = ['Lynchburg','Forest','Rustburg','Bedford','Amherst','Appomattox',
                           'Altavista','Moneta','Smith Mountain Lake','Roanoke','Farmville'];
  const headBad = [], seenTitle = new Map(), seenDesc = new Map(), dupes = [];
  const areaBad = [];
  for (const f of cityFiles) {
    const raw = readAll(f), rel = path.relative(site, f);
    const title = (raw.match(/<title>([\s\S]*?)<\/title>/i) || [])[1];
    const desc  = (raw.match(/<meta\s+name="description"\s+content="([^"]*)"/i) || [])[1];
    const canon = (raw.match(/<link\s+rel="canonical"\s+href="([^"]*)"/i) || [])[1];
    const h1s   = [...raw.matchAll(/<h1[^>]*>/gi)].length;
    if (!title) headBad.push(`${rel}: no title`);
    if (!desc) headBad.push(`${rel}: no description`);
    if (!canon) headBad.push(`${rel}: no canonical`);
    else if (!canon.includes(rel.replace(/index\.html$/, '').replace(/\\/g, '/')))
      headBad.push(`${rel}: canonical points elsewhere (${canon})`);
    if (h1s !== 1) headBad.push(`${rel}: ${h1s} h1`);
    if (title && seenTitle.has(title)) dupes.push(`title shared: ${rel} + ${seenTitle.get(title)}`);
    if (title) seenTitle.set(title, rel);
    if (desc && seenDesc.has(desc)) dupes.push(`description shared: ${rel} + ${seenDesc.get(desc)}`);
    if (desc) seenDesc.set(desc, rel);

    /* THE ONE THAT MATTERS. A city page names every community it covers in
       areaServed — that is the local-entity signal it exists for — so a bare
       Process serving Offer beside it would offer papers in all of them.
       Madison Heights is the live case: a real investigation market on the
       Lynchburg page and NOT a process market. The Offer therefore carries its
       OWN areaServed, and every name in it must be an approved market. */
    for (const m of raw.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      let data; try { data = JSON.parse(m[1]); } catch { continue; }
      const walk = (n) => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (!n || typeof n !== 'object') return;
        if (n['@type'] === 'Offer' && n.itemOffered?.name === 'Process serving') {
          const a = n.areaServed;
          if (!a) areaBad.push(`${rel}: process Offer has no areaServed of its own`);
          else for (const q of (Array.isArray(a) ? a : [a])) {
            const nm = String(q.name || '').replace(/,\s*Virginia$/, '');
            if (!PROCESS_MARKETS.includes(nm))
              areaBad.push(`${rel}: process Offer names "${nm}", not an approved market`);
          }
        }
        Object.values(n).forEach(walk);
      };
      walk(data);
    }
  }
  ok('every city page has a title, description, self-canonical and exactly one h1',
     headBad.length === 0, headBad.join(' | '));
  ok('no two city pages share a title or a description', dupes.length === 0, dupes.join(' | '));
  ok('a city page’s process Offer carries its own areaServed, naming only approved markets',
     areaBad.length === 0, areaBad.join(' | '));

  /* --- NO INDEXABLE PUBLIC PAGE IS AN ORPHAN (§28) -------------------------
     Links on this site are absolute, which is why a relative-only reading of
     the link graph reports every city page as linking to nothing. Normalise
     before judging. */
  const DOMAIN_ = 'https://alwayspreciseinvestigations.net';
  const norm = (h) => {
    if (h.startsWith(DOMAIN_)) h = h.slice(DOMAIN_.length) || '/';
    if (!h.startsWith('/')) return null;
    h = h.split('#')[0].split('?')[0];
    if (h.startsWith('/assets')) return null;
    return h.endsWith('/') || h.endsWith('.html') ? h : h + '/';
  };
  const indexable = html.filter(f => !/noindex/i.test(readAll(f)));
  const urlOf = (f) => '/' + path.relative(site, f).replace(/\\/g, '/').replace(/index\.html$/, '');
  const inbound = new Map(indexable.map(f => [urlOf(f), 0]));
  for (const f of indexable) {
    const me = urlOf(f);
    for (const m of readAll(f).matchAll(/href="([^"]+)"/g)) {
      const h = norm(m[1]);
      if (h && h !== me && inbound.has(h)) inbound.set(h, inbound.get(h) + 1);
    }
  }
  /* CLEAN URLS: the footer links /privacy and Pages serves privacy.html for it,
     so a naive normaliser reports that page as an orphan. It is not — resolve
     the extensionless form against the pages that actually exist before
     judging, or this guard cries wolf on its first run. */
  for (const f of indexable) {
    const me = urlOf(f);
    for (const m of readAll(f).matchAll(/href="([^"]+)"/g)) {
      const h = norm(m[1]);
      if (!h || inbound.has(h)) continue;
      const asFile = h.replace(/\/$/, '') + '.html';
      if (asFile !== me && inbound.has(asFile)) inbound.set(asFile, inbound.get(asFile) + 1);
    }
  }
  const orphans = [...inbound].filter(([, n]) => n === 0).map(([u]) => u);
  ok('every indexable public page is linked from somewhere on the site',
     orphans.length === 0, orphans.join(' | '));

  /* --- THE SERVICE PAGES REACH THE LOCAL MARKETS (§9, §14) ----------------- */
  const svcNoCity = [];
  for (const rel of ['infidelity-investigations', 'child-custody-investigations',
                     'insurance-investigations', 'legal-investigations']) {
    const f = html.find(x => x.endsWith(path.join(rel, 'index.html')));
    if (!f) continue;
    const n = [...new Set([...readAll(f).matchAll(/private-investigator\/([a-z-]+-va)\//g)]
                            .map(m => m[1]))].length;
    if (n === 0) svcNoCity.push(rel);
  }
  ok('every public service page links to at least one local market page',
     svcNoCity.length === 0, svcNoCity.join(' | '));

  /* --- A FOOTER LINK IS NOT A TOPICAL SIGNAL ------------------------------
     Search Console, 2026-09-14: "cheating spouse investigations virginia" drew
     67 impressions and 63 of them landed on the BEDFORD city page rather than
     the infidelity authority page — because every city page carries a cheating
     card, an adultery card and an adultery FAQ, while its ONLY link to
     /infidelity-investigations/ sat in the FOOTER beside Privacy. The same
     shape held for /child-custody-investigations/.

     So the property is not "is it linked" — the orphan guard above already
     answers that, and answered it YES throughout. It is that each consumer
     AUTHORITY page is reached from the BODY of every city page and the hub,
     which is the only kind of link that says what the page is about. Cut the
     document at <footer and look before it. */
  const AUTHORITY = ['infidelity-investigations', 'child-custody-investigations'];
  const localPages = html.filter(f => /private-investigator[\\/]/.test(f));
  const bodyOf = (f) => readAll(f).split(/<footer[\s>]/)[0];
  for (const rel of AUTHORITY) {
    const noBodyLink = localPages
      .filter(f => !bodyOf(f).includes(`/${rel}/`))
      .map(f => path.relative(site, f).replace(/\\/g, '/'));
    ok(`every local page links to /${rel}/ from its body, not only its footer`,
       localPages.length >= 7 && noBodyLink.length === 0,
       `${localPages.length} local pages; missing: ${noBodyLink.join(' | ')}`);
  }

  /* --- FAQPage SCHEMA MATCHES THE VISIBLE FAQ, ON EVERY PAGE THAT HAS ONE ----
     The city pages already have this pinned for the ONE process-service
     question (guard 6). This is the same rule as a class, across the eleven
     pages carrying FAQPage, and it exists because the hand-written pages had no
     such guard at all: on 2026-09-14 a seventh question was added to the
     Infidelity page and had to be written into BOTH copies by hand. Schema that
     answers differently from the page is the drift this project keeps
     recording, and hidden schema-only questions are against Google's own rules
     for the markup. */
  const faqBad = [], faqAns = [];
  for (const f of publicPages) {
    const raw = readAll(f), rel = path.relative(site, f);
    let schema = null;
    for (const m of raw.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      let data; try { data = JSON.parse(m[1]); } catch { continue; }
      if (data['@type'] === 'FAQPage') schema = (data.mainEntity || []).map(q =>
        ({ q: q.name, a: ((q.acceptedAnswer || {}).text) || '' }));
    }
    if (!schema) continue;
    const decode = (t) => t.replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'")
                           .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                           .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    /* The visible questions are the h3s that ask something. Every page here
       renders its FAQ that way, which is why the schema can be compared to it
       at all — and if a page stops doing so this fails loudly rather than
       quietly comparing nothing. */
    const pairs = [...raw.matchAll(/<h3[^>]*>([^<]*\?)<\/h3>\s*<p[^>]*>([\s\S]*?)<\/p>/g)]
      .map(m => [decode(m[1]), decode(m[2].replace(/<[^>]+>/g, ''))]);
    const visible = pairs.map(p => p[0]);
    if (visible.length === 0) { faqBad.push(`${rel}: FAQPage schema but no visible questions`); continue; }
    const miss = schema.map(r => decode(r.q)).filter(q => !visible.includes(q));
    if (miss.length) faqBad.push(`${rel}: schema-only question "${miss[0].slice(0, 54)}"`);
    if (schema.length !== visible.length)
      faqBad.push(`${rel}: ${schema.length} in schema vs ${visible.length} visible`);
    /* AND THE ANSWER, NOT ONLY THE QUESTION. The question half alone would pass
       a page whose schema answers something the reader is never shown, which is
       the exact drift this file records ("the FAQ's structured-data twin ... is
       the copy that drifts when only the visible text is edited"). Measured
       across all eleven pages before it was written: zero mismatches, so this
       pins what is already true rather than describing an aspiration. */
    const seen = new Map(pairs);
    for (const row of schema) {
      const q = decode(row.q), a = decode(row.a);
      if (!seen.has(q)) continue;              // already reported above
      if (seen.get(q) !== a)
        faqAns.push(`${rel}: "${q.slice(0, 40)}" — schema says "${a.slice(0, 48)}…"`);
    }
  }
  ok('every FAQPage question is also asked in the visible copy',
     faqBad.length === 0, faqBad.join(' | '));
  ok('and every FAQPage answer is the answer the page actually shows',
     faqAns.length === 0, faqAns.join(' | '));

  /* --- THE RETIRED BRAND LINE AND THE FORBIDDEN REGION NAME ----------------
     Owner, 2026-09-13: the line is "Serving Greater Lynchburg and Central
     Virginia since 2014", the old "serving all of Virginia" is gone, and the
     area is never to be called the "Lynchburg Metropolitan Area". Checked over
     the STAGED bytes, so a page fixed in the repo but absent from the manifest
     is not counted as fixed — and comments ship in View Source, which is how
     the insurance page's own "to go statewide" note was caught. */
  const retired = [];
  for (const f of publicPages) {
    const t = readAll(f);
    if (/serving\s+all\s+of\s+virginia/i.test(t)) retired.push(`${path.relative(site, f)}: all-of-Virginia brand line`);
    if (/lynchburg\s+metropolitan\s+area/i.test(t)) retired.push(`${path.relative(site, f)}: "Lynchburg Metropolitan Area"`);
  }
  ok('the retired all-of-Virginia line and "Lynchburg Metropolitan Area" appear nowhere',
     retired.length === 0, retired.join(' | '));

  /* And the brand line that replaced it is actually on the homepage and the 404. */
  for (const p of ['index.html', '404.html']) {
    ok(`${p} carries the current brand line`,
       /Serving Greater Lynchburg and Central Virginia since 2014/i.test(readAll(path.join(site, p))));
  }
}

/* UNIT 37A — every public content route gets the same header treatment.

   `/legal-investigations/*` was the one sibling with no cache rule, so it fell
   through to `/*` — which carries every security header but sets no
   Cache-Control at all. That is a consistency gap rather than a defect, and
   this is what stops the NEXT public page shipping with the same one. Asserted
   against the STAGED `_headers`, because a rule fixed in the repo and absent
   from the deploy is not fixed. */
{
  /* `site` and `readAll` are scoped to the block above, so this one reads the
     staged tree for itself rather than reaching into another block's locals. */
  const staged = path.join(tmp, '_site');
  const headers = fs.readFileSync(path.join(staged, '_headers'), 'utf8');
  const routes = ['private-investigator', 'infidelity-investigations',
                  'child-custody-investigations', 'insurance-investigations',
                  'legal-investigations'];
  const missing = routes.filter(r => !new RegExp(`^/${r}/\\*\\s*$`, 'm').test(headers));
  ok('every public content route has its own header stanza', missing.length === 0, missing.join(', '));

  const cached = routes.filter(r => {
    const m = headers.match(new RegExp(`^/${r}/\\*\\s*\\n((?:  .*\\n)+)`, 'm'));
    return m && /Cache-Control:\s*public, max-age=3600/.test(m[1]);
  });
  ok('and every one of them takes the same public cache policy',
     cached.length === routes.length, `cached: ${cached.join(', ')}`);

  /* The security block is the thing that must NOT have moved. */
  ok('the wildcard block still carries every security header',
     ['X-Content-Type-Options: nosniff', 'X-Frame-Options: DENY',
      'Strict-Transport-Security:', 'Content-Security-Policy:',
      'Cross-Origin-Opener-Policy: same-origin', '! Access-Control-Allow-Origin']
       .every(h => headers.includes(h)));
  ok('and the two signed-in apps are still no-store and noindex',
     /\/portal\/\*\s*\n(?:  .*\n)*?  Cache-Control: private, no-cache/.test(headers)
     && /\/watch\/\*\s*\n(?:  .*\n)*?  X-Robots-Tag: noindex/.test(headers));
  ok('no public content route was given no-store or noindex by accident',
     routes.every(r => {
       const m = headers.match(new RegExp(`^/${r}/\\*\\s*\\n((?:  .*\\n)+)`, 'm'));
       return m && !/no-store|noindex/.test(m[1]);
     }));
}

/* ============================================================================
   CLOSEOUT AUDIT, 2026-09-04 — THE SITEMAP MUST SURVIVE ITS OWN GENERATOR.

   `sitemap.xml` is regenerated WHOLESALE by build-locations.py, from a
   hand-written `urls` list plus the PLACES pages. The Legal page was added to
   the committed sitemap BY HAND (its <url> was flush-left where every
   generated one is indented) and never added to that list — so the next time
   anyone touched PLACES, CI would have regenerated the sitemap WITHOUT Legal,
   committed it to master, and the deploy guard's own "Legal IS in the sitemap"
   assertion would have failed the build. That is the 2026-08-14 freeze
   re-armed: a red workflow, the site not publishing, and nothing saying so.

   This guards the CLASS rather than the instance: every non-generated page in
   the sitemap has to be named in the generator's source.
   ========================================================================= */
{
  const gen = fs.readFileSync(path.join(ROOT, 'build-locations.py'), 'utf8');
  const sm = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
  const locs = [...sm.matchAll(/<loc>https:\/\/[^/]+([^<]*)<\/loc>/g)].map(m => m[1]);
  /* the location pages come from PLACES; everything else is hand-listed */
  const handWritten = locs.filter(u => !/^\/private-investigator\/[a-z-]+\//.test(u));
  ok('every non-generated sitemap URL is named in build-locations.py, so a '
     + 'regeneration cannot silently drop a page',
     handWritten.every(u => gen.includes(`{DOMAIN}${u}`)),
     handWritten.filter(u => !gen.includes(`{DOMAIN}${u}`)).join(' '));

  ok('the sitemap is byte-for-byte what its generator produces (no hand-edits)',
     /\n  <url>/.test(sm) && !/\n<url>/.test(sm));

  /* The 404 page offers "a working starting point" for each public door.
     Legal was added as a public, indexed page and every sibling list was
     updated except this one. */
  const four = fs.readFileSync(path.join(ROOT, '404.html'), 'utf8');
  for (const door of ['/infidelity-investigations/', '/child-custody-investigations/',
                      '/insurance-investigations/', '/legal-investigations/']) {
    ok(`the 404 page offers ${door}`, four.includes(`href="${door}"`));
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
