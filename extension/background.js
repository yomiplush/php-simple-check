/*!
 * PHP Simple Check — background service worker
 *
 * Responsibilities:
 *   1. Observe main_frame response headers (X-Powered-By, Server, Set-Cookie, …).
 *   2. Collect cookies for the tab URL (including HttpOnly ones) via chrome.cookies.
 *   3. Merge those with the DOM observations sent by content.js, run the shared
 *      detector, then paint the toolbar badge (🔴/🟡/🟢) and tell the page.
 */
'use strict';

importScripts('lib/detector.js');

const STATE_PREFIX = 'php-simple-check:tab:';
const MAX_TRACKED_TABS = 60;

/** The action icon itself shows the verdict, so the toolbar reads at a glance. */
const STATUS_ICONS = {
  idle: {
    16: 'icons/icon16.png',
    32: 'icons/icon32.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png'
  },
  php: {
    16: 'icons/status-php-16.png',
    32: 'icons/status-php-32.png',
    48: 'icons/status-php-48.png',
    128: 'icons/status-php-128.png'
  },
  maybe: {
    16: 'icons/status-maybe-16.png',
    32: 'icons/status-maybe-32.png',
    48: 'icons/status-maybe-48.png',
    128: 'icons/status-maybe-128.png'
  },
  none: {
    16: 'icons/status-none-16.png',
    32: 'icons/status-none-32.png',
    48: 'icons/status-none-48.png',
    128: 'icons/status-none-128.png'
  }
};

const IDLE_TITLE = 'PHP Simple Check — 判定中…';

const CAPTURED_HEADERS = new Set(['x-powered-by', 'server', 'set-cookie', 'x-generator']);
const CAPTURED_PREFIXES = ['x-drupal', 'x-typo3', 'x-symfony', 'x-debug-token', 'x-laravel', 'x-php', 'x-csrf'];

const tabStates = new Map();
const evalTimers = new Map();

/* ------------------------------------------------------------- guard mode */
/*
 * "警戒モード": once a site is judged 🔴, block that host on subsequent
 * navigations with a dynamic declarativeNetRequest rule that redirects the main
 * frame to blocked.html. A response cannot be inspected before it is delivered,
 * so the current load always completes — the guard kicks in from the next one.
 */
const GUARD_DEFAULTS = {
  guardEnabled: false,
  blockedHosts: {},
  allowedHosts: []
};

async function readGuard() {
  try {
    const stored = await chrome.storage.local.get(GUARD_DEFAULTS);
    return {
      enabled: stored.guardEnabled === true,
      blocked: stored.blockedHosts && typeof stored.blockedHosts === 'object' ? stored.blockedHosts : {},
      allowed: Array.isArray(stored.allowedHosts) ? stored.allowedHosts.slice() : []
    };
  } catch (error) {
    return { enabled: false, blocked: {}, allowed: [] };
  }
}

async function writeGuard(guard) {
  await chrome.storage.local.set({
    guardEnabled: guard.enabled,
    blockedHosts: guard.blocked,
    allowedHosts: guard.allowed
  });
}

async function syncGuardRules() {
  let existing = [];
  try {
    existing = await chrome.declarativeNetRequest.getDynamicRules();
  } catch (error) {
    return;
  }

  const guard = await readGuard();
  const hosts = guard.enabled ? Object.keys(guard.blocked).sort() : [];
  const addRules = hosts.map(function (host, index) {
    return {
      id: index + 1,
      priority: 1,
      action: {
        type: 'redirect',
        redirect: {
          url: chrome.runtime.getURL('blocked.html') + '?host=' + encodeURIComponent(host)
        }
      },
      condition: { requestDomains: [host], resourceTypes: ['main_frame'] }
    };
  });

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map(function (rule) { return rule.id; }),
      addRules: addRules
    });
  } catch (error) {
    console.error('[PHP Simple Check] could not update guard rules', error);
  }
}

async function maybeGuard(tabId, result, pageUrl) {
  if (!result || result.verdict !== 'php') return;

  const guard = await readGuard();
  if (!guard.enabled) return;

  let host = '';
  try {
    host = new URL(pageUrl).hostname;
  } catch (error) {
    return;
  }
  if (!host || guard.allowed.indexOf(host) !== -1 || guard.blocked[host]) return;

  guard.blocked[host] = {
    url: pageUrl,
    score: result.score,
    at: Date.now(),
    signals: result.signals
      .filter(function (signal) { return signal.weight > 0; })
      .slice(0, 5)
      .map(function (signal) { return { label: signal.label, weight: signal.weight }; })
  };

  await writeGuard(guard);
  await syncGuardRules();
  notifyContent(tabId, { type: 'php-simple-check:guarded', host: host, url: pageUrl });
}

