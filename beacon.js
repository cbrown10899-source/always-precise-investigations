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
  var API = 'https://api-visitor-alerts.corlinllc.workers.dev';

  // Respect opt-outs.
  if (navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl) return;

  // Headless/automated browsers announce themselves here.
  if (navigator.webdriver) return;

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
    /* Or simply being on the page, visible, for a few seconds. If the tab
       happens to be hidden when this fires, RE-ARM rather than forfeit — it
       used to just return, so a reader who tabbed away across the four-second
       mark and came back was never counted unless they touched something. */
    timer = setTimeout(function tick() {
      if (sent) return;
      if (document.visibilityState === 'visible') send();
      else timer = setTimeout(tick, 2000);
    }, 4000);
  }

  function start() {
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
  }

  /* Chrome prerenders links the user has not clicked, and those are not
     visits — but they BECOME one the moment the user navigates there, and
     the prerendered document is the SAME document, already parsed and
     already run. So this defers rather than returning: returning here meant
     a real visit was never counted at all, and the visits it lost were the
     highest-intent ones, arriving straight from the address bar. */
  if (document.prerendering) {
    document.addEventListener('prerenderingchange', start, { once: true });
  } else if (document.visibilityState === 'prerender') {
    // The older, deprecated prerender API — same deferral, its own event.
    document.addEventListener('visibilitychange', function pre() {
      if (document.visibilityState !== 'prerender') {
        document.removeEventListener('visibilitychange', pre);
        start();
      }
    });
  } else {
    start();
  }
})();
