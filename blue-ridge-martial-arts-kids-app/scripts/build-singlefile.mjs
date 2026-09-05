/**
 * Builds a single self-contained HTML file from the production bundle.
 *
 * Used to publish the app somewhere that serves exactly one file — the CSS and
 * the JS are inlined, and the manifest/favicon links are dropped because there
 * is no sibling directory for them to resolve against. The app itself is
 * unchanged; this only changes how it is delivered.
 *
 * Run: npm run build:single -- <output.html>
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DIST = join(process.cwd(), 'dist')
const out = process.argv[2] ?? join(DIST, 'single.html')

const assets = readdirSync(join(DIST, 'assets'))
const jsName = assets.find((f) => f.endsWith('.js'))
const cssName = assets.find((f) => f.endsWith('.css'))
if (!jsName || !cssName) throw new Error('build first: dist/assets is missing a .js or .css')

const css = readFileSync(join(DIST, 'assets', cssName), 'utf8')
let js = readFileSync(join(DIST, 'assets', jsName), 'utf8')

// A literal </script> anywhere in the bundle would close the tag early. The
// escape is invisible to the JS parser and is the standard fix.
js = js.replace(/<\/script>/gi, '<\\/script>')

const html = `<title>Blue Ridge Kids Dojo</title>
<meta name="theme-color" content="#10233f" />
<style>
${css}
</style>
<div id="root"></div>
<script type="module">
${js}
</script>
`

writeFileSync(out, html)
console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KB)`)
