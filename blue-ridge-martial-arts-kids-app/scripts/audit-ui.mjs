import { chromium } from 'playwright'

const BASE = 'http://localhost:4183'
const WIDTHS = [320, 390, 430, 768, 1200]
const ROUTES = [
  '#/', '#/lessons', '#/lessons/straight-punch', '#/practice', '#/progress',
  '#/more', '#/profile', '#/parent', '#/instructor', '#/schedule', '#/dojo',
  '#/safety', '#/settings', '#/nope',
]

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
let problems = []

for (const width of WIDTHS) {
  const page = await browser.newPage({ viewport: { width, height: 900 } })
  page.on('pageerror', (e) => problems.push(`${width}px PAGEERROR: ${e.message}`))

  for (const route of ROUTES) {
    await page.goto(`${BASE}/${route}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(150)

    // Horizontal overflow: the page body must never scroll sideways.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    if (overflow > 0) problems.push(`${width}px ${route}: horizontal overflow ${overflow}px`)

    // Tap targets: every interactive control must clear 44px in both axes.
    const small = await page.evaluate(() => {
      const out = []
      const nodes = document.querySelectorAll('button, a[href], input, select, textarea, [role="tab"]')
      for (const el of nodes) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 && r.height === 0) continue // hidden
        const style = getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden') continue
        if (el.classList.contains('skip-link')) continue // off-screen until focused
        if (r.height < 44 || r.width < 24) {
          out.push(
            `${el.tagName.toLowerCase()}.${el.className.toString().split(' ')[0] || '-'} ` +
              `"${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 28)}" ` +
              `${Math.round(r.width)}x${Math.round(r.height)}`,
          )
        }
      }
      return out
    })
    for (const s of small) problems.push(`${width}px ${route}: small target ${s}`)

    // Every control must have an accessible name.
    const unnamed = await page.evaluate(() => {
      const out = []
      for (const el of document.querySelectorAll('button, a[href], input, select, textarea')) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 && r.height === 0) continue
        const name =
          el.getAttribute('aria-label') ||
          el.getAttribute('aria-labelledby') ||
          (el.id && document.querySelector(`label[for="${el.id}"]`)?.textContent) ||
          el.textContent?.trim() ||
          el.closest('label')?.textContent?.trim()
        if (!name) out.push(`${el.tagName.toLowerCase()}.${el.className.toString().split(' ')[0] || '-'}`)
      }
      return out
    })
    for (const u of unnamed) problems.push(`${width}px ${route}: unnamed control ${u}`)
  }
  await page.close()
}

// Font size floor: any input under 16px makes iOS zoom the page on focus.
const page = await browser.newPage({ viewport: { width: 390, height: 900 } })
for (const route of ['#/instructor', '#/profile', '#/parent', '#/settings']) {
  await page.goto(`${BASE}/${route}`, { waitUntil: 'networkidle' })
  const tiny = await page.evaluate(() =>
    [...document.querySelectorAll('input, select, textarea')]
      .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16)
      .map((el) => `${el.tagName.toLowerCase()}#${el.id} ${getComputedStyle(el).fontSize}`),
  )
  for (const t of tiny) problems.push(`390px ${route}: input under 16px ${t}`)
}
await page.close()

console.log(problems.length ? problems.join('\n') : 'CLEAN: no problems found')
console.log(`\n${problems.length} problem(s) across ${WIDTHS.length} widths x ${ROUTES.length} routes`)
await browser.close()
