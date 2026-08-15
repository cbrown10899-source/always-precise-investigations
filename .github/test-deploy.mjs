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

fs.rmSync(tmp, { recursive: true, force: true });
console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
