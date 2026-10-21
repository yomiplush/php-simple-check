# Chrome Web Store listing

Copy/paste material for the Chrome Web Store console. The store build is
`dist/php-simple-check-store-vX.Y.Z.zip` (permissions: `storage` only, no host
permissions, no guard mode).

Paste-ready plain text for the "Description" field:
[`description-en.txt`](description-en.txt) ·
[`description-ja.txt`](description-ja.txt).

---

## English (default listing)

**Name** (≤ 45 chars)

```
PHP Simple Check
```

**Summary** (≤ 132 chars)

```
See at a glance whether a site is served by PHP. Detection runs locally: a colour-coded toolbar icon plus an optional page badge.
```

**Category**

```
Developer Tools
```

**Single purpose**

```
Report whether the page you are looking at is served by PHP, using signals available to the page itself.
```

**Detailed description**

```
PHP Simple Check tells you whether the page you are looking at is served by PHP.

Single purpose: report whether the current page is served by PHP by inspecting the page's own response
headers, cookies, URLs and markup. It does nothing else — no blocking, no browsing-history access, no
accounts, no remote servers.

After a page loads, the extension inspects signals that are already available to
the page itself — response headers, cookies the page can read, URLs, and markup —
then shows one of three verdicts:

  🔴 PHP usage detected
  🟡 Possibly PHP (weak signals only)
  🟢 No PHP signals found

The verdict appears four ways: the toolbar icon takes the verdict colour, a small
toolbar badge shows PHP / ? / OK, an optional badge sits in the bottom-right of
the page, and the popup lists every signal that contributed to the score.

Why people use it
• Check which stack a site runs before reporting a bug or filing a security report.
• Confirm a migration away from PHP actually happened.
• Learn how sites are built without opening developer tools.

Privacy first
• No servers, no analytics, no accounts. Everything is computed on your device.
• The only network request is a HEAD request to the page you already opened, used
  to read its own response headers. Nothing is sent to us or to third parties.
• The store build requests a single permission: storage (for your badge preference
  and per-site choices). It has no host permissions, reads no cookies through
  browser APIs, intercepts no network traffic, and ships no remote code.
• Google Chrome Web Store Limited Use: no data is sold, transferred or used for
  purposes unrelated to this single purpose, and none of it is used for
  creditworthiness or lending.

Good to know
• A client-side check can only see signals. A site that hides its stack (proxy
  stripping headers, extension-less URLs, no session cookies) will show 🟢 even if
  PHP is running. The popup explains this and lists what was actually observed.
• It is a stack fingerprint, not a malware or security scanner. "Uses PHP" does not
  mean "dangerous" — a large share of the web runs on PHP.
• Works on http and https pages. Chrome internal pages are out of scope.

Available in 12 languages: English, 日本語, 简体中文, 繁體中文, 한국어, Español,
Français, Deutsch, Português (Brasil), Русский, العربية, हिन्दी.

Open source (MIT): https://github.com/yomiplush/php-simple-check
```

**Screenshots** (1280×800)

```
docs/store/screenshot-1.png  Detected PHP signals with the breakdown panel open
docs/store/screenshot-2.png  A page with no PHP signals
```

**Store icon**

```
extension/icons/icon128.png
```

**Homepage / Support URL**

```
https://github.com/yomiplush/php-simple-check
https://github.com/yomiplush/php-simple-check/issues
```

**Privacy policy URL**

```
https://yomiplush.github.io/php-simple-check/privacy-policy.html
```

(Hosted with GitHub Pages from `docs/`. The GitHub blob URL
`https://github.com/yomiplush/php-simple-check/blob/main/docs/privacy-policy.html`
works as a fallback.)

---

## 日本語リスティング

**名前**

```
PHP Simple Check
```

**概要（132文字以内）**

```
そのサイトが PHP で動いているかを一目で確認。判定はすべて端末内で完結し、ツールバーアイコンとページ内バッジに色で表示します。
```

**詳細説明**

```
PHP Simple Check は、いま見ているページが PHP で動いているかを判定する拡張機能です。

ページの読み込み後に、そのページ自身から取得できる手がかり（レスポンスヘッダー、
ページが読める Cookie、URL、マークアップ）を調べ、3 段階で表示します。

  🔴 PHP 使用の兆候あり
  🟡 PHP の可能性あり（弱い兆候のみ）
  🟢 PHP の兆候なし

結果は 4 か所に出ます。ツールバーのアイコンが判定色に変わり、小さなバッジが
PHP / ? / OK を表示し、ページ右下のバッジとポップアップで根拠を確認できます。

プライバシー
• サーバー・解析・アカウントはありません。判定はすべて端末内で完結します。
• 通信は、開いたページ自身への HEAD リクエスト 1 回だけ（レスポンスヘッダーの取得）。
  どこにも送信しません。
• ストア版の権限は storage のみ（バッジ表示とサイトごとの設定の保存）。

単一目的
• ページ自身から取得できる情報（レスポンスヘッダー、Cookie、URL、マークアップ）
  だけを使い、そのページが PHP で動いているかを報告します。それ以外の機能はありません。

注意
• クライアント側で見えるのは「兆候」だけです。ヘッダーを削除するプロキシや
  拡張子なし URL を使うサイトでは、PHP が動いていても 🟢 になります。
• これはスタックの推定であり、マルウェア検査ではありません。PHP の使用は危険を
  意味しません。

対応言語: 日本語 / English / 简体中文 / 繁體中文 / 한국어 / Español / Français /
Deutsch / Português (Brasil) / Русский / العربية / हिन्दी

オープンソース (MIT): https://github.com/yomiplush/php-simple-check
```

---

## Review answers (Privacy practices tab)

| Question | Answer |
| --- | --- |
| Single purpose | Report whether the current page is served by PHP, using signals available to the page itself. |
| `storage` justification | Stores the on-page badge preference and per-site hide choices locally. |
| Host access justification | The content script needs to run on http(s) pages to read the page's markup and to issue one same-origin HEAD request for its response headers, which is what the verdict is based on. No data leaves the browser. |
| Remote code | **No.** All code ships in the package; nothing is fetched or evaluated at runtime. |
| Data collection | **None.** Nothing is sold, transferred, or used for unrelated purposes. |
| Cookies | The store build uses no cookie API; it only sees cookies that the page's own JavaScript can read. |
| Authentication / accounts | Not applicable. |
| Ads / analytics | None. |
| Privacy policy | URL above. |

## Reviewer test script

1. Install the extension and open any `https://` page.
2. A badge appears in the bottom-right corner with a verdict; the toolbar icon is
   red, amber or green. Clicking the badge or the toolbar icon shows the signals.
3. For an obvious 🔴, open `https://wordpress.org/` (WordPress, PHP). For 🟢, open a
   static site, e.g. `https://example.com/`.
4. No network requests are made other than a HEAD request to the page you opened
   (visible in DevTools › Network).
