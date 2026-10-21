# Policy compliance notes

How the store package meets the Chrome Web Store programme policies, what the
automated preflight checks, and what to say if a reviewer asks. Everything here
is about the **store build** (`dist/store/php-simple-check`, permissions:
`storage` only). The GitHub build is a separate, sideloaded artefact.

Run the automated checks before every submission:

```bash
npm run build
npm run check:store
```

## Requirement → implementation

| Policy requirement | How this item complies | Where to verify |
| --- | --- | --- |
| **Single purpose** | One function: report whether the current page is served by PHP from signals available to the page. No blocking, no history access, no accounts, no second feature. | `listing.md` (Single purpose), `manifest.json`, popup |
| **Minimum permissions** | `permissions: ["storage"]`. No `host_permissions`, no `cookies`, no `webRequest`, no `declarativeNetRequest`, no `tabs`. | `npm run check:store`; `chrome.permissions.getAll()` returns `{permissions:["storage"]}` |
| **No remote code** | All code is bundled, including all 12 translations. No `eval`, `new Function`, string timers, remote scripts/styles/fonts, source maps. | `check:store`; `grep` sweep in tests |
| **User data / Limited Use** | No collection, storage or transmission of user data. No sale, no unrelated use, no creditworthiness use. | `docs/privacy-policy.html` (§ Limited Use) |
| **Privacy policy** | Public, linked in the listing and in this repo. | <https://yomiplush.github.io/php-simple-check/privacy-policy.html> |
| **Transparency** | The badge, the popup and the toolbar tooltip all show what was observed. The popup states that client-side checks only see signals. | popup, `lib/overlay.js` |
| **No deceptive or misleading claims** | The listing states explicitly that this is a stack fingerprint, not malware/security protection, and that PHP usage is not dangerous. | `listing.md` |
| **Functionality** | Works on install with no setup, no login, no external service. | reviewer test script in `listing.md` |
| **Manifest V3** | MV3 service worker, no background page. | `manifest.json` |
| **Readable code** | Plain, unminified JavaScript with comments. | package contents |
| **Listing accuracy** | Screenshots are captured from the real store build (`npm run screenshots`). | `docs/store/screenshot-*.png` |

## Why content-script access to all sites is required

The verdict is about *the page you are on*, so the observation code must run on
whichever page you open. There is no narrower host pattern that would keep the
feature working; the alternative (click the icon to scan) would change the
current behaviour and still need the same access once invoked.

What that access actually does:

1. Read the page's own markup, resource URLs and `<meta name="generator">`.
2. Issue **one same-origin `HEAD` request** to the page's own URL to read its
   response headers.
3. Append a badge element to the page (the only change made to the page).

It cannot read cookies through browser APIs, cannot intercept or modify network
requests, and never sends anything off the device.

## What the store build deliberately omits

| Omitted | Why | Consequence |
| --- | --- | --- |
| `cookies` permission | Not needed for the verdict: PHP session cookies that are not `HttpOnly` are still visible to the page's own JavaScript. | `HttpOnly` session cookie names are not seen. Headers, `.php` URLs, CMS markers and framework headers still cover the decision. |
| `webRequest` | Headers are obtained with the same-origin `HEAD` request instead. | None for users; one extra `HEAD` request per page. |
| `declarativeNetRequest` + `host_permissions` | Powers guard mode (blocking flagged hosts), which needs broad access and is a second purpose. | Guard mode is not in the store build; it remains in the GitHub build. |
| `blocked.html/js/css` | Guard interstitial only. | Not shipped, so no unused web-accessible resources. |

**If you want guard mode back in the store build** it becomes a second, quite
different purpose with broad host access and request-redirect privileges. That is
a legitimate feature, but it needs its own permission justifications and a much
longer review conversation; it is not a "minimal risk" submission.

## Automated preflight (`npm run check:store`)

- manifest: MV3, permissions exactly `["storage"]`, no host/optional permissions,
  no web-accessible resources, no CSP override, Web Store excluded from injection
- localisation: `default_locale`, `__MSG_` name/description, `_locales/en`
- assets: 128×128 icon, two 1280×800 screenshots, privacy policy, listing copy
- hygiene: version match, no guard files, no userscripts/tests/source maps,
  no `eval`, no string timers, no remote URLs, no inline scripts or `on*`
  handlers, no `document.write`, no `innerHTML` assignment
- reviewer experience: popup present, `minimum_chrome_version`, `homepage_url`,
  summary length (≤132), "no data collection" statement

CI and the release workflow run this after `npm run build`, so a non-compliant
package cannot be published by accident.

## Manual checks before pressing submit

- [ ] `dist/store/php-simple-check/manifest.json` shows `"permissions": ["storage"]`
      and no `host_permissions`.
- [ ] The zip has `manifest.json` at its **root**.
- [ ] Popup opens and shows a verdict; the toolbar icon changes colour.
- [ ] The privacy practices tab matches `listing.md` → *Review answers*.
- [ ] Screenshots still match the UI (regenerate if the layout changed).
- [ ] Version in `manifest.json` is higher than the last upload.

## If a reviewer asks

**"Why does the extension need access to all websites?"**

> The extension's single purpose is to report whether the page the user is
> currently viewing is served by PHP. The verdict is computed from that page's
> own response headers, cookies (only those the page's JavaScript can already
> read), URLs and markup, so the observation code has to run on whichever page
> the user opens. It reads only what the page itself can read, makes one HEAD
> request to the same URL, appends a small badge to the page, and transmits
> nothing. There is no narrower host pattern that keeps the feature working; the
> alternative (scan only after a click) would need the same access and would
> remove the automatic verdict.

**"Why is a HEAD request made to the page?"**

> Response headers such as `X-Powered-By` and `Server` are the strongest signal.
> `HEAD` re-requests the same URL the user already opened, from that page's own
> origin, so no new host is contacted and no data is sent anywhere. Sites that
> reject `HEAD` are judged from the remaining signals.

**"Does the extension collect or transmit data?"**

> No. There are no servers, no analytics and no remote code. Settings and
> per-tab verdicts stay in `chrome.storage` on the device and are cleared when the
> tab or browser closes. The privacy policy documents this and the Limited Use
> commitments.

**"Does it block or modify sites?"**

> It never blocks or redirects navigation in the store build. It appends one
> badge element to the page and, when the user asks for details, opens a panel
> inside that page.

## Change management

- Bump `version` in **both** `extension/manifest.json` and `package.json`
  (the build fails if they disagree), then `npm run build && npm run check:store`.
- Upload `dist/php-simple-check-store-vX.Y.Z.zip` — the same build that CI
  verified.
- If the permission surface ever changes, update `listing.md`, the privacy
  policy, `check-store.mjs`'s `ALLOWED_PERMISSIONS`, and this document in the
  same commit.
