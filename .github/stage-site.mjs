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
 * nothing saying so. The guard was right; the list was wrong.
 *
 * WHY FILE PATTERNS AND NOT DIRECTORIES. The first version of this allow-list
 * named directories and copied them whole. That is default-deny at the top
 * level and default-ALLOW inside anything listed — `portal/` was allowed, so
 * `portal/anything.txt` would have shipped. The same hole, one level down, and
 * the comment above it claimed otherwise. Patterns match FILES.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.join(import.meta.dirname, '..'));
const MANIFEST = path.join(ROOT, '.github', 'deploy-manifest.txt');

/* Never walked at all: huge, or never site content under any pattern. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '_site']);

/* Belt and braces. If any of these ever reaches the artifact, something has
 * gone wrong in a way the patterns did not anticipate, and shipping is worse
 * than failing. CLAUDE.md was served publicly until 2026-08-12; it describes
 * where every boundary is enforced, which is a map for anyone probing them. */
const NEVER_PRESENT = [
  { test: p => p.split('/').includes('.claude'), why: 'Claude agent/tooling config' },
  { test: p => p.split('/').includes('.github'), why: 'workflow and deploy config' },
  { test: p => p.split('/').includes('case-portal'), why: 'Worker source, pricing and handoff notes' },
  { test: p => p.split('/').includes('visitor-alerts'), why: 'Worker source' },
  { test: p => p.toLowerCase().endsWith('.md'), why: 'internal documentation' },
  { test: p => p.endsWith('.mjs'), why: 'test suite' },
  { test: p => p.endsWith('.py'), why: 'the page generator' },
  { test: p => p.endsWith('.sql'), why: 'database schema' },
];

/* The site is broken in a quieter way if these vanish, so their ABSENCE fails
 * the build too. A renamed directory would otherwise publish a site with a
 * hole in it and pass every other check. */
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

/* `*` within a segment, `**` across zero or more whole segments. Written out
 * rather than pulled in, because a deploy boundary should not depend on a
 * package resolving the way you assumed. */
function globToRegExp(glob) {
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = glob.split('/');
  let re = '^';
  parts.forEach((seg, i) => {
    const last = i === parts.length - 1;
    if (seg === '**') {
      /* Zero or more WHOLE segments, each carrying its own trailing slash, so
         a doubled star between two segments matches both "a/b.html" and
         "a/c/b.html". The slash belongs to the group rather than being emitted
         separately: written outside, matching zero segments also ate the
         separator, and then nothing matched at all. */
      re += last ? '.*' : '(?:[^/]+/)*';
      return;
    }
    re += seg.split('*').map(esc).join('[^/]*');
    if (!last) re += '/';
  });
  return new RegExp(`${re}$`);
}

function allFiles(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!base && SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const rel = base ? `${base}/${entry}` : entry;
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.isDirectory()) out.push(...allFiles(full, rel));
    else out.push(rel);
  }
  return out;
}

/* The first thing stage() does is delete its target, recursively. That is
   correct for a build directory and catastrophic for anything else, and the
   difference is one mistyped argument: `node .github/stage-site.mjs .` would
   erase the repository. The cost of being wrong here is unbounded and the
   check is three comparisons, so it is not left to care. */
const BUILD_DIR = '_site';   // the only directory inside the repo this may delete

function assertSafeTarget(dest) {
  // At or above the repository: the catastrophic cases.
  if (dest === ROOT || ROOT.startsWith(dest + path.sep)) {
    throw new Error(`refusing to stage into "${dest}": it is the repository, or contains it`);
  }

  /* INSIDE the repository is the dangerous middle ground, and the first
     version of this guard missed it entirely: it refused the repo root and
     anything above, so `stage('portal')` sailed through and would have deleted
     the portal page, and `stage('case-portal')` the Worker source. Blocking
     the root while leaving every directory under it open is not a guard.

     Only the build directory may be rebuilt. Everything else inside the repo
     is either source or generated output that belongs to git, and nothing here
     has any business deleting it. Tests stage into a temp directory, which is
     outside the repository and therefore unaffected by this rule. */
  const rel = path.relative(ROOT, dest);
  const insideRepo = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  if (insideRepo && rel.split(path.sep)[0] !== BUILD_DIR) {
    throw new Error(`refusing to stage into "${rel}": inside the repository, `
                  + `only ${BUILD_DIR}/ may be rebuilt`);
  }

  if (fs.existsSync(path.join(dest, '.git'))) {
    throw new Error(`refusing to stage into "${dest}": it looks like a git working tree`);
  }
  if (fs.existsSync(dest) && !fs.statSync(dest).isDirectory()) {
    throw new Error(`refusing to stage into "${dest}": it is a file`);
  }
}

export function stage(target) {
  const dest = path.resolve(target);
  assertSafeTarget(dest);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  const problems = [];
  const patterns = readManifest().map(p => ({ glob: p, re: globToRegExp(p), hits: 0 }));
  const repo = allFiles(ROOT);

  const files = [];
  const skipped = [];
  for (const rel of repo) {
    const hit = patterns.find(p => p.re.test(rel));
    if (!hit) { skipped.push(rel); continue; }
    hit.hits++;
    fs.mkdirSync(path.join(dest, path.dirname(rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(dest, rel));
    files.push(rel);
  }

  /* A pattern matching nothing means a page was renamed or deleted and the
     site is about to lose it quietly. */
  for (const p of patterns) {
    if (!p.hits) problems.push(`the pattern "${p.glob}" matches no file in the repository`);
  }
  for (const f of files) {
    for (const rule of NEVER_PRESENT) {
      if (rule.test(f)) problems.push(`${f} must never be deployed (${rule.why})`);
    }
  }
  for (const need of MUST_EXIST) {
    if (!files.includes(need)) problems.push(`the site is missing ${need}`);
  }
  return { files: files.sort(), skipped, problems };
}

/* Run directly (the workflow) rather than imported (the test). */
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const target = process.argv[2] || '_site';
  const { files, skipped, problems } = stage(target);
  for (const p of problems) console.error(`::error::${p}`);
  if (problems.length) {
    console.error(`\nRefusing to deploy: ${problems.length} problem(s) with the artifact.`);
    process.exit(1);
  }
  console.log(`Staged ${files.length} files into ${target}/ from the deploy allow-list.`);
  console.log(`Not published (${skipped.length} repository files matched no pattern).`);
}