function blankState() {
  return {
    url: null,
    headers: null,
    headersDocumentId: null,
    dom: null,
    result: null,
    iconState: 'idle',
    probedDocumentId: null,
    probedFallback: false,
    updatedAt: 0
  };
}

function shouldCapture(name) {
  if (CAPTURED_HEADERS.has(name)) return true;
  return CAPTURED_PREFIXES.some(function (prefix) { return name.indexOf(prefix) === 0; });
}

function trimStates() {
  if (tabStates.size <= MAX_TRACKED_TABS) return;
  const oldest = Array.from(tabStates.entries())
    .sort(function (a, b) { return a[1].updatedAt - b[1].updatedAt; })
    .slice(0, tabStates.size - MAX_TRACKED_TABS);
  oldest.forEach(function (entry) { tabStates.delete(entry[0]); });
}

async function persistState(tabId, state) {
  try {
    const key = STATE_PREFIX + tabId;
    if (!state.url) {
      await chrome.storage.session.remove(key);
      return;
    }
    await chrome.storage.session.set({
      [key]: {
        url: state.url,
        headers: state.headers,
        headersDocumentId: state.headersDocumentId,
        result: state.result,
        iconState: state.iconState
      }
    });
  } catch (error) {
    /* session storage is best-effort */
  }
}

async function stateFor(tabId) {
  const cached = tabStates.get(tabId);
  if (cached) return cached;

  const state = blankState();
  try {
    const key = STATE_PREFIX + tabId;
    const stored = await chrome.storage.session.get(key);
    const saved = stored[key];
    if (saved && typeof saved === 'object') {
      state.url = saved.url || null;
      state.headers = saved.headers || null;
      state.headersDocumentId = saved.headersDocumentId || null;
      state.result = saved.result || null;
      state.iconState = saved.iconState || 'idle';
    }
  } catch (error) {
    /* fall back to a blank state */
  }
  tabStates.set(tabId, state);
  trimStates();
  return state;
}

/**
 * webRequest events do not wake a suspended MV3 service worker, so response
 * headers can be missed on a cold start (e.g. the first page after install).
 * A same-origin HEAD request recovers the same evidence at the cost of one
 * extra request — and mirrors what the userscript does.
 */
const probeCache = new Map();

function probeHeaders(url) {
  const cached = probeCache.get(url);
  if (cached) return cached;

  const pending = fetch(url, {
    method: 'HEAD',
    credentials: 'include',
    cache: 'no-store',
    redirect: 'follow'
  })
    .then(function (response) {
      if (!response.ok) return null;
      const headers = {};
      response.headers.forEach(function (value, name) {
        const key = name.toLowerCase();
        (headers[key] = headers[key] || []).push(value);
      });
      return Object.keys(headers).length ? headers : null;
    })
    .catch(function () {
      return null;
    });

  probeCache.set(url, pending);
  setTimeout(function () { probeCache.delete(url); }, 30000);
  return pending;
}

function withoutHash(url) {
  const index = url.indexOf('#');
  return index === -1 ? url : url.slice(0, index);
}

function scheduleEvaluation(tabId, delay) {
  const existing = evalTimers.get(tabId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(function () {
    evalTimers.delete(tabId);
    void evaluateTab(tabId);
  }, delay);
  evalTimers.set(tabId, timer);
}

async function applyBadge(tabId, result) {
  const meta = PHPSimpleCheck.verdicts[result.verdict];
  if (!meta) return;
  try {
    await chrome.action.setIcon({
      tabId: tabId,
      path: STATUS_ICONS[result.verdict] || STATUS_ICONS.idle
    });
    await chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: meta.color });
    await chrome.action.setBadgeText({ tabId: tabId, text: meta.badge });
    await chrome.action.setTitle({
      tabId: tabId,
      title: meta.emoji + ' ' + meta.label + ' — PHP Simple Check'
    });
  } catch (error) {
    /* tab closed while we were working */
  }
}

/** Back to the neutral icon while a new document is loading. */
async function resetAction(tabId) {
  try {
    await chrome.action.setIcon({ tabId: tabId, path: STATUS_ICONS.idle });
    await chrome.action.setBadgeText({ tabId: tabId, text: '' });
    await chrome.action.setTitle({ tabId: tabId, title: IDLE_TITLE });
  } catch (error) {
    /* tab closed while we were working */
  }
}

