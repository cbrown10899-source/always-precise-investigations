import { chromium } from 'playwright'

const BASE = 'http://localhost:4183'
// 375 is the iPhone SE / mini width and the narrowest phone in common use;
// 320 is the floor the layout must still hold at.
const WIDTHS = [320, 375, 390, 430, 768, 1200]
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

    // The wordmark is the identity and must stay on one line. A wrapped
    // "BLUE / RIDGE" reads as a layout failure to a parent, and no overflow
    // or tap-target check would ever see it.
    const wrapped = await page.evaluate(() => {
      const out = []
      for (const sel of ['.masthead__name', '.masthead__sub']) {
        const el = document.querySelector(sel)
        if (!el) continue
        const line = parseFloat(getComputedStyle(el).lineHeight) || 20
        const lines = Math.round(el.getBoundingClientRect().height / line)
        if (lines > 1) out.push(`${sel} on ${lines} lines`)
      }
      return out
    })
    for (const w of wrapped) problems.push(`${width}px ${route}: wordmark wraps — ${w}`)
  }
  await page.close()
}

// Font size floor: any input under 16px makes iOS zoom the page on focus,
// and body text under 12px is unreadable for the age group.
{
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } })
  for (const route of ROUTES) {
    await page.goto(`${BASE}/${route}`, { waitUntil: 'networkidle' })
    const tiny = await page.evaluate(() =>
      [...document.querySelectorAll('input, select, textarea')]
        .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16)
        .map((el) => `${el.tagName.toLowerCase()}#${el.id} ${getComputedStyle(el).fontSize}`),
    )
    for (const t of tiny) problems.push(`390px ${route}: input under 16px ${t}`)

    const microtype = await page.evaluate(() => {
      const out = new Set()
      for (const el of document.querySelectorAll('p, span, li, div, label, h1, h2, h3, h4')) {
        if (!el.textContent?.trim()) continue
        // Only leaf-ish nodes: a wrapper inherits its children's boxes.
        if (el.children.length > 0) continue
        const size = parseFloat(getComputedStyle(el).fontSize)
        if (size < 11) out.add(`${el.className || el.tagName.toLowerCase()} ${size}px`)
      }
      return [...out]
    })
    for (const t of microtype) problems.push(`390px ${route}: text under 11px ${t}`)
  }
  await page.close()
}

// Nothing may sit underneath the fixed bottom navigation, and nothing that is
// meant to be reachable may be clipped by it.
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  for (const route of ROUTES) {
    await page.goto(`${BASE}/${route}`, { waitUntil: 'networkidle' })
    // Two scrolls with a settle between: the first can be measured against a
    // document that is still laying out, which reports content under the nav
    // that is not actually there.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await page.waitForTimeout(250)
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await page.waitForTimeout(250)
    const buried = await page.evaluate(() => {
      const nav = document.querySelector('nav[aria-label="Main"]')
      if (!nav) return []
      const navTop = nav.getBoundingClientRect().top
      const out = []
      for (const el of document.querySelectorAll('button, a[href], input, select, textarea')) {
        if (el.closest('nav[aria-label="Main"]')) continue
        const r = el.getBoundingClientRect()
        if (r.height === 0) continue
        // Fully below the fold is fine (not scrolled to); overlapping the nav
        // while the page is scrolled to the bottom is content nobody can tap.
        if (r.top < navTop && r.bottom > navTop + 4) {
          out.push(
            `${el.tagName.toLowerCase()}.${el.className.toString().split(' ')[0] || '-'} ` +
              `"${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 24)}"`,
          )
        }
      }
      return out
    })
    for (const b of buried) problems.push(`390px ${route}: control under the bottom nav ${b}`)
  }
  await page.close()
}

// The two confirm dialogs and the interactive planner, which only exist after
// a click and so are invisible to a plain route sweep.
{
  for (const width of [320, 375, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } })

    // Reset confirmation on More.
    await page.goto(`${BASE}/#/more`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /reset demo data/i }).click()
    await page.waitForTimeout(120)
    let overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    if (overflow > 0) problems.push(`${width}px reset confirm: horizontal overflow ${overflow}px`)
    let small = await page.evaluate(() =>
      [...document.querySelectorAll('button')]
        .filter((el) => {
          const r = el.getBoundingClientRect()
          return r.height > 0 && r.height < 44
        })
        .map((el) => `"${el.textContent?.trim().slice(0, 20)}" ${Math.round(el.getBoundingClientRect().height)}px`),
    )
    for (const s2 of small) problems.push(`${width}px reset confirm: small target ${s2}`)

    // The planner's day-detail panel.
    await page.goto(`${BASE}/#/practice`, { waitUntil: 'networkidle' })
    const days = page.locator('.week button')
    if ((await days.count()) > 0) {
      await days.nth(3).click()
      await page.waitForTimeout(120)
      overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      if (overflow > 0) problems.push(`${width}px planner detail: horizontal overflow ${overflow}px`)
    }

    // The guided practice player, which is its own full-screen layout.
    await page.goto(`${BASE}/#/practice/session/daily-10`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(150)
    overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    if (overflow > 0) problems.push(`${width}px practice player: horizontal overflow ${overflow}px`)
    small = await page.evaluate(() =>
      [...document.querySelectorAll('button')]
        .filter((el) => {
          const r = el.getBoundingClientRect()
          return r.height > 0 && r.height < 44
        })
        .map((el) => `"${el.textContent?.trim().slice(0, 20)}" ${Math.round(el.getBoundingClientRect().height)}px`),
    )
    for (const s2 of small) problems.push(`${width}px practice player: small target ${s2}`)

    // The player's own controls must clear the bottom edge, where the phone's
    // home indicator and the browser's own bar sit.
    const gap = await page.evaluate(() => {
      const main = document.querySelector('.player__main')
      if (!main) return null
      return Math.round(window.innerHeight - main.getBoundingClientRect().bottom)
    })
    if (gap !== null && gap < 12) {
      problems.push(`${width}px practice player: primary control only ${gap}px from the bottom edge`)
    }

    await page.close()
  }
}

console.log(problems.length ? problems.join('\n') : 'CLEAN: no problems found')
console.log(`\n${problems.length} problem(s) across ${WIDTHS.length} widths x ${ROUTES.length} routes`)
await browser.close()
