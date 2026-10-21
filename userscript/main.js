/*!
 * PHP Simple Check — userscript entry point
 *
 * Built for Safari (Userscripts app) and Firefox for Android (Tampermonkey).
 * It runs at document-idle with @grant none, so it lives in the page world and
 * can see framework globals (window.wp / window.drupalSettings).
 *
 * Response headers are the only signal a userscript cannot read from the
 * document, so we make one extra same-origin HEAD request for them.
 *
 * Mobile extras:
 *   - "Hide on this site" is remembered per hostname in localStorage
 *     (with an undo toast), because on a phone there is no other way to get the
 *     badge out of the way.
 */
(function () {
  'use strict';

  var RECHECK_DELAYS = [2500, 6000];
  var HIDDEN_PREFIX = 'php-simple-check:hidden:';

  var lastHref = location.href;
  var probed = false;
  var probedHeaders = null;

  /* ---------------------------------------------------------- per-site hide */

  function hiddenKey() {
    return HIDDEN_PREFIX + location.hostname;
  }

  function isHidden() {
    try {
      return window.localStorage.getItem(hiddenKey()) === '1';
    } catch (error) {
      return false; /* private mode / storage disabled */
    }
  }

  function setHidden(hidden) {
    try {
      if (hidden) window.localStorage.setItem(hiddenKey(), '1');
      else window.localStorage.removeItem(hiddenKey());
    } catch (error) {
      /* ignore */
    }
  }

  function showToast(message, actionLabel, onAction) {
    var host = document.createElement('div');
    host.setAttribute('data-php-simple-check-toast', '');
    host.style.cssText =
      'all:initial;position:fixed;left:50%;bottom:calc(76px + env(safe-area-inset-bottom, 0px));' +
      'transform:translateX(-50%);z-index:2147483647;';
    var shadow = host.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent =
      '.toast{display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:10px;' +
      'background:#1f2937;color:#f9fafb;box-shadow:0 6px 22px rgba(0,0,0,.3);' +
      'font:400 12px/1.4 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;' +
      'max-width:calc(100vw - 32px)}' +
      '.toast button{border:0;background:transparent;color:#93c5fd;font:inherit;font-weight:700;' +
      'cursor:pointer;padding:6px;touch-action:manipulation}';

    var box = document.createElement('div');
    box.className = 'toast';
    var text = document.createElement('span');
    text.textContent = message;
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = actionLabel;
    button.addEventListener('click', function () {
      cleanup();
      onAction();
    });

    box.appendChild(text);
    box.appendChild(button);
    shadow.appendChild(style);
    shadow.appendChild(box);
    document.documentElement.appendChild(host);

    var timer = setTimeout(cleanup, 8000);

    function cleanup() {
      clearTimeout(timer);
      if (host.parentNode) host.parentNode.removeChild(host);
    }
  }

  /* ------------------------------------------------------------- header probe */

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

  /* --------------------------------------------------------------------- run */

  function run() {
    if (isHidden()) return;

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
        PHPSimpleCheckOverlay.render(result, {
          onSiteDismiss: function () {
            setHidden(true);
            showToast('PHP Simple Check is hidden on this site', 'Undo', function () {
              setHidden(false);
              PHPSimpleCheckOverlay.show();
              run();
            });
          }
        });
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
    if (document.hidden) return; // keep mobile battery usage low
    if (location.href === lastHref) return;
    lastHref = location.href;
    setTimeout(run, 800);
  }, 1200);

  window.addEventListener('popstate', function () { setTimeout(run, 500); });
  window.addEventListener('hashchange', function () { setTimeout(run, 500); });
})();
