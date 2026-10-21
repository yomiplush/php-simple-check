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

  var els = {};
  var activeTabId = null;

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
    els.rescan.textContent = busy ? 'スキャン中…' : '再スキャン';
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

  function renderVerdict(result) {
    var verdict = result && result.verdict;
    els.verdict.className = 'verdict ' + (VERDICT_CLASS[verdict] || 'verdict-unknown');
    els.verdictEmoji.textContent = result ? result.emoji : '⚪';
    els.verdictLabel.textContent = result ? result.label : 'まだ判定していません';

    if (!result) {
      els.verdictMeta.textContent = '再読み込みするか「再スキャン」を押してください';
      return;
    }

    var positives = result.signals.filter(function (signal) { return signal.weight > 0; }).length;
    var checked = new Date(result.checkedAt);
    els.verdictMeta.textContent =
      'スコア ' + result.score +
      ' ・ 手がかり ' + positives + ' 件' +
      ' ・ ' + checked.toLocaleTimeString('ja-JP');
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
    els.blockedTitle.textContent = guardEnabled ? 'ブロック中' : '記録済み（警戒モード OFF）';
    els.blockedWrap.hidden = blockedHosts.length === 0;
    els.allowedWrap.hidden = allowed.length === 0;

    els.blockedList.textContent = '';
    blockedHosts.forEach(function (host) {
      els.blockedList.appendChild(
        guardRow(host, '解除', function () {
          return send({ type: 'php-simple-check:unblock-host', host: host });
        })
      );
    });

    els.allowedList.textContent = '';
    allowed.slice().sort().forEach(function (host) {
      els.allowedList.appendChild(
        guardRow(host, 'ブロックに戻す', function () {
          return send({ type: 'php-simple-check:unallow-host', host: host });
        })
      );
    });
  }

  function renderEmpty(message) {
    els.emptySection.hidden = !message;
    els.emptyText.textContent = message || '';
  }

  function render(result) {
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
      renderEmpty('このページでは判定できませんでした。再読み込みしてから試してください。');
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
    els.overlayToggle = $('overlay-toggle');
    els.guardToggle = $('guard-toggle');
    els.blockedWrap = $('blocked-wrap');
    els.blockedTitle = $('blocked-title');
    els.blockedList = $('blocked-list');
    els.allowedWrap = $('allowed-wrap');
    els.allowedList = $('allowed-list');

    els.version.textContent = 'v' + PHPSimpleCheck.version;

    try {
      var settings = await chrome.storage.local.get({ overlayEnabled: true });
      els.overlayToggle.checked = settings.overlayEnabled !== false;
    } catch (error) {
      els.overlayToggle.checked = true;
    }

    els.rescan.addEventListener('click', function () { void rescan(); });

    els.guardToggle.addEventListener('change', function () {
      var enabled = els.guardToggle.checked;
      els.guardToggle.disabled = true;
      void send({ type: 'php-simple-check:set-guard', enabled: enabled, tabId: activeTabId }).then(function (response) {
        els.guardToggle.disabled = false;
        if (response && response.guard) renderGuard(response.guard);
      });
    });
    els.overlayToggle.addEventListener('change', function () {
      chrome.storage.local.set({ overlayEnabled: els.overlayToggle.checked }).catch(function () {});
    });

    var guardResponse = await send({ type: 'php-simple-check:get-guard' });
    renderGuard(guardResponse && guardResponse.guard ? guardResponse.guard : null);

    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    var tab = tabs && tabs[0];
    if (!tab || tab.id == null) {
      render(null);
      renderEmpty('アクティブなタブが見つかりません。');
      els.rescan.disabled = true;
      return;
    }

    activeTabId = tab.id;
    els.pageUrl.textContent = tab.url || '';

    if (!/^https?:/i.test(tab.url || '')) {
      render(null);
      renderEmpty('このページでは判定できません（chrome:// や Web Store などは対象外です）。');
      els.rescan.disabled = true;
      return;
    }

    var response = await send({ type: 'php-simple-check:get-result', tabId: activeTabId });
    if (response && response.result) {
      render(response.result);
      return;
    }

    render(null);
    renderEmpty('判定結果がまだありません。自動で再スキャンします。');
    void rescan();
  }

  void init();
})();
