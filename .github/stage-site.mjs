/* Build the public deployment artifact, from an explicit allow-list.
 *
 *   node .github/stage-site.mjs _site
 *
 * `deploy.yml` runs this, and `.github/test-deploy.mjs` runs the SAME script
 * into a temporary directory and inspects what came out. One implementation,
 * so the test cannot pass while the deploy does something else.
 *
 * WHY AN ALLOW-LIST. The staging step used to be a list of rsync --exclude
 * flags, which means every new file and directory in the repository was public
 * BY DEFAULT, with a guard as the only thing between it and the internet. On
 * 2026-08-14 .claude/agents/*.md arrived, the markdown guard fired, and the
 * PUBLIC SITE STOPPED DEPLOYING for four merges — while deploy-portal.yml kept
 * shipping the Worker, so the two halves of the system drifted apart with
 * nothing saying so. The guard was right; the list was wrong. Adding one more
 * --exclude fixes that instance and leaves the next one waiting.
 *
 * With an allow-list, a new agent definition, handoff note or tooling
 * directory is simply not site content. It cannot reach the artifact, and it
 * cannot break the deploy either.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.join(import.meta.dirname, '..'));
const MANIFEST = path.join(ROOT, '.github', 'deploy-manifest.txt');

/* File types that are never site content, even inside a directory that IS.
 * The suites live beside the pages they exercise (intake/test-intake.mjs,
 * portal/test-portal.mjs), and a public copy of the test harness is a map of
 * exactly what the defences check. This is a second, narrower boundary INSIDE
 * an allowed path — not a substitute for the allow-list. */
const NEVER_SHIP = new Set(['.mjs', '.md', '.py', '.sh', '.sql']);

/* Belt and braces. If any of these ever appears in the artifact, something has
 * gone wrong in a way the allow-list did not anticipate, and shipping is worse
 * than failing. CLAUDE.md was served publicly until 2026-08-12; it describes
 * where every boundary is enforced, which is a map for anyone probing them. */
const NEVER_PRESENT = [
  { test: p => p.split('/').includes('.claude'), why: 'Claude agent/tooling config' },
  { test: p => p.split('/').includes('.github'), why: 'workflow and deploy config' },
  { test: p => p.split('/').includes('case-portal'), why: 'Worker source, pricing and handoff notes' },
  { test: p => p.split('/').includes('visitor-alerts'), why: 'Worker source' },
  { test: p => p.endsWith('.md'), why: 'internal documentation' },
  { test: p => p.endsWith('.mjs'), why: 'test suite' },
  { test: p => /(^|\/)(CLAUDE|README|PRICING|NEXT|RECONCILIATION|MASTER-HANDOFF|PAYMENTS|WORK-ORDER)\.md$/i.test(p),
    why: 'internal handoff document' },
];

/* The site is broken in a quieter way if these vanish, so their ABSENCE is a
 * build failure too. A renamed directory would otherwise publish a site with a
 * hole in it and pass every guard. */
const MUST_EXIST = [
  'index.html', '_headers', '_redirects', 'robots.txt',
  'portal/index.html', 'intake/index.html',
];

function readManifest() {
  return fs.readFileSync(MANIFEST, 'utf8')
    .split(/\r?\n/)
    .map(l => l.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

function copyInto(src, destDir, rel) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(path.join(destDir, rel), { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyInto(path.join(src, entry), destDir, path.posix.join(rel, entry));
    }
    return;
  }
  if (NEVER_SHIP.has(path.extname(src).toLowerCase())) return;   // pruned, by type
  fs.mkdirSync(path.join(destDir, path.dirname(rel)), { recursive: true });
  fs.copyFileSync(src, path.join(destDir, rel));
}

function walk(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel = base ? path.posix.join(base, entry) : entry;
    if (fs.statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push(rel);
  }
  return out;
}

export function stage(target) {
  const dest = path.resolve(target);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  const problems = [];
  for (const item of readManifest()) {
    const src = path.join(ROOT, item);
    if (!fs.existsSync(src)) {
      // A listed path that has gone is a real failure: it means a page was
      // renamed or removed and the site would quietly lose it.
      problems.push(`manifest lists "${item}", which does not exist in the repository`);
      continue;
    }
    copyInto(src, dest, item);
  }

  const files = walk(dest);
  for (const f of files) {
    for (const rule of NEVER_PRESENT) {
      if (rule.test(f)) problems.push(`${f} must never be deployed (${rule.why})`);
    }
  }
  for (const need of MUST_EXIST) {
    if (!files.includes(need)) problems.push(`the site is missing ${need}`);
  }
  return { files, problems };
}

/* Run directly (the workflow) rather than imported (the test). */
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const target = process.argv[2] || '_site';
  const { files, problems } = stage(target);
  for (const p of problems) console.error(`::error::${p}`);
  if (problems.length) {
    console.error(`\nRefusing to deploy: ${problems.length} problem(s) with the artifact.`);
    process.exit(1);
  }
  console.log(`Staged ${files.length} files into ${target}/ from the deploy allow-list.`);
}
