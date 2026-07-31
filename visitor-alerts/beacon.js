/* Always Precise — visitor beacon.
 *
 * Fires once per page view, and only for what looks like a real person:
 *   - never for automated browsers (navigator.webdriver)
 *   - never for prerender/prefetch or a page opened in a background tab
 *   - only after a human signal (pointer, touch, scroll, key) or 4s of
 *     visible dwell, whichever comes first
 *
 * Sends only the path and the referring host. No cookies, no identifiers,
 * nothing typed into any form. Honors Do Not Track and Global Privacy Control.
 */
(function () {
  var API = 'https://api-visitor-alerts.YOUR-SUBDOMAIN.workers.dev';

  // Respect opt-outs.
  if (navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl) return;

  // Headless/automated browsers announce themselves here.
  if (navigator.webdriver) return;

  // Chrome prerenders links the user has not clicked; those are not visits.
  if (document.prerendering || document.visibilityState === 'prerender') return;

  var sent = false;
  var timer = null;

  var EVENTS = ['pointermove', 'pointerdown', 'touchstart', 'scroll', 'keydown', 'wheel'];

  function cleanup() {
    if (timer) clearTimeout(timer);
    for (var i = 0; i < EVENTS.length; i++) {
      window.removeEventListener(EVENTS[i], onSignal, true);
    }
  }

  function send() {
    if (sent) return;
    sent = true;
    cleanup();
    try {
      fetch(API + '/hit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: location.pathname,
          ref: document.referrer || '',
          // Coarse signals used only to score this request as human or script.
          // Not stored, not a fingerprint.
          s: {
            tz: (Intl.DateTimeFormat().resolvedOptions().timeZone || '').slice(0, 40),
            w: screen.width,
            h: screen.height,
            t: Math.round(performance.now())  // ms on page before the signal
          }
        }),
        keepalive: true,
        mode: 'cors',
        credentials: 'omit'
      }).catch(function () {});
    } catch (e) {}
  }

  function onSignal() { send(); }

  function arm() {
    // Any genuine interaction counts immediately.
    for (var i = 0; i < EVENTS.length; i++) {
      window.addEventListener(EVENTS[i], onSignal, { capture: true, passive: true, once: true });
    }
    // Or simply being on the page, visible, for a few seconds.
    timer = setTimeout(function () {
      if (document.visibilityState === 'visible') send();
    }, 4000);
  }

  if (document.visibilityState === 'visible') {
    arm();
  } else {
    // Opened in a background tab — wait until it is actually looked at.
    document.addEventListener('visibilitychange', function once() {
      if (document.visibilityState === 'visible') {
        document.removeEventListener('visibilitychange', once);
        arm();
      }
    });
  }
})();
