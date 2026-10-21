/*!
 * PHP Simple Check — interstitial shown by the guard mode
 *
 * The guard's declarativeNetRequest rule redirects the main frame here with
 * ?host=…, so nothing from the blocked site is loaded. This page lets the user
 * look at why it was blocked and allow the host (which removes the rule).
 */
'use strict';

(function () {
  var i18n = globalThis.PHPSimpleCheckI18n;
  var t = i18n.t;
  var params = new URLSearchParams(location.search);
  var host = params.get('host') || '';
  var fallbackUrl = host ? 'https://' + host + '/' : 'about:blank';

  function $(id) {
    return document.getElementById(id);
  }

  function applyTranslations() {
    document.documentElement.lang = i18n.locale;
    document.documentElement.dir = i18n.dir;
    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n]'), function (node) {
      node.textContent = t(node.getAttribute('data-i18n'));
    });
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function send(message) {
    try {
      return chrome.runtime.sendMessage(message).catch(function () { return null; });
    } catch (error) {
      return Promise.resolve(null);
    }
  }

  function renderDetails(entry) {
    if (!entry) {
      $('note').textContent = t('blocked.missing');
      return;
    }

    $('facts').hidden = false;
    $('score').textContent = String(entry.score);
    if (entry.at) {
      $('checked').textContent = new Date(entry.at).toLocaleString(i18n.locale);
    }

    var signals = Array.isArray(entry.signals) ? entry.signals : [];
    if (!signals.length) return;

    $('signal-section').hidden = false;
    var list = $('signals');
    signals.forEach(function (signal) {
      var item = el('li');
      item.appendChild(el('span', 'weight', '+' + signal.weight));
      item.appendChild(el('span', null, signal.label));
      list.appendChild(item);
    });
  }

  function navigate(url) {
    location.replace(url || fallbackUrl);
  }

  async function allow() {
    var response = await send({ type: 'php-simple-check:allow-host', host: host });
    navigate(response && response.url ? response.url : fallbackUrl);
  }

  async function disableGuard() {
    await send({ type: 'php-simple-check:set-guard', enabled: false });
    navigate(originFromEntry());
  }

  var entryUrl = null;

  function originFromEntry() {
    return entryUrl || fallbackUrl;
  }

  async function init() {
    applyTranslations();
    $('host').textContent = host || t('blocked.unknown');
    if (!host) {
      $('allow').disabled = true;
    }

    $('allow').addEventListener('click', function () {
      void allow();
    });

    $('back').addEventListener('click', function () {
      if (history.length > 1) history.back();
      else location.replace('about:blank');
    });

    $('disable').addEventListener('click', function () {
      void disableGuard();
    });

    if (!host) return;

    try {
      var stored = await chrome.storage.local.get({ blockedHosts: {} });
      var entry = stored.blockedHosts && stored.blockedHosts[host];
      if (entry && entry.url) entryUrl = entry.url;
      renderDetails(entry);
    } catch (error) {
      /* storage unavailable — the page still works with the allow button */
    }
  }

  void init();
})();
