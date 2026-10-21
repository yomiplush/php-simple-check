/*!
 * PHP Simple Check — content script
 *
 * Observes the loaded document (resources, anchors, generator meta, inline
 * script markers, JS-visible cookies) and reports it to the service worker,
 * which owns the verdict. Then paints the on-page 🔴/🟡/🟢 badge.
 */
(function () {
  'use strict';

  const MESSAGE_DOM = 'php-simple-check:dom';
  const MESSAGE_RESULT = 'php-simple-check:result';
  const RECHECK_DELAYS = [2500, 6000];

  let overlayEnabled = true;
  let lastResult = null;
  let lastHref = location.href;
  let pollTimer = null;

  function alive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (error) {
      return false;
    }
  }

  function send(message) {
    if (!alive()) return Promise.resolve(null);
    try {
      const pending = chrome.runtime.sendMessage(message);
      if (pending && typeof pending.catch === 'function') {
        return pending.catch(function () { return null; });
      }
      return Promise.resolve(pending);
    } catch (error) {
      return Promise.resolve(null);
    }
  }

  function render(result) {
    if (!result || !result.verdict) return;
    lastResult = result;
    if (!overlayEnabled) return;
    try {
      PHPSimpleCheckOverlay.render(result);
    } catch (error) {
      /* overlay is cosmetic — never break the page */
    }
  }

  async function scan() {
    let payload;
    try {
      payload = PHPSimpleCheckDom.collect();
    } catch (error) {
      return;
    }
    lastHref = payload.url;

    const response = await send({ type: MESSAGE_DOM, payload: payload });
    if (response && response.result) render(response.result);
  }

  function schedule(delay) {
    setTimeout(function () {
      if (location.href !== lastHref) return;
      void scan();
    }, delay);
  }

  function watchSettings() {
    try {
      const stored = chrome.storage.local.get({ overlayEnabled: true });
      if (stored && typeof stored.then === 'function') {
        stored
          .then(function (settings) {
            overlayEnabled = settings.overlayEnabled !== false;
            if (overlayEnabled && lastResult) render(lastResult);
            else if (!overlayEnabled) PHPSimpleCheckOverlay.hide();
          })
          .catch(function () {});
      }

      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || !changes.overlayEnabled) return;
        overlayEnabled = changes.overlayEnabled.newValue !== false;
        if (!overlayEnabled) {
          PHPSimpleCheckOverlay.hide();
          return;
        }
        if (lastResult) render(lastResult);
      });
    } catch (error) {
      /* storage unavailable — keep the default */
    }
  }

  function watchNavigation() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      if (location.href === lastHref) return;
      lastHref = location.href;
      setTimeout(function () { void scan(); }, 800);
    }, 1200);
    window.addEventListener('popstate', function () { setTimeout(function () { void scan(); }, 500); });
    window.addEventListener('hashchange', function () { setTimeout(function () { void scan(); }, 500); });
  }

  try {
    chrome.runtime.onMessage.addListener(function (message) {
      if (!message || message.type !== MESSAGE_RESULT) return;
      render(message.result);
    });
  } catch (error) {
    /* ignore */
  }

  watchSettings();
  watchNavigation();
  void scan();
  RECHECK_DELAYS.forEach(schedule);
})();