function notifyContent(tabId, message) {
  if (!message || !message.type) return;
  try {
    const sending = chrome.tabs.sendMessage(tabId, message);
    if (sending && typeof sending.catch === 'function') sending.catch(function () {});
  } catch (error) {
    /* no content script on this page */
  }
}

async function evaluateTab(tabId) {
  if (tabId == null || tabId < 0) return null;

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (error) {
    return null;
  }
  if (!tab || !tab.url || !/^https?:/i.test(tab.url)) return null;

  const state = await stateFor(tabId);
  const domPayload = state.dom && state.dom.url ? state.dom : null;
  // The tab URL is authoritative: SPA history changes keep it current, and a
  // stale DOM payload must not move the verdict to another page.
  const pageUrl = tab.url || (domPayload && domPayload.url) || state.url;

  let cookieNames = [];
  try {
    const cookies = await chrome.cookies.getAll({ url: pageUrl });
    cookieNames = cookies.map(function (cookie) { return cookie.name; });
  } catch (error) {
    /* restricted URL — fall back to what the page itself could read */
  }
  if (!cookieNames.length && domPayload && Array.isArray(domPayload.cookieNames)) {
    cookieNames = domPayload.cookieNames;
  }

  // Headers are only trustworthy when they belong to the document we are
  // judging. webRequest tags them with details.documentId, the content script
  // reports its own via sender.documentId; anything else is re-probed once.
  const documentId = domPayload ? domPayload.documentId : null;
  let headers = state.headers;
  if (headers && !Object.keys(headers).length) headers = null;
  if (headers && documentId) {
    if (state.headersDocumentId !== documentId) headers = null;
  } else if (headers) {
    // No document id yet (popup opened, or the worker restarted): only trust
    // headers captured for exactly this URL.
    if (!state.url || withoutHash(state.url) !== withoutHash(pageUrl)) headers = null;
  }

  if (!headers && documentId && state.probedDocumentId !== documentId) {
    state.probedDocumentId = documentId;
    headers = await probeHeaders(pageUrl);
    if (headers) {
      state.headers = headers;
      state.headersDocumentId = documentId;
      state.url = pageUrl;
      void persistState(tabId, state);
    }
  } else if (!headers && !documentId && !state.probedFallback) {
    state.probedFallback = true;
    headers = await probeHeaders(pageUrl);
    if (headers) {
      state.headers = headers;
      state.url = pageUrl;
      void persistState(tabId, state);
    }
  }

  let result;
  try {
    result = PHPSimpleCheck.evaluate({
      url: pageUrl,
      headers: headers,
      cookieNames: cookieNames,
      dom: domPayload ? domPayload.dom : null
    });
  } catch (error) {
    console.error('[PHP Simple Check] evaluation failed', error);
    return null;
  }
  result.tabId = tabId;

  state.result = result;
  state.iconState = result.verdict;
  state.url = pageUrl;
  state.updatedAt = Date.now();
  void persistState(tabId, state);

  await applyBadge(tabId, result);
  notifyContent(tabId, { type: 'php-simple-check:result', result: result });
  if (result.verdict === 'php') await maybeGuard(tabId, result, pageUrl);
  return result;
}

/* ------------------------------------------------------------------ listeners */

chrome.webRequest.onBeforeRequest.addListener(
  function (details) {
    if (details.tabId < 0 || details.type !== 'main_frame') return;
    const state = blankState();
    state.url = details.url;
    state.updatedAt = Date.now();
    tabStates.set(details.tabId, state);
    void persistState(details.tabId, state);
    void resetAction(details.tabId);
  },
  { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] }
);

