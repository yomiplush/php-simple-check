import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(path.join(ROOT, relative), 'utf8');
const readJson = async (relative) => JSON.parse(await read(relative));

const manifest = await readJson('extension/manifest.json');
const pkg = await readJson('package.json');

const locales = Object.fromEntries(
  await Promise.all(
    (await readdir(path.join(ROOT, 'locales')))
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map(async (file) => [file.replace(/\.json$/, ''), await readJson(`locales/${file}`)])
  )
);

function folderName(language) {
  const parts = language.split('-');
  return parts.length === 1 ? parts[0] : `${parts[0]}_${parts[1].toUpperCase()}`;
}

test('manifest and package.json agree on the version', () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
});

test('manifest is MV3 and localises its name through _locales', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, '__MSG_extName__');
  assert.equal(manifest.description, '__MSG_extDescription__');
  assert.equal(manifest.default_locale, 'en');
  assert.ok(manifest.background.service_worker);
  assert.ok(manifest.action.default_popup);
});

test('the full build only asks for the APIs it uses', () => {
  // Headers come from a same-origin HEAD request in the content script, so the
  // extension needs no webRequest access at all.
  assert.deepEqual(manifest.permissions, ['cookies', 'storage', 'declarativeNetRequest']);
  assert.ok(!manifest.permissions.includes('webRequest'));
});

test('_locales contains the manifest strings for every language', async () => {
  const languages = (await readdir(path.join(ROOT, 'locales')))
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.replace(/\.json$/, ''));

  assert.deepEqual(languages.sort(), Object.keys(locales).sort());
  for (const language of languages) {
    const messages = await readJson(`extension/_locales/${folderName(language)}/messages.json`);
    assert.equal(messages.extName.message, locales[language].extName, language);
    assert.ok(messages.extDescription.message.length > 10, language);
  }
});

test('every locale has exactly the English key set', () => {
  const english = Object.keys(locales.en).sort();
  for (const [language, table] of Object.entries(locales)) {
    assert.deepEqual(Object.keys(table).sort(), english, language);
    for (const [key, value] of Object.entries(table)) {
      assert.equal(typeof value, 'string', `${language}/${key}`);
      assert.ok(value.trim().length > 0, `${language}/${key} is empty`);
    }
  }
});

test('placeholders match between locales', () => {
  const placeholders = (text) => (text.match(/\{\w+\}/g) || []).sort().join(',');
  for (const [key, english] of Object.entries(locales.en)) {
    for (const [language, table] of Object.entries(locales)) {
      assert.equal(
        placeholders(table[key]),
        placeholders(english),
        `${language}/${key} placeholder mismatch`
      );
    }
  }
});

test('lib/i18n-data.js is generated from locales/*.json', async () => {
  const source = await read('extension/lib/i18n-data.js');
  const parsed = JSON.parse(source.slice(source.indexOf('{'), source.lastIndexOf('}') + 1));
  assert.deepEqual(parsed, locales);
});

test('every t() key used in the extension exists in English', async () => {
  const files = [
    'extension/background.js',
    'extension/content.js',
    'extension/popup.js',
    'extension/blocked.js',
    'extension/lib/overlay.js',
    'userscript/main.js'
  ];
  const used = new Set();
  for (const file of files) {
    const source = await read(file);
    for (const match of source.matchAll(/\bt\(\s*'([a-zA-Z0-9.]+)'/g)) used.add(match[1]);
    for (const match of source.matchAll(/t\(\s*(?:busy \?|guardEnabled \?)\s*'([a-zA-Z0-9.]+)'\s*:\s*'([a-zA-Z0-9.]+)'/g)) {
      used.add(match[1]);
      used.add(match[2]);
    }
  }
  assert.ok(used.size > 20, `expected many keys, found ${used.size}`);
  // Keys built at runtime ("verdict." + verdict) are validated below instead.
  const missing = [...used].filter((key) => !key.endsWith('.') && !(key in locales.en));
  assert.deepEqual(missing, []);

  for (const verdict of ['php', 'maybe', 'none']) {
    for (const suffix of ['', '.short']) {
      assert.ok(`verdict.${verdict}${suffix}` in locales.en, `verdict.${verdict}${suffix}`);
    }
  }
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

test('status icon variants exist for every verdict and size', async () => {
  for (const state of ['php', 'maybe', 'none']) {
    for (const size of [16, 32, 48, 128]) {
      const png = await readFile(path.join(ROOT, 'extension', `icons/status-${state}-${size}.png`));
      assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `status-${state}-${size}.png`);
      assert.equal(png.readUInt32BE(16), size);
      assert.equal(png.readUInt32BE(20), size);
    }
  }
});

test('the worker maps every verdict to its icon set', async () => {
  const background = await read('extension/background.js');
  for (const state of ['php', 'maybe', 'none']) {
    for (const size of [16, 32, 48, 128]) {
      assert.ok(background.includes(`icons/status-${state}-${size}.png`), `missing ${state}/${size}`);
    }
  }
  assert.ok(background.includes('chrome.action.setIcon'));
});

const RAW_BASE = 'https://raw.githubusercontent.com/yomiplush/php-simple-check/main';

const USERSCRIPTS = [
  { file: 'php-simple-check.user.js', suffix: '' },
  { file: 'php-simple-check-ios.user.js', suffix: ' (iOS)' },
  { file: 'php-simple-check-android.user.js', suffix: ' (Android)' }
];

test('every committed userscript matches its sources and metadata', async () => {
  const main = (await read('userscript/main.js')).replace(/\s+$/, '');

  for (const variant of USERSCRIPTS) {
    const userscript = await read(`userscript/${variant.file}`);

    assert.ok(userscript.startsWith('// ==UserScript=='), `${variant.file} must start with the metadata block`);
    assert.ok(userscript.includes('// ==/UserScript=='));
    const english = locales.en;
  assert.ok(userscript.includes(`// @name         ${english.extName}${variant.suffix || ''}`));
    assert.ok(userscript.includes(`// @version      ${manifest.version}`));
    assert.ok(userscript.includes(`// @updateURL    ${RAW_BASE}/userscript/${variant.file}`));
    assert.ok(userscript.includes(`// @downloadURL  ${RAW_BASE}/userscript/${variant.file}`));
    assert.ok(userscript.includes('// @match        https://*/*'));
    assert.ok(userscript.includes('// @grant        none'));
    assert.ok(userscript.includes('// @noframes'));

    for (const lib of ['detector.js', 'i18n-data.js', 'i18n.js', 'collect-dom.js', 'overlay.js']) {
      const source = (await read(`extension/lib/${lib}`)).replace(/\s+$/, '');
      assert.ok(userscript.includes(source), `${lib} is stale in ${variant.file} — run npm run build`);
    }
    assert.ok(userscript.includes(main), `userscript/main.js is stale in ${variant.file} — run npm run build`);
  }
});

test('platform variants differ only in the metadata block', async () => {
  const bodies = [];
  for (const variant of USERSCRIPTS) {
    const text = await read(`userscript/${variant.file}`);
    const marker = '// ==/UserScript==';
    bodies.push(text.slice(text.indexOf(marker) + marker.length));
  }
  assert.equal(new Set(bodies).size, 1, 'variants must share the same implementation');
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
