# Chrome Web Store submission checklist

Goal: get the item approved on the first review. Everything below is already
prepared — the steps are ordered the way the console asks for them.

## 0. One-time setup

- [ ] Register a Chrome Web Store developer account (US$5, one-time) with 2FA.
- [ ] Verify the contact email in the developer dashboard.
- [ ] Decide the publisher name (e.g. `YomiPlush`).

## 1. Build the upload package

```bash
npm install --no-package-lock   # not required: there are no dependencies
npm test                        # 44 unit tests
npm run build                   # writes dist/
npm run check:store             # policy preflight (CI runs this too)
```

Upload **`dist/php-simple-check-store-vX.Y.Z.zip`** (or the folder
`dist/store/php-simple-check`).

The store build differs from the GitHub build on purpose:

| | Store build | GitHub build |
| --- | --- | --- |
| `permissions` | `["storage"]` | `["cookies", "storage", "declarativeNetRequest"]` |
| `host_permissions` | none | `http://*/*`, `https://*/*` |
| Guard mode (host blocking) | not included | included |
| HttpOnly cookie names | no | yes |

Both use the same detector, and the store build passes the same
headless-Chrome end-to-end run:

```bash
EXTENSION_DIR=dist/store/php-simple-check EXPECT_MINIMAL=1 \
  CHROME_BIN=/path/to/chrome-for-testing/chrome-linux64/chrome npm run test:e2e
```

- [ ] `npm run check:store` prints `✔ store package looks ready for submission`.
- [ ] Confirm the zip has `manifest.json` at its **root** (not inside a folder).
- [ ] Confirm `dist/store/php-simple-check/manifest.json` says `"permissions": ["storage"]`
      and has no `host_permissions`.

## 2. Store listing tab

- [ ] Name: `PHP Simple Check`
- [ ] Summary (≤132 chars), detailed description, category **Developer Tools**:
      copy from [`listing.md`](listing.md).
- [ ] Language: English (add the Japanese listing from the same file if you want
      a second locale).
- [ ] Upload the 128×128 icon: `extension/icons/icon128.png`.
- [ ] Upload screenshots (1280×800): `docs/store/screenshot-1.png`, `screenshot-2.png`.
      Regenerate them any time with `node tools/screenshots.mjs`.
- [ ] Homepage: `https://github.com/yomiplush/php-simple-check`
- [ ] Support URL: `https://github.com/yomiplush/php-simple-check/issues`
- [ ] (Optional) Small promo tile 440×280, marquee 1400×560.

## 3. Privacy practices tab

- [ ] Single purpose: *"Report whether the current page is served by PHP, using
      signals available to the page itself."*
- [ ] Justification for `storage`: *"Stores the on-page badge preference and
      per-site hide choices locally."*
- [ ] Justification for host access (content script): *"Reads the page's own
      markup and issues one same-origin HEAD request for its response headers to
      compute the verdict. No data leaves the browser."*
- [ ] Remote code: **No** — all code is in the package; nothing is fetched or
      evaluated at runtime.
- [ ] Data usage: tick **none** of the collection categories. Do not select
      "sells data" or "uses data for unrelated purposes".
- [ ] Privacy policy URL: `https://yomiplush.github.io/php-simple-check/privacy-policy.html`
      (GitHub Pages is enabled for `/docs`; the blob URL also works).
- [ ] Certify the three compliance statements.

## 4. Distribution tab

- [ ] Visibility: **Public**.
- [ ] Regions: all.
- [ ] Pricing: free.
- [ ] Submit for review.

## 5. After approval

- [ ] Copy the store URL into the README and the release notes.
- [ ] For every release, bump `version` in **both** `extension/manifest.json` and
      `package.json` (the build fails if they disagree), rebuild and upload the
      new store zip.
- [ ] Keep the store zip free of APIs the listing does not mention: the store
      manifest is generated, so do not hand-edit `dist/store/...`.
- [ ] Optional: staged rollout (10% → 50% → 100%) for the first few updates.

## Common rejection causes (and how this package avoids them)

| Rejection reason | Mitigation here |
| --- | --- |
| Broad or unjustified permissions | Store build declares only `storage`; no host permissions, `cookies`, `webRequest` or DNR. (Chrome still warns about site access because a content script runs on http(s) pages — that access is inherent to showing a page-level verdict, and no data leaves the browser.) |
| Remote code | No `eval`, no `new Function`, no remote scripts; everything is bundled, including all 12 translations. |
| Missing or vague privacy policy | `docs/privacy-policy.html` spells out storage, the single HEAD request and the absence of collection. |
| Unclear single purpose | Stated in the listing and in the privacy tab; the UI does exactly one thing. |
| Misleading security claims | The listing says explicitly that this is a stack fingerprint, not malware protection. |
| Broken install / blank popup | Verified by the headless E2E run against the exact store build (`EXPECT_MINIMAL=1`). |
| Advertised feature missing from the build | Guard mode is stripped from the store package (code, strings and files); the listing never mentions it. |
| Missing functionality for reviewers | Reviewer test script in `listing.md`: the badge, the popup, and two example sites. |
| Icon mismatch | 128×128 PNG used for both the manifest and the store listing. |

## Review notes you can paste

```
This extension is a single-purpose, fully local stack fingerprint.

Test: install, open https://wordpress.org/ (should show 🔴) and https://example.com/
(should show 🟢). A badge appears bottom-right; the toolbar icon changes colour;
clicking the badge or the icon shows the detected signals.

Network: the only request made is a HEAD request to the URL you opened, from that
page's origin, to read its response headers. You can see it in DevTools › Network.

Permissions: storage only. No cookies, no webRequest, no remote code, no analytics.
```
