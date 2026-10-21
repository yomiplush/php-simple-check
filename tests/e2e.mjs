#!/usr/bin/env node
/**
 * End-to-end smoke test (no dependencies)
 *
 *   node tests/e2e.mjs
 *
 * Boots a tiny fixture server, launches headless Chrome with the unpacked
 * extension, then checks — via the DevTools Protocol — that
 *   1. the on-page badge shows the expected emoji, and
 *   2. the toolbar badge/title were painted by the service worker.
 *
 * Set CHROME_BIN to point at a different Chrome/Chromium binary.
 */
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}
const EXTENSION_DIR = process.env.EXTENSION_DIR
  ? path.resolve(process.env.EXTENSION_DIR)
  : path.join(ROOT, 'extension');
const CHROME = process.env.CHROME_BIN || 'google-chrome-stable';

const STATIC_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>static</title>
<script src="/static/app.js"></script></head>
<body><h1>Static site</h1><a href="/static/about">About</a></body></html>`;

const LEGACY_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>legacy</title></head>
<body><h1>Legacy links</h1><a href="/legacy/contact.php">Contact</a></body></html>`;

const HEADER_ONLY_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>header only</title></head>
<body><h1>Nothing but response headers</h1></body></html>`;

const PHP_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>php</title>
<link rel="stylesheet" href="/wp-content/themes/demo/style.css"></head>
<body><h1>WordPress-ish</h1><a href="/php/hello.php">hello</a></body></html>`;

const ROUTES = new Map([
  [
    '/static/',
    {
      headers: { 'content-type': 'text/html; charset=utf-8', server: 'nginx' },
      body: STATIC_PAGE
    }
  ],
  [
    '/legacy/',
    {
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: LEGACY_PAGE
    }
  ],
  [
    '/php/',
    {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'x-powered-by': 'PHP/8.2.13',
        'set-cookie': 'PHPSESSID=e2e-session; Path=/; HttpOnly'
      },
      body: PHP_PAGE
    }
  ],
  [
    '/header-only/',
    {
      headers: { 'content-type': 'text/html; charset=utf-8', 'x-powered-by': 'PHP/8.3.4', server: 'Apache' },
      body: HEADER_ONLY_PAGE
    }
  ],
  ['/static/app.js', { headers: { 'content-type': 'text/javascript' }, body: 'console.log("app");' }],
  ['/wp-content/themes/demo/style.css', { headers: { 'content-type': 'text/css' }, body: 'body{}' }]
]);

const CASES = [
  { path: '/static/', verdict: 'none', emoji: '🟢', badgeLabel: 'PHP 非検出', actionBadge: 'OK', panelTitle: 'PHP の兆候なし' },
  { path: '/legacy/', verdict: 'maybe', emoji: '🟡', badgeLabel: '要確認', actionBadge: '?', panelTitle: 'PHP の可能性あり（弱い兆候のみ）' },
  { path: '/php/', verdict: 'php', emoji: '🔴', badgeLabel: 'PHP 検出', actionBadge: 'PHP', panelTitle: 'PHP 使用の兆候あり' },
  { path: '/header-only/', verdict: 'php', emoji: '🔴', badgeLabel: 'PHP 検出', actionBadge: 'PHP', panelTitle: 'PHP 使用の兆候あり' }
];

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  console.error(`✖ ${message}`);
  process.exitCode = 1;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(label, check, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`timed out waiting for ${label}${lastError ? ` (${lastError.message})` : ''}`);
}

async function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('websocket failed')), { once: true });
  });

  let nextId = 0;
  const pending = new Map();

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      return;
    }
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });

  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  return { send, close: () => socket.close() };
}

