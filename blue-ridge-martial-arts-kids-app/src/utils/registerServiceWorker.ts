/**
 * Registers the service worker, in production only.
 *
 * In development a worker would cache the dev server's module graph and make
 * every subsequent edit invisible, so it is deliberately not registered there —
 * and any worker left over from a previous production visit on the same origin
 * is removed, which is the case that otherwise wastes an afternoon.
 *
 * `import.meta.env.BASE_URL` is what makes this work under a GitHub Pages
 * sub-path: the worker must be registered from the app's own scope, not '/'.
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return

  if (!import.meta.env.PROD) {
    navigator.serviceWorker.getRegistrations?.().then((registrations) => {
      registrations.forEach((registration) => registration.unregister())
    })
    return
  }

  window.addEventListener('load', () => {
    const base = import.meta.env.BASE_URL || '/'
    navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch(() => {
      // An install that fails costs offline support and nothing else. The app
      // works exactly as it did; there is nothing to tell the child about.
    })
  })
}
