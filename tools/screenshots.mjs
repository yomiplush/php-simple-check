#!/usr/bin/env node
/**
 * Store screenshot generator
 *
 *   CHROME_BIN=/path/to/chrome node tools/screenshots.mjs
 *
 * Serves two fixture pages, opens them with the store build and captures
 * 1280×800 PNGs (the size the Chrome Web Store asks for) into docs/store/.
 * Run `npm run build` first so dist/store/php-simple-check exists.
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_BIN || 'google-chrome-stable';
const EXTENSION_DIR = process.env.EXTENSION_DIR || path.join(ROOT, 'dist', 'store', 'php-simple-check');
const OUT_DIR = path.join(ROOT, 'docs', 'store');
const WIDTH = 1280;
const HEIGHT = 800;

const LAYOUT = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body{margin:0;font:16px/1.7 -apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;color:#111827;background:#f8fafc}
  .bar{height:56px;display:flex;align-items:center;padding:0 28px;background:#fff;border-bottom:1px solid #e5e7eb;font-weight:700}
  main{max-width:760px;margin:0 auto;padding:48px 24px}
  h1{font-size:30px;margin:0 0 16px}
  p{color:#374151;margin:0 0 14px}
  .card{margin-top:28px;padding:20px;border:1px solid #e5e7eb;border-radius:12px;background:#fff}
  a{color:#2563eb}
</style></head>
<body><div class="bar">${title}</div><main>${body}</main></body></html>`;

const PAGES = {
  '/php/': [
    'Example Shop',
    `<h1>Example Shop</h1>
     <p>An ordinary storefront page. It is rendered by a PHP application behind a reverse
        proxy, which is exactly what this extension reports.</p>
     <p>Open the badge in the bottom-right corner to see the individual signals that
        produced the verdict, including the response header and the session cookie name.</p>
     <div class="card"><strong>Demo store</strong><br>Cart · Orders · Support</div>`
  ],
  '/static/': [
    'Example Docs',
    `<h1>Example Docs</h1>
     <p>A statically generated documentation site. Its responses carry no PHP signals,
        so the verdict here is green.</p>
     <p>The popup and the badge list what was actually observed — which is often nothing,
        and that is a valid result.</p>
     <div class="card"><strong>Getting started</strong><br>Install · Configure · Deploy</div>`
  ]
};

function log(message) {
  process.stdout.write(`${message}\n`);
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await wait(150);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? ` (${lastError.message})` : ''}`);
}

async function freePort() {
  const net = await import('node:net');
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
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
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });

  return {
    send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      });
    },
    close() {
      socket.close();
    }
  };
}

async function main() {
  await readFile(path.join(EXTENSION_DIR, 'manifest.json'), 'utf8').catch(() => {
    throw new Error(`${EXTENSION_DIR} is missing — run npm run build first`);
  });

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const page = PAGES[url.pathname];
    if (!page) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
    const headers = { 'content-type': 'text/html; charset=utf-8' };
    if (url.pathname === '/php/') {
      headers['x-powered-by'] = 'PHP/8.3.4';
      headers['set-cookie'] = 'PHPSESSID=demo-session; Path=/; HttpOnly';
    }
    response.writeHead(200, headers);
    response.end(LAYOUT(page[0], page[1]));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const profile = await mkdtemp(path.join(os.tmpdir(), 'php-simple-check-shots-'));
  const port = await freePort();
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      `--load-extension=${EXTENSION_DIR}`,
      `--disable-extensions-except=${EXTENSION_DIR}`,
      'about:blank'
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );

  const cleanup = async () => {
    chrome.kill('SIGKILL');
    await new Promise((resolve) => server.close(resolve));
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

    await mkdir(OUT_DIR, { recursive: true });

    const shots = [
      { file: 'screenshot-1.png', path: '/php/' },
      { file: 'screenshot-2.png', path: '/static/' }
    ];

    for (const shot of shots) {
      const { targetId } = await client.send('Target.createTarget', { url: origin + shot.path });
      const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });

      await client.send('Emulation.setDeviceMetricsOverride', {
        width: WIDTH,
        height: HEIGHT,
        deviceScaleFactor: 1,
        mobile: false
      }, sessionId);

      await waitFor(`overlay on ${shot.path}`, async () => {
        const ready = await evaluate(
          sessionId,
          `(() => {
             const host = document.getElementById('php-simple-check-badge');
             if (!host || !host.shadowRoot) return false;
             return Boolean(host.shadowRoot.querySelector('.badge-label').textContent);
           })()`
        );
        return ready ? true : null;
      });

      // Open the breakdown panel so the screenshot shows what the extension does.
      await evaluate(
        sessionId,
        `document.getElementById('php-simple-check-badge').shadowRoot.querySelector('.badge').click()`
      );
      await wait(400);

      const { data } = await client.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      await writeFile(path.join(OUT_DIR, shot.file), Buffer.from(data, 'base64'));
      log(`wrote docs/store/${shot.file} (${WIDTH}×${HEIGHT})`);

      await client.send('Target.closeTarget', { targetId });
    }

    client.close();
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(`screenshots failed: ${error.message}`);
  process.exitCode = 1;
});
