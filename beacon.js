/* Always Precise — visitor beacon.
 *
 * Fires once per page view, and only for what looks like a real person:
 *   - never for automated browsers (navigator.webdriver)
 *   - never for prerender/prefetch or a page opened in a background tab
 *   - only after a human signal (pointer, touch, scroll, key) or 4s of
 *     visible dwell, whichever comes first
 *
 * What it sends, and nothing else (Live Visitors V2, owner brief 2026-10-10):
 *   - the page's path — never the query string — and the referring site's
 *     host, never the page it was on;
 *   - a random visitor token this browser keeps in its own local storage, so
 *     a return visit can be recognised. Not a cookie, not an IP address, not a
 *     fingerprint: clearing this site's data or a private window starts over;
 *   - how long the page was actually being looked at — visible, focused, and
 *     touched in the last minute; a tab left open is not engagement — sent
 *     when the page is hidden or left, and at most once a minute while read;
 *   - presses of the Call, Email, Contact and intake buttons;
 *   - from the intake page only: that it was opened, that it was started, and
 *     after Submit the request number that page minted and the service chosen.
 * Never anything typed into a form, never a field's name, never a keystroke.
 * Honors Do Not Track and Global Privacy Control, and a browser the owner has
 * marked as his own on the Live Visitors page. Every call is fire-and-forget:
 * if this script is blocked or the Worker is down, nothing on the page waits.
 */
