# PHP Simple Check

A Manifest V3 extension for Chromium browsers plus userscripts for Safari and Firefox for Android that tell you, at a glance, whether a site is served by PHP.

| Verdict | Meaning |
| --- | --- |
| 🔴 **PHP detected** | PHP usage detected (headers, cookies, URLs or markup) |
| 🟡 **Likely PHP** | Only weak signals — worth a second look |
| 🟢 **No PHP** | Nothing in the response or markup points at PHP |

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/manifest-v3-informational.svg)](extension/manifest.json)

- Verdicts appear on the **toolbar icon colour**, a small toolbar badge, an on-page badge and in the popup.
- The detection engine is a single file (`extension/lib/detector.js`) shared by every platform, so the extension and the userscripts always agree.
- Everything runs locally. No network calls, no telemetry.

## Contents

- [Toolbar icon legend](#toolbar-icon-legend)
- [Verdicts](#verdicts)
- [Downloads](#downloads)
- [Install](#install)
- [Mobile controls](#mobile-controls)
- [How detection works](#how-detection-works)
- [Guard mode](#guard-mode)
- [Accuracy and limits](#accuracy-and-limits)
- [Privacy](#privacy)
- [Development](#development)
- [License](#license)

## Toolbar icon legend

The extension icon is repainted per tab, so the toolbar alone tells you the verdict.

| Icon | State | Toolbar badge |
| --- | --- | --- |
| Navy with a violet dot | Not judged yet, loading, or out of scope | none |
| 🔴 Red | PHP usage detected | `PHP` |
| 🟡 Amber | Possibly PHP (weak signals only) | `?` |
| 🟢 Green | No PHP signals found | `OK` |

Hovering shows a tooltip such as `🔴 PHP usage detected — PHP Simple Check`. The badge text is there as a fallback when colours are hard to distinguish. Clicking the icon opens the breakdown.

## Verdicts

Signal weights are added up (strong evidence = 3, weak hints = 1–2):

- **score ≥ 3 → 🔴**
- **score 1–2 → 🟡**
- **score 0 → 🟢**

Negative evidence (`X-Powered-By: Express`, a static site generator, …) is shown as supporting detail for a green result instead of lowering the score, so a strong PHP signal is never cancelled by a proxy header.

## Downloads

| File | Platform |
| --- | --- |
| `php-simple-check-extension-vX.Y.Z.zip` | Chrome, Edge, Brave (Chromium desktop) |
| `php-simple-check-ios.user.js` | iOS / iPadOS / macOS Safari (Userscripts app) |
| `php-simple-check-android.user.js` | Android Firefox (Tampermonkey) |
| `php-simple-check.user.js` | Generic userscript copy |

All three userscripts contain the **same engine**; only the metadata (`@name`, `@description`, `@updateURL`) differs. A test asserts that the bodies stay identical.

## Install

### Chrome / Edge / Brave

1. Download `php-simple-check-extension-vX.Y.Z.zip` from the [latest release](https://github.com/yomiplush/php-simple-check/releases/latest) and **unzip it**.
2. Open `chrome://extensions` (Brave: `brave://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the folder that contains `manifest.json`:

```
php-simple-check-extension-v1.4.0/
├── manifest.json          ← must be directly inside
├── background.js
├── content.js
├── popup.html
├── lib/
└── icons/
```

Cloning the repository works too — load the `extension/` directory as-is, no build step required.

> **`Manifest file is missing or unreadable`** means the selected folder has no `manifest.json`:
> - the zip was not extracted, or
> - the parent folder was selected instead of the one containing `manifest.json`.

### iOS / iPadOS Safari (Userscripts app)

1. Install [Userscripts](https://apps.apple.com/app/userscripts/id1463298887) from the App Store (free).
2. **Settings › Safari › Extensions › Userscripts**: enable the extension and set website access to **Allow** (or "Allow on All Websites").
3. Open the Userscripts app once and choose a storage folder (iCloud Drive or "On My iPhone").
4. In Safari, open the iOS userscript URL and follow the install sheet:

```
https://raw.githubusercontent.com/yomiplush/php-simple-check/main/userscript/php-simple-check-ios.user.js
```

You can also download `php-simple-check-ios.user.js` from the [latest release](https://github.com/yomiplush/php-simple-check/releases/latest) and open it, or add the same URL via the app's **+ → Add remote** flow. Updates arrive through `@updateURL`.
5. Open a site: a 🔴 / 🟡 / 🟢 badge appears in the bottom-right corner. Tap it for the breakdown.

The same steps work for Safari on macOS.

> **No badge?** Check that the extension is enabled in Settings › Safari › Extensions, that the script is toggled on inside the Userscripts app, that you reloaded the page (only `http://` and `https://` pages are supported), and that you did not previously choose "Hide on this site". Private browsing may disable extensions.

### Android Firefox (Tampermonkey)

1. Install Firefox for Android (120 or newer).
2. Add [Tampermonkey](https://addons.mozilla.org/firefox/addon/tampermonkey/) (Settings › Extensions, or from AMO).
3. Open the Android userscript URL and press **Install** in Tampermonkey:

```
https://raw.githubusercontent.com/yomiplush/php-simple-check/main/userscript/php-simple-check-android.user.js
```

The same file is attached to every [release](https://github.com/yomiplush/php-simple-check/releases/latest).
4. Confirm the script is enabled in the Tampermonkey dashboard. Updates come from the dashboard's "Check for userscript updates".

> Chrome for Android does not support extensions or userscripts. On iOS only Safari (with the Userscripts app) can run the script — Chrome and Firefox for iOS cannot.

## Mobile controls

| Action | Result |
| --- | --- |
| Tap the bottom-right badge | Open or close the breakdown panel |
| Panel ✕ | Hide for this page view only (a reload brings it back) |
| Panel "Hide on this site" | Never show the badge on this host again; an **Undo** toast appears for 8 seconds |

The per-site preference is stored in `localStorage` on that host only. To reset it, use the Undo toast or clear website data in Safari.

## How detection works

After the page has loaded, client-side observable signals are collected and scored. Nothing is guessed from the domain name.

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

### Extension vs. userscript

| | Chrome extension | Userscript |
| --- | --- | --- |
| Response headers | `webRequest`, plus a HEAD request when the worker missed them | one same-origin HEAD request |
| HttpOnly cookies | yes (`chrome.cookies`) | no (`document.cookie` only) |
| DOM / resources / generator | yes | yes |
| Page globals (`window.wp`, …) | no (isolated world) | yes (`@grant none`) |
| Blocking navigation | yes (guard mode) | no |

### Implementation notes

- An MV3 service worker is **not woken by `webRequest` events**, so response headers can be missed on a cold start. When that happens the extension issues a single HEAD request to the same URL and recovers the same evidence.
- Captured headers are tied to the document that produced them (`documentId`), so navigating between pages never reuses another document's evidence.
- `tabs.onUpdated` also clears the per-tab state at the start of a navigation, and the popup refuses to show a stored verdict for a different URL.

## Guard mode

**Guard mode** (off by default) blocks hosts that were judged 🔴.

```
First visit   page loads (the verdict can only be computed after the response)
                ↓ guard mode is on → warning banner + host is recorded
Next visits   blocked → "This site was blocked" page
                ↓ "Allow and open" removes the rule and adds the host to your allow list
```

- Blocked and allowed hosts are managed per host from the popup.
- The block is host-wide: every path and port of that host is redirected.
- **The first visit cannot be stopped.** Detection happens after the response arrives, and MV3 offers no way to cancel a navigation from a response (`declarativeNetRequest` rules must be registered in advance). Guard mode therefore protects subsequent visits.
- Userscripts cannot intercept navigation either, so guard mode exists only in the extension.

> **Note** — PHP is used by a huge share of the web (WordPress alone runs a large fraction of all sites). "Uses PHP" is not a signal of danger. Guard mode is meant for research and verification work, not as malware protection; this extension does not classify sites as malicious.

## Accuracy and limits

Client-side checks only observe signals. A green verdict does **not** prove that no PHP is running:

- a reverse proxy or CDN strips `X-Powered-By`
- the site routes everything through extension-less URLs
- sessions are disabled (no cookies are issued)
- the site is a static export

Conversely, a static HTML file served as `.php` will be reported as red. Same-site detection only follows hostname parent/child relationships (`example.com` and `www.example.com` are related; `static.example.com` and `blog.example.com` are not).

## Privacy

- No servers, no analytics, no tracking.
- The extension stores per-tab verdicts in memory and `storage.session`, the guard lists in `storage.local`, and nothing else.
- The userscript makes one HEAD request to the page's own URL to read response headers.

## Development

Node.js 20+ with no npm dependencies.

```bash
npm test          # unit tests (detector, build artifacts, icons, userscripts)
npm run build     # regenerate userscripts and dist/ artifacts
npm run icons     # regenerate icon PNGs
npm run test:e2e  # drive the extension and userscripts in headless Chrome
```

`npm run test:e2e` needs a browser that honours `--load-extension`. **Branded Chrome 137+ ignores it**, so point `CHROME_BIN` at [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/) or Chromium:

```bash
CHROME_BIN=/path/to/chrome-linux64/chrome npm run test:e2e
```

The end-to-end run covers, against a local fixture server:

- a static page → 🟢, a same-site `.php` link → 🟡, and `X-Powered-By: PHP` + `PHPSESSID` + `/wp-content/` → 🔴
- a header-only PHP page (validates the HEAD fallback)
- navigating `/header-only/` → `/static/` without reusing the previous document's evidence
- the same fixtures through the built userscript
- a 390×844 touch viewport: badge inside the viewport, tap opens the panel, per-site hide and undo
- guard mode: flag → banner → redirect to the interstitial → allow → rule removed
- packaging: all 16 icon files are loadable from the extension

You can also validate a packaged artifact:

```bash
EXTENSION_DIR=/tmp/php-simple-check-extension-v1.4.0 CHROME_BIN=… npm run test:e2e
```

### Project layout

```
extension/                            Chrome extension (loadable as-is)
  manifest.json
  background.js                       header capture, cookies, verdict, badge, guard
  content.js                          DOM observation and the on-page badge
  popup.html / popup.js / popup.css   breakdown and guard controls
  blocked.html / blocked.js / .css    guard-mode interstitial
  lib/detector.js                     scoring engine (shared with userscripts)
  lib/collect-dom.js                  page observation (shared)
  lib/overlay.js                      on-page badge and warning banner (shared)
  icons/                              generated PNGs, one set per verdict
userscript/
  main.js                             entry point (concatenated at build time)
  php-simple-check.user.js            generic build output
  php-simple-check-ios.user.js        Safari / Userscripts
  php-simple-check-android.user.js    Firefox for Android / Tampermonkey
tools/                                icon generator, zip writer, build
tests/                                unit tests and the headless-Chrome E2E
```

`userscript/*.user.js` and `dist/` are build outputs; the userscripts are committed so their raw URLs can be installed directly. Run `npm run build` after editing `extension/lib/` (CI fails if the committed files are stale).

### Releasing

Push a tag; GitHub Actions runs the tests, builds the artifacts and publishes them with English release notes.

```bash
git tag v1.4.0
git push origin v1.4.0
```

## License

[MIT](LICENSE) © 2026 YomiPlush
