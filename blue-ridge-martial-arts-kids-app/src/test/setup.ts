import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// jsdom does not implement scrollTo, and the router calls it on every
// navigation. Stubbing it keeps real failures visible in the output.
window.scrollTo = () => {}

// Each test starts with an empty store, so no test can pass because of a
// value another test happened to leave behind.
beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})
