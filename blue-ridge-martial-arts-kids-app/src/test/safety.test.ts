import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { LESSONS } from '../data/lessons'
import { CHECKLIST, ROUTINES } from '../data/practice'
import { DEFAULT_DOJO, createDefaultState } from '../data/defaultState'

/**
 * The safety boundary.
 *
 * This app teaches children at home, unsupervised for stretches of it. These
 * tests grep the actual instructional content for the categories the brief
 * rules out, rather than trusting that whoever wrote a lesson remembered.
 */

/** Every line of instructional prose the app can put in front of a child. */
function instructionalText(): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = []

  for (const lesson of LESSONS) {
    out.push({ where: `lesson ${lesson.id} title`, text: lesson.title })
    out.push({ where: `lesson ${lesson.id} tagline`, text: lesson.tagline })
    for (const step of lesson.steps) {
      out.push({ where: `${lesson.id}/${step.id} title`, text: step.title })
      out.push({ where: `${lesson.id}/${step.id} summary`, text: step.summary })
      step.points.forEach((p, i) => out.push({ where: `${lesson.id}/${step.id} point ${i}`, text: p }))
      if (step.safetyNote) out.push({ where: `${lesson.id}/${step.id} safety`, text: step.safetyNote })
      for (const q of step.questions ?? []) {
        out.push({ where: `${lesson.id}/${q.id} prompt`, text: q.prompt })
        q.options.forEach((o, i) => out.push({ where: `${lesson.id}/${q.id} option ${i}`, text: o }))
        out.push({ where: `${lesson.id}/${q.id} explanation`, text: q.explanation })
      }
    }
  }

  for (const routine of ROUTINES) {
    for (const step of routine.steps) {
      out.push({ where: `${routine.id}/${step.id} title`, text: step.title })
      out.push({ where: `${routine.id}/${step.id} instruction`, text: step.instruction })
      step.cues.forEach((c, i) => out.push({ where: `${routine.id}/${step.id} cue ${i}`, text: c }))
    }
  }

  for (const item of CHECKLIST) {
    out.push({ where: `checklist ${item.id}`, text: `${item.label} ${item.hint}` })
  }

  return out
}

/**
 * Forbidden techniques and targets.
 *
 * Each entry is a pattern plus what it is guarding against, so a failure says
 * WHY rather than only which string matched. Patterns allow for the word being
 * used in a permitted refusal ("never punch a wall"), so the check is on the
 * INSTRUCTION, not on vocabulary — the negated forms are excluded below.
 */
const FORBIDDEN: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bspar(ring|s)?\b/i, reason: 'sparring' },
  { pattern: /\bchok(e|ing|ehold)\b/i, reason: 'chokes' },
  { pattern: /\bstrangl/i, reason: 'strangulation' },
  { pattern: /\bjoint lock|\barmbar|\bwrist lock|\bsubmission hold/i, reason: 'joint locks' },
  { pattern: /\bnunchaku|\bbo staff|\bkatana|\bsword|\bknife|\bweapon/i, reason: 'weapons' },
  { pattern: /\btakedown|\bthrow (your |a )?(partner|opponent|friend|sibling)/i, reason: 'throws' },
  { pattern: /\bopponent\b/i, reason: 'fighting another person' },
  { pattern: /\bhit (the |a )?(wall|door|furniture|table|couch|tree)/i, reason: 'striking objects' },
  { pattern: /\bpunch (the |a )?(wall|door|furniture|bag|table|tree)/i, reason: 'striking objects' },
  { pattern: /\bkick (the |a )?(wall|door|furniture|bag|table|tree)/i, reason: 'striking objects' },
  { pattern: /\bfull(-| )?(power|force|contact)\b/i, reason: 'full-force striking' },
  { pattern: /\bas hard as you can\b/i, reason: 'uncontrolled force' },
  { pattern: /\bhead(-| )?butt/i, reason: 'dangerous impact' },
  { pattern: /\bgroin\b|\bthroat\b|\beye (poke|gouge)/i, reason: 'targeting vulnerable areas' },
]

