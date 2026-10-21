/*!
 * PHP Simple Check — background service worker
 *
 * Responsibilities:
 *   1. Read the page observations reported by content.js (including the response
 *      headers obtained with one same-origin HEAD request).
 *   2. Add cookies when the build has the cookies API (the store build does
 *      not — it falls back to document.cookie).
 *   3. Run the shared detector, paint the toolbar icon/badge and answer the
 *      popup.
 *
 * Guard mode (blocking flagged hosts) only exists in builds that ship the
 * declarativeNetRequest permission; every guard entry point checks
 * CAPABILITIES.guard first, so the same source powers the minimal store build.
 */
'use strict';

importScripts('lib/detector.js', 'lib/i18n-data.js', 'lib/i18n.js');

const t = PHPSimpleCheckI18n.t;

const STATE_PREFIX = 'php-simple-check:tab:';
const MAX_TRACKED_TABS = 60;

/** APIs available in this build (the store build only has "storage"). */
const CAPABILITIES = {
  cookies: Boolean(typeof chrome.cookies !== 'undefined' && chrome.cookies && chrome.cookies.getAll),
  guard: Boolean(
    typeof chrome.declarativeNetRequest !== 'undefined' &&
    chrome.declarativeNetRequest &&
    chrome.declarativeNetRequest.updateDynamicRules
  )
};

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

const tabStates = new Map();
const evalTimers = new Map();

function blankState() {
  return {
    url: null,
    dom: null,
    result: null,
    iconState: 'idle',
    updatedAt: 0
  };
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
      [key]: { url: state.url, dom: state.dom, result: state.result, iconState: state.iconState }
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
      state.dom = saved.dom || null;
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

function scheduleEvaluation(tabId, delay) {
  const existing = evalTimers.get(tabId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(function () {
    evalTimers.delete(tabId);
    void evaluateTab(tabId);
  }, delay);
  evalTimers.set(tabId, timer);
}

/* ---------------------------------------------------------------- guard mode
 *
 * "Guard mode": once a site is judged 🔴, block that host on subsequent
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
  if (!CAPABILITIES.guard) return;

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
  if (!CAPABILITIES.guard) return;
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

/* ---------------------------------------------------------------- action UI */

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
      title: meta.emoji + ' ' + t('verdict.' + result.verdict) + ' — PHP Simple Check'
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
    await chrome.action.setTitle({ tabId: tabId, title: t('status.idle') });
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

/* ------------------------------------------------------------------ judging */

async function tabUrl(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab && tab.url ? tab.url : null;
  } catch (error) {
    return null;
  }
}

async function evaluateTab(tabId) {
  if (tabId == null || tabId < 0) return null;

  const state = await stateFor(tabId);
  const domPayload = state.dom && state.dom.url ? state.dom : null;

  // The content script supplies the URL: the store build has no host
  // permissions, so chrome.tabs.get() does not expose tab.url there.
  const pageUrl = (domPayload && domPayload.url) || state.url || (await tabUrl(tabId));
  if (!pageUrl || !/^https?:/i.test(pageUrl)) return null;

  const headers = domPayload && domPayload.headers ? domPayload.headers : null;

  let cookieNames = [];
  if (CAPABILITIES.cookies) {
    try {
      const cookies = await chrome.cookies.getAll({ url: pageUrl });
      cookieNames = cookies.map(function (cookie) { return cookie.name; });
    } catch (error) {
      /* restricted URL — fall back to what the page itself could read */
    }
  }
  if (!cookieNames.length && domPayload && Array.isArray(domPayload.cookieNames)) {
    cookieNames = domPayload.cookieNames;
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
  await maybeGuard(tabId, result, pageUrl);
  return result;
}

/* ------------------------------------------------------------------ messages */

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
      const currentUrl = await tabUrl(tabId);
      if (result && currentUrl && result.facts && result.facts.url &&
          withoutHash(result.facts.url) !== withoutHash(currentUrl)) {
        result = null; // the stored verdict belongs to a page the tab has left
      }
      if (!result && currentUrl) result = await evaluateTab(tabId);
      sendResponse({
        ok: true,
        result: result,
        url: state.url || currentUrl,
        capabilities: CAPABILITIES
      });
    })();
    return true;
  }

  if (type === 'php-simple-check:rescan') {
    const tabId = message.tabId;
    (async function () {
      const result = await evaluateTab(tabId);
      sendResponse({ ok: Boolean(result), result: result, capabilities: CAPABILITIES });
    })();
    return true;
  }

  if (type === 'php-simple-check:get-guard') {
    (async function () {
      sendResponse({ ok: true, guard: await readGuard(), capabilities: CAPABILITIES });
    })();
    return true;
  }

  if (type === 'php-simple-check:set-guard') {
    const requested = message.enabled === true;
    (async function () {
      if (!CAPABILITIES.guard) {
        sendResponse({ ok: false, error: 'unsupported', capabilities: CAPABILITIES });
        return;
      }
      const guard = await readGuard();
      guard.enabled = requested;
      await writeGuard(guard);
      await syncGuardRules();
      if (guard.enabled && message.tabId != null) await evaluateTab(message.tabId);
      sendResponse({ ok: true, guard: await readGuard(), capabilities: CAPABILITIES });
    })();
    return true;
  }

  if (type === 'php-simple-check:unblock-host') {
    const host = String(message.host || '');
    (async function () {
      if (!CAPABILITIES.guard) {
        sendResponse({ ok: false, error: 'unsupported' });
        return;
      }
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

  return undefined;
});

/* ----------------------------------------------------------------- lifecycle */

// A real navigation starts a new document: drop the previous document's DOM and
// reset the icon so a cold worker cannot show stale evidence.
// (status "loading" is not emitted for SPA pushState, so the verdict survives.)
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
  if (changeInfo.status !== 'loading') return;
  const state = tabStates.get(tabId);
  if (!state) return;
  state.url = null;
  state.dom = null;
  state.result = null;
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
