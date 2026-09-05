/*
 * Service worker for the Blue Ridge Martial Arts Kids App.
 *
 * Two caching rules, chosen so the app can be opened on a phone with no
 * signal WITHOUT the "installed app is stuck on an old build" problem:
 *
 *  - Hashed build assets (/assets/*) are cache-first. Vite content-hashes
 *    those filenames, so a changed file is a NEW url and can never be served
 *    stale.
 *  - Everything else — the document above all — is network-first, falling back
 *    to the cache only when the network genuinely fails. A new deploy is
 *    therefore picked up on the next online load rather than on some later
 *    visit.
 *
 * CACHE_VERSION is bumped by hand when the shell changes; activate deletes
 * every cache that is not the current one, so an old shell cannot survive.
 */

const CACHE_VERSION = 'brma-v1'

// Resolved against the worker's own location, so this works unchanged whether
// the app is served from a domain root or a GitHub Pages sub-path.
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) =>
        // addAll rejects the whole batch if any one request fails, which would
        // leave the worker uninstalled. Each is added on its own instead.
        Promise.all(
          SHELL.map((url) =>
            cache.add(new Request(url, { cache: 'reload' })).catch(() => undefined),
          ),
        ),
      )
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  // Never touch another origin: a cached cross-origin response is a surprise
  // nobody asked for, and this app loads nothing from one anyway.
  if (url.origin !== self.location.origin) return

  const isHashedAsset = url.pathname.includes('/assets/')

  if (isHashedAsset) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone()
              caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy))
            }
            return response
          }),
      ),
    )
    return
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone()
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy))
        }
        return response
      })
      .catch(async () => {
        const hit = await caches.match(request)
        if (hit) return hit
        // A navigation that missed the cache still has to render something,
        // so fall back to the shell rather than the browser's error page.
        if (request.mode === 'navigate') {
          const shell = await caches.match('./index.html')
          if (shell) return shell
        }
        return Response.error()
      }),
  )
})