(function () {
  var API = 'https://api-visitor-alerts.corlinllc.workers.dev';

  // Respect opt-outs.
  if (navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl) return;

  // Headless/automated browsers announce themselves here.
  if (navigator.webdriver) return;

  // The owner's own browsers, marked from /watch/ (same site), are not visitors.
  try { if (localStorage.getItem('apiv-exclude') === '1') return; } catch (e) {}

  var IDLE_MS = 60000;     // engagement stops a minute after the last touch
  var BEAT_MS = 60000;     // a check-in at most once a minute while being read
  var MAX_BEATS = 30;
  var QKEY = 'apiv-q';     // this tab's outbox: events not yet acknowledged

  function rnd(n) {
    var a = new Uint8Array(n), s = '';
    crypto.getRandomValues(a);
    for (var i = 0; i < n; i++) s += String.fromCharCode(a[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  /* The visitor token. Storage blocked means no token, and the page view is
     still counted the old way — it just has no journey. */
  function token() {
    try {
      var t = localStorage.getItem('apiv-id');
      if (!/^[A-Za-z0-9_-]{22,64}$/.test(t || '')) { t = rnd(16); localStorage.setItem('apiv-id', t); }
      return t;
    } catch (e) { return ''; }
  }
  var ID = token();
  var PV = rnd(12);                                       // this page load
  /* When the page opened, by this clock. A prerendered page opened when it
     was activated, not when Chrome built it in the background. */
  function opened() {
    var nav = performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
    return Date.now() - Math.round(performance.now() - ((nav && nav.activationStart) || 0));
  }

  function refHost() {
    // The referring site's scheme and host only. Its path and query stay put.
    try { var u = new URL(document.referrer); return u.protocol + '//' + u.hostname + '/'; } catch (e) { return ''; }
  }

  function post(path, body, keep) {
    try {
      // text/plain keeps this a simple request: no preflight, so it still
      // goes when the page is being left.
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify(body),
        keepalive: !!keep,
        mode: 'cors',
        credentials: 'omit'
      }).then(function (r) { return r.ok; }, function () { return false; });
    } catch (e) { return Promise.resolve(false); }
  }

  /* ---- the outbox: sessionStorage, so a press made as the page is left
     rides with the next page's view instead of being lost ---- */
  function qRead() {
    try { var q = JSON.parse(sessionStorage.getItem(QKEY) || '[]'); return Array.isArray(q) ? q : []; } catch (e) { return []; }
  }
  function qWrite(q) { try { sessionStorage.setItem(QKEY, JSON.stringify(q.slice(-12))); } catch (e) {} }
  function qKey(x) { return x.k + '|' + x.p + '|' + (x.e || x.a || ''); }
  function qAdd(item) {
    var q = qRead(), k = qKey(item);
    // A page's engagement is a running total: the newest replaces the older.
    q = q.filter(function (x) { return qKey(x) !== k; });
    q.push(item);
    qWrite(q);
  }
  function qDrop(sent) {
    var gone = {};
    for (var i = 0; i < sent.length; i++) gone[qKey(sent[i]) + '|' + (sent[i].m || '')] = 1;
    qWrite(qRead().filter(function (x) { return !gone[qKey(x) + '|' + (x.m || '')]; }));
  }

  var sent = false;
  var timer = null;
  var pvState = 0;        // 0 not sent · 1 in flight · 2 recorded · 3 refused
  var flushing = false;
  var HINT = null;        // the intake page's door, set by the page itself

  var EVENTS = ['pointermove', 'pointerdown', 'touchstart', 'scroll', 'keydown', 'wheel'];

  function cleanup() {
    if (timer) clearTimeout(timer);
    for (var i = 0; i < EVENTS.length; i++) {
      window.removeEventListener(EVENTS[i], onSignal, true);
    }
  }

  function flush(keep) {
    if (pvState !== 2 || !ID) return;
    var q = qRead();
    if (!q.length || (flushing && !keep)) return;
    flushing = true;
    var items = q.slice(0, 20);
    post('/t', { id: ID, c: Date.now(), q: items }, keep).then(function (ok) {
      flushing = false;
      if (ok) qDrop(items);
    });
  }

  function send() {
    if (sent) return;
    sent = true;
    cleanup();
    var body = {
      path: location.pathname,
      ref: refHost(),
      // Coarse signals used only to score this request as human or script.
      // Not stored, not a fingerprint.
      s: {
        tz: (Intl.DateTimeFormat().resolvedOptions().timeZone || '').slice(0, 40),
        w: screen.width,
        h: screen.height,
        t: Math.round(performance.now())  // ms on page before the signal
      },
      id: ID,
      pv: PV,
      lt: opened(),
      c: Date.now()
    };
    if (HINT) body.d = HINT;
    var q = qRead().slice(-8);
    if (q.length) body.q = q;
    if (JSON.stringify(body).length > 1900) delete body.q;   // the page view itself must fit
    pvState = 1;
    post('/hit', body, true).then(function (ok) {
      pvState = ok ? 2 : 3;
      if (ok && body.q) qDrop(body.q);
      flush(false);
    });
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

  /* ---- actions ---- */
  function act(a, extra) {
    if (!ID) return;
    var item = { k: 'a', p: PV, a: a, e: rnd(6), t: Date.now() };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) item[k] = extra[k];
    qAdd(item);
    if (!sent) send();        // a press is a human signal; the view goes first and carries it
    else flush(false);
  }

  /* Which button was pressed, from the link's own address. Only the firm's
     phone and email links and its own intake doors count. */
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (/^tel:/i.test(href)) { act('call'); return; }
    if (/^mailto:/i.test(href)) { act('email'); return; }
    var u;
    try { u = new URL(a.href); } catch (e) { return; }
    if (u.origin !== location.origin) return;
    if (u.hash === '#contact') { act('contact'); return; }
    if (/^\/intake(\/|$)/.test(u.pathname)) {
      var as = (u.searchParams.get('assignment') || '').toLowerCase();
      var sv = (u.searchParams.get('service') || '').toLowerCase();
      act('cta', { d: sv === 'custody' ? 'custody'
        : /^(insurance|carrier|claims)$/.test(as) ? 'insurance'
        : as === 'legal' ? 'legal' : as === 'private' ? 'private' : 'intake' });
    }
  }, true);

  /* ---- engagement: visible, focused, and touched within the last minute ---- */
  var eng = 0, since = 0, lastInput = Date.now(), idleT = null, beats = 0, lastSent = 0, lastMove = 0;
  function looking() {
    return document.visibilityState === 'visible' && (!document.hasFocus || document.hasFocus());
  }
  function stop(now) {
    if (since) { eng += Math.max(0, Math.min(now, lastInput + IDLE_MS) - since); since = 0; }
  }
  function begin(now) { if (!since && looking()) since = now; }
  function armIdle() {
    if (idleT) clearTimeout(idleT);
    idleT = setTimeout(function () { stop(Date.now()); }, IDLE_MS + 50);
  }
  function touched() {
    var now = Date.now();
    if (since && now > lastInput + IDLE_MS) stop(now);   // the idle stretch is not counted
    lastInput = now;
    begin(now);
    armIdle();
  }
  function engagedNow() {
    var now = Date.now();
    return eng + (since ? Math.max(0, Math.min(now, lastInput + IDLE_MS) - since) : 0);
  }
  function checkpoint(leaving, beat) {
    if (!sent || !ID) return;
    var ms = Math.round(engagedNow());
    if (ms > lastSent) {
      lastSent = ms;
      var item = { k: 'e', p: PV, m: ms };
      if (beat) item.b = 1;
      qAdd(item);
    }
    flush(leaving);
  }
  var INPUTS = ['pointerdown', 'keydown', 'scroll', 'wheel', 'touchstart'];
  for (var i = 0; i < INPUTS.length; i++) window.addEventListener(INPUTS[i], touched, { capture: true, passive: true });
  window.addEventListener('pointermove', function () {
    var now = Date.now();
    if (now - lastMove > 1000) { lastMove = now; touched(); }
  }, { capture: true, passive: true });
  window.addEventListener('focus', touched);
  window.addEventListener('blur', function () { stop(Date.now()); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { stop(Date.now()); checkpoint(true, false); }
    else touched();
  });
  window.addEventListener('pagehide', function () { stop(Date.now()); checkpoint(true, false); });
  setInterval(function () {
    if (!since || beats >= MAX_BEATS) return;   // only while somebody is reading
    beats++;
    checkpoint(false, true);
  }, BEAT_MS);
  begin(Date.now());
  armIdle();

  /* ---- the intake page's own hooks. It pushes onto window.APIVisitQ; a
     push made before this script ran is waiting in that array ---- */
  function handle(x) {
    if (!x || !x.length) return;
    if (x[0] === 'door' && x[1]) {
      HINT = { door: String(x[1].door || '').slice(0, 12), svc: String(x[1].svc || '').slice(0, 16) };
    } else if (x[0] === 'act' && x[1] === 'intake_started') {
      act('intake_started');
    } else if (x[0] === 'act' && x[1] === 'intake_submitted' && x[2]) {
      act('intake_submitted', {
        n: String(x[2].n || '').slice(0, 24),
        s: String(x[2].s || '').slice(0, 16),
        l: String(x[2].l || '').slice(0, 16)
      });
    }
  }
  var waiting = window.APIVisitQ;
  window.APIVisitQ = { push: handle };
  if (waiting && waiting.length) for (var j = 0; j < waiting.length; j++) handle(waiting[j]);

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
