/*!
 * PHP Simple Check — toolbar popup
 *
 * Shows the verdict the service worker stored for the active tab, plus every
 * signal that contributed to it. The popup can re-run the evaluation and toggle
 * the on-page badge.
 */
'use strict';

(function () {
  var VERDICT_CLASS = { php: 'verdict-php', maybe: 'verdict-maybe', none: 'verdict-none' };
  var i18n = globalThis.PHPSimpleCheckI18n;
  var t = i18n.t;

  function verdictText(result, suffix) {
    var key = 'verdict.' + result.verdict + (suffix || '');
    var value = t(key);
    if (value === key) return suffix ? result.short || result.label : result.label;
    return value;
  }

  function applyTranslations() {
    document.documentElement.lang = i18n.locale;
    document.documentElement.dir = i18n.dir;
    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n]'), function (node) {
      node.textContent = t(node.getAttribute('data-i18n'));
    });
  }

  var els = {};
  var activeTabId = null;
  // @store-strip-start
  var capabilities = { guard: true };
  // @store-strip-end
  var lastResult = null;
  var copyTimer = null;

  function $(id) {
    return document.getElementById(id);
  }

  function send(message) {
    try {
      return chrome.runtime.sendMessage(message).catch(function () { return null; });
    } catch (error) {
      return Promise.resolve(null);
    }
  }

  function setBusy(busy) {
    els.rescan.disabled = busy;
    els.rescan.textContent = t(busy ? 'popup.scanning' : 'popup.rescan');
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function weightClass(weight) {
    if (weight < 0) return 'weight negative';
    return weight >= 3 ? 'weight strong' : 'weight weak';
  }

  function setCopyState(result) {
    els.copy.disabled = !result;
    els.copyStatus.hidden = true;
  }

  function renderVerdict(result) {
    var verdict = result && result.verdict;
    els.verdict.className = 'verdict ' + (VERDICT_CLASS[verdict] || 'verdict-unknown');
    els.verdictEmoji.textContent = result ? result.emoji : '⚪';
    els.verdictLabel.textContent = result ? verdictText(result) : t('popup.notJudged');

    if (!result) {
      els.verdictMeta.textContent = t('popup.reload');
      return;
    }

    var checked = new Date(result.checkedAt);
    els.verdictMeta.textContent = t('popup.meta', {
      score: result.score,
      time: checked.toLocaleTimeString()
    });
  }

  function renderSignals(result) {
    var signals = result ? result.signals : [];
    els.signalList.textContent = '';
    els.signalSection.hidden = signals.length === 0;

    signals.forEach(function (signal) {
      var item = el('li');
      item.appendChild(el('span', weightClass(signal.weight), (signal.weight > 0 ? '+' : '') + signal.weight));

      var body = el('span');
      body.appendChild(el('span', 'signal-label', signal.label));
      if (signal.detail) body.appendChild(el('span', 'signal-detail', signal.detail));
      item.appendChild(body);
      els.signalList.appendChild(item);
    });
  }

  function renderFacts(result) {
    var facts = result ? result.facts || {} : {};
    var rows = [
      ['X-Powered-By', facts.xPoweredBy],
      ['Server', facts.server],
      ['generator', facts.generator],
      ['Cookie', (facts.cookies || []).slice(0, 5).join(', ')],
      ['.php', (facts.phpResources || []).slice(0, 2).join(', ') || (facts.phpAnchors || []).slice(0, 2).join(', ')]
    ].filter(function (row) { return Boolean(row[1]); });

    els.factList.textContent = '';
    els.factSection.hidden = rows.length === 0;
    rows.forEach(function (row) {
      els.factList.appendChild(el('dt', null, row[0]));
      els.factList.appendChild(el('dd', null, row[1]));
    });
  }

  // @store-strip-start
  function guardRow(host, label, action) {
    var item = el('li');
    item.appendChild(el('span', 'guard-host', host));
    var button = el('button', 'mini', label);
    button.type = 'button';
    button.addEventListener('click', function () {
      button.disabled = true;
      void action().then(function (response) {
        button.disabled = false;
        if (response && response.guard) renderGuard(response.guard);
      });
    });
    item.appendChild(button);
    return item;
  }

  function renderGuard(guard) {
    var blocked = guard && guard.blocked ? guard.blocked : {};
    var allowed = guard && Array.isArray(guard.allowed) ? guard.allowed : [];
    var blockedHosts = Object.keys(blocked).sort();

    var guardEnabled = Boolean(guard && guard.enabled);
    els.guardToggle.checked = guardEnabled;
    els.blockedTitle.textContent = t(guardEnabled ? 'popup.blocked' : 'popup.recorded');
    els.guardSection.hidden = !capabilities.guard;
    els.blockedWrap.hidden = blockedHosts.length === 0;
    els.allowedWrap.hidden = allowed.length === 0;

    els.blockedList.textContent = '';
    blockedHosts.forEach(function (host) {
      els.blockedList.appendChild(
        guardRow(host, t('popup.remove'), function () {
          return send({ type: 'php-simple-check:unblock-host', host: host });
        })
      );
    });

    els.allowedList.textContent = '';
    allowed.slice().sort().forEach(function (host) {
      els.allowedList.appendChild(
        guardRow(host, t('popup.blockAgain'), function () {
          return send({ type: 'php-simple-check:unallow-host', host: host });
        })
      );
    });
  }

  // @store-strip-end
  function renderEmpty(message) {
    els.emptySection.hidden = !message;
    els.emptyText.textContent = message || '';
  }

  function render(result) {
    lastResult = result || null;
    setCopyState(lastResult);
    renderVerdict(result);
    renderSignals(result);
    renderFacts(result);
  }

  async function rescan() {
    if (activeTabId == null) return;
    setBusy(true);
    var response = await send({ type: 'php-simple-check:rescan', tabId: activeTabId });
    setBusy(false);
    if (response && response.result) {
      render(response.result);
      renderEmpty('');
    } else {
      renderEmpty(t('popup.failed'));
    }
  }

  async function init() {
    els.version = $('version');
    els.verdict = $('verdict');
    els.verdictEmoji = $('verdict-emoji');
    els.verdictLabel = $('verdict-label');
    els.verdictMeta = $('verdict-meta');
    els.pageUrl = $('page-url');
    els.signalSection = $('signal-section');
    els.signalList = $('signal-list');
    els.factSection = $('fact-section');
    els.factList = $('fact-list');
    els.emptySection = $('empty-section');
    els.emptyText = $('empty-text');
    els.rescan = $('rescan');
    els.copy = $('copy');
    els.copyStatus = $('copy-status');
    els.overlayToggle = $('overlay-toggle');
    // @store-strip-start
    els.guardSection = $('guard-section');
    els.guardTitle = null;
    els.guardToggle = $('guard-toggle');
    els.blockedWrap = $('blocked-wrap');
    els.blockedTitle = $('blocked-title');
    els.blockedList = $('blocked-list');
    els.allowedWrap = $('allowed-wrap');
    els.allowedList = $('allowed-list');
    // @store-strip-end

    applyTranslations();
    els.version.textContent = 'v' + PHPSimpleCheck.version;
    els.copyStatus.hidden = true;

    try {
      var settings = await chrome.storage.local.get({ overlayEnabled: true });
      els.overlayToggle.checked = settings.overlayEnabled !== false;
    } catch (error) {
      els.overlayToggle.checked = true;
    }

    els.rescan.addEventListener('click', function () { void rescan(); });

    els.copy.addEventListener('click', function () {
      if (!lastResult) return;
      var text = PHPSimpleCheckReport.build(lastResult);
      var finish = function (ok) {
        els.copyStatus.hidden = false;
        els.copyStatus.textContent = t(ok ? 'popup.copied' : 'popup.copyFailed');
        clearTimeout(copyTimer);
        copyTimer = setTimeout(function () { els.copyStatus.hidden = true; }, 2000);
      };
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        finish(false);
        return;
      }
      navigator.clipboard.writeText(text).then(function () { finish(true); }, function () { finish(false); });
    });

    // @store-strip-start
    els.guardToggle.addEventListener('change', function () {
      var enabled = els.guardToggle.checked;
      els.guardToggle.disabled = true;
      void send({ type: 'php-simple-check:set-guard', enabled: enabled, tabId: activeTabId }).then(function (response) {
        els.guardToggle.disabled = false;
        if (response && response.guard) renderGuard(response.guard);
      });
    });
    // @store-strip-end

    els.overlayToggle.addEventListener('change', function () {
      chrome.storage.local.set({ overlayEnabled: els.overlayToggle.checked }).catch(function () {});
    });

    // @store-strip-start
    var guardResponse = await send({ type: 'php-simple-check:get-guard' });
    capabilities = (guardResponse && guardResponse.capabilities) || { guard: true };
    els.guardSection.hidden = !capabilities.guard;
    renderGuard(guardResponse && guardResponse.guard ? guardResponse.guard : null);
    // @store-strip-end

    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    var tab = tabs && tabs[0];
    if (!tab || tab.id == null) {
      render(null);
      renderEmpty(t('popup.noTab'));
      els.rescan.disabled = true;
      return;
    }

    activeTabId = tab.id;

    // The store build has no host permissions, so tab.url is undefined there.
    // Ask the worker instead: it learns the URL from the content script.
    var response = await send({ type: 'php-simple-check:get-result', tabId: activeTabId });
    var knownUrl = (response && response.url) || tab.url || '';
    els.pageUrl.textContent = knownUrl;

    if (response && response.result) {
      render(response.result);
      return;
    }

    render(null);

    if (knownUrl && !/^https?:/i.test(knownUrl)) {
      renderEmpty(t('popup.unsupported'));
      els.rescan.disabled = true;
      return;
    }

    if (!knownUrl) {
      renderEmpty(t('popup.reloadToScan'));
      return;
    }

    renderEmpty(t('popup.noVerdict'));
    void rescan();
  }

  void init();
})();
