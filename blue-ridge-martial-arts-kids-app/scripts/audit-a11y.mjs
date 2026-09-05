/**
 * Keyboard and screen-reader audit.
 *
 * Complements `audit-ui.mjs`, which measures geometry. This one drives the
 * keyboard: it tabs through every screen and checks that every control is
 * reachable, that focus is visible when it lands, and that focus order follows
 * the reading order rather than the DOM's accidents.
 *
 * Run: npm run build && npm run preview & && node scripts/audit-a11y.mjs
 */
import { chromium } from 'playwright'

const BASE = 'http://localhost:4183'
const ROUTES = [
  '#/', '#/lessons', '#/lessons/straight-punch', '#/practice', '#/progress',
  '#/more', '#/profile', '#/parent', '#/instructor', '#/schedule', '#/dojo',
  '#/safety', '#/settings', '#/practice/session/daily-10',
]

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const problems = []

for (const route of ROUTES) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await page.goto(`${BASE}/${route}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(200)

  // Tag every focusable so the walk can tell two identical-looking buttons
  // apart. Keying on class+text made the second "Add" button on Instructor
  // Demo look like a wrap-around and cut the walk short at 16 of 47.
  await page.evaluate(() => {
    let n = 0
    for (const el of document.querySelectorAll('button, a[href], input, select, textarea')) {
      el.setAttribute('data-audit-id', String(n++))
    }
  })

  // How many controls the page actually has.
  const expected = await page.evaluate(
    () =>
      [...document.querySelectorAll('button, a[href], input, select, textarea')].filter((el) => {
        const r = el.getBoundingClientRect()
        const s = getComputedStyle(el)
        return r.height > 0 && s.visibility !== 'hidden' && !el.hasAttribute('disabled')
      }).length,
  )

  // Tab through and record what focus lands on.
  const seen = new Set()
  const order = []
  let firstKey = null
  await page.evaluate(() => document.body.focus())
  // A composite control consumes several Tab presses without changing element
  // — `<input type="time">` has hour, minute and AM/PM segments — so the walk
  // allows repeats and stops only on a true wrap back to the first control.
  for (let i = 0; i < expected * 3 + 12; i += 1) {
    await page.keyboard.press('Tab')
    const info = await page.evaluate(() => {
      const el = document.activeElement
      if (!el || el === document.body) return null
      const r = el.getBoundingClientRect()
      const s = getComputedStyle(el)
      // A focus ring is either our project box-shadow or a real outline.
      const hasRing =
        (s.boxShadow && s.boxShadow !== 'none') ||
        (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0)
      // An input's accessible name comes from its associated <label for>,
      // which has no textContent of its own — checking only aria-label and
      // textContent reported correctly-labelled fields as unnamed.
      const labelled =
        el.getAttribute('aria-label') ||
        (el.getAttribute('aria-labelledby') &&
          document.getElementById(el.getAttribute('aria-labelledby'))?.textContent) ||
        (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent) ||
        el.closest('label')?.textContent ||
        el.textContent ||
        ''
      return {
        key: el.getAttribute('data-audit-id') ?? 'untagged',
        top: Math.round(r.top + window.scrollY),
        left: Math.round(r.left),
        hasRing,
        offscreen: r.height === 0,
        name: labelled.trim().slice(0, 30),
      }
    })
    if (!info) break
    if (firstKey === null) firstKey = info.key
    else if (info.key === firstKey) break // wrapped around
    if (seen.has(info.key)) continue // a segment of a control already recorded
    seen.add(info.key)
    order.push(info)
    if (!info.hasRing && !info.offscreen) {
      problems.push(`${route}: no visible focus ring on "${info.name || info.key}"`)
    }
    if (!info.name) {
      problems.push(`${route}: focusable control with no accessible name (${info.key})`)
    }
  }

  // Every control should be reachable. The skip link is intentionally the
  // first stop and is off-screen until focused, so it is counted separately.
  if (order.length < expected) {
    problems.push(
      `${route}: tab reached ${order.length} controls but the page has ${expected}`,
    )
  }

  // Focus order should broadly follow the visual order down the page. A big
  // backwards jump means the DOM and the layout disagree.
  for (let i = 1; i < order.length; i += 1) {
    const back = order[i - 1].top - order[i].top
    if (back > 220) {
      problems.push(
        `${route}: focus jumps back up the page from "${order[i - 1].name}" to "${order[i].name}" (${back}px)`,
      )
    }
  }

  await page.close()
}

// The guided player must be operable and escapable by keyboard alone.
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await page.goto(`${BASE}/#/practice/session/daily-10`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(200)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  const left = await page.evaluate(() => location.hash)
  if (left.includes('session')) problems.push('practice player: Escape does not leave the player')
  await page.close()
}

// Reduced motion must be honoured.
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' })
  await page.goto(`${BASE}/#/`, { waitUntil: 'networkidle' })
  const animated = await page.evaluate(() =>
    [...document.querySelectorAll('*')].filter((el) => {
      const s = getComputedStyle(el)
      return parseFloat(s.transitionDuration) > 0.01 || parseFloat(s.animationDuration) > 0.01
    }).length,
  )
  if (animated > 0) problems.push(`reduced motion: ${animated} elements still animate`)
  await page.close()
}

console.log(problems.length ? problems.join('\n') : 'CLEAN: no keyboard or focus problems found')
console.log(`\n${problems.length} problem(s) across ${ROUTES.length} routes`)
await browser.close()
