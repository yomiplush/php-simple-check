import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(path.join(ROOT, relative), 'utf8');
const readJson = async (relative) => JSON.parse(await read(relative));

const manifest = await readJson('extension/manifest.json');
const pkg = await readJson('package.json');

test('manifest and package.json agree on the version', () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
});

test('manifest is MV3 and declares the permissions the design needs', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.permissions.includes('webRequest'), 'reads response headers');
  assert.ok(manifest.permissions.includes('cookies'), 'reads HttpOnly session cookies');
  assert.ok(manifest.host_permissions.includes('https://*/*'));
  assert.ok(manifest.background.service_worker);
  assert.ok(manifest.action.default_popup);
});

test('every manifest-referenced file exists', async () => {
  const referenced = new Set();
  const collect = (value) => {
    if (!value) return;
    if (typeof value === 'string') referenced.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else Object.values(value).forEach(collect);
  };
  collect(manifest.background && manifest.background.service_worker);
  collect(manifest.action && manifest.action.default_popup);
  collect(manifest.action && manifest.action.default_icon);
  collect(manifest.icons);
  manifest.content_scripts.forEach((script) => collect(script.js));

  for (const relative of referenced) {
    await stat(path.join(ROOT, 'extension', relative));
  }
  assert.ok(referenced.size >= 8);
});

test('icons are real PNG files', async () => {
  for (const size of [16, 32, 48, 128]) {
    const png = await readFile(path.join(ROOT, 'extension', `icons/icon${size}.png`));
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
});

test('the committed userscript matches its sources and metadata', async () => {
  const userscript = await read('userscript/php-simple-check.user.js');

  assert.ok(userscript.startsWith('// ==UserScript=='), 'userscript must start with the metadata block');
  assert.ok(userscript.includes('// ==/UserScript=='));
  assert.ok(userscript.includes(`// @version      ${manifest.version}`));
  assert.ok(userscript.includes('// @match        https://*/*'));
  assert.ok(userscript.includes('// @grant        none'));
  assert.ok(userscript.includes('// @noframes'));

  for (const lib of ['detector.js', 'collect-dom.js', 'overlay.js']) {
    const source = (await read(`extension/lib/${lib}`)).replace(/\s+$/, '');
    assert.ok(userscript.includes(source), `${lib} is stale — run npm run build`);
  }
  const main = (await read('userscript/main.js')).replace(/\s+$/, '');
  assert.ok(userscript.includes(main), 'userscript/main.js is stale — run npm run build');
});

test('the detection core has no browser-only dependencies', async () => {
  const detector = await read('extension/lib/detector.js');
  // Strings may mention window.* in user-facing details; code must not touch it.
  const code = detector.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  assert.ok(!/\bdocument\./.test(code));
  assert.ok(!/\bwindow\./.test(code));
  assert.ok(!/\bchrome\./.test(code));
  assert.ok(!/\bfetch\(/.test(code));
});

test('the collector is defensive about page access', async () => {
  const collector = await read('extension/lib/collect-dom.js');
  assert.ok(collector.includes('try {'), 'DOM access should be guarded');
  assert.ok(!collector.includes('innerHTML'), 'page markup must never be injected');
});