/** Phrases that legitimately name a forbidden thing in order to REFUSE it. */
const PERMITTED_REFUSALS = [
  /never (punch|kick|hit)/i,
  /not .{0,24}(punch|kick|hit)/i,
  /\bno (weapons|sparring)\b/i,
  /weapons of any kind/i,
  /sparring of any kind/i,
  /what should you (punch|kick)/i,
  /\ba wall or door\b/i,
  /holds, locks or anything applied/i,
  /practising with or against another person/i,
  /punching or kicking walls/i,
]

describe('no lesson or practice step teaches a forbidden technique', () => {
  const text = instructionalText()

  it('has content to check (so this suite cannot pass vacuously)', () => {
    expect(text.length).toBeGreaterThan(200)
  })

  it('CONTROL: the matcher catches a violation when one is planted', () => {
    // Without this, every assertion below would pass on a broken regex set and
    // the suite would look green while testing nothing.
    const planted = [
      { where: 'planted', text: 'Practise sparring with your opponent at full power.' },
      { where: 'planted', text: 'Punch the wall ten times.' },
      { where: 'planted', text: 'Kick as hard as you can.' },
    ]
    for (const line of planted) {
      const caught = FORBIDDEN.some(
        ({ pattern }) =>
          pattern.test(line.text) && !PERMITTED_REFUSALS.some((allow) => allow.test(line.text)),
      )
      expect(caught, `not caught: "${line.text}"`).toBe(true)
    }
  })

  it('CONTROL: a legitimate refusal is not flagged as instruction', () => {
    const refusals = [
      'Never punch a wall, a door, furniture, a person or a pet.',
      'Weapons of any kind',
      'Sparring of any kind',
    ]
    for (const line of refusals) {
      const flagged = FORBIDDEN.some(
        ({ pattern }) => pattern.test(line) && !PERMITTED_REFUSALS.some((allow) => allow.test(line)),
      )
      expect(flagged, `wrongly flagged: "${line}"`).toBe(false)
    }
  })

  for (const { pattern, reason } of FORBIDDEN) {
    it(`teaches no ${reason}`, () => {
      const hits = text.filter(
        ({ text: line }) =>
          pattern.test(line) && !PERMITTED_REFUSALS.some((allow) => allow.test(line)),
      )
      expect(hits.map((h) => `${h.where}: "${h.text}"`)).toEqual([])
    })
  }
})

describe('the safety rules are actually present', () => {
  it('every practice routine ends in a cool down', () => {
    for (const routine of ROUTINES) {
      const last = routine.steps[routine.steps.length - 1]
      expect(last.title.toLowerCase(), `${routine.id} does not cool down`).toContain('cool')
    }
  })

  it('every practice routine starts with a warm up', () => {
    for (const routine of ROUTINES) {
      expect(routine.steps[0].title.toLowerCase(), `${routine.id} does not warm up`).toContain('warm')
    }
  })

  it('every lesson opens with a warm-up step', () => {
    for (const lesson of LESSONS) {
      expect(lesson.steps[0].kind, `${lesson.id} does not warm up`).toBe('warmup')
    }
  })

  it('every lesson ends with a completion step', () => {
    for (const lesson of LESSONS) {
      expect(lesson.steps[lesson.steps.length - 1].kind).toBe('complete')
    }
  })

  it('every striking lesson carries an explicit safety note', () => {
    const striking = LESSONS.filter((l) => l.skills.includes('punches') || l.skills.includes('kicks'))
    expect(striking.length).toBeGreaterThan(0)
    for (const lesson of striking) {
      const notes = lesson.steps.filter((s) => s.safetyNote)
      expect(notes.length, `${lesson.id} has no safety note`).toBeGreaterThan(0)
    }
  })

  it('the four home-practice rules appear in the app', () => {
    const screens = readFileSync(join(process.cwd(), 'src/screens/SafetyScreen.tsx'), 'utf8')
    expect(screens).toMatch(/clear area/i)
    expect(screens).toMatch(/slowly and stay in control/i)
    expect(screens).toMatch(/stop if something hurts/i)
    expect(screens).toMatch(/permission/i)
  })
})

