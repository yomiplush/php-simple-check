/*!
 * PHP Simple Check — on-page badge
 *
 * A small, self-contained Shadow DOM badge (bottom-right) shared by the Chrome
 * content script and the userscript, so both platforms show the same 🔴/🟢 UI.
 * No page CSS can leak in, and page data is always inserted with textContent.
 */
(function (global) {
  'use strict';

  var HOST_ID = 'php-simple-check-badge';
  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box}',
    '.wrap{display:flex;flex-direction:column;align-items:flex-end;gap:8px;font:400 12px/1.45 system-ui,-apple-system,"Segoe UI","Hiragino Sans","Noto Sans JP",sans-serif;color:#111}',
    '.badge{display:inline-flex;align-items:center;gap:6px;padding:6px 11px;border-radius:999px;border:1px solid #d0d7de;background:#fff;color:#111;font:inherit;font-weight:600;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;box-shadow:0 2px 10px rgba(0,0,0,.18);transition:transform .12s ease,box-shadow .12s ease}',
    '.badge:hover{transform:translateY(-1px);box-shadow:0 4px 14px rgba(0,0,0,.24)}',
    '.badge:focus-visible{outline:2px solid #0969da;outline-offset:2px}',
    '.badge-emoji{font-size:13px;line-height:1}',
    '.panel{width:min(340px,calc(100vw - 32px));max-height:min(60vh,520px);overflow:auto;overscroll-behavior:contain;padding:12px;border-radius:12px;border:1px solid #d0d7de;background:#fff;box-shadow:0 8px 28px rgba(0,0,0,.22)}',
    '.panel[hidden]{display:none}',
    '.panel-head{display:flex;align-items:center;gap:6px;margin:0 0 6px}',
    '.panel-emoji{font-size:16px;line-height:1}',
    '.panel-title{font-weight:700;font-size:13px;flex:1 1 auto}',
    '.close{border:0;background:transparent;color:#57606a;font-size:16px;line-height:1;cursor:pointer;padding:2px 4px;border-radius:6px}',
    '.close:hover{background:#f3f4f6;color:#111}',
    '.summary{margin:0 0 8px;color:#57606a;font-size:11px}',
    '.signals{list-style:none;margin:0 0 8px;padding:0;display:flex;flex-direction:column;gap:6px}',
    '.signals li{display:flex;gap:7px;align-items:flex-start}',
    '.weight{flex:0 0 auto;min-width:22px;text-align:center;border-radius:5px;padding:0 4px;font-weight:700;font-size:10px;line-height:16px;background:#eef1f4;color:#57606a}',
    '.weight.strong{background:#fdecea;color:#b3261e}',
    '.weight.weak{background:#fff4e5;color:#8a5300}',
    '.weight.negative{background:#e8f5e9;color:#1b5e20}',
    '.signal-label{display:block;font-weight:600;font-size:11.5px}',
    '.signal-detail{display:block;color:#57606a;font:400 10.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}',
    '.facts{margin:0 0 8px;display:grid;grid-template-columns:auto 1fr;gap:2px 8px;font-size:10.5px;color:#57606a}',
    '.facts dt{font-weight:600;color:#111}',
    '.facts dd{margin:0;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
    '.facts:empty{display:none}',
    '.note{margin:0;font-size:10px;line-height:1.5;color:#6e7781}',
    '.site-dismiss{display:block;width:100%;margin:0 0 8px;padding:7px 8px;border:1px solid #d0d7de;border-radius:8px;background:transparent;color:#57606a;font:inherit;font-size:11px;cursor:pointer}',
    '.site-dismiss:hover{background:#f3f4f6;color:#111}',
    '.site-dismiss[hidden]{display:none}',
    /* Phones / tablets: bigger tap targets and a taller scrollable panel. */
    '@media (pointer:coarse){',
    '.badge{padding:8px 13px;font-size:13px}',
    '.badge-emoji{font-size:15px}',
    '.panel{width:min(360px,calc(100vw - 24px));max-height:min(70vh,560px);padding:14px}',
    '.close{font-size:20px;padding:6px 8px}',
    '.signal-label{font-size:12px}',
    '.signal-detail{font-size:11px}',
    '.site-dismiss{padding:10px 8px;font-size:12px}',
    '}',
    '@media (prefers-color-scheme:dark){',
    '.wrap{color:#e6edf3}',
    '.badge{background:#161b22;color:#e6edf3;border-color:#30363d}',
    '.panel{background:#161b22;color:#e6edf3;border-color:#30363d}',
    '.panel-title{color:#e6edf3}',
    '.summary,.note{color:#8b949e}',
    '.facts dt{color:#e6edf3}',
    '.facts dd{color:#8b949e}',
    '.close{color:#8b949e}',
    '.close:hover{background:#21262d;color:#e6edf3}',
    '.site-dismiss{color:#8b949e;border-color:#30363d}',
    '.site-dismiss:hover{background:#21262d;color:#e6edf3}',
    '}'
  ].join('\n');

  /* ------------------------------------------------------------ guard banner */

  var BANNER_ID = 'php-simple-check-banner';
  var BANNER_CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box}',
    '.bar{display:flex;align-items:center;gap:10px;padding:10px 14px;background:#8e1f1a;color:#fff;',
    'font:400 12px/1.45 system-ui,-apple-system,"Segoe UI","Hiragino Sans","Noto Sans JP",sans-serif;',
    'box-shadow:0 2px 12px rgba(0,0,0,.28)}',
    '.icon{font-size:15px;line-height:1;flex:0 0 auto}',
    '.text{flex:1 1 auto;min-width:0}',
    '.host{font-weight:700;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}',
    '.actions{display:flex;gap:6px;flex:0 0 auto}',
    '.actions button{border:1px solid rgba(255,255,255,.5);border-radius:7px;background:transparent;color:#fff;',
    'font:inherit;font-weight:600;padding:5px 9px;cursor:pointer;touch-action:manipulation}',
    '.actions button.allow{background:#fff;color:#8e1f1a;border-color:#fff}',
    '.actions button:focus-visible{outline:2px solid #fff;outline-offset:1px}',
    '@media (pointer:coarse){.bar{padding:12px 14px;font-size:12.5px}.actions button{padding:8px 12px}}',
    '@media (max-width:560px){.bar{flex-wrap:wrap}.actions{width:100%;justify-content:flex-end}}'
  ].join('\n');

  var banner = { host: null, onAllow: null, onLeave: null };

  function hideGuardBanner() {
    if (banner.host && banner.host.parentNode) banner.host.parentNode.removeChild(banner.host);
    banner.host = null;
  }

  function showGuardBanner(options) {
    var settings = options || {};
    hideGuardBanner();

    var host = el('div');
    host.id = BANNER_ID;
    host.style.cssText = 'all:initial;position:fixed;left:0;right:0;top:0;z-index:2147483647;display:block;';
    var shadow = host.attachShadow({ mode: 'open' });

    var style = el('style');
    style.textContent = BANNER_CSS;

    var bar = el('div', 'bar');
    bar.setAttribute('role', 'alert');
    bar.appendChild(el('span', 'icon', '⚠'));

    var text = el('span', 'text');
    text.appendChild(el('span', 'host', settings.host || 'This site'));
    text.appendChild(
      el('span', null, ' looks like it runs PHP. Guard mode will block it on the next visit.')
    );

    var actions = el('span', 'actions');

    var allow = el('button', 'allow', 'Allow');
    allow.type = 'button';
    allow.addEventListener('click', function () {
      hideGuardBanner();
      if (banner.onAllow) banner.onAllow();
    });

    var leave = el('button', null, 'Leave');
    leave.type = 'button';
    leave.addEventListener('click', function () {
      if (banner.onLeave) banner.onLeave();
      else hideGuardBanner();
    });

    var close = el('button', null, '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', hideGuardBanner);

    actions.appendChild(allow);
    actions.appendChild(leave);
    actions.appendChild(close);

    bar.appendChild(text);
    bar.appendChild(actions);
    shadow.appendChild(style);
    shadow.appendChild(bar);
    document.documentElement.appendChild(host);

    banner.host = host;
    banner.onAllow = settings.onAllow || null;
    banner.onLeave = settings.onLeave || null;
  }

  var state = {
    host: null,
    refs: null,
    result: null,
    hidden: false,
    onClose: null,
    onSiteDismiss: null
  };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function ensure() {
    if (state.host && state.host.isConnected) return state.refs;

    var host = el('div');
    host.id = HOST_ID;
    // Sit a little higher on touch devices so Safari's bottom bar does not
    // cover the badge.
    var coarsePointer = false;
    try {
      coarsePointer = Boolean(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    } catch (error) {
      coarsePointer = false;
    }
    var offset = coarsePointer ? 26 : 16;
    host.style.cssText =
      'all:initial;position:fixed;right:calc(' + offset + 'px + env(safe-area-inset-right, 0px));' +
      'bottom:calc(' + offset + 'px + env(safe-area-inset-bottom, 0px));z-index:2147483647;display:block;';
    var shadow = host.attachShadow({ mode: 'open' });

    var style = el('style');
    style.textContent = CSS;

    var wrap = el('div', 'wrap');

    var panel = el('section', 'panel');
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'PHP Simple Check result');

    var head = el('div', 'panel-head');
    var panelEmoji = el('span', 'panel-emoji');
    var panelTitle = el('span', 'panel-title');
    var close = el('button', 'close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', function () {
      hide();
      if (state.onClose) state.onClose();
    });
    head.appendChild(panelEmoji);
    head.appendChild(panelTitle);
    head.appendChild(close);

    var summary = el('p', 'summary');
    var list = el('ul', 'signals');
    var facts = el('dl', 'facts');
    var note = el('p', 'note', 'Client-side checks only see signals. If PHP runs without leaving traces in the response, the result stays 🟢.');

    var siteDismiss = el('button', 'site-dismiss', 'Hide on this site');
    siteDismiss.type = 'button';
    siteDismiss.hidden = true;
    siteDismiss.addEventListener('click', function () {
      hide();
      if (state.onSiteDismiss) state.onSiteDismiss();
    });

    panel.appendChild(head);
    panel.appendChild(summary);
    panel.appendChild(list);
    panel.appendChild(facts);
    panel.appendChild(siteDismiss);
    panel.appendChild(note);

    var badge = el('button', 'badge');
    badge.type = 'button';
    badge.title = 'Click for details';
    var badgeEmoji = el('span', 'badge-emoji');
    var badgeLabel = el('span', 'badge-label');
    badge.appendChild(badgeEmoji);
    badge.appendChild(badgeLabel);
    badge.addEventListener('click', function () {
      panel.hidden = !panel.hidden;
    });

    wrap.appendChild(panel);
    wrap.appendChild(badge);
    shadow.appendChild(style);
    shadow.appendChild(wrap);

    document.documentElement.appendChild(host);

    state.host = host;
    state.refs = {
      shadow: shadow,
      wrap: wrap,
      panel: panel,
      panelEmoji: panelEmoji,
      panelTitle: panelTitle,
      summary: summary,
      list: list,
      facts: facts,
      siteDismiss: siteDismiss,
      badge: badge,
      badgeEmoji: badgeEmoji,
      badgeLabel: badgeLabel
    };
    return state.refs;
  }

  function weightClass(weight) {
    if (weight < 0) return 'weight negative';
    return weight >= 3 ? 'weight strong' : 'weight weak';
  }

  function renderSignals(refs, result) {
    refs.list.textContent = '';
    var signals = result.signals || [];
    if (!signals.length) {
      var empty = el('li');
      empty.appendChild(el('span', 'signal-label', 'No signals detected'));
      refs.list.appendChild(empty);
      return;
    }
    signals.forEach(function (signal) {
      var item = el('li');
      var weight = el('span', weightClass(signal.weight), (signal.weight > 0 ? '+' : '') + signal.weight);
      var body = el('span');
      body.appendChild(el('span', 'signal-label', signal.label));
      if (signal.detail) {
        var detail = el('span', 'signal-detail', signal.detail);
        body.appendChild(detail);
      }
      item.appendChild(weight);
      item.appendChild(body);
      refs.list.appendChild(item);
    });
  }

  function renderFacts(refs, result) {
    refs.facts.textContent = '';
    var facts = result.facts || {};
    var rows = [
      ['X-Powered-By', facts.xPoweredBy],
      ['Server', facts.server],
      ['generator', facts.generator],
      ['Cookie', (facts.cookies || []).slice(0, 4).join(', ')],
      ['.php', (facts.phpResources || [])[0] || (facts.phpAnchors || [])[0]]
    ];
    rows.forEach(function (row) {
      if (!row[1]) return;
      refs.facts.appendChild(el('dt', null, row[0]));
      refs.facts.appendChild(el('dd', null, row[1]));
    });
  }

  function render(result, options) {
    if (!result || !result.verdict) return;
    var refs = ensure();
    state.result = result;
    if (options && (options.onSiteDismiss || options.allowSiteDismiss)) {
      state.onSiteDismiss = options.onSiteDismiss || null;
      refs.siteDismiss.hidden = false;
    } else {
      refs.siteDismiss.hidden = true;
    }
    if (state.hidden) {
      state.host.style.display = 'none';
      return;
    }
    state.host.style.display = 'block';

    refs.badgeEmoji.textContent = result.emoji;
    refs.badgeLabel.textContent = result.short || result.label;
    refs.badge.style.borderColor = result.color;
    refs.badge.setAttribute('aria-label', result.emoji + ' ' + result.label + ' (show details)');
    refs.panelEmoji.textContent = result.emoji;
    refs.panelTitle.textContent = result.label;

    var count = (result.signals || []).filter(function (signal) { return signal.weight > 0; }).length;
    refs.summary.textContent =
      'Score ' + result.score + ' · ' + count + ' PHP signal' + (count === 1 ? '' : 's') +
      (result.confidence === 'high' ? ' · decisive signal' : '');

    renderSignals(refs, result);
    renderFacts(refs, result);
  }

  function hide() {
    state.hidden = true;
    if (state.host) state.host.style.display = 'none';
  }

  function show() {
    state.hidden = false;
    if (state.result) render(state.result);
  }

  function destroy() {
    if (state.host && state.host.parentNode) state.host.parentNode.removeChild(state.host);
    state.host = null;
    state.refs = null;
  }

  global.PHPSimpleCheckOverlay = {
    render: render,
    hide: hide,
    show: show,
    destroy: destroy,
    showGuardBanner: showGuardBanner,
    hideGuardBanner: hideGuardBanner,
    onClose: function (handler) { state.onClose = handler; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
