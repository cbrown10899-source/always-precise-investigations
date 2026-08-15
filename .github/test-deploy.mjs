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
    'assets/original-pricing.pdf',
    '.well-known/notes.txt',
    'watch/passcode.txt',
  ];
  const made = [];
  for (const rel of strays) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) { fs.writeFileSync(p, 'internal\n'); made.push(p); }
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
  ok('the skipped set is real — most of the repo is NOT published',
     skipped.length > files.length, `${skipped.length} skipped vs ${files.length} published`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
