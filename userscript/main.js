/*!
 * PHP Simple Check — userscript entry point
 *
 * Built for Safari (Userscripts app) and Firefox for Android (Tampermonkey).
 * It runs at document-idle with @grant none, so it lives in the page world and
 * can see framework globals (window.wp / window.drupalSettings).
 *
 * Response headers are the only signal a userscript cannot read from the
 * document, so we make one extra same-origin HEAD request for them.
 */
(function () {
  'use strict';

  var RECHECK_DELAYS = [2500, 6000];
  var lastHref = location.href;
  var probed = false;
  var probedHeaders = null;

  function probeHeaders() {
    if (probed) return Promise.resolve(probedHeaders);
    probed = true;

    return fetch(location.href, {
      method: 'HEAD',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'follow'
    }).then(function (response) {
      if (!response.ok) return null;
      var headers = {};
      response.headers.forEach(function (value, name) {
        headers[name.toLowerCase()] = value;
      });
      probedHeaders = headers;
      return headers;
    }).catch(function () {
      probedHeaders = null;
      return null;
    });
  }

  function run() {
    var payload;
    try {
      payload = PHPSimpleCheckDom.collect();
    } catch (error) {
      return;
    }

    probeHeaders().then(function (headers) {
      var result;
      try {
        result = PHPSimpleCheck.evaluate({
          url: payload.url,
          headers: headers,
          cookieNames: payload.cookieNames,
          dom: payload.dom
        });
      } catch (error) {
        return;
      }
      lastHref = payload.url;
      try {
        PHPSimpleCheckOverlay.render(result);
      } catch (error) {
        /* overlay is cosmetic */
      }
      window.dispatchEvent(new CustomEvent('php-simple-check:result', { detail: result }));
    });
  }

  function schedule(delay) {
    setTimeout(function () {
      if (location.href !== lastHref) return;
      run();
    }, delay);
  }

  run();
  RECHECK_DELAYS.forEach(schedule);

  // Single-page apps swap content without a reload: re-evaluate on URL change.
  setInterval(function () {
    if (location.href === lastHref) return;
    lastHref = location.href;
    setTimeout(run, 800);
  }, 1200);

  window.addEventListener('popstate', function () { setTimeout(run, 500); });
  window.addEventListener('hashchange', function () { setTimeout(run, 500); });
})();
