#!/usr/bin/env node
/**
 * Build script
 *
 *   node tools/build.mjs
 *
 * 1. Generates the translation table (extension/lib/i18n-data.js) and Chrome's
 *    _locales/* from locales/*.json.
 * 2. Verifies every file the manifest references exists.
 * 3. Regenerates the userscripts from extension/lib/* plus userscript/main.js.
 * 4. Produces dist/:
 *      extension/                     unpacked "full" build (cookies + guard)
 *      php-simple-check-extension-*.zip
 *      store/php-simple-check/        store build: permissions = ["storage"]
 *      php-simple-check-store-*.zip   flat zip ready for the Web Store console
 *      *.user.js                      generic / iOS / Android userscripts
 *
 * No dependencies — a fresh clone can build with Node alone.
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createZip } from './zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = path.join(ROOT, 'extension');
const USERSCRIPT_DIR = path.join(ROOT, 'userscript');
const LOCALES_DIR = path.join(ROOT, 'locales');
const DIST_DIR = path.join(ROOT, 'dist');

const REPO_SLUG = 'yomiplush/php-simple-check';
const BRANCH = 'main';
const RAW_BASE = `https://raw.githubusercontent.com/${REPO_SLUG}/${BRANCH}`;

const USERSCRIPT_LIBS = ['detector.js', 'i18n-data.js', 'i18n.js', 'collect-dom.js', 'overlay.js'];

/** Guard-only files, removed from the store build (no declarativeNetRequest). */
const GUARD_ONLY_FILES = ['blocked.html', 'blocked.js', 'blocked.css'];

/**
 * Regions marked with @store-strip are removed from the store copy, so the
 * package it uploads contains only the code it can actually run.
 */
const STORE_STRIP_MARKERS = /^\s*(?:\/\/|<!--) @store-strip-(?:start|end)(?: -->)?\s*$/gm;

/** Nesting-aware removal of @store-strip regions (keeps the line structure). */
function stripStoreRegions(text) {
  const kept = [];
  let depth = 0;
  for (const line of text.split('\n')) {
    if (line.includes('@store-strip-start')) {
      depth += 1;
      continue;
    }
    if (line.includes('@store-strip-end')) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) kept.push(line);
  }
  return kept.join('\n');
}

/** UI copy that only makes sense with guard mode. */
const GUARD_I18N_PREFIXES = [
  'banner.',
  'blocked.',
  'popup.guard',
  'popup.blocked',
  'popup.recorded',
  'popup.allowed',
  'popup.remove',
  'popup.blockAgain'
];

const USERSCRIPT_VARIANTS = [
  { file: 'php-simple-check.user.js', suffix: '', platform: '' },
  {
    file: 'php-simple-check-ios.user.js',
    suffix: ' (iOS)',
    platform: 'For Safari on iOS, iPadOS and macOS (Userscripts app)'
  },
  {
    file: 'php-simple-check-android.user.js',
    suffix: ' (Android)',
    platform: 'For Firefox on Android (Tampermonkey)'
  }
];

function log(message) {
  process.stdout.write(`${message}\n`);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    return false;
  }
}

/* ------------------------------------------------------------------- i18n */

async function loadLocales() {
  const files = (await readdir(LOCALES_DIR)).filter((file) => file.endsWith('.json')).sort();
  const locales = {};
  for (const file of files) {
    const language = file.replace(/\.json$/, '');
    locales[language] = await readJson(path.join(LOCALES_DIR, file));
  }
  if (!locales.en) throw new Error('locales/en.json is required');
  return locales;
}

async function buildI18n(locales) {
  const banner = [
    '/*!',
    ' * PHP Simple Check — translation table',
    ' * Generated from locales/*.json by tools/build.mjs. Do not edit by hand.',
    ' */'
  ].join('\n');
  const body = `var PHPSimpleCheckStrings = ${JSON.stringify(locales, null, 2)};\n`;
  await writeFile(path.join(EXTENSION_DIR, 'lib', 'i18n-data.js'), `${banner}\n${body}`, 'utf8');

  const localesRoot = path.join(EXTENSION_DIR, '_locales');
  await rm(localesRoot, { recursive: true, force: true });
  for (const [language, table] of Object.entries(locales)) {
    // Chrome expects locale directories such as zh_CN / pt_BR.
    const parts = language.split('-');
    const folder = parts.length === 1 ? parts[0] : `${parts[0]}_${parts[1].toUpperCase()}`;
    const directory = path.join(localesRoot, folder);
    await mkdir(directory, { recursive: true });
    const messages = {
      extName: { message: table.extName },
      extDescription: { message: table.extDescription }
    };
    await writeFile(path.join(directory, 'messages.json'), `${JSON.stringify(messages, null, 2)}\n`, 'utf8');
  }
  log(`i18n: ${Object.keys(locales).length} locales -> lib/i18n-data.js + _locales/`);
}

