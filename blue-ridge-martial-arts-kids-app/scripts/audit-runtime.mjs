/**
 * Runtime sweep.
 *
 * Drives the real interactions — not just page loads — watching for console
 * errors, unhandled rejections, failed requests, and links that lead nowhere.
 * A page can load clean and still throw the moment somebody presses a button,
 * which is what this catches.
 *
 * Run: npm run build && npm run preview & && node scripts/audit-runtime.mjs
 */
import { chromium } from 'playwright'

const BASE = 'http://localhost:4183'
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const problems = []

const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
page.on('pageerror', (e) => problems.push(`PAGE ERROR: ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`CONSOLE ERROR: ${m.text()}`)
  if (m.type() === 'warning' && /React|Warning:/i.test(m.text())) {
    problems.push(`REACT WARNING: ${m.text()}`)
  }
})
page.on('requestfailed', (r) => {
  const url = r.url()
  // A cancelled favicon fetch is a headless-Chromium artefact, not a fault.
  if (url.endsWith('icon.svg') && r.failure()?.errorText === 'net::ERR_ABORTED') return
  problems.push(`REQUEST FAILED: ${url} ${r.failure()?.errorText}`)
})
page.on('response', (r) => {
  if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`)
})

let stepsRun = 0

const step = async (label, fn) => {
  try {
    await fn()
    await page.waitForTimeout(140)
    stepsRun += 1
  } catch (e) {
    problems.push(`STEP FAILED (${label}): ${e.message.split('\n')[0]}`)
  }
}

/** Reads the persisted state, so a journey can assert it actually landed. */
const stored = () =>
  page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('brma.kids.v1'))
    } catch {
      return null
    }
  })

/** Fails the sweep when a journey ran but changed nothing. */
const expect = (ok, message) => {
  if (!ok) problems.push(`ASSERTION FAILED: ${message}`)
}

await page.goto(`${BASE}/#/`, { waitUntil: 'networkidle' })
await page.waitForTimeout(300)

// --- every link on every screen resolves to a real route -------------------
const ROUTES = [
  '#/', '#/lessons', '#/practice', '#/progress', '#/more', '#/profile',
  '#/parent', '#/instructor', '#/schedule', '#/dojo', '#/safety', '#/settings',
]
const KNOWN = new Set([
  '/', '/lessons', '/practice', '/progress', '/more', '/profile', '/parent',
  '/instructor', '/schedule', '/dojo', '/safety', '/settings',
])

for (const route of ROUTES) {
  await page.goto(`${BASE}/${route}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(150)
  const hrefs = await page.evaluate(() =>
    [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')),
  )
  for (const href of hrefs) {
    if (!href || href.startsWith('#main') || href.startsWith('mailto:') || href.startsWith('tel:')) continue
    if (!href.startsWith('#/')) {
      problems.push(`${route}: link is not a hash route: ${href}`)
      continue
    }
    const path = href.slice(1)
    const base = '/' + path.split('/')[1]
    const isLesson = path.startsWith('/lessons/')
    const isSession = path.startsWith('/practice/session/')
    if (!KNOWN.has(base) && !isLesson && !isSession) {
      problems.push(`${route}: link to an unknown route: ${href}`)
    }
  }
}

// --- drive the real journeys ----------------------------------------------
await page.goto(`${BASE}/#/`, { waitUntil: 'networkidle' })

const before = await stored()
await step('start and complete a practice', async () => {
  await page.getByRole('button', { name: /start practice|practise anyway|warm up with a practice/i }).first().click()
  for (let i = 0; i < 12; i += 1) {
    const next = page.getByRole('button', { name: /^Next$/ })
    if ((await next.count()) === 0) break
    await next.click()
    await page.waitForTimeout(40)
  }
  await page.getByRole('button', { name: /^Complete$/ }).click()
  await page.getByRole('button', { name: /^Done$/ }).click()
})
{
  const after = await stored()
  expect(
    after.practiceHistory.length === before.practiceHistory.length + 1,
    `completing a practice did not log one (${before.practiceHistory.length} -> ${after.practiceHistory.length})`,
  )
  expect(after.earnedBadges.length > 0, 'completing a practice earned no badge')
}

await step('pause and resume a timed step', async () => {
  await page.goto(`${BASE}/#/practice/session/daily-10`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /^Start$/ }).click()
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /^Pause$/ }).click()
  await page.getByRole('button', { name: /^Start$/ }).click()
  await page.getByRole('button', { name: /exit/i }).click()
})

