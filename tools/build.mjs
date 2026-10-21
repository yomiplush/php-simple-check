#!/usr/bin/env node
/**
 * Build script
 *
 *   node tools/build.mjs
 *
 * 1. Verifies every file the manifest references actually exists.
 * 2. Regenerates userscript/php-simple-check.user.js from extension/lib/* plus
 *    userscript/main.js (single source of truth for the detection logic).
 * 3. Produces dist/: an unpacked extension copy, a .user.js copy and a zip that
 *    can be side-loaded after unzipping.
 *
 * No dependencies — a fresh clone can build with Node alone.
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip } from './zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = path.join(ROOT, 'extension');
const USERSCRIPT_DIR = path.join(ROOT, 'userscript');
const DIST_DIR = path.join(ROOT, 'dist');

const REPO_SLUG = 'yomiplush/php-simple-check';
const BRANCH = 'main';
const RAW_BASE = `https://raw.githubusercontent.com/${REPO_SLUG}/${BRANCH}`;

const USERSCRIPT_LIBS = ['detector.js', 'collect-dom.js', 'overlay.js'];

/**
 * Same detection engine, three entry files so the release page offers the right
 * download per platform. Each one has its own @downloadURL/@updateURL, so an
 * installed copy updates itself from the matching file.
 */
const USERSCRIPT_VARIANTS = [
  {
    file: 'php-simple-check.user.js',
    suffix: '',
    platform: ''
  },
  {
    file: 'php-simple-check-ios.user.js',
    suffix: ' (iOS)',
    platform: 'iOS・iPadOS・macOS の Safari（Userscripts アプリ）用'
  },
  {
    file: 'php-simple-check-android.user.js',
    suffix: ' (Android)',
    platform: 'Android の Firefox（Tampermonkey）用'
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
  log(`manifest ok (${referenced.size} referenced files)`);
}

async function verifyVersions(manifest, pkg) {
  const versions = { 'manifest.json': manifest.version, 'package.json': pkg.version };
  const unique = new Set(Object.values(versions));
  if (unique.size !== 1) {
    throw new Error(`version mismatch: ${JSON.stringify(versions)}`);
  }
  log(`version ${manifest.version}`);
}

function userscriptDescription(manifest, variant) {
  return variant.platform
    ? `${variant.platform}。${manifest.description}`
    : manifest.description;
}

function userscriptHeader(manifest, variant) {
  const url = `${RAW_BASE}/userscript/${variant.file}`;
  const lines = [
    '// ==UserScript==',
    `// @name         ${manifest.name}${variant.suffix}`,
    `// @namespace    https://github.com/${REPO_SLUG}`,
    `// @version      ${manifest.version}`,
    `// @description  ${userscriptDescription(manifest, variant)}`,
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
  ];
  return lines.join('\n');
}

async function buildUserscripts(manifest) {
  const bodies = [];

  for (const lib of USERSCRIPT_LIBS) {
    const source = await readFile(path.join(EXTENSION_DIR, 'lib', lib), 'utf8');
    bodies.push(`/* ---- extension/lib/${lib} ---- */`);
    bodies.push(source.replace(/\s+$/, ''));
  }

  const main = await readFile(path.join(USERSCRIPT_DIR, 'main.js'), 'utf8');
  bodies.push('/* ---- userscript/main.js ---- */');
  bodies.push(main.replace(/\s+$/, ''));

  const built = [];
  for (const variant of USERSCRIPT_VARIANTS) {
    const content = `${userscriptHeader(manifest, variant)}\n\n${bodies.join('\n\n')}\n`;
    const target = path.join(USERSCRIPT_DIR, variant.file);
    await writeFile(target, content, 'utf8');
    log(`userscript ${variant.file} (${(Buffer.byteLength(content) / 1024).toFixed(1)} KiB)`);
    built.push({ file: variant.file, content: content });
  }
  return built;
}

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

async function buildDist(manifest, userscripts) {
  await rm(DIST_DIR, { recursive: true, force: true });
  await mkdir(DIST_DIR, { recursive: true });

  const unpacked = path.join(DIST_DIR, 'extension');
  await cp(EXTENSION_DIR, unpacked, { recursive: true });
  log(`dist/extension ready (${(await listFiles(unpacked)).length} files)`);

  for (const userscript of userscripts) {
    await writeFile(path.join(DIST_DIR, userscript.file), userscript.content, 'utf8');
  }

  // Flat archive: manifest.json sits at the zip root, so whatever folder the
  // extractor creates (usually named after the zip) is directly loadable with
  // "Load unpacked". A nested php-simple-check-extension/ folder made users
  // select the parent and hit "Manifest file is missing or unreadable".
  const zipEntries = [];
  for (const file of await listFiles(EXTENSION_DIR)) {
    zipEntries.push({ name: file.name, data: await readFile(file.file) });
  }
  if (!zipEntries.some((entry) => entry.name === 'manifest.json')) {
    throw new Error('extension zip must contain manifest.json at its root');
  }
  const zip = createZip(zipEntries);
  const versionedZip = path.join(DIST_DIR, `php-simple-check-extension-v${manifest.version}.zip`);
  await writeFile(versionedZip, zip);
  await writeFile(path.join(DIST_DIR, 'php-simple-check-extension.zip'), zip);
  log(`dist/${path.basename(versionedZip)} (${(zip.length / 1024).toFixed(1)} KiB)`);
}

async function main() {
  const manifest = await readJson(path.join(EXTENSION_DIR, 'manifest.json'));
  const pkg = await readJson(path.join(ROOT, 'package.json'));

  await verifyVersions(manifest, pkg);
  await verifyManifest(manifest);
  const userscripts = await buildUserscripts(manifest);
  await buildDist(manifest, userscripts);

  log('\nDone. Load dist/extension (or extension/) via chrome://extensions → Load unpacked.');
}

main().catch((error) => {
  console.error(`build failed: ${error.message}`);
  process.exitCode = 1;
});