/* --------------------------------------------------------------- manifest */

async function verifyManifest(manifest) {
  const referenced = new Set();
  const collect = (value) => {
    if (!value) return;
    if (typeof value === 'string') referenced.add(value.replace(/^\//, ''));
    else if (Array.isArray(value)) value.forEach(collect);
    else Object.values(value).forEach(collect);
  };

  collect(manifest.background && manifest.background.service_worker);
  collect(manifest.action && manifest.action.default_popup);
  collect(manifest.action && manifest.action.default_icon);
  collect(manifest.icons);
  (manifest.content_scripts || []).forEach((script) => {
    collect(script.js);
    collect(script.css);
  });

  const missing = [];
  for (const relative of referenced) {
    if (!(await exists(path.join(EXTENSION_DIR, relative)))) missing.push(relative);
  }
  if (missing.length) throw new Error(`manifest.json references missing files: ${missing.join(', ')}`);

  if (manifest.default_locale) {
    const messages = path.join(EXTENSION_DIR, '_locales', manifest.default_locale, 'messages.json');
    if (!(await exists(messages))) throw new Error(`missing ${path.relative(ROOT, messages)}`);
  }
  log(`manifest ok (${referenced.size} referenced files)`);
}

async function verifyVersions(manifest, pkg) {
  const versions = { 'manifest.json': manifest.version, 'package.json': pkg.version };
  if (new Set(Object.values(versions)).size !== 1) {
    throw new Error(`version mismatch: ${JSON.stringify(versions)}`);
  }
  log(`version ${manifest.version}`);
}

/* -------------------------------------------------------------- userscripts */

function userscriptHeader(manifest, locales, variant) {
  const english = locales.en;
  const name = english.extName + variant.suffix;
  const description = variant.platform
    ? `${variant.platform}. ${english.extDescription}`
    : english.extDescription;
  const url = `${RAW_BASE}/userscript/${variant.file}`;

  return [
    '// ==UserScript==',
    `// @name         ${name}`,
    `// @namespace    https://github.com/${REPO_SLUG}`,
    `// @version      ${manifest.version}`,
    `// @description  ${description}`,
    '// @author       yomiplush',
    `// @homepageURL  https://github.com/${REPO_SLUG}`,
    `// @supportURL   https://github.com/${REPO_SLUG}/issues`,
    `// @downloadURL  ${url}`,
    `// @updateURL    ${url}`,
    '// @match        http://*/*',
    '// @match        https://*/*',
    '// @run-at       document-idle',
    '// @grant        none',
    '// @noframes',
    `// @icon         ${RAW_BASE}/extension/icons/icon128.png`,
    '// ==/UserScript=='
  ].join('\n');
}

async function buildUserscripts(manifest, locales) {
  const bodies = [];
  for (const lib of USERSCRIPT_LIBS) {
    const source = await readFile(path.join(EXTENSION_DIR, 'lib', lib), 'utf8');
    bodies.push(`/* ---- extension/lib/${lib} ---- */`);
    bodies.push(source.replace(/\s+$/, ''));
  }

  const main = await readFile(path.join(USERSCRIPT_DIR, 'main.js'), 'utf8');
  bodies.push('/* ---- userscript/main.js ---- */');
  bodies.push(main.replace(/\s+$/, ''));

  // Userscripts have no "store" variant: drop the markers, keep the code.
  for (let i = 1; i < bodies.length; i += 1) {
    bodies[i] = bodies[i].replace(STORE_STRIP_MARKERS, '');
  }

  const built = [];
  for (const variant of USERSCRIPT_VARIANTS) {
    const content = `${userscriptHeader(manifest, locales, variant)}\n\n${bodies.join('\n\n')}\n`;
    await writeFile(path.join(USERSCRIPT_DIR, variant.file), content, 'utf8');
    log(`userscript ${variant.file} (${(Buffer.byteLength(content) / 1024).toFixed(1)} KiB)`);
    built.push({ file: variant.file, content });
  }
  return built;
}

/* ---------------------------------------------------------------- packaging */

async function listFiles(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(absolute, relative)));
    else if (entry.isFile()) files.push({ name: relative, file: absolute });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

async function zipDirectory(dir) {
  const entries = [];
  for (const file of await listFiles(dir)) {
    entries.push({ name: file.name, data: await readFile(file.file) });
  }
  if (!entries.some((entry) => entry.name === 'manifest.json')) {
    throw new Error('extension zip must contain manifest.json at its root');
  }
  return createZip(entries);
}

async function buildStoreExtension(manifest) {
  const storeDir = path.join(DIST_DIR, 'store', 'php-simple-check');
  await cp(EXTENSION_DIR, storeDir, { recursive: true });

  for (const file of GUARD_ONLY_FILES) {
    await rm(path.join(storeDir, file), { force: true });
  }

  // Remove the code for features the store build cannot use, and syntax-check
  // the result so a broken marker can never reach a release.
  for (const file of await listFiles(storeDir)) {
    if (!/\.(js|html)$/.test(file.name)) continue;
    const source = await readFile(file.file, 'utf8');
    if (source.indexOf('@store-strip') === -1) continue;
    const stripped = stripStoreRegions(source);
    if (file.name.endsWith('.js')) {
      try {
        new vm.Script(stripped, { filename: file.name });
      } catch (error) {
        throw new Error(`store transform broke ${file.name}: ${error.message}`);
      }
    }
    await writeFile(file.file, stripped, 'utf8');
  }

  // The store bundle ships only the strings its UI can show.
  const i18nFile = path.join(storeDir, 'lib', 'i18n-data.js');
  const i18nSource = await readFile(i18nFile, 'utf8');
  const i18n = JSON.parse(i18nSource.slice(i18nSource.indexOf('{'), i18nSource.lastIndexOf('}') + 1));
  const storeI18n = {};
  for (const [language, table] of Object.entries(i18n)) {
    storeI18n[language] = Object.fromEntries(
      Object.entries(table).filter(
        ([key]) => !GUARD_I18N_PREFIXES.some((prefix) => key.startsWith(prefix))
      )
    );
  }
  await writeFile(
    i18nFile,
    `var PHPSimpleCheckStrings = ${JSON.stringify(storeI18n, null, 2)};\n`,
    'utf8'
  );

  const storeManifest = JSON.parse(JSON.stringify(manifest));
  // The store build asks for the absolute minimum: local settings only.
  storeManifest.permissions = ['storage'];
  delete storeManifest.host_permissions;
  delete storeManifest.web_accessible_resources;

  await writeFile(path.join(storeDir, 'manifest.json'), `${JSON.stringify(storeManifest, null, 2)}\n`, 'utf8');
  return storeDir;
}

async function buildDist(manifest, userscripts) {
  await rm(DIST_DIR, { recursive: true, force: true });
  await mkdir(DIST_DIR, { recursive: true });

  const unpacked = path.join(DIST_DIR, 'extension');
  await cp(EXTENSION_DIR, unpacked, { recursive: true });
  log(`dist/extension ready (${(await listFiles(unpacked)).length} files)`);

  const zip = await zipDirectory(EXTENSION_DIR);
  await writeFile(path.join(DIST_DIR, `php-simple-check-extension-v${manifest.version}.zip`), zip);
  await writeFile(path.join(DIST_DIR, 'php-simple-check-extension.zip'), zip);
  log(`dist/php-simple-check-extension-v${manifest.version}.zip (${(zip.length / 1024).toFixed(1)} KiB)`);

  const storeDir = await buildStoreExtension(manifest);
  const storeZip = await zipDirectory(storeDir);
  await writeFile(path.join(DIST_DIR, `php-simple-check-store-v${manifest.version}.zip`), storeZip);
  await writeFile(path.join(DIST_DIR, 'php-simple-check-store.zip'), storeZip);
  log(
    `dist/php-simple-check-store-v${manifest.version}.zip (${(storeZip.length / 1024).toFixed(1)} KiB, permissions: storage)`
  );

  for (const userscript of userscripts) {
    await writeFile(path.join(DIST_DIR, userscript.file), userscript.content, 'utf8');
  }
}

async function main() {
  const manifest = await readJson(path.join(EXTENSION_DIR, 'manifest.json'));
  const pkg = await readJson(path.join(ROOT, 'package.json'));

  await verifyVersions(manifest, pkg);
  const locales = await loadLocales();
  await buildI18n(locales);
  await verifyManifest(manifest);

  const userscripts = await buildUserscripts(manifest, locales);
  await buildDist(manifest, userscripts);

  log('\nDone.');
  log('  full build   : dist/extension           (Load unpacked)');
  log('  store build  : dist/store/php-simple-check  + php-simple-check-store.zip');
}

main().catch((error) => {
  console.error(`build failed: ${error.message}`);
  process.exitCode = 1;
});