async function main() {
  const fixture = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    const route = ROUTES.get(pathname) || (pathname.endsWith('/') ? ROUTES.get(pathname) : null);
    if (!route) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
    response.writeHead(200, route.headers);
    response.end(route.body);
  });
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${fixture.address().port}`;

  const profile = await mkdtemp(path.join(os.tmpdir(), 'php-simple-check-e2e-'));
  const port = await freePort();
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-translate',
      '--mute-audio',
      `--load-extension=${EXTENSION_DIR}`,
      `--disable-extensions-except=${EXTENSION_DIR}`,
      'about:blank'
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );

  let stderr = '';
  chrome.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const cleanup = async () => {
    chrome.kill('SIGKILL');
    await new Promise((resolve) => fixture.close(resolve));
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  };

  try {
    const version = await waitFor('DevTools endpoint', async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      return response.ok ? response.json() : null;
    });

    const client = await connect(version.webSocketDebuggerUrl);
    log(`chrome ${version.Browser}`);

    async function evaluate(sessionId, expression) {
      const { result, exceptionDetails } = await client.send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        sessionId
      );
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
      return result.value;
    }

    // Chrome ships component extensions with their own service workers, so the
    // target has to be identified by its manifest name rather than its URL.
    const extensionName = await readJson(path.join(EXTENSION_DIR, 'manifest.json')).then((m) => m.name);
    const worker = await waitFor(
      'extension service worker',
      async () => {
        const { targetInfos } = await client.send('Target.getTargets');
        for (const info of targetInfos.filter((target) => target.type === 'service_worker')) {
          const { sessionId } = await client.send('Target.attachToTarget', {
            targetId: info.targetId,
            flatten: true
          });
          const name = await evaluate(sessionId, 'chrome.runtime.getManifest().name').catch(() => null);
          if (name === extensionName) return { sessionId, url: info.url };
          await client.send('Target.detachFromTarget', { sessionId }).catch(() => {});
        }
        return null;
      },
      20000
    ).catch(() => {
      throw new Error(
        'extension service worker did not start.\n' +
        'Branded Chrome 137+ ignores --load-extension; point CHROME_BIN at Chrome for Testing.\n' +
        stderr.slice(-1500)
      );
    });
    const workerSession = worker.sessionId;
    log(`extension service worker is running (${worker.url.split('/')[2]})`);

    // Cookies are per-host, not per-document: clear them so each fixture is
    // judged on its own evidence.
    async function clearCookies(sessionId) {
      await client.send('Network.enable', {}, sessionId).catch(() => {});
      await client.send('Network.clearBrowserCookies', {}, sessionId).catch(() => {});
    }

    for (const testCase of CASES) {
      const url = origin + testCase.path;
      const { targetId } = await client.send('Target.createTarget', { url });
      const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
      await clearCookies(sessionId);

      const overlay = await waitFor(
        `overlay on ${testCase.path}`,
        async () => {
          const value = await evaluate(
            sessionId,
            `(() => {
               const host = document.getElementById('php-simple-check-badge');
               if (!host || !host.shadowRoot) return null;
               const pick = (selector) => {
                 const node = host.shadowRoot.querySelector(selector);
                 return node ? node.textContent : null;
               };
               return {
                 emoji: pick('.badge-emoji'),
                 badgeLabel: pick('.badge-label'),
                 panelTitle: pick('.panel-title')
               };
             })()`
          );
          return value && value.emoji ? value : null;
        },
        10000
      ).catch(async (error) => {
        await client.send('Target.closeTarget', { targetId }).catch(() => {});
        throw error;
      });

      const action = await evaluate(
        workerSession,
        `chrome.storage.session.get(null).then((all) => {
           const entry = Object.entries(all).find(([key, value]) =>
             key.startsWith('php-simple-check:tab:') && value.url === ${JSON.stringify(url)});
           if (!entry) return null;
           const tabId = Number(entry[0].slice(entry[0].lastIndexOf(':') + 1));
           return Promise.all([
             chrome.action.getBadgeText({ tabId }),
             chrome.action.getTitle({ tabId })
           ]).then(([text, title]) => ({
             text,
             title,
             verdict: entry[1].result && entry[1].result.verdict,
             score: entry[1].result && entry[1].result.score
           }));
         })`
      );

      const problems = [];
      if (overlay.emoji !== testCase.emoji) problems.push(`emoji ${overlay.emoji} != ${testCase.emoji}`);
      if (overlay.badgeLabel !== testCase.badgeLabel) problems.push(`badge ${overlay.badgeLabel} != ${testCase.badgeLabel}`);
      if (overlay.panelTitle !== testCase.panelTitle) problems.push(`panel ${overlay.panelTitle} != ${testCase.panelTitle}`);
      if (!action) problems.push('extension state missing for this tab');
      else {
        if (action.verdict !== testCase.verdict) problems.push(`verdict ${action.verdict} != ${testCase.verdict}`);
        if (action.text !== testCase.actionBadge) problems.push(`toolbar text ${action.text} != ${testCase.actionBadge}`);
        if (!action.title.startsWith(testCase.emoji)) problems.push(`toolbar title "${action.title}" lacks ${testCase.emoji}`);
      }

      if (problems.length) fail(`${testCase.path}: ${problems.join(', ')}`);
      else log(`✔ ${testCase.path} → ${testCase.emoji} ${testCase.badgeLabel} (toolbar "${action.text}")`);

      await client.send('Target.closeTarget', { targetId });
    }

    // ---- cold service worker: no stale evidence after a navigation ---------
    const navCase = await client.send('Target.createTarget', { url: origin + '/header-only/' });
    const { sessionId: navSession } = await client.send('Target.attachToTarget', {
      targetId: navCase.targetId,
      flatten: true
    });

    const readOverlay = () =>
      evaluate(
        navSession,
        `(() => {
           const host = document.getElementById('php-simple-check-badge');
           if (!host || !host.shadowRoot) return null;
           const pick = (selector) => {
             const node = host.shadowRoot.querySelector(selector);
             return node ? node.textContent : null;
           };
           return { emoji: pick('.badge-emoji'), badgeLabel: pick('.badge-label') };
         })()`
      );

    await waitFor('overlay on /header-only/ (navigation case)', async () => {
      const value = await readOverlay();
      return value && value.emoji === '🔴' ? value : null;
    });
    await clearCookies(navSession);

    const stopped = await client
      .send('ServiceWorker.stopAllWorkers')
      .then(() => ({ ok: true }))
      .catch((error) => ({ ok: false, error: error.message }));
    if (!stopped.ok) log(`· ServiceWorker.stopAllWorkers skipped (${stopped.error})`);

    await client.send('Page.enable', {}, navSession).catch(() => {});
    const navigation = await client
      .send('Page.navigate', { url: origin + '/static/' }, navSession)
      .catch((error) => ({ errorText: error.message }));
    if (navigation && navigation.errorText) log(`· Page.navigate reported: ${navigation.errorText}`);

    const afterNavigation = await waitFor(
      'overlay to turn green after navigating /header-only/ → /static/',
      async () => {
        const value = await readOverlay();
        return value && value.badgeLabel === 'PHP 非検出' ? value : null;
      },
      15000
    ).catch(() => null);

    if (!afterNavigation || afterNavigation.emoji !== '🟢') {
      const where = await evaluate(navSession, 'location.href').catch(() => '?');
      const shown = await readOverlay().catch(() => null);
      fail(
        `navigation /header-only/ → /static/ did not re-evaluate (at ${where}, badge ${JSON.stringify(shown)})`
      );
    } else {
      log('✔ navigation /header-only/ → /static/ re-evaluated to 🟢 (no stale evidence)');
    }
    await client.send('Target.closeTarget', { targetId: navCase.targetId }).catch(() => {});

    // ---- userscript path (Safari Userscripts / Tampermonkey) ----------------
    // The content script would paint the same badge, so turn its overlay off and
    // run the built userscript in the page world instead.
    await evaluate(workerSession, 'chrome.storage.local.set({ overlayEnabled: false })');
    const userscript = await readFile(path.join(ROOT, 'userscript/php-simple-check.user.js'), 'utf8');

    for (const testCase of CASES) {
      const url = origin + testCase.path;
      const { targetId } = await client.send('Target.createTarget', { url });
      const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
      await clearCookies(sessionId);

      await waitFor(`document ready on ${testCase.path}`, async () => {
        const state = await evaluate(sessionId, '({ ready: document.readyState, href: location.href })');
        return state && state.ready === 'complete' && state.href === url ? state : null;
      });

      await evaluate(sessionId, userscript);

      const overlay = await waitFor(
        `userscript overlay on ${testCase.path}`,
        async () => {
          const value = await evaluate(
            sessionId,
            `(() => {
               const host = document.getElementById('php-simple-check-badge');
               if (!host || !host.shadowRoot) return null;
               const pick = (selector) => {
                 const node = host.shadowRoot.querySelector(selector);
                 return node ? node.textContent : null;
               };
               return { emoji: pick('.badge-emoji'), badgeLabel: pick('.badge-label'), panelTitle: pick('.panel-title') };
             })()`
          );
          return value && value.emoji ? value : null;
        },
        10000
      ).catch(async (error) => {
        await client.send('Target.closeTarget', { targetId }).catch(() => {});
        throw error;
      });

      const problems = [];
      if (overlay.emoji !== testCase.emoji) problems.push(`emoji ${overlay.emoji} != ${testCase.emoji}`);
      if (overlay.badgeLabel !== testCase.badgeLabel) problems.push(`badge ${overlay.badgeLabel} != ${testCase.badgeLabel}`);
      if (overlay.panelTitle !== testCase.panelTitle) problems.push(`panel ${overlay.panelTitle} != ${testCase.panelTitle}`);

      if (problems.length) fail(`userscript ${testCase.path}: ${problems.join(', ')}`);
      else log(`✔ userscript ${testCase.path} → ${testCase.emoji} ${testCase.badgeLabel}`);

      await client.send('Target.closeTarget', { targetId });
    }

    // ---- mobile viewport (iPhone-sized Safari / Firefox for Android) --------
    {
      const url = origin + '/php/';
      const { targetId } = await client.send('Target.createTarget', { url });
      const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
      await clearCookies(sessionId);
      await client.send('Page.enable', {}, sessionId).catch(() => {});
      await client
        .send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }, sessionId)
        .catch(() => {});
      await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId).catch(() => {});
      await client.send('Page.reload', {}, sessionId).catch(() => {});

      await waitFor(`mobile document ready`, async () => {
        const state = await evaluate(sessionId, '({ ready: document.readyState, w: innerWidth })');
        return state && state.ready === 'complete' && state.w === 390 ? state : null;
      });

      await evaluate(sessionId, userscript);
      await waitFor('mobile overlay', async () => {
        const value = await evaluate(sessionId, `document.getElementById('php-simple-check-badge') ? true : null`);
        return value ? true : null;
      });

      const geometry = await evaluate(
        sessionId,
        `(() => {
           const host = document.getElementById('php-simple-check-badge');
           const root = host.shadowRoot;
           const rect = root.querySelector('.badge').getBoundingClientRect();
           return {
             left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
             width: rect.width, height: rect.height,
             center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
             dismissVisible: !root.querySelector('.site-dismiss').hidden,
             vw: innerWidth, vh: innerHeight,
             overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
           };
         })()`
      );

      const mobileProblems = [];
      if (geometry.right > geometry.vw + 0.5 || geometry.left < 0) mobileProblems.push('badge is clipped horizontally');
      if (geometry.bottom > geometry.vh + 0.5 || geometry.top < 0) mobileProblems.push('badge is clipped vertically');
      if (geometry.height < 30) mobileProblems.push(`badge tap target is only ${geometry.height}px tall`);
      if (!geometry.dismissVisible) mobileProblems.push('per-site dismiss control missing');
      if (geometry.overflow > 0) mobileProblems.push(`overlay causes ${geometry.overflow}px horizontal overflow`);

      // Tap it like a finger would.
      await client
        .send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: geometry.center.x, y: geometry.center.y }] }, sessionId)
        .catch(() => {});
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId).catch(() => {});

      const panel = await waitFor(
        'panel opens on tap',
        async () => {
          const value = await evaluate(
            sessionId,
            `(() => {
               const panel = document.getElementById('php-simple-check-badge').shadowRoot.querySelector('.panel');
               if (panel.hidden) return null;
               const rect = panel.getBoundingClientRect();
               return {
                 fitsX: rect.left >= 0 && rect.right <= innerWidth + 0.5,
                 fitsY: rect.top >= 0 && rect.bottom <= innerHeight + 0.5,
                 fitsContent: panel.scrollWidth <= panel.clientWidth + 1
               };
             })()`
          );
          return value && value.fitsX && value.fitsY && value.fitsContent ? value : null;
        },
        5000
      ).catch(() => null);

      if (!panel) mobileProblems.push('tapping the badge did not open a fully visible panel');

      const dismissed = await evaluate(
        sessionId,
        `(() => {
           const root = document.getElementById('php-simple-check-badge').shadowRoot;
           root.querySelector('.site-dismiss').click();
           const toast = document.querySelector('[data-php-simple-check-toast]');
           return {
             stored: window.localStorage.getItem('php-simple-check:hidden:' + location.hostname),
             display: document.getElementById('php-simple-check-badge').style.display,
             toast: Boolean(toast)
           };
         })()`
      );
      if (dismissed.stored !== '1') mobileProblems.push('per-site dismissal was not stored');
      if (dismissed.display !== 'none') mobileProblems.push('badge stayed visible after dismissal');
      if (!dismissed.toast) mobileProblems.push('undo toast did not appear');

      const undone = await evaluate(
        sessionId,
        `(() => {
           const toast = document.querySelector('[data-php-simple-check-toast]');
           if (!toast || !toast.shadowRoot) return null;
           toast.shadowRoot.querySelector('button').click();
           return {
             stored: window.localStorage.getItem('php-simple-check:hidden:' + location.hostname),
             display: document.getElementById('php-simple-check-badge').style.display
           };
         })()`
      );
      if (!undone || undone.stored !== null) mobileProblems.push('undo did not clear the stored preference');
      if (!undone || undone.display === 'none') mobileProblems.push('badge did not come back after undo');

      if (mobileProblems.length) fail(`mobile: ${mobileProblems.join(', ')}`);
      else log('✔ mobile 390x844: badge inside viewport, tap opens panel, per-site hide/undo works');

      await client.send('Target.closeTarget', { targetId }).catch(() => {});
    }

    await evaluate(workerSession, 'chrome.storage.local.set({ overlayEnabled: true })');

    client.close();
  } finally {
    await cleanup();
  }
}

main().catch(async (error) => {
  fail(error.message);
  process.exitCode = 1;
});