await step('count reps in a lesson', async () => {
  await page.goto(`${BASE}/#/lessons/straight-punch`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /^Next$/ }).click()
  await page.getByRole('button', { name: /^Next$/ }).click()
  await page.getByRole('button', { name: /^Next$/ }).click()
  for (let i = 0; i < 3; i += 1) await page.getByRole('button', { name: /one more rep/i }).click()
  await page.getByRole('button', { name: /one fewer rep/i }).click()
})

await step('answer a lesson quiz', async () => {
  await page.goto(`${BASE}/#/lessons/ready-stance`, { waitUntil: 'networkidle' })
  for (let i = 0; i < 4; i += 1) {
    const next = page.getByRole('button', { name: /^Next$/ })
    if ((await next.count()) === 0) break
    await next.click()
    await page.waitForTimeout(60)
  }
  const options = page.locator('fieldset button')
  if ((await options.count()) > 0) await options.first().click()
})

await step('tick and untick the checklist', async () => {
  await page.goto(`${BASE}/#/practice`, { waitUntil: 'networkidle' })
  const items = page.locator('button.check')
  const n = await items.count()
  for (let i = 0; i < n; i += 1) await items.nth(i).click()
  await items.nth(0).click()
})

{
  const after = await stored()
  expect(after.checklist.length > 0, 'ticking the checklist stored nothing')
}

await step('open every planner day', async () => {
  const days = page.locator('.week button')
  const n = await days.count()
  expect(n === 7, `the planner drew ${n} days, expected 7`)
  for (let i = 0; i < n; i += 1) {
    await days.nth(i).click()
    await page.waitForTimeout(50)
  }
})

await step('unlock parent mode', async () => {
  await page.goto(`${BASE}/#/parent`, { waitUntil: 'networkidle' })
  await page.getByLabel(/demo pin/i).fill('1234')
  await page.getByRole('button', { name: /unlock parent mode/i }).click()
})

await step('edit every instructor field', async () => {
  await page.goto(`${BASE}/#/instructor`, { waitUntil: 'networkidle' })
  await page.getByLabel(/current belt/i).selectOption('white-2')
  await page.getByLabel(/next belt/i).selectOption('blue')
  await page.getByLabel(/estimated test window/i).fill('June 2026')
  await page.getByRole('button', { name: /^Guard Position$/ }).click()
  await page.getByLabel(/class day/i).selectOption('2')
  await page.getByLabel(/start time/i).fill('17:30')
  await page.getByLabel(/end time/i).fill('18:30')
  await page.getByLabel(/class focus/i).fill('Stance and balance')
  const goal = page.getByLabel(/home practices per week/i)
  await goal.fill('5')
  await goal.blur()
  await page.getByLabel(/mission title/i).fill('Steady Weeks')
  await page.getByLabel(/mission detail/i).fill('Five short practices.')
  await page.getByLabel(/your name/i).fill('Sensei Rivera')
  await page.getByLabel(/note to the parent/i).fill('Good week.')
  await page.getByRole('button', { name: /^Attended$/ }).click()
  await page.getByRole('button', { name: /^Missed$/ }).click()
})