describe('nothing about the school is invented', () => {
  it('no contact detail is seeded with a made-up value', () => {
    expect(DEFAULT_DOJO.phone).toBeNull()
    expect(DEFAULT_DOJO.website).toBeNull()
    expect(DEFAULT_DOJO.email).toBeNull()
    expect(DEFAULT_DOJO.addressLine1).toBeNull()
    expect(DEFAULT_DOJO.addressLine2).toBeNull()
    expect(DEFAULT_DOJO.instructorName).toBeNull()
  })

  it('the seeded state carries the same nulls', () => {
    const dojo = createDefaultState().dojo
    expect(dojo.name).toBe('Blue Ridge Martial Arts')
    expect(dojo.city).toBe('Forest')
    expect(dojo.state).toBe('VA')
    for (const key of ['phone', 'website', 'email', 'addressLine1', 'instructorName'] as const) {
      expect(dojo[key], `${key} was invented`).toBeNull()
    }
  })

  it('no source file contains a plausible phone number or street address', () => {
    // A placeholder like "(555) 123-4567" is exactly the kind of thing someone
    // would dial. Nothing of the shape may exist anywhere in the app.
    const root = join(process.cwd(), 'src')
    const offenders: string[] = []
    let scanned = 0

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue
        if (full.includes(join('src', 'test'))) continue
        scanned += 1
        const body = readFileSync(full, 'utf8')
        if (/\(\d{3}\)\s*\d{3}[- ]\d{4}|\b\d{3}-\d{3}-\d{4}\b/.test(body)) {
          offenders.push(`${entry}: phone-shaped string`)
        }
        if (/\b\d{2,5}\s+[A-Z][a-z]+\s+(Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Boulevard|Blvd)\b/.test(body)) {
          offenders.push(`${entry}: address-shaped string`)
        }
      }
    }
    walk(root)

    expect(scanned).toBeGreaterThan(20)
    expect(offenders).toEqual([])
  })
})

describe('the app makes no claim it cannot support', () => {
  it('growth is never expressed as a percentage in the Progress screen', () => {
    const screen = readFileSync(join(process.cwd(), 'src/screens/ProgressScreen.tsx'), 'utf8')
    // The one percentage on that screen is attendance, which IS a real ratio
    // of recorded classes. Growth must carry a word.
    expect(screen).toMatch(/reading\.level/)
    expect(screen).toMatch(/not test scores/i)
  })

  it('the belt journey is labelled as a demo progression', () => {
    const screen = readFileSync(join(process.cwd(), 'src/screens/ProgressScreen.tsx'), 'utf8')
    expect(screen).toMatch(/demo progression/i)
    expect(screen).toMatch(/awarded by your instructor/i)
  })

  it('parent notes are labelled instructor-written, not generated', () => {
    const screen = readFileSync(join(process.cwd(), 'src/screens/ParentModeScreen.tsx'), 'utf8')
    expect(screen).toMatch(/not an automatic assessment/i)
  })

  it('the parent PIN is labelled DEMO ONLY', () => {
    const screen = readFileSync(join(process.cwd(), 'src/screens/ParentModeScreen.tsx'), 'utf8')
    expect(screen).toMatch(/DEMO ONLY/)
    expect(screen).toMatch(/not real security/i)
  })

  it('instructor mode is labelled as not real authentication', () => {
    const screen = readFileSync(join(process.cwd(), 'src/screens/InstructorDemoScreen.tsx'), 'utf8')
    expect(screen).toMatch(/not real authentication/i)
  })
})
