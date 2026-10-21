# PHP Simple Check

サイトを開いたときに、そのサイトが **PHP で動いているか** を簡易判定するブラウザツールです。

- **🔴 赤** … PHP 使用の兆候あり
- **🟡 黄** … PHP の可能性あり（弱い兆候のみ）
- **🟢 緑** … PHP の兆候なし

判定結果はツールバーのバッジ、ページ右下のバッジ、ポップアップの 3 か所に出ます。
データは端末内で完結し、外部への送信は一切ありません。

| 配布物 | 対応環境 |
| --- | --- |
| `extension/`（Chrome 拡張 / Manifest V3） | Chrome・Edge・Brave など Chromium 系デスクトップ |
| `userscript/php-simple-check.user.js`（ユーザースクリプト） | iOS/iPadOS Safari（Userscripts アプリ）、macOS Safari、Android Firefox（Tampermonkey） |

判定ロジックは 1 か所（`extension/lib/detector.js`）にまとめてあり、拡張とユーザースクリプトは同じ結果を返します。

---

## インストール

### 1. Chrome / Edge / Brave（PC）

GitHub からサイドロードします。

1. [Releases](https://github.com/yomiplush/php-simple-check/releases/latest) から最新の `php-simple-check-extension-vX.Y.Z.zip` をダウンロードして **解凍** します。
2. ブラウザで `chrome://extensions`（Brave は `brave://extensions`）を開きます。
3. 右上の **デベロッパー モード** をオンにします。
4. **パッケージ化されていない拡張機能を読み込む** を押し、**`manifest.json` が直下にあるフォルダ** を選択します。

解凍すると通常は zip と同じ名前のフォルダができます。そのフォルダの中身はこうなっています。

```
php-simple-check-extension-v1.0.1/     ← これを選択する
├── manifest.json                      ← このファイルが直下にあること
├── background.js
├── content.js
├── popup.html
├── lib/
└── icons/
```

リポジトリを clone している場合は、`extension/` ディレクトリをそのまま読み込んでも構いません（ビルド不要）。

> **`Manifest file is missing or unreadable` と出たら**
> - zip を解凍せずに選択している → 先に解凍する
> - 1つ上のフォルダを選択している → `manifest.json` が入っているフォルダを選ぶ
> - v1.0.0 の zip は中のフォルダが1階層深い `php-simple-check-extension/` でした。v1.0.1 以降は直下に `manifest.json` が入る構造に変更しています（v1.0.0 を使う場合は `php-simple-check-extension/` を選択してください）

インストール後、任意のサイトを開くとツールバーのアイコンにバッジが付きます。アイコンをクリックすると判定の内訳（どのシグナルが効いたか）が確認できます。

### 2. iOS / iPadOS Safari（Userscripts アプリ）

1. App Store で [Userscripts](https://apps.apple.com/app/userscripts/id1463298887) をインストールします（無料）。
2. **設定 › Safari › 機能拡張 › Userscripts** を開き、機能拡張を **オン**、サイトアクセスを **許可**（または「すべての Web サイトを許可」）にします。
3. Userscripts アプリを起動し、初回だけスクリプトの保存先を選びます（iCloud Drive か「この iPhone 内」）。
4. Safari で次の URL を開き、インストール画面の指示に従います。

   ```
   https://raw.githubusercontent.com/yomiplush/php-simple-check/main/userscript/php-simple-check.user.js
   ```

   アプリの「＋」→「リモートから追加」に同じ URL を貼っても登録できます。以後は `@updateURL` で更新できます。
5. サイトを開くと右下に 🔴 / 🟡 / 🟢 バッジが出ます。タップすると内訳パネルが開きます。

macOS の Safari でも同じ手順で使えます。

> **バッジが出ないとき**
> - 設定 › Safari › 機能拡張 で Userscripts がオンになっているか
> - Userscripts アプリ内でスクリプトが有効（トグルON）か
> - ページを再読み込みしたか（`http://` / `https://` のページのみ対象）
> - プライベートブラウズでは拡張が無効になることがあります
> - 以前「このサイトでは表示しない」を押した場合は、下記の「元に戻す」で復帰できます

### 3. Android Firefox（Tampermonkey）

1. Firefox for Android（120 以降）をインストールします。
2. [Tampermonkey](https://addons.mozilla.org/firefox/addon/tampermonkey/) を Firefox に追加します（設定 › 拡張機能 から、または AMO のページから）。
3. 上と同じ `php-simple-check.user.js` の URL を Firefox で開き、Tampermonkey のインストール画面で **インストール** を押します。
4. Tampermonkey のダッシュボード（拡張機能アイコン → ダッシュボード）でスクリプトが **有効** になっていることを確認します。
5. サイトを開くと右下にバッジが出ます。更新はダッシュボードの「ユーザースクリプトを更新」から。

> Android Chrome は拡張機能・ユーザースクリプトに対応していないため対象外です。iOS も Safari（＋Userscripts）のみで、Chrome for iOS では動作しません。

### モバイルでの操作

| 操作 | 動き |
| --- | --- |
| 右下のバッジをタップ | 判定の内訳パネルを開閉 |
| パネルの ✕ | このページ表示の間だけ閉じる（再読み込みで戻る） |
| パネルの「このサイトでは表示しない」 | そのホストでは今後バッジを出さない（8 秒間「元に戻す」が出ます） |

非表示にした設定は端末内の `localStorage`（ホスト単位）にだけ保存されます。元に戻すには、バッジを消した直後の「元に戻す」を押すか、Safari の「Web サイトデータを消去」でリセットしてください。

---

## 判定のしくみ

ページ読み込み後に、クライアント側から観測できるシグナルを集めてスコア化します。
**+3 以上 → 🔴 / +1〜+2 → 🟡 / 0 → 🟢** です。

| シグナル | 重み | 例 |
| --- | --- | --- |
| `X-Powered-By` が PHP | +3 | `X-Powered-By: PHP/8.2.13` |
| `Server` に PHP / HHVM | +3 | `Server: Apache/2.4 PHP/8.1` |
| PHP セッション Cookie | +3 | `PHPSESSID=…` |
| PHP フレームワークの Cookie | +3 | `laravel_session`, `ci_session`, `CAKEPHP`, `CraftSessionId`, `fe_typo_user`, `SESS<32桁hex>` … |
| ページ URL が `.php` | +3 | `/index.php` |
| 同一サイトの `.php` を読み込んでいる | +3 | `/api/session.php` |
| CMS の generator | +3 | `<meta name="generator" content="WordPress 6.6">` |
| WordPress の痕跡 | +3 | `/wp-content/`, `/wp-includes/`, `wp-json`, `api.w.org` |
| Drupal / Joomla の痕跡 | +3 | `/sites/default/files/`, `/media/system/` |
| フレームワークのヘッダ | +3 | `X-Generator: Drupal`, `X-Drupal-*`, `X-TYPO3-*` |
| 同一サイトの `.php` へのリンク | +2 | `<a href="/contact.php">` |
| インライン JS 内の `.php` | +2 | `fetch("/ajax.php")` |
| `XSRF-TOKEN` Cookie | +1 | |
| PHP っぽいクエリ | +1 | `?p=`, `?page_id=` |
| `X-Powered-By` が PHP 以外 | −2 | `Express`, `Next.js`, `ASP.NET`（緑の根拠として表示） |
| 静的サイトジェネレーター | −2 | `Hugo`, `Jekyll`, `Astro`, `Next.js` …（同上） |

### 拡張とユーザースクリプトの違い

| | Chrome 拡張 | ユーザースクリプト |
| --- | --- | --- |
| レスポンスヘッダ | ○（`webRequest`、取得できないときは HEAD で補完） | ○（HEAD を 1 回追加送信） |
| HttpOnly Cookie | ○（`chrome.cookies`） | ×（`document.cookie` のみ） |
| DOM / リソース / generator | ○ | ○ |
| ページ内グローバル | ×（隔離ワールド） | ○（`window.wp` など。`@grant none`） |

### 実装メモ

- MV3 の Service Worker は `webRequest` イベントでは起動しないため、初回読み込みなどでレスポンスヘッダを取り逃すことがあります。その場合は同じ URL へ HEAD リクエストを 1 回送って補完します（ユーザースクリプトと同じ経路）。
- 取得したヘッダは `documentId` で文書に紐付け、別ページの証拠を再利用しないようにしています。

### 精度について（重要）

クライアント側で観測できるのは **兆候だけ** です。したがって次のような場合は 🟢 でも PHP が動いている可能性があります。

- リバースプロキシや CDN が `X-Powered-By` を削除している
- 拡張子のない URL（`/about` など）だけでルーティングしている
- セッションを持たない（Cookie を発行しない）構成
- サイト全体が静的書き出しされている

逆に、静的な HTML を `.php` という名前で配信している場合などは 🔴 になります。あくまで「簡易チェック」として使ってください。

同一サイト判定はホスト名の親子関係のみを見ます（`example.com` と `www.example.com` は同一、`static.example.com` と `blog.example.com` は別扱い）。

---

## プライバシー

- 外部サーバへの送信・解析・トラッキングはありません。
- 保存するのは「タブごとの判定結果」（メモリ＋`storage.session`）と「バッジ表示の ON/OFF」設定だけです。
- ユーザースクリプトは同じ URL へ HEAD リクエストを 1 回送るだけです（判定用ヘッダの取得）。

---

## 開発

Node.js 20+ のみで動きます（npm 依存パッケージはありません）。

```bash
npm test          # 判定ロジック・ビルド成果物のユニットテスト
npm run build     # ユーザースクリプト生成 + dist/ に zip を作成
npm run icons     # アイコン PNG を再生成
npm run test:e2e  # ヘッドレス Chrome で拡張とユーザースクリプトを実際に動かす
```

`npm run test:e2e` は Chrome を起動して検証します。**ブランド版 Chrome 137 以降は `--load-extension` を無視する**ため、[Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/) を指定してください。

```bash
CHROME_BIN=/path/to/chrome-for-testing/chrome-linux64/chrome npm run test:e2e
```

E2E では次のフィクスチャを用意し、拡張・ユーザースクリプト双方でページ内バッジ・ツールバーバッジ・保存された判定を検証します。

- 静的なページ（`Server: nginx` のみ）→ 🟢
- 同一サイトへの `.php` リンクのみ → 🟡
- `X-Powered-By: PHP` + `PHPSESSID` + `/wp-content/` → 🔴
- `X-Powered-By: PHP` だけ（HTML に痕跡なし）→ 🔴（ヘッダ取得経路の検証）
- `/header-only/` → `/static/` への同一タブ遷移 → 前ページの証拠を引きずらず 🟢 になること
- モバイル（390×844・タッチ）: バッジが画面内に収まり、タップでパネルが開き、「このサイトでは表示しない」→ 保存 →「元に戻す」が動くこと

### ディレクトリ構成

```
extension/                  Chrome 拡張（このフォルダをそのまま読み込める）
  manifest.json
  background.js             ヘッダ観測・Cookie 取得・判定・バッジ描画
  content.js                DOM 観測とページ内バッジ
  popup.html / popup.js     判定の内訳 UI
  lib/detector.js           判定ロジック（拡張とユーザースクリプトで共有）
  lib/collect-dom.js        ページからのシグナル収集（共有）
  lib/overlay.js            ページ内バッジ UI（共有）
  icons/                    生成済み PNG
userscript/
  main.js                   ユーザースクリプトのエントリ（ビルドで連結される）
  php-simple-check.user.js  ビルド成果物（そのままインストール可能）
tools/                      アイコン生成・zip 作成・ビルド
tests/                      ユニットテストと E2E
```

`userscript/php-simple-check.user.js` はビルド成果物ですが、GitHub の raw URL から直接インストールできるようにコミットしています。`extension/lib/` を編集したら `npm run build` を実行してください（CI が差分をチェックします）。

### リリース

`v1.0.0` のようなタグを push すると、GitHub Actions が zip とユーザースクリプトを Releases に添付します。

```bash
git tag v1.0.0
git push origin v1.0.0
```
