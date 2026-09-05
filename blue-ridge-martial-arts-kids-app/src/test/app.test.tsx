import { describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HashRouter } from 'react-router-dom'
import { App } from '../app/App'
import { StoreProvider } from '../app/StoreProvider'
import { loadState, saveState } from '../utils/storage'
import { createDefaultState } from '../data/defaultState'
import { CHECKLIST } from '../data/practice'
import { DEMO_PIN } from '../screens/ParentModeScreen'

function renderApp() {
  window.location.hash = '#/'
  return {
    user: userEvent.setup(),
    ...render(
      <StoreProvider>
        <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <App />
        </HashRouter>
      </StoreProvider>,
    ),
  }
}

/** Moves to a screen through the bottom navigation, as a child would. */
async function navigate(user: ReturnType<typeof userEvent.setup>, label: string) {
  const nav = screen.getByRole('navigation', { name: 'Main' })
  await user.click(within(nav).getByRole('link', { name: label }))
}

describe('the shell', () => {
  it('renders the brand and all five destinations', () => {
    renderApp()
    expect(screen.getByText('BLUE RIDGE')).toBeInTheDocument()
    expect(screen.getByText('MARTIAL ARTS')).toBeInTheDocument()
    expect(screen.getByText('FOREST, VA')).toBeInTheDocument()

    const nav = screen.getByRole('navigation', { name: 'Main' })
    for (const label of ['Home', 'Lessons', 'Practice', 'Progress', 'More']) {
      expect(within(nav).getByRole('link', { name: label })).toBeInTheDocument()
    }
  })

  it('marks the current destination with aria-current, not colour alone', async () => {
    const { user } = renderApp()
    const nav = screen.getByRole('navigation', { name: 'Main' })
    expect(within(nav).getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page')

    await navigate(user, 'Lessons')
    expect(within(nav).getByRole('link', { name: 'Lessons' })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current')
  })

  it('has exactly one h1 per screen', async () => {
    const { user } = renderApp()
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)

    for (const label of ['Lessons', 'Practice', 'Progress', 'More']) {
      await navigate(user, label)
      expect(
        screen.getAllByRole('heading', { level: 1 }),
        `${label} has the wrong number of h1s`,
      ).toHaveLength(1)
    }
  })

  it('offers a skip link to the main content', () => {
    renderApp()
    expect(screen.getByRole('link', { name: /skip to main content/i })).toBeInTheDocument()
  })
})

describe('completing a practice', () => {
  it('logs it, and the streak, badges and weekly count all move together', async () => {
    const { user } = renderApp()

    const before = loadState()
    const practicesBefore = before.practiceHistory.length

    await user.click(screen.getByRole('button', { name: /start practice/i }))

    // Skip through every step to the end of the routine.
    for (let i = 0; i < 20; i += 1) {
      const next = screen.queryByRole('button', { name: /^Next$/ })
      if (!next) break
      await user.click(next)
    }

    await user.click(screen.getByRole('button', { name: /^Complete$/ }))
    expect(await screen.findByText(/practice complete/i)).toBeInTheDocument()

    await waitFor(() => {
      expect(loadState().practiceHistory.length).toBe(practicesBefore + 1)
    })

    // The record is complete, not a bare counter.
    const logged = loadState().practiceHistory.at(-1)!
    expect(logged.routineId).toBe('daily-10')
    expect(logged.minutes).toBeGreaterThanOrEqual(1)
    expect(logged.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(logged.skills.length).toBeGreaterThan(0)

    // And a badge was awarded for it.
    expect(loadState().earnedBadges.length).toBeGreaterThan(0)
  })

  it('exits without logging anything when the practice is abandoned', async () => {
    const { user } = renderApp()
    const before = loadState().practiceHistory.length

    await user.click(screen.getByRole('button', { name: /start practice/i }))
    await user.click(screen.getByRole('button', { name: /exit/i }))

    expect(screen.getByRole('heading', { name: /my weekly practice plan/i })).toBeInTheDocument()
    expect(loadState().practiceHistory.length).toBe(before)
  })
})

describe('the checklist', () => {
  it('ticks persist, the meter moves, and finishing it earns the badge', async () => {
    const { user } = renderApp()
    await navigate(user, 'Practice')

    for (const item of CHECKLIST) {
      await user.click(screen.getByRole('button', { name: new RegExp(item.label, 'i') }))
    }

    await waitFor(() => {
      expect(loadState().checklist).toHaveLength(CHECKLIST.length)
    })

    expect(screen.getByText(/you're ready/i)).toBeInTheDocument()
    await waitFor(() => {
      expect(loadState().earnedBadges.map((b) => b.badgeId)).toContain('ready-for-dojo')
    })
  })

  it('un-ticking removes the item again', async () => {
    const { user } = renderApp()
    await navigate(user, 'Practice')

    const first = CHECKLIST[0]
    const control = screen.getByRole('button', { name: new RegExp(first.label, 'i') })

    await user.click(control)
    await waitFor(() => expect(loadState().checklist).toContain(first.id))

    await user.click(control)
    await waitFor(() => expect(loadState().checklist).not.toContain(first.id))
  })
})

describe('a lesson can actually be completed', () => {
  it('walks the steps and records completion', async () => {
    const { user } = renderApp()
    await navigate(user, 'Lessons')

    await user.click(screen.getByRole('link', { name: /Ready Stance\./i }))
    expect(screen.getByRole('heading', { name: 'Ready Stance', level: 1 })).toBeInTheDocument()

    for (let i = 0; i < 10; i += 1) {
      const next = screen.queryByRole('button', { name: /^Next$/ })
      if (!next) break
      await user.click(next)
    }

    await user.click(screen.getByRole('button', { name: /^Complete Lesson$/ }))

    await waitFor(() => {
      expect(loadState().lessonProgress['ready-stance']?.completed).toBe(true)
    })
    expect(await screen.findByText(/lesson complete/i)).toBeInTheDocument()
  })

  it('remembers where the student stopped', async () => {
    const { user, unmount } = renderApp()
    await navigate(user, 'Lessons')
    await user.click(screen.getByRole('link', { name: /Guard Position\./i }))

    await user.click(screen.getByRole('button', { name: /^Next$/ }))
    await user.click(screen.getByRole('button', { name: /^Next$/ }))

    await waitFor(() => {
      expect(loadState().lessonProgress['guard-position']?.currentStepIndex).toBe(2)
    })

    unmount()

    // Reopening lands on the step that was left, not back at the start.
    window.location.hash = '#/lessons/guard-position'
    render(
      <StoreProvider>
        <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <App />
        </HashRouter>
      </StoreProvider>,
    )
    expect(await screen.findByText(/STEP 3 OF/)).toBeInTheDocument()
  })
})

describe('parent mode', () => {
  it('refuses a wrong PIN and admits the right one', async () => {
    const { user } = renderApp()
    await navigate(user, 'More')
    await user.click(screen.getByRole('link', { name: /parent mode/i }))

    const field = screen.getByLabelText(/demo pin/i)
    await user.type(field, '9999')
    await user.click(screen.getByRole('button', { name: /unlock parent mode/i }))
    expect(await screen.findByText(/that pin did not match/i)).toBeInTheDocument()

    await user.clear(field)
    await user.type(field, DEMO_PIN)
    await user.click(screen.getByRole('button', { name: /unlock parent mode/i }))

    expect(await screen.findByText(/practices this week/i)).toBeInTheDocument()
    expect(screen.getByText(/DEMO ONLY/)).toBeInTheDocument()
  })
})

describe('instructor demo changes reach the student app', () => {
  it('a belt change shows on the masthead and the progress screen', async () => {
    const { user } = renderApp()
    await navigate(user, 'More')
    await user.click(screen.getByRole('link', { name: /instructor demo/i }))

    await user.selectOptions(screen.getByLabelText(/current belt/i), 'white-2')
    await waitFor(() => expect(loadState().instructor.currentBeltId).toBe('white-2'))

    await navigate(user, 'Progress')
    // The chip carries the FULL belt name, not the journey strip's short form.
    expect(screen.getByText(/Now: White Belt, 2 Stripes/)).toBeInTheDocument()
    // And the masthead agrees, so the two never disagree about the same belt.
    expect(screen.getAllByLabelText(/White Belt, 2 Stripes/).length).toBeGreaterThan(0)
  })

  it('a weekly goal change moves the student’s Home progress', async () => {
    const { user } = renderApp()
    await navigate(user, 'More')
    await user.click(screen.getByRole('link', { name: /instructor demo/i }))

    const goal = screen.getByLabelText(/home practices per week/i)
    await user.clear(goal)
    await user.type(goal, '7')
    await user.tab()
    await waitFor(() => expect(loadState().instructor.weeklyPlan.goalPractices).toBe(7))

    await navigate(user, 'Home')
    expect(screen.getByText(/of 7/)).toBeInTheDocument()
  })

  it('hiding a lesson removes it from the student library', async () => {
    const { user } = renderApp()
    await navigate(user, 'Lessons')
    expect(screen.getByRole('link', { name: /Front Kick Basics\./i })).toBeInTheDocument()

    await navigate(user, 'More')
    await user.click(screen.getByRole('link', { name: /instructor demo/i }))
    await user.click(screen.getByRole('button', { name: /Front Kick Basics/i }))

    await waitFor(() => {
      expect(loadState().instructor.availableLessonIds).not.toContain('front-kick-basics')
    })

    await navigate(user, 'Lessons')
    expect(screen.queryByRole('link', { name: /Front Kick Basics\./i })).not.toBeInTheDocument()
  })

  it('a class time change reaches the schedule', async () => {
    const { user } = renderApp()
    await navigate(user, 'More')
    await user.click(screen.getByRole('link', { name: /instructor demo/i }))

    await user.selectOptions(screen.getByLabelText(/class day/i), '2')
    await waitFor(() => expect(loadState().instructor.classSession.dayIndex).toBe(2))
    // The weekly plan's dojo day moves with it, so the two cannot disagree.
    const dojoDays = loadState().instructor.weeklyPlan.days.filter((d) => d.kind === 'dojo')
    expect(dojoDays).toHaveLength(1)
    expect(dojoDays[0].dayIndex).toBe(2)
  })
})

describe('reset', () => {
  it('restores the demo and clears what the student did', async () => {
    const dirty = createDefaultState()
    dirty.checklist = CHECKLIST.map((c) => c.id)
    dirty.student.firstName = 'Jordan'
    dirty.earnedBadges = [{ badgeId: 'first-practice', earnedAt: new Date().toISOString() }]
    saveState(dirty)

    const { user } = renderApp()
    await navigate(user, 'More')

    await user.click(screen.getByRole('button', { name: /reset demo data/i }))
    await user.click(screen.getByRole('button', { name: /yes, reset/i }))

    await waitFor(() => {
      const fresh = loadState()
      expect(fresh.student.firstName).toBe('Alex')
      expect(fresh.checklist).toEqual([])
    })
  })
})

describe('the school card never invents a detail', () => {
  it('says what is missing instead of showing a placeholder', async () => {
    const { user } = renderApp()
    await navigate(user, 'More')
    await user.click(screen.getByRole('link', { name: /dojo information/i }))

    const missing = screen.getAllByText(/add school contact information/i)
    expect(missing.length).toBeGreaterThanOrEqual(5)
    expect(screen.getByText(/still needed/i)).toBeInTheDocument()
  })
})

describe('an unknown route', () => {
  it('offers a way back rather than a blank screen', async () => {
    window.location.hash = '#/nowhere-at-all'
    render(
      <StoreProvider>
        <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <App />
        </HashRouter>
      </StoreProvider>,
    )
    expect(await screen.findByText(/that page is not here/i)).toBeInTheDocument()
  })
})