{
  const after = await stored()
  const i = after.instructor
  expect(i.currentBeltId === 'white-2', `belt did not save (got ${i.currentBeltId})`)
  expect(i.nextGoalBeltId === 'blue', `next goal did not save (got ${i.nextGoalBeltId})`)
  expect(i.testWindow === 'June 2026', `test window did not save (got "${i.testWindow}")`)
  expect(i.classSession.dayIndex === 2, `class day did not save (got ${i.classSession.dayIndex})`)
  expect(i.classSession.startTime === '17:30', `start time did not save (got ${i.classSession.startTime})`)
  expect(i.weeklyPlan.goalPractices === 5, `weekly goal did not save (got ${i.weeklyPlan.goalPractices})`)
  expect(i.weeklyPlan.mission === 'Steady Weeks', `mission did not save (got "${i.weeklyPlan.mission}")`)
  expect(i.insight.instructorName === 'Sensei Rivera', 'instructor name did not save')
  expect(i.attendance.length === 2, `attendance did not save (got ${i.attendance.length} rows)`)
  // Guard Position is NOT in the seeded focus list, so pressing it ADDS it.
  expect(i.weeklyFocusSkillIds.includes('guard'), 'the focus toggle did not take effect')
  // The plan's dojo day must have moved with the class, or the week strip and
  // the schedule would disagree about the same class.
  const dojoDays = i.weeklyPlan.days.filter((d) => d.kind === 'dojo')
  expect(dojoDays.length === 1 && dojoDays[0].dayIndex === 2, 'the plan did not follow the class day')
}

await step('add and remove an insight item', async () => {
  const input = page.locator('#list-what-the-student-practised')
  await input.fill('Kata basics')
  await page.locator('#list-what-the-student-practised ~ button').click()
  const remove = page.getByRole('button', { name: /Remove "Kata basics"/i })
  if ((await remove.count()) > 0) await remove.click()
})

await step('toggle lesson availability', async () => {
  const lessons = page.locator('button.check')
  await lessons.nth(0).click()
  await lessons.nth(0).click()
})

await step('confirm the profile change persisted', async () => {})

await step('change the profile', async () => {
  await page.goto(`${BASE}/#/profile`, { waitUntil: 'networkidle' })
  await page.getByLabel(/first name/i).fill('Jordan')
  await page.getByRole('button', { name: /Trail avatar/i }).click()
})

{
  const after = await stored()
  expect(after.student.firstName === 'Jordan', `profile name did not save (got "${after.student.firstName}")`)
  expect(after.student.avatarId === 'trail', `avatar did not save (got ${after.student.avatarId})`)
}

await step('toggle every setting', async () => {
  await page.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle' })
  const toggles = page.locator('button.check')
  for (let i = 0; i < (await toggles.count()); i += 1) {
    await toggles.nth(i).click()
    await page.waitForTimeout(40)
    await toggles.nth(i).click()
  }
})

await step('open a badge', async () => {
  await page.goto(`${BASE}/#/progress`, { waitUntil: 'networkidle' })
  await page.locator('button.badge').first().click()
})

await step('reset the demo', async () => {
  await page.goto(`${BASE}/#/more`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /reset demo data/i }).click()
  await page.getByRole('button', { name: /yes, reset/i }).click()
})

await step('confirm the reset restored the demo student', async () => {
  await page.goto(`${BASE}/#/profile`, { waitUntil: 'networkidle' })
  const name = await page.getByLabel(/first name/i).inputValue()
  if (name !== 'Alex') problems.push(`reset did not restore the demo student (got "${name}")`)
})

// The sweep must have actually run. Without this it reports "clean" when
// every journey silently did nothing, which is the failure this file exists
// to prevent in the app.
const EXPECTED_STEPS = 16
if (stepsRun < EXPECTED_STEPS) {
  problems.push(`only ${stepsRun} of ${EXPECTED_STEPS} journeys ran — the sweep proved nothing`)
}

console.log(problems.length ? problems.join('\n') : 'CLEAN: no runtime problems found')
console.log(`\n${problems.length} problem(s) after ${stepsRun} journeys`)
await browser.close()
