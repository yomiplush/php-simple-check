# PHP Simple Check

A Manifest V3 extension for Chromium browsers — plus userscripts for Safari and Firefox for Android — that tells you, at a glance, whether a site is served by PHP.

| Verdict | Meaning |
| --- | --- |
| 🔴 **PHP detected** | PHP usage detected (headers, cookies, URLs or markup) |
| 🟡 **Likely PHP** | Only weak signals — worth a second look |
| 🟢 **No PHP** | Nothing in the response or markup points at PHP |

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/manifest-v3-informational.svg)](extension/manifest.json)
[![Permissions](https://img.shields.io/badge/store%20build-storage%20only-brightgreen.svg)](docs/store/checklist.md)

- Verdicts appear on the **toolbar icon colour**, a small toolbar badge, an on-page badge and in the popup.
- **Copy report** in the popup puts a plain-text fingerprint (URL, verdict, signals, observed headers) on your clipboard for a bug report or ticket.
- The detection engine is a single file (`extension/lib/detector.js`) shared by every platform, so the extension and the userscripts always agree.
- The UI is translated into **12 languages** and follows your browser language automatically.
- Everything runs locally: no servers, no analytics, no remote code.
- It is a stack fingerprint, not a malware or security scanner — see [What this is not](#what-this-is-not).

## Contents

- [What this is not](#what-this-is-not)
- [Two builds](#two-builds)
- [Downloads](#downloads)
- [Install](#install)
- [Languages](#languages)
- [Toolbar icon legend](#toolbar-icon-legend)
- [How detection works](#how-detection-works)
- [Guard mode](#guard-mode-full-build-only)
- [Accuracy and limits](#accuracy-and-limits)
- [Privacy](#privacy)
- [Chrome Web Store](#chrome-web-store)
- [Development](#development)
- [License](#license)

## What this is not

This extension answers one question — *is this page served by PHP?* — from signals the page itself exposes. It is **not** a malware or security scanner:

- "Uses PHP" is not a risk rating. WordPress, Drupal and most shared hosting run PHP.
- It cannot see a web shell, a backdoored plugin, a compromised upload directory or a server-side intrusion: those live on the server and leave no fingerprint in the HTML the browser receives.
- It never blocks or redirects a navigation in the store build, and the first visit can never be stopped even in the full build (detection happens after the response).

If you are dealing with an active PHP-based compromise, use server-side scanning, patched CMS/plugins, upload-execution hardening, a WAF and endpoint protection. This tool can help you *triage which hosts are PHP-backed* and produce a copyable fingerprint report — nothing more.

## Two builds

| | Store build (`dist/store/…`) | Full build (`extension/`) |
| --- | --- | --- |
| Permissions | `storage`, `activeTab`, `scripting` | `cookies`, `storage`, `declarativeNetRequest` |
| Host permissions | none at install; `http://*/*` + `https://*/*` as an **optional** permission | `http://*/*`, `https://*/*` |
| Content scripts | registered after the user enables automatic verdicts | declared in the manifest |
| Response headers | via a same-origin `HEAD` request | same |
| HttpOnly cookie names | no (`document.cookie` only) | yes (`chrome.cookies`) |
| Guard mode (host blocking) | not included | included |
| Guard/cookie code inside the package | **none** — stripped at build time | present |
| Guard-only UI strings | **none** — filtered out | present |
| Intended for | Chrome Web Store | sideloading from GitHub |

The two packages are generated from one source tree but share no unreachable features: source regions marked `@store-strip` are removed while building the store package, and the build syntax-checks the result. A reviewer opening the store zip finds no cookie, network-interception or blocking code, and no UI strings for features the build cannot run.

**First run of the store build:** nothing is injected on any site until the user presses **Enable automatic verdicts** in the popup, which requests the optional host permission once. After that the behaviour is identical to the GitHub build (badge on page load, per-tab toolbar colour). Until then, clicking the toolbar icon scans just the current tab on demand via `activeTab`.

Both builds are generated from the same sources; the worker checks for the APIs it needs at runtime (`CAPABILITIES`), so the store build simply hides the features it cannot support. The store build passes the same headless-Chrome end-to-end run:

```bash
EXTENSION_DIR=dist/store/php-simple-check EXPECT_MINIMAL=1 CHROME_BIN=… npm run test:e2e
```

## Downloads

| File | Platform |
| --- | --- |
| `php-simple-check-extension-vX.Y.Z.zip` | Chrome, Edge, Brave (full build) |
| `php-simple-check-store-vX.Y.Z.zip` | Chrome Web Store upload (permissions: `storage`) |
| `php-simple-check-ios.user.js` | iOS / iPadOS / macOS Safari (Userscripts app) |
| `php-simple-check-android.user.js` | Android Firefox (Tampermonkey) |
| `php-simple-check.user.js` | Generic userscript copy |

All three userscripts contain the same engine; only the metadata (`@name`, `@description`, `@updateURL`) differs.

## Install

### Chrome / Edge / Brave (sideload)

1. Download `php-simple-check-extension-vX.Y.Z.zip` from the [latest release](https://github.com/yomiplush/php-simple-check/releases/latest) and **unzip it**.
2. Open `chrome://extensions` (Brave: `brave://extensions`).
3. Turn on **Developer mode** and click **Load unpacked**.
4. Select the folder that contains `manifest.json` directly:

```
php-simple-check-extension-v2.0.0/
├── manifest.json          ← must be directly inside
├── background.js
├── content.js
├── popup.html
├── _locales/
├── lib/
└── icons/
```

Cloning the repository works too — load `extension/` as-is, no build step required.

> **`Manifest file is missing or unreadable`**: the folder you selected has no `manifest.json` (not extracted, or the parent folder was selected).

### iOS / iPadOS Safari (Userscripts app)

1. Install [Userscripts](https://apps.apple.com/app/userscripts/id1463298887) from the App Store.
2. **Settings › Safari › Extensions › Userscripts**: enable it and allow website access.
3. Open the app once and choose a storage folder.
4. In Safari, open the iOS userscript URL and follow the install sheet:

```
https://raw.githubusercontent.com/yomiplush/php-simple-check/main/userscript/php-simple-check-ios.user.js
```

5. Open a site: a 🔴 / 🟡 / 🟢 badge appears in the bottom-right corner. Tap it for the breakdown.

The same steps work for Safari on macOS.

### Android Firefox (Tampermonkey)

1. Install Firefox for Android (120 or newer) and add [Tampermonkey](https://addons.mozilla.org/firefox/addon/tampermonkey/).
2. Open the Android userscript URL and press **Install**:

```
https://raw.githubusercontent.com/yomiplush/php-simple-check/main/userscript/php-simple-check-android.user.js
```

3. Confirm the script is enabled in the Tampermonkey dashboard.

> Chrome for Android does not support extensions or userscripts; on iOS only Safari (with Userscripts) can run the script.

### Mobile controls

| Action | Result |
| --- | --- |
| Tap the bottom-right badge | Open or close the breakdown panel |
| Panel ✕ | Hide for this page view only |
| Panel "Hide on this site" | Never show the badge on this host; an **Undo** toast appears for 8 seconds |

## Languages

The UI follows the browser's UI language (`chrome.i18n.getUILanguage()`, then `navigator.languages`), falling back to English. Right-to-left languages (Arabic) switch the badge, popup and blocked page to RTL automatically.

Available: English, 日本語, 简体中文, 繁體中文, 한국어, Español, Français, Deutsch, Português (Brasil), Русский, العربية, हिन्दी.

The extension name and description are localised through Chrome's `_locales` mechanism, generated from the same translation files.

**Add a language** — copy `locales/en.json`, translate the values (keep the keys and `{placeholders}` intact) and run `npm run build`. A test fails if a key is missing, empty, or has mismatched placeholders, so a broken translation cannot ship.

## Toolbar icon legend

| Icon | State | Toolbar badge |
| --- | --- | --- |
| Navy with a violet dot | Not judged yet, loading, or out of scope | none |
| 🔴 Red | PHP usage detected | `PHP` |
| 🟡 Amber | Possibly PHP (weak signals only) | `?` |
| 🟢 Green | No PHP signals found | `OK` |

Hovering shows a tooltip such as `🔴 PHP usage detected — PHP Simple Check`; the badge text is a fallback when colours are hard to distinguish.

## How detection works

After the page loads, client-side observable signals are collected and scored. Strong evidence is worth 3 points, weak hints 1–2:

- **score ≥ 3 → 🔴**
- **score 1–2 → 🟡**
- **score 0 → 🟢**

| Signal | Weight | Example |
| --- | --- | --- |
| `X-Powered-By` reports PHP | +3 | `X-Powered-By: PHP/8.2.13` |
| `Server` mentions PHP / HHVM | +3 | `Server: Apache/2.4 PHP/8.1` |
| PHP session cookie | +3 | `PHPSESSID=…` |
| PHP framework cookie | +3 | `laravel_session`, `ci_session`, `CAKEPHP`, `CraftSessionId`, `fe_typo_user`, `SESS<32 hex>` |
| Page URL ends in `.php` | +3 | `/index.php` |
| Same-site `.php` resource | +3 | `/api/session.php` |
| CMS `generator` meta | +3 | `<meta name="generator" content="WordPress 6.6">` |
| WordPress paths / REST API | +3 | `/wp-content/`, `/wp-includes/`, `wp-json`, `api.w.org` |
| Drupal / Joomla markers | +3 | `/sites/default/files/`, `/media/system/` |
| Framework headers | +3 | `X-Generator: Drupal`, `X-Drupal-*`, `X-TYPO3-*` |
| Same-site link to `.php` | +2 | `<a href="/contact.php">` |
| `.php` inside inline scripts | +2 | `fetch("/ajax.php")` |
| `XSRF-TOKEN` cookie | +1 | |
| PHP-like query parameters | +1 | `?p=`, `?page_id=` |
| `X-Powered-By` is not PHP | −2 | `Express`, `Next.js`, `ASP.NET` (green supporting detail) |
| Static site generator | −2 | `Hugo`, `Jekyll`, `Astro`, `Next.js` |

Negative evidence is shown as supporting detail for a green result instead of lowering the score, so a strong PHP signal is never cancelled by a proxy header.

### Extension vs. userscript

| | Store build | Full build | Userscript |
| --- | --- | --- | --- |
| Response headers | same-origin `HEAD` from the content script | same | same |
| HttpOnly cookies | no | yes | no |
| DOM / resources / generator | yes | yes | yes |
| Page globals (`window.wp`, …) | no (isolated world) | no | yes (`@grant none`) |
| Blocking navigation | no | yes | no |

### Implementation notes

- Response headers come from **one same-origin `HEAD` request issued by the content script**. That keeps the extension free of `webRequest` and host permissions in the store build, and it is the only network request the extension makes. Sites that reject `HEAD` are judged from the remaining signals.
- The content script reports the page URL with every observation, so the worker never needs `tabs` access to learn where it is (the store build has no host permissions, and `tab.url` is then unavailable).
- `tabs.onUpdated` clears the per-tab state at the start of a navigation, and the popup refuses to show a stored verdict for a different URL.

## Guard mode (full build only)

**Guard mode** (off by default) blocks hosts that were judged 🔴.

```
First visit   page loads (the verdict can only be computed after the response)
                ↓ guard mode is on → warning banner + host is recorded
Next visits   blocked → "This site was blocked" page
                ↓ "Allow and open" removes the rule and adds the host to your allow list
```

- The block is host-wide and implemented with a dynamic `declarativeNetRequest` redirect to an interstitial page.
- **The first visit cannot be stopped.** Detection happens after the response arrives and MV3 offers no way to cancel a navigation from a response, so guard mode protects subsequent visits.
- Userscripts cannot intercept navigation either, and the store build ships without `declarativeNetRequest`, so guard mode is only in the sideloaded build.

> PHP is used by a large share of the web. "Uses PHP" is not a signal of danger; guard mode is a research and verification tool, not malware protection.

## Accuracy and limits

Client-side checks only observe signals. A green verdict does **not** prove that no PHP is running:

- a reverse proxy or CDN strips `X-Powered-By`
- the site routes everything through extension-less URLs
- sessions are disabled (no cookies are issued)
- the site is a static export

Conversely, static HTML served as `.php` is reported as red. Same-site detection only follows hostname parent/child relationships (`example.com` and `www.example.com` are related; `static.example.com` and `blog.example.com` are not).

## Privacy

- No servers, no analytics, no tracking, no accounts.
- The only network request is a `HEAD` request to the page you already opened, to read its own response headers.
- Settings live in `chrome.storage.local`, per-tab verdicts in `chrome.storage.session` (cleared when the browser exits).
- The store build requests a single permission (`storage`) and uses no cookie API; the full build additionally reads cookie *names* for the current tab, never values.

Full policy: <https://yomiplush.github.io/php-simple-check/privacy-policy.html>
(source: [docs/privacy-policy.html](docs/privacy-policy.html)).
Reviewer notes: <https://yomiplush.github.io/php-simple-check/reviewer-notes.html>.

## Chrome Web Store

Everything needed for submission is in [`docs/store/`](docs/store):

- [`checklist.md`](docs/store/checklist.md) — console walkthrough, privacy-practices answers, reviewer notes, common rejection causes
- [`listing.md`](docs/store/listing.md) — English and Japanese store copy, permission justifications, reviewer test script
- [`policy-compliance.md`](docs/store/policy-compliance.md) — requirement-by-requirement audit, why all-site content-script access is needed, what the store build omits and reviewer reply templates
- [`privacy-policy.html`](docs/privacy-policy.html) — hostable policy page
- `screenshot-1.png`, `screenshot-2.png` — 1280×800 store screenshots, regenerated with `npm run screenshots`

`npm run check:store` verifies the built store package mechanically (permission surface, no remote code or inline scripts, localisation wiring, icon and screenshot sizes, listing summary length). CI and the release workflow both fail if it does not pass.

## Development

Node.js 20+ with no npm dependencies.

```bash
npm test            # unit tests (detector, i18n, build artifacts, icons, userscripts)
npm run build       # translations, userscripts, dist/ (full + store builds)
npm run icons       # regenerate icon PNGs
npm run screenshots # regenerate store screenshots (needs CHROME_BIN)
npm run test:e2e    # drive the extension and userscripts in headless Chrome
```

`npm run test:e2e` needs a browser that honours `--load-extension`. Branded Chrome 137+ ignores it, so point `CHROME_BIN` at [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/) or Chromium.

Extra modes:

```bash
# store build: asserts permissions == ["storage"] and no host permissions
EXTENSION_DIR=dist/store/php-simple-check EXPECT_MINIMAL=1 CHROME_BIN=… npm run test:e2e

# localized UI (the browser UI language is taken from the environment)
EXPECT_LOCALE=ja LANG=ja_JP.UTF-8 CHROME_BIN=… npm run test:e2e
```

The end-to-end run covers, against a local fixture server:

- a static page → 🟢, a same-site `.php` link → 🟡, `X-Powered-By: PHP` + `PHPSESSID` + `/wp-content/` → 🔴
- a header-only PHP page (validates the `HEAD` fallback)
- navigating `/header-only/` → `/static/` without reusing the previous document's evidence
- the same fixtures through the built userscript
- a 390×844 touch viewport: badge inside the viewport, tap opens the panel, per-site hide and undo
- guard mode (full build): flag → banner → redirect → allow → rule removed
- packaging: all 16 icon files are loadable from the extension

### Project layout

```
extension/                            Chrome extension (loadable as-is, full build)
  manifest.json                       name/description via __MSG_ + _locales
  background.js                       verdict, badge, guard, i18n titles
  content.js                          DOM observation + the one HEAD request
  popup.html / popup.js / popup.css   breakdown and guard controls
  blocked.html / blocked.js / .css    guard-mode interstitial
  lib/detector.js                     scoring engine (shared)
  lib/collect-dom.js                  page observation + header probe (shared)
  lib/overlay.js                      on-page badge and warning banner (shared)
  lib/i18n.js                         runtime translation lookup
  lib/i18n-data.js                    generated translation table
  _locales/                           generated Chrome locales
  icons/                              generated PNGs, one set per verdict
locales/                              translation sources (one JSON per language)
userscript/
  main.js                             entry point (concatenated at build time)
  php-simple-check.user.js            generic build output
  php-simple-check-ios.user.js        Safari / Userscripts
  php-simple-check-android.user.js    Firefox for Android / Tampermonkey
docs/
  privacy-policy.html
  store/                              listing copy, checklist, screenshots
tools/                                icon generator, zip writer, build, screenshots
tests/                                unit tests and the headless-Chrome E2E
```

`userscript/*.user.js`, `extension/lib/i18n-data.js`, `extension/_locales/` and `dist/` are build outputs. The userscripts are committed so their raw URLs can be installed directly; run `npm run build` after editing `extension/lib/` or `locales/` (CI fails if the committed files are stale).

### Releasing

Push a tag; GitHub Actions runs the tests, builds both extension variants plus the userscripts, and publishes them with English release notes.

```bash
git tag v2.0.0
git push origin v2.0.0
```

## License

[MIT](LICENSE) © 2026 YomiPlush
