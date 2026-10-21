#!/usr/bin/env node
/**
 * Chrome Web Store preflight check
 *
 *   npm run check:store        (run npm run build first)
 *
 * Validates the *store package* against the publication requirements we can
 * check mechanically: permission surface, no remote code, no inline scripts,
 * localisation wiring, icons, and the store listing assets. Exits non-zero so
 * CI and the release workflow refuse to publish a non-compliant package.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORE_DIR = process.env.STORE_DIR || path.join(ROOT, 'dist', 'store', 'php-simple-check');
const ALLOWED_PERMISSIONS = ['storage'];

const problems = [];
const notes = [];

function check(label, condition, detail) {
  if (condition) {
    process.stdout.write(`✔ ${label}\n`);
  } else {
    process.stdout.write(`✖ ${label}${detail ? ` — ${detail}` : ''}\n`);
    problems.push(label);
  }
}

function note(message) {
  notes.push(message);
  process.stdout.write(`· ${message}\n`);
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    return false;
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function listFiles(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(path.join(dir, entry.name), relative)));
    else files.push({ name: relative, file: path.join(dir, entry.name) });
  }
  return files;
}

async function main() {
  if (!(await exists(STORE_DIR))) {
    console.error(`✖ ${path.relative(ROOT, STORE_DIR)} is missing — run npm run build first`);
    process.exitCode = 1;
    return;
  }

  const manifest = await readJson(path.join(STORE_DIR, 'manifest.json'));
  const pkg = await readJson(path.join(ROOT, 'package.json'));

  process.stdout.write('\nPermission surface\n');
  check('Manifest V3', manifest.manifest_version === 3);
  check(
    `permissions are exactly ${JSON.stringify(ALLOWED_PERMISSIONS)}`,
    JSON.stringify(manifest.permissions) === JSON.stringify(ALLOWED_PERMISSIONS),
    JSON.stringify(manifest.permissions)
  );
  check('no host_permissions', !manifest.host_permissions);
  check('no optional_permissions', !manifest.optional_permissions);
  check('no web_accessible_resources', !manifest.web_accessible_resources);
  check('no "tabs" permission', !(manifest.permissions || []).includes('tabs'));
  check(
    'content scripts only on http(s)',
    (manifest.content_scripts || []).every((script) =>
      script.matches.every((match) => match.startsWith('http://') || match.startsWith('https://'))
    )
  );
  check(
    'content scripts exclude the Web Store',
    (manifest.content_scripts || []).some((script) =>
      (script.exclude_matches || []).some((match) => match.includes('chromewebstore') || match.includes('chrome.google.com/webstore'))
    )
  );

  process.stdout.write('\nRemote code and CSP\n');
  check('default CSP (no content_security_policy override)', !manifest.content_security_policy);

  process.stdout.write('\nLocalisation\n');
  check('default_locale is en', manifest.default_locale === 'en');
  check('name uses __MSG_', manifest.name === '__MSG_extName__');
  check('description uses __MSG_', manifest.description === '__MSG_extDescription__');
  check(
    '_locales/en/messages.json exists',
    await exists(path.join(STORE_DIR, '_locales', 'en', 'messages.json'))
  );

  process.stdout.write('\nStore assets\n');
  const iconPath = path.join(STORE_DIR, manifest.icons['128']);
  const icon = await readFile(iconPath).catch(() => null);
  check('128px icon is a 128×128 PNG', Boolean(icon) && icon.readUInt32BE(16) === 128 && icon.readUInt32BE(20) === 128);
  const screenshot1 = await readFile(path.join(ROOT, 'docs', 'store', 'screenshot-1.png')).catch(() => null);
  const screenshot2 = await readFile(path.join(ROOT, 'docs', 'store', 'screenshot-2.png')).catch(() => null);
  const isStoreSize = (buffer) =>
    Boolean(buffer) && buffer.readUInt32BE(16) === 1280 && buffer.readUInt32BE(20) === 800;
  check('two 1280×800 screenshots are present', isStoreSize(screenshot1) && isStoreSize(screenshot2));
  check(
    'privacy policy is shipped in the repo',
    await exists(path.join(ROOT, 'docs', 'privacy-policy.html'))
  );
  check(
    'listing copy is shipped in the repo',
    await exists(path.join(ROOT, 'docs', 'store', 'listing.md'))
  );

  process.stdout.write('\nPackage hygiene\n');
  check('version matches package.json', manifest.version === pkg.version, `${manifest.version} vs ${pkg.version}`);
  check('guard-mode interstitial is not shipped', !(await exists(path.join(STORE_DIR, 'blocked.html'))));
  check(
    'no userscripts or tests inside the extension',
    !(await listFiles(STORE_DIR)).some((file) => file.name.endsWith('.user.js') || file.name.startsWith('tests/'))
  );
  check('no source maps', !(await listFiles(STORE_DIR)).some((file) => file.name.endsWith('.map')));

  const files = await listFiles(STORE_DIR);
  const textFiles = files.filter((file) => /\.(js|html|css|json)$/.test(file.name));
  const code = await Promise.all(textFiles.map(async (file) => ({ name: file.name, body: await readFile(file.file, 'utf8') })));

  check(
    'no eval / new Function',
    !code.some((file) => /\beval\s*\(|\bnew\s+Function\s*\(/.test(file.body)),
    code.filter((file) => /\beval\s*\(|\bnew\s+Function\s*\(/.test(file.body)).map((file) => file.name).join(', ')
  );
  check(
    'no string-based timers',
    !code.some((file) => /set(?:Timeout|Interval)\s*\(\s*['"`]/.test(file.body))
  );
  check(
    'no remote script / style / font references',
    !code.some((file) => /(?:src|href)\s*=\s*["']https?:\/\//i.test(file.body) || /url\(\s*["']?https?:\/\//i.test(file.body))
  );
  check(
    'no inline <script> blocks or on* handlers',
    !code.some(
      (file) =>
        file.name.endsWith('.html') &&
        (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(file.body) ||
          /\son[a-z]+\s*=/i.test(file.body))
    )
  );
  check(
    'no document.write',
    !code.some((file) => /document\.write\s*\(/.test(file.body))
  );
  check(
    'no innerHTML assignment',
    !code.some((file) => !file.name.endsWith('.html') && /\.innerHTML\s*=/.test(file.body)),
    code.filter((file) => !file.name.endsWith('.html') && /\.innerHTML\s*=/.test(file.body)).map((file) => file.name).join(', ')
  );
  const joined = code.map((file) => file.body).join('\n');
  check(
    'no cookie / DNR / guard code in the store bundle',
    !/chrome\.cookies|chrome\.declarativeNetRequest|blocked\.html|guardEnabled|php-simple-check:get-guard/.test(joined),
    (joined.match(/chrome\.cookies|chrome\.declarativeNetRequest|blocked\.html|guardEnabled/) || [])[0] || ''
  );
  check('no build markers left in the store bundle', !joined.includes('@store-strip'));

  const storeI18nSource = await readFile(path.join(STORE_DIR, 'lib', 'i18n-data.js'), 'utf8');
  const storeI18n = JSON.parse(
    storeI18nSource.slice(storeI18nSource.indexOf('{'), storeI18nSource.lastIndexOf('}') + 1)
  );
  const guardKeys = Object.keys(storeI18n.en).filter((key) =>
    /^(banner\.|blocked\.|popup\.guard|popup\.blocked|popup\.recorded|popup\.allowed|popup\.remove|popup\.blockAgain)/.test(key)
  );
  check('store translations contain no guard strings', guardKeys.length === 0, guardKeys.join(', '));

  check(
    'store bundle declares no forbidden APIs in the manifest',
    !['cookies', 'webRequest', 'webRequestBlocking', 'declarativeNetRequest', 'management', 'history'].some((api) =>
      (manifest.permissions || []).includes(api)
    )
  );

  process.stdout.write('\nPage wiring\n');
  for (const page of ['popup.html']) {
    const html = await readFile(path.join(STORE_DIR, page), 'utf8');
    for (const match of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
      check(`${page} → ${match[1]}`, await exists(path.join(STORE_DIR, match[1])));
    }
    for (const match of html.matchAll(/<link[^>]+href="([^"]+)"/g)) {
      check(`${page} → ${match[1]}`, await exists(path.join(STORE_DIR, match[1])));
    }
  }

  process.stdout.write('\nMarketing claims\n');
  const listingText = await readFile(path.join(ROOT, 'docs', 'store', 'listing.md'), 'utf8');
  const readmeText = await readFile(path.join(ROOT, 'README.md'), 'utf8');
  const manifestText = JSON.stringify(manifest);

  // The item fingerprints a stack; it must never read like a malware product.
  const AFFIRMATIVE = /(protects? (?:you|users|against)|blocks? (?:malware|ransomware|threats|attackers)|detects? malware|anti-?malware|anti-?virus|virus scanner|removes? (?:malware|viruses)|guarantee[sd]?\b|100% safe|fully secure|prevents? (?:infection|malware))/i;
  const DISCLAIMER = /(not (?:a|an) (?:malware|security|anti-?virus)|not designed (?:as|to|for)|does not (?:detect|scan|protect)|is not a (?:malware|security))/i;

  const claimHits = (text) => {
    const match = text.match(AFFIRMATIVE);
    return match ? match[0] : '';
  };
  check('listing makes no security-protection claims', !AFFIRMATIVE.test(listingText), claimHits(listingText));
  check('README makes no security-protection claims', !AFFIRMATIVE.test(readmeText), claimHits(readmeText));
  check('manifest makes no security-protection claims', !AFFIRMATIVE.test(manifestText), claimHits(manifestText));
  check('listing states it is not a malware/security scanner', DISCLAIMER.test(listingText));
  check('README states it is not a malware/security scanner', DISCLAIMER.test(readmeText));

  process.stdout.write('\nReviewer experience\n');
  check('action popup is present', Boolean(manifest.action && manifest.action.default_popup));
  check('minimum_chrome_version set', Boolean(manifest.minimum_chrome_version));
  check('homepage_url set', Boolean(manifest.homepage_url));

  const english = await readJson(path.join(ROOT, 'locales', 'en.json'));
  const summary = (await readFile(path.join(ROOT, 'docs', 'store', 'listing.md'), 'utf8'))
    .match(/\*\*Summary\*\*[^\n]*\n\n```\n([\s\S]*?)\n```/);
  if (summary) {
    const text = summary[1].trim();
    check(`listing summary ≤ 132 chars (${text.length})`, text.length <= 132);
  } else {
    note('listing summary could not be parsed — check it by hand');
  }
  check('listing mentions no data collection', /no data|nothing is sent/i.test(
    await readFile(path.join(ROOT, 'docs', 'store', 'listing.md'), 'utf8')
  ));

  note(`store bundle: ${files.length} files`);
  note('manual follow-ups: upload the zip, paste the listing, answer the privacy questionnaire');

  if (problems.length) {
    console.error(`\n✖ ${problems.length} store compliance check(s) failed`);
    process.exitCode = 1;
    return;
  }
  console.log('\n✔ store package looks ready for submission');
}

main().catch((error) => {
  console.error(`check failed: ${error.message}`);
  process.exitCode = 1;
});
