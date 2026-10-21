# Privacy practices tab — copy/paste answers

Field-by-field answers for the Chrome Web Store "Privacy practices" tab, matching
the **store build** (`php-simple-check-store-vX.Y.Z.zip`:
`permissions ["storage","activeTab","scripting"]`, optional host permission,
no declarative content scripts).

## Single purpose (481 chars)

```
PHP Simple Check reports whether the page the user is currently viewing is served by PHP. It inspects only signals already available to that page — response headers (via one same-origin HEAD request), cookies the page's own JavaScript can read, URLs and markup — and shows a red/amber/green verdict on the toolbar icon, an on-page badge and in the popup. It does not block, redirect or modify navigation, does not access browsing history, and does not collect or transmit any data.
```

## Why `storage` is needed (286 chars)

```
Used to remember user preferences on the device only: whether the on-page badge is shown, and per-site "hide the badge" choices. The latest verdict for each open tab is kept in session storage so the popup can display it, and it is cleared when the tab closes. No data is sent anywhere.
```

## Why `activeTab` is needed (368 chars)

```
activeTab lets the extension judge the page the user is looking at without any standing access. When the user clicks the toolbar icon, the popup injects the read-only observer into that one tab (chrome.scripting.executeScript) and the verdict is computed locally in the browser. No page is accessed unless the user opens the popup on it, and no data leaves the device.
```

## Why `scripting` is needed (699 chars)

```
scripting is used for two user-driven purposes only. (1) On-demand scan: when the user clicks the toolbar icon, the observer is injected into that one tab using the temporary activeTab access. (2) Automatic verdicts: after the user presses "Enable automatic verdicts" in the popup and grants the optional host permission, the worker registers the same unmodified observer with chrome.scripting.registerContentScripts so a verdict appears when a page loads; revoking the permission unregisters it. The injected code only reads the page's own DOM, sends one same-origin HEAD request for its response headers, and appends a small badge. It does not modify or block anything else, and transmits nothing.
```

## Why host access is needed (optional permission, 699 chars)

```
The manifest declares no host permissions and no content scripts. The all-site origin is an optional permission, requested only when the user presses "Enable automatic verdicts" in the popup; without it the extension scans just the current tab after a click (activeTab). When granted, the worker registers the same observer dynamically with chrome.scripting.registerContentScripts (Chrome Web Store excluded). On a visited page it only reads the page's own DOM, sends one same-origin HEAD request for its response headers, and appends a small badge. It declares no cookies or webRequest APIs, intercepts no traffic, and sends nothing off the device. Revoking the permission unregisters the observer.
```

## Remote code

**No** — "No, I am not using remote code." All JavaScript, CSS, translations
and icons ship in the package. There is no `eval`, no `new Function`, no external
`<script>`, `<link>`, `import()` or `@import` of a remote URL, and no source maps.
The only network request is a data request: one same-origin `HEAD` to the page
the user already opened.

## Data usage

Tick **no** categories (no data is collected or transmitted). Leave these all
unticked: personally identifiable information, health, financial, authentication,
personal communications, location, web history, user activity, website content.

Then tick all three disclosures:

- do not sell or transfer user data to third parties outside approved use
- do not use or transfer user data for purposes unrelated to the single purpose
- do not use or transfer user data to determine creditworthiness or for lending

## Privacy policy URL

```
https://yomiplush.github.io/php-simple-check/privacy-policy.html
```

## Reviewer notes

If the console exposes a notes field (varies by console version), paste the block
from [`listing.md`](listing.md#reviewer-notes-field). If not, the same content is
published at <https://yomiplush.github.io/php-simple-check/reviewer-notes.html>.

## Reminder

Saving this tab is not enough: press **Save draft**, then re-check the uploaded
package (`php-simple-check-store-vX.Y.Z.zip`, version matching the manifest) and
submit.
