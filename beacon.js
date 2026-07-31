/* Always Precise — visitor beacon.
 * Fires once per page view. Sends only the path and the referring host.
 * No cookies, no identifiers, nothing typed into any form.
 * Honors Do Not Track and Global Privacy Control.
 */
(function () {
  if (navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl) return;
  var API = 'https://api-visitor-alerts.YOUR-SUBDOMAIN.workers.dev';
  try {
    fetch(API + '/hit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: location.pathname, ref: document.referrer || '' }),
      keepalive: true,
      mode: 'cors',
      credentials: 'omit'
    }).catch(function () {});
  } catch (e) {}
})();