chrome.webRequest.onHeadersReceived.addListener(
  function (details) {
    if (details.tabId < 0 || details.type !== 'main_frame') return;
    if (details.statusCode >= 300 && details.statusCode < 400) return;

    const headers = {};
    (details.responseHeaders || []).forEach(function (header) {
      const name = String(header.name || '').toLowerCase();
      if (!shouldCapture(name) || header.value == null) return;
      const bucket = headers[name] || (headers[name] = []);
      bucket.push(String(header.value));
    });

    const state = tabStates.get(details.tabId) || blankState();
    state.url = details.url;
    state.headers = headers;
    state.headersDocumentId = details.documentId || null;
    state.updatedAt = Date.now();
    tabStates.set(details.tabId, state);
    void persistState(details.tabId, state);

    scheduleEvaluation(details.tabId, 1500);
  },
  { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] },
  ['responseHeaders', 'extraHeaders']
);

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || typeof message !== 'object') return undefined;
  const type = message.type;

  if (type === 'php-simple-check:dom') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) {
      sendResponse({ ok: false });
      return undefined;
    }
    (async function () {
      const state = await stateFor(tabId);
      const payload = message.payload || null;
      state.dom = payload ? Object.assign({}, payload, { documentId: sender.documentId || null }) : null;
      state.updatedAt = Date.now();
      const result = await evaluateTab(tabId);
      sendResponse({ ok: Boolean(result), result: result });
    })();
    return true;
  }

  if (type === 'php-simple-check:get-result') {
    const tabId = message.tabId;
    (async function () {
      const state = await stateFor(tabId);
      let result = state.result || null;
      let currentUrl = null;
      try {
        const tab = await chrome.tabs.get(tabId);
        currentUrl = tab && tab.url ? tab.url : null;
      } catch (error) {
        /* tab closed */
      }
      if (result && currentUrl && result.facts && result.facts.url &&
          withoutHash(result.facts.url) !== withoutHash(currentUrl)) {
        result = null; // the stored verdict belongs to a page the tab has left
      }
      if (!result && currentUrl) result = await evaluateTab(tabId);
      sendResponse({
        ok: true,
        result: result,
        url: state.url || currentUrl,
        headers: state.headers || null
      });
    })();
    return true;
  }

  if (type === 'php-simple-check:get-guard') {
    (async function () {
      sendResponse({ ok: true, guard: await readGuard() });
    })();
    return true;
  }

  if (type === 'php-simple-check:set-guard') {
    (async function () {
      const guard = await readGuard();
      guard.enabled = message.enabled === true;
      await writeGuard(guard);
      await syncGuardRules();
      if (guard.enabled && message.tabId != null) await evaluateTab(message.tabId);
      sendResponse({ ok: true, guard: await readGuard() });
    })();
    return true;
  }

  if (type === 'php-simple-check:unblock-host') {
    const host = String(message.host || '');
    (async function () {
      const guard = await readGuard();
      if (host && guard.blocked[host]) {
        delete guard.blocked[host];
        await writeGuard(guard);
        await syncGuardRules();
      }
      sendResponse({ ok: true, guard: await readGuard() });
    })();
    return true;
  }

  if (type === 'php-simple-check:allow-host') {
    const host = String(message.host || '');
    (async function () {
      const guard = await readGuard();
      let url = 'https://' + host + '/';
      if (host) {
        if (guard.blocked[host]) {
          if (guard.blocked[host].url) url = guard.blocked[host].url;
          delete guard.blocked[host];
        }
        if (guard.allowed.indexOf(host) === -1) guard.allowed.push(host);
        await writeGuard(guard);
        await syncGuardRules();
      }
      sendResponse({ ok: Boolean(host), url: url, guard: await readGuard() });
    })();
    return true;
  }

  if (type === 'php-simple-check:unallow-host') {
    const host = String(message.host || '');
    (async function () {
      const guard = await readGuard();
      const index = guard.allowed.indexOf(host);
      if (index !== -1) {
        guard.allowed.splice(index, 1);
        await writeGuard(guard);
      }
      sendResponse({ ok: true, guard: await readGuard() });
    })();
    return true;
  }

  if (type === 'php-simple-check:rescan') {
    const tabId = message.tabId;
    (async function () {
      const result = await evaluateTab(tabId);
      sendResponse({ ok: Boolean(result), result: result });
    })();
    return true;
  }

  return undefined;
});

// A real navigation starts a new document: drop the previous document's
// headers/DOM so a cold service worker cannot reuse stale evidence.
// (status "loading" is not emitted for SPA pushState, so headers survive those.)
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
  if (changeInfo.status !== 'loading') return;
  const state = tabStates.get(tabId);
  if (!state) return;
  state.url = null;
  state.headers = null;
  state.headersDocumentId = null;
  state.dom = null;
  state.result = null;
  state.probedDocumentId = null;
  state.probedFallback = false;
  state.iconState = 'idle';
  state.updatedAt = Date.now();
  void persistState(tabId, state);
  void resetAction(tabId);
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  tabStates.delete(tabId);
  const timer = evalTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
    evalTimers.delete(tabId);
  }
  try {
    void chrome.storage.session.remove(STATE_PREFIX + tabId);
  } catch (error) {
    /* ignore */
  }
});

chrome.runtime.onInstalled.addListener(function () {
  (async function () {
    try {
      const settings = await chrome.storage.local.get({ overlayEnabled: true });
      await chrome.storage.local.set({ overlayEnabled: settings.overlayEnabled !== false });
    } catch (error) {
      /* ignore */
    }
    await syncGuardRules();
  })();
});

chrome.runtime.onStartup.addListener(function () {
  void syncGuardRules();
});
