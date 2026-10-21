// ==UserScript==
// @name         PHP Simple Check
// @namespace    https://github.com/yomiplush/php-simple-check
// @version      1.0.0
// @description  読み込んだサイトのレスポンスヘッダー・Cookie・DOM から、PHP が使われているかを簡易判定します（🔴 PHP / 🟢 非 PHP）。
// @author       yomiplush
// @homepageURL  https://github.com/yomiplush/php-simple-check
// @supportURL   https://github.com/yomiplush/php-simple-check/issues
// @downloadURL  https://raw.githubusercontent.com/yomiplush/php-simple-check/main/userscript/php-simple-check.user.js
// @updateURL    https://raw.githubusercontent.com/yomiplush/php-simple-check/main/userscript/php-simple-check.user.js
// @match        http://*/*
// @match        https://*/*
// @run-at       document-idle
// @grant        none
// @noframes
// @icon         https://raw.githubusercontent.com/yomiplush/php-simple-check/main/extension/icons/icon128.png
// ==/UserScript==

/* ---- extension/lib/detector.js ---- */

/*!
 * PHP Simple Check — detection core
 *
 * Pure logic: no DOM, no network, no browser APIs. It is loaded by the Chrome
 * extension (service worker / popup / content script) and by the userscript, so
 * every platform gives the same verdict.
 *
 * Input (all fields optional):
 *   {
 *     url: string,
 *     headers: { [name]: string | string[] } | Array<{ name, value }>,
 *     cookieNames: string[],
 *     dom: {
 *       url?: string,
 *       generator?: string | null,
 *       resources?: string[],   // URLs the page loads (scripts, styles, images, …)
 *       anchors?: string[],     // hrefs found in the document
 *       apiLinks?: string[],    // <link href> values hinting at REST APIs
 *       markers?: {             // cheap booleans observed in the page
 *         wpSettings?: boolean,
 *         drupalSettings?: boolean,
 *         joomlaOptions?: boolean,
 *         inlineHasWpPaths?: boolean,
 *         inlineHasWpJson?: boolean,
 *         inlineHasPhpUrl?: boolean
 *       }
 *     }
 *   }
 *
 * Output:
 *   { verdict: 'php' | 'maybe' | 'none', emoji, label, score, signals[], facts{} }
 *
 * Verdict rules: positive weights add up.
 *   score >= 3 → 🔴 php   (a decisive signal, or several decent ones)
 *   score >= 1 → 🟡 maybe (weak hints only)
 *   otherwise  → 🟢 none  (nothing points at PHP)
 */
(function (global) {
  'use strict';

  var VERSION = '1.0.0';

  var VERDICTS = {
    php: {
      key: 'php',
      emoji: '🔴',
      label: 'PHP 使用の兆候あり',
      short: 'PHP 検出',
      badge: 'PHP',
      color: '#d32f2f'
    },
    maybe: {
      key: 'maybe',
      emoji: '🟡',
      label: 'PHP の可能性あり（弱い兆候のみ）',
      short: '要確認',
      badge: '?',
      color: '#f9a825'
    },
    none: {
      key: 'none',
      emoji: '🟢',
      label: 'PHP の兆候なし',
      short: 'PHP 非検出',
      badge: 'OK',
      color: '#2e7d32'
    }
  };

  /** Matches `/index.php`, `/api.php/v1` … but not `/data.php.bak`. */
  var PHP_EXTENSION = /\.php(?:\/|$)/i;
  var STATIC_GENERATOR = /^(?:hugo|jekyll|gatsby|eleventy|astro|next\.js|nuxt|docusaurus|hexo|pelican|mkdocs|vitepress|vuepress|sphinx|zola|11ty)\b/i;

  /** Cookie names that only PHP stacks hand out. */
  var COOKIE_SIGNATURES = [
    { id: 'cookie-php-session', weight: 3, label: 'PHP セッション Cookie', pattern: /^PHPSESSID/i },
    { id: 'cookie-wordpress', weight: 3, label: 'WordPress の Cookie', pattern: /^(?:wordpress(?:_sec)?_|wp-settings-|wp_woocommerce_session_)/i },
    { id: 'cookie-laravel', weight: 3, label: 'Laravel のセッション Cookie', pattern: /^laravel_session$/i },
    { id: 'cookie-codeigniter', weight: 3, label: 'CodeIgniter のセッション Cookie', pattern: /^ci_session/i },
    { id: 'cookie-cakephp', weight: 3, label: 'CakePHP のセッション Cookie', pattern: /^CAKEPHP$/i },
    { id: 'cookie-craft', weight: 3, label: 'Craft CMS の Cookie', pattern: /^(?:CraftSessionId|CRAFT_CSRF_TOKEN)$/i },
    { id: 'cookie-typo3', weight: 3, label: 'TYPO3 の Cookie', pattern: /^fe_typo_user$/i },
    { id: 'cookie-drupal', weight: 3, label: 'Drupal / Symfony 系のセッション Cookie', pattern: /^S?SESS[0-9a-f]{32}$/i },
    { id: 'cookie-symfony', weight: 3, label: 'Symfony 系の Cookie', pattern: /^(?:sf_redirect|symfony)$/i },
    { id: 'cookie-joomla', weight: 3, label: 'Joomla の Cookie', pattern: /^joomla_/i },
    { id: 'cookie-phpbb', weight: 3, label: 'phpBB の Cookie', pattern: /^phpbb\d*_(?:sid|data)$/i },
    { id: 'cookie-xsrf', weight: 1, label: 'XSRF-TOKEN Cookie（PHP フレームワークでよく使われる）', pattern: /^XSRF-TOKEN$/i }
  ];

  /** <meta name="generator"> values. */
  var GENERATOR_SIGNATURES = [
    { id: 'generator-wordpress', weight: 3, label: 'WordPress', pattern: /wordpress/i },
    { id: 'generator-drupal', weight: 3, label: 'Drupal', pattern: /drupal/i },
    { id: 'generator-joomla', weight: 3, label: 'Joomla', pattern: /joomla/i },
    { id: 'generator-typo3', weight: 3, label: 'TYPO3', pattern: /typo3/i },
    { id: 'generator-concrete', weight: 3, label: 'Concrete CMS', pattern: /concrete\s*cms/i },
    { id: 'generator-craft', weight: 3, label: 'Craft CMS', pattern: /craft\s*cms/i },
    { id: 'generator-mediawiki', weight: 3, label: 'MediaWiki', pattern: /mediawiki/i },
    { id: 'generator-moodle', weight: 3, label: 'Moodle', pattern: /moodle/i },
    { id: 'generator-shopware', weight: 3, label: 'Shopware', pattern: /shopware/i },
    { id: 'generator-prestashop', weight: 3, label: 'PrestaShop', pattern: /prestashop/i },
    { id: 'generator-bitrix', weight: 3, label: '1C-Bitrix', pattern: /bitrix/i }
  ];

  /** Headers emitted by PHP frameworks / runtimes. */
  var FRAMEWORK_HEADERS = [
    { id: 'header-drupal', weight: 3, label: 'Drupal のレスポンスヘッダ', prefix: 'x-drupal' },
    { id: 'header-typo3', weight: 3, label: 'TYPO3 のレスポンスヘッダ', prefix: 'x-typo3' },
    { id: 'header-symfony', weight: 3, label: 'Symfony のレスポンスヘッダ', prefix: 'x-symfony' },
    { id: 'header-laravel', weight: 3, label: 'Laravel のレスポンスヘッダ', prefix: 'x-laravel' }
  ];

  function safeUrl(value, base) {
    if (!value) return null;
    try {
      return new URL(String(value), base || undefined);
    } catch (error) {
      return null;
    }
  }

  function normalizeHeaderInput(headers) {
    if (!headers) return [];
    if (Array.isArray(headers)) {
      return headers
        .map(function (entry) {
          if (Array.isArray(entry)) return entry;
          if (entry && typeof entry === 'object' && 'name' in entry) return [entry.name, entry.value];
          return null;
        })
        .filter(Boolean);
    }
    if (typeof headers === 'object') return Object.keys(headers).map(function (name) { return [name, headers[name]]; });
    return [];
  }

  function toHeaderMap(headers) {
    var map = Object.create(null);
    normalizeHeaderInput(headers).forEach(function (pair) {
      var name = String(pair[0] == null ? '' : pair[0]).toLowerCase().trim();
      if (!name) return;
      var rawValue = pair[1];
      if (rawValue == null) return;
      var values = Array.isArray(rawValue) ? rawValue : [rawValue];
      var bucket = map[name] || (map[name] = []);
      values.forEach(function (value) {
        if (value == null) return;
        var text = String(value).trim();
        if (text) bucket.push(text);
      });
    });
    return map;
  }

  function uniqueHttpUrls(list, base) {
    var seen = Object.create(null);
    var out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length && out.length < 400; i += 1) {
      var url = safeUrl(list[i], base);
      if (!url) continue;
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      if (seen[url.href]) continue;
      seen[url.href] = true;
      out.push(url);
    }
    return out;
  }

  function hostRelated(a, b) {
    if (!a || !b) return false;
    var x = String(a).toLowerCase();
    var y = String(b).toLowerCase();
    return x === y || x.endsWith('.' + y) || y.endsWith('.' + x);
  }

  function buildContext(signals) {
    var input = signals && typeof signals === 'object' ? signals : {};
    var pageUrl = safeUrl(input.url);
    var headers = toHeaderMap(input.headers);
    var cookieNames = Array.isArray(input.cookieNames)
      ? input.cookieNames.filter(Boolean).map(String)
      : [];
    var dom = input.dom && typeof input.dom === 'object' ? input.dom : {};
    var markers = dom.markers && typeof dom.markers === 'object' ? dom.markers : {};
    var headerNames = Object.keys(headers);

    return {
      pageUrl: pageUrl,
      dom: dom,
      markers: markers,
      cookieNames: cookieNames,
      resources: uniqueHttpUrls(dom.resources, pageUrl),
      anchors: uniqueHttpUrls(dom.anchors, pageUrl),
      apiLinks: uniqueHttpUrls(dom.apiLinks, pageUrl),
      headerNames: headerNames,
      header: function (name) {
        var values = headers[name];
        return values && values.length ? values.join(', ') : null;
      },
      hasHeaderPrefix: function (prefix) {
        return headerNames.some(function (name) { return name.indexOf(prefix) === 0; });
      },
      isFirstParty: function (url) {
        return Boolean(url && pageUrl && hostRelated(url.hostname, pageUrl.hostname));
      }
    };
  }

  function firstPartyPhpUrls(urls, ctx) {
    return urls.filter(function (url) {
      return ctx.isFirstParty(url) && PHP_EXTENSION.test(url.pathname);
    });
  }

  /** Rules run in order; each may return { detail, label? } or null. */
  var RULES = [
    /* ---------------------------------------------------------------- headers */
    {
      id: 'header-x-powered-by-php',
      source: 'header',
      weight: 3,
      label: 'X-Powered-By が PHP',
      test: function (ctx) {
        var value = ctx.header('x-powered-by');
        if (!value || !/(?:^|[\s,;/])php(?:[\s/;,]|$)/i.test(value)) return null;
        return { detail: 'X-Powered-By: ' + value };
      }
    },
    {
      id: 'header-x-powered-by-other',
      source: 'header',
      weight: -2,
      label: 'X-Powered-By が PHP 以外',
      test: function (ctx) {
        var value = ctx.header('x-powered-by');
        if (!value || /php/i.test(value)) return null;
        return { detail: 'X-Powered-By: ' + value };
      }
    },
    {
      id: 'header-server-php',
      source: 'header',
      weight: 3,
      label: 'Server ヘッダに PHP / HHVM',
      test: function (ctx) {
        var value = ctx.header('server');
        if (!value || !/(?:php|hhvm)/i.test(value)) return null;
        return { detail: 'Server: ' + value };
      }
    },
    {
      id: 'header-set-cookie-php-session',
      source: 'header',
      weight: 3,
      label: 'Set-Cookie に PHP セッション',
      test: function (ctx) {
        var value = ctx.header('set-cookie');
        if (!value || !/PHPSESSID=/i.test(value)) return null;
        return { detail: 'Set-Cookie: PHPSESSID=…' };
      }
    },
    {
      id: 'header-x-generator',
      source: 'header',
      weight: 3,
      label: 'X-Generator が PHP 製 CMS',
      test: function (ctx) {
        var value = ctx.header('x-generator');
        if (!value) return null;
        var match = null;
        GENERATOR_SIGNATURES.forEach(function (signature) {
          if (signature.weight > 0 && signature.pattern.test(value)) match = signature;
        });
        if (!match) return null;
        return { label: 'X-Generator: ' + match.label, detail: 'X-Generator: ' + value };
      }
    },
    /* ---------------------------------------------------------------- cookies */
    {
      id: 'cookie-signature',
      source: 'cookie',
      weight: 3,
      label: 'PHP フレームワークの Cookie',
      test: function (ctx) {
        var hits = [];
        ctx.cookieNames.forEach(function (name) {
          COOKIE_SIGNATURES.forEach(function (signature) {
            if (signature.pattern.test(name)) hits.push({ signature: signature, name: name });
          });
        });
        if (!hits.length) return null;
        var best = hits[0];
        hits.forEach(function (hit) {
          if (hit.signature.weight > best.signature.weight) best = hit;
        });
        return {
          weight: best.signature.weight,
          label: best.signature.label,
          detail: 'Cookie: ' + hits.map(function (hit) { return hit.name; }).slice(0, 4).join(', ')
        };
      }
    },

    /* --------------------------------------------------------------- meta tag */
    {
      id: 'generator-cms',
      source: 'dom',
      weight: 3,
      label: 'PHP 製 CMS の generator',
      test: function (ctx) {
        var generator = ctx.dom.generator;
        if (!generator || typeof generator !== 'string') return null;
        var match = null;
        GENERATOR_SIGNATURES.forEach(function (signature) {
          if (signature.weight > 0 && signature.pattern.test(generator)) match = signature;
        });
        if (!match) return null;
        return { label: match.label + ' (generator)', detail: 'meta generator: ' + generator };
      }
    },
    {
      id: 'generator-static',
      source: 'dom',
      weight: -2,
      label: '静的サイトジェネレーター',
      test: function (ctx) {
        var generator = ctx.dom.generator;
        if (!generator || typeof generator !== 'string' || !STATIC_GENERATOR.test(generator)) return null;
        return { detail: 'meta generator: ' + generator };
      }
    },

    /* -------------------------------------------------------------------- URL */
    {
      id: 'url-php',
      source: 'url',
      weight: 3,
      label: 'ページ URL が .php',
      test: function (ctx) {
        if (!ctx.pageUrl || !PHP_EXTENSION.test(ctx.pageUrl.pathname)) return null;
        return { detail: ctx.pageUrl.pathname };
      }
    },
    {
      id: 'resource-php',
      source: 'dom',
      weight: 3,
      label: 'PHP ファイルを読み込んでいる',
      test: function (ctx) {
        var urls = firstPartyPhpUrls(ctx.resources, ctx);
        if (!urls.length) return null;
        return { detail: urls.slice(0, 3).map(function (url) { return url.href; }).join(', ') + (urls.length > 3 ? ' …' : '') };
      }
    },
    {
      id: 'anchor-php',
      source: 'dom',
      weight: 2,
      label: '同一サイトの .php へのリンク',
      test: function (ctx) {
        var urls = firstPartyPhpUrls(ctx.anchors, ctx);
        if (!urls.length) return null;
        return { detail: urls.slice(0, 3).map(function (url) { return url.pathname; }).join(', ') + (urls.length > 3 ? ' …' : '') };
      }
    },
    {
      id: 'query-hints',
      source: 'url',
      weight: 1,
      label: 'PHP っぽいクエリパラメータ',
      test: function (ctx) {
        if (!ctx.pageUrl) return null;
        var keys = ['p', 'page_id', 'cat', 'attachment_id', 'preview_id'];
        var hit = keys.filter(function (key) { return ctx.pageUrl.searchParams.has(key); });
        if (!hit.length) return null;
        return { detail: '?' + hit[0] + '=…' };
      }
    },

    /* -------------------------------------------------------------- page body */
    {
      id: 'wp-paths',
      source: 'dom',
      weight: 3,
      label: 'WordPress のパス (/wp-content/, /wp-includes/)',
      test: function (ctx) {
        var all = ctx.resources.concat(ctx.anchors);
        var hit = all.filter(function (url) { return /\/wp-(?:content|includes)\//i.test(url.pathname); });
        if (!hit.length && !ctx.markers.inlineHasWpPaths) return null;
        return { detail: hit.length ? hit[0].pathname : 'インラインスクリプト内の /wp-content/' };
      }
    },
    {
      id: 'wp-api',
      source: 'dom',
      weight: 3,
      label: 'WordPress REST API への参照',
      test: function (ctx) {
        var hit = ctx.apiLinks.filter(function (url) { return /api\.w\.org|\/wp-json/i.test(url.href); });
        if (hit.length) return { detail: hit[0].href };
        if (ctx.markers.inlineHasWpJson) return { detail: 'インラインスクリプト内の wp-json' };
        return null;
      }
    },
    {
      id: 'wp-globals',
      source: 'dom',
      weight: 3,
      label: 'WordPress のグローバル変数',
      test: function (ctx) {
        if (!ctx.markers.wpSettings) return null;
        return { detail: 'window.wp が存在' };
      }
    },
    {
      id: 'drupal-markers',
      source: 'dom',
      weight: 3,
      label: 'Drupal のマーカー',
      test: function (ctx) {
        var hit = ctx.resources.filter(function (url) { return /\/sites\/default\/files\//i.test(url.pathname); });
        if (!hit.length && !ctx.markers.drupalSettings) return null;
        return { detail: hit.length ? hit[0].pathname : 'drupalSettings が存在' };
      }
    },
    {
      id: 'joomla-markers',
      source: 'dom',
      weight: 3,
      label: 'Joomla のマーカー',
      test: function (ctx) {
        var hit = ctx.resources.filter(function (url) { return /\/media\/system\//i.test(url.pathname); });
        if (!hit.length && !ctx.markers.joomlaOptions) return null;
        return { detail: hit.length ? hit[0].pathname : 'window.Joomla が存在' };
      }
    },
    {
      id: 'inline-php-url',
      source: 'dom',
      weight: 2,
      label: 'インラインスクリプト内の .php URL',
      test: function (ctx) {
        if (!ctx.markers.inlineHasPhpUrl) return null;
        return { detail: 'スクリプト文字列に .php を検出' };
      }
    }
  ];

  /* Framework header rules are generated so the list above stays readable. */
  FRAMEWORK_HEADERS.forEach(function (spec) {
    RULES.push({
      id: spec.id,
      source: 'header',
      weight: spec.weight,
      label: spec.label,
      test: function (ctx) {
        if (!ctx.hasHeaderPrefix(spec.prefix)) return null;
        var names = ctx.headerNames.filter(function (name) { return name.indexOf(spec.prefix) === 0; });
        return { detail: names.slice(0, 3).join(', ') };
      }
    });
  });

  function evaluate(signals) {
    var ctx = buildContext(signals);
    var signalsOut = [];

    RULES.forEach(function (rule) {
      var match;
      try {
        match = rule.test(ctx);
      } catch (error) {
        return;
      }
      if (!match) return;
      signalsOut.push({
        id: rule.id,
        source: rule.source,
        weight: typeof match.weight === 'number' ? match.weight : rule.weight,
        label: match.label || rule.label,
        detail: match.detail || ''
      });
    });

    var score = signalsOut.reduce(function (sum, signal) {
      return signal.weight > 0 ? sum + signal.weight : sum;
    }, 0);
    var negatives = signalsOut.filter(function (signal) { return signal.weight < 0; });

    var verdictKey = score >= 3 ? 'php' : score >= 1 ? 'maybe' : 'none';
    var verdict = VERDICTS[verdictKey];

    var positives = signalsOut
      .filter(function (signal) { return signal.weight > 0; })
      .sort(function (a, b) { return b.weight - a.weight; });

    var phpResources = firstPartyPhpUrls(ctx.resources, ctx);
    var phpAnchors = firstPartyPhpUrls(ctx.anchors, ctx);

    return {
      version: VERSION,
      verdict: verdictKey,
      emoji: verdict.emoji,
      label: verdict.label,
      short: verdict.short,
      color: verdict.color,
      score: score,
      confidence: positives.some(function (signal) { return signal.weight >= 3; })
        ? 'high'
        : positives.length
          ? 'low'
          : negatives.length ? 'medium' : 'low',
      signals: positives.concat(negatives),
      facts: {
        url: ctx.pageUrl ? ctx.pageUrl.href : '',
        xPoweredBy: ctx.header('x-powered-by'),
        server: ctx.header('server'),
        generator: typeof ctx.dom.generator === 'string' ? ctx.dom.generator : null,
        cookies: ctx.cookieNames.slice(0, 12),
        phpResources: phpResources.slice(0, 5).map(function (url) { return url.href; }),
        phpAnchors: phpAnchors.slice(0, 5).map(function (url) { return url.pathname; })
      },
      checkedAt: Date.now()
    };
  }

  global.PHPSimpleCheck = {
    version: VERSION,
    verdicts: VERDICTS,
    evaluate: evaluate
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ---- extension/lib/collect-dom.js ---- */

/*!
 * PHP Simple Check — page observation
 *
 * Collects the cheap, client-side observable facts the detector needs:
 * resource URLs, anchors, <meta name="generator">, cookies readable from JS and
 * a few page markers. Runs in a content script (isolated world) and in the
 * userscript (page world), so it must never touch page-specific globals without
 * a guard.
 */
(function (global) {
  'use strict';

  var MAX_RESOURCES = 250;
  var MAX_ANCHORS = 400;
  var MAX_INLINE_SCRIPT_CHARS = 400000;

  var RESOURCE_SELECTOR = [
    'script[src]',
    'link[href]',
    'img[src]',
    'iframe[src]',
    'source[src]',
    'video[src]',
    'audio[src]',
    'track[src]',
    'embed[src]',
    'object[data]',
    'form[action]'
  ].join(',');

  function each(selector, limit, handler) {
    var nodes;
    try {
      nodes = document.querySelectorAll(selector);
    } catch (error) {
      return;
    }
    for (var i = 0; i < nodes.length && i < limit; i += 1) handler(nodes[i]);
  }

  function metaGenerator() {
    var content = null;
    each('meta[name]', 200, function (meta) {
      if (content) return;
      var name = (meta.getAttribute('name') || '').toLowerCase();
      if (name === 'generator') content = meta.getAttribute('content') || null;
    });
    return content;
  }

  function resourceUrls() {
    var urls = [];
    var seen = Object.create(null);

    function push(value) {
      if (!value || urls.length >= MAX_RESOURCES) return;
      var text;
      try {
        text = new URL(value, document.baseURI).href;
      } catch (error) {
        return;
      }
      if (seen[text]) return;
      seen[text] = true;
      urls.push(text);
    }

    try {
      var entries = performance.getEntriesByType('resource') || [];
      for (var i = 0; i < entries.length; i += 1) push(entries[i].name);
    } catch (error) {
      /* performance API unavailable (rare) */
    }

    each(RESOURCE_SELECTOR, MAX_RESOURCES, function (element) {
      push(element.src || element.href || element.getAttribute('data') || element.getAttribute('action'));
    });

    return urls;
  }

  function anchorUrls() {
    var urls = [];
    each('a[href], area[href]', MAX_ANCHORS, function (anchor) {
      var href = anchor.href;
      if (!href) return;
      if (href.indexOf('http://') !== 0 && href.indexOf('https://') !== 0) return;
      urls.push(href);
    });
    return urls;
  }

  function apiLinkUrls() {
    var urls = [];
    each('link[href]', 60, function (link) {
      var rel = (link.getAttribute('rel') || '').toLowerCase();
      var href = link.getAttribute('href') || '';
      if (rel.indexOf('api.w.org') !== -1 || href.indexOf('/wp-json') !== -1) {
        try {
          urls.push(new URL(href, document.baseURI).href);
        } catch (error) {
          /* ignore malformed href */
        }
      }
    });
    return urls;
  }

  function inlineScriptText() {
    var parts = [];
    var total = 0;
    var scripts;
    try {
      scripts = document.scripts;
    } catch (error) {
      return '';
    }
    for (var i = 0; i < scripts.length && total < MAX_INLINE_SCRIPT_CHARS; i += 1) {
      var script = scripts[i];
      if (script.src) continue;
      var text = script.textContent || '';
      if (!text) continue;
      parts.push(text);
      total += text.length;
    }
    return parts.join('\n').slice(0, MAX_INLINE_SCRIPT_CHARS);
  }

  function pageGlobals() {
    var observed = {};
    try {
      observed.wp = Boolean(global.wp && (global.wp.apiSettings || global.wp.apiFetch));
      observed.drupalSettings = Boolean(global.drupalSettings);
      observed.Joomla = Boolean(global.Joomla);
    } catch (error) {
      /* cross-world access can throw */
    }
    return observed;
  }

  function cookieNames() {
    var raw = '';
    try {
      raw = document.cookie || '';
    } catch (error) {
      return [];
    }
    return raw
      .split(';')
      .map(function (part) { return part.split('=')[0].trim(); })
      .filter(Boolean);
  }

  function collect(options) {
    var settings = options || {};
    var inline = settings.includeInlineScripts === false ? '' : inlineScriptText();
    var globalsSeen = pageGlobals();

    return {
      url: location.href,
      cookieNames: cookieNames(),
      dom: {
        generator: metaGenerator(),
        resources: resourceUrls(),
        anchors: anchorUrls(),
        apiLinks: apiLinkUrls(),
        markers: {
          wpSettings: globalsSeen.wp,
          drupalSettings: globalsSeen.drupalSettings,
          joomlaOptions: globalsSeen.Joomla,
          inlineHasWpPaths: /\/wp-(?:content|includes)\//i.test(inline),
          inlineHasWpJson: /(?:wp-json|api\.w\.org)/i.test(inline),
          inlineHasPhpUrl: /\.php(?:[?#"')\s]|$)/i.test(inline)
        }
      }
    };
  }

  global.PHPSimpleCheckDom = { collect: collect };
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ---- extension/lib/overlay.js ---- */

/*!
 * PHP Simple Check — on-page badge
 *
 * A small, self-contained Shadow DOM badge (bottom-right) shared by the Chrome
 * content script and the userscript, so both platforms show the same 🔴/🟢 UI.
 * No page CSS can leak in, and page data is always inserted with textContent.
 */
(function (global) {
  'use strict';

  var HOST_ID = 'php-simple-check-badge';
  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box}',
    '.wrap{display:flex;flex-direction:column;align-items:flex-end;gap:8px;font:400 12px/1.45 system-ui,-apple-system,"Segoe UI","Hiragino Sans","Noto Sans JP",sans-serif;color:#111}',
    '.badge{display:inline-flex;align-items:center;gap:6px;padding:6px 11px;border-radius:999px;border:1px solid #d0d7de;background:#fff;color:#111;font:inherit;font-weight:600;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.18);transition:transform .12s ease,box-shadow .12s ease}',
    '.badge:hover{transform:translateY(-1px);box-shadow:0 4px 14px rgba(0,0,0,.24)}',
    '.badge:focus-visible{outline:2px solid #0969da;outline-offset:2px}',
    '.badge-emoji{font-size:13px;line-height:1}',
    '.panel{width:min(340px,calc(100vw - 32px));max-height:min(60vh,520px);overflow:auto;padding:12px;border-radius:12px;border:1px solid #d0d7de;background:#fff;box-shadow:0 8px 28px rgba(0,0,0,.22)}',
    '.panel[hidden]{display:none}',
    '.panel-head{display:flex;align-items:center;gap:6px;margin:0 0 6px}',
    '.panel-emoji{font-size:16px;line-height:1}',
    '.panel-title{font-weight:700;font-size:13px;flex:1 1 auto}',
    '.close{border:0;background:transparent;color:#57606a;font-size:16px;line-height:1;cursor:pointer;padding:2px 4px;border-radius:6px}',
    '.close:hover{background:#f3f4f6;color:#111}',
    '.summary{margin:0 0 8px;color:#57606a;font-size:11px}',
    '.signals{list-style:none;margin:0 0 8px;padding:0;display:flex;flex-direction:column;gap:6px}',
    '.signals li{display:flex;gap:7px;align-items:flex-start}',
    '.weight{flex:0 0 auto;min-width:22px;text-align:center;border-radius:5px;padding:0 4px;font-weight:700;font-size:10px;line-height:16px;background:#eef1f4;color:#57606a}',
    '.weight.strong{background:#fdecea;color:#b3261e}',
    '.weight.weak{background:#fff4e5;color:#8a5300}',
    '.weight.negative{background:#e8f5e9;color:#1b5e20}',
    '.signal-label{display:block;font-weight:600;font-size:11.5px}',
    '.signal-detail{display:block;color:#57606a;font:400 10.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}',
    '.facts{margin:0 0 8px;display:grid;grid-template-columns:auto 1fr;gap:2px 8px;font-size:10.5px;color:#57606a}',
    '.facts dt{font-weight:600;color:#111}',
    '.facts dd{margin:0;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
    '.facts:empty{display:none}',
    '.note{margin:0;font-size:10px;line-height:1.5;color:#6e7781}',
    '@media (prefers-color-scheme:dark){',
    '.wrap{color:#e6edf3}',
    '.badge{background:#161b22;color:#e6edf3;border-color:#30363d}',
    '.panel{background:#161b22;color:#e6edf3;border-color:#30363d}',
    '.panel-title{color:#e6edf3}',
    '.summary,.note{color:#8b949e}',
    '.facts dt{color:#e6edf3}',
    '.facts dd{color:#8b949e}',
    '.close{color:#8b949e}',
    '.close:hover{background:#21262d;color:#e6edf3}',
    '}'
  ].join('\n');

  var state = {
    host: null,
    refs: null,
    result: null,
    hidden: false,
    onClose: null
  };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function ensure() {
    if (state.host && state.host.isConnected) return state.refs;

    var host = el('div');
    host.id = HOST_ID;
    host.style.cssText =
      'all:initial;position:fixed;right:calc(16px + env(safe-area-inset-right, 0px));' +
      'bottom:calc(16px + env(safe-area-inset-bottom, 0px));z-index:2147483647;display:block;';
    var shadow = host.attachShadow({ mode: 'open' });

    var style = el('style');
    style.textContent = CSS;

    var wrap = el('div', 'wrap');

    var panel = el('section', 'panel');
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'PHP Simple Check の判定結果');

    var head = el('div', 'panel-head');
    var panelEmoji = el('span', 'panel-emoji');
    var panelTitle = el('span', 'panel-title');
    var close = el('button', 'close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '閉じる');
    close.addEventListener('click', function () {
      hide();
      if (state.onClose) state.onClose();
    });
    head.appendChild(panelEmoji);
    head.appendChild(panelTitle);
    head.appendChild(close);

    var summary = el('p', 'summary');
    var list = el('ul', 'signals');
    var facts = el('dl', 'facts');
    var note = el('p', 'note', 'クライアント側で観測できるのは「兆候」だけです。PHP がサーバー内部で動いていても、応答に痕跡が出ない場合は 🟢 になります。');

    panel.appendChild(head);
    panel.appendChild(summary);
    panel.appendChild(list);
    panel.appendChild(facts);
    panel.appendChild(note);

    var badge = el('button', 'badge');
    badge.type = 'button';
    badge.title = 'クリックで詳細を表示';
    var badgeEmoji = el('span', 'badge-emoji');
    var badgeLabel = el('span', 'badge-label');
    badge.appendChild(badgeEmoji);
    badge.appendChild(badgeLabel);
    badge.addEventListener('click', function () {
      panel.hidden = !panel.hidden;
    });

    wrap.appendChild(panel);
    wrap.appendChild(badge);
    shadow.appendChild(style);
    shadow.appendChild(wrap);

    document.documentElement.appendChild(host);

    state.host = host;
    state.refs = {
      shadow: shadow,
      wrap: wrap,
      panel: panel,
      panelEmoji: panelEmoji,
      panelTitle: panelTitle,
      summary: summary,
      list: list,
      facts: facts,
      badge: badge,
      badgeEmoji: badgeEmoji,
      badgeLabel: badgeLabel
    };
    return state.refs;
  }

  function weightClass(weight) {
    if (weight < 0) return 'weight negative';
    return weight >= 3 ? 'weight strong' : 'weight weak';
  }

  function renderSignals(refs, result) {
    refs.list.textContent = '';
    var signals = result.signals || [];
    if (!signals.length) {
      var empty = el('li');
      empty.appendChild(el('span', 'signal-label', '検出できたシグナルはありません'));
      refs.list.appendChild(empty);
      return;
    }
    signals.forEach(function (signal) {
      var item = el('li');
      var weight = el('span', weightClass(signal.weight), (signal.weight > 0 ? '+' : '') + signal.weight);
      var body = el('span');
      body.appendChild(el('span', 'signal-label', signal.label));
      if (signal.detail) {
        var detail = el('span', 'signal-detail', signal.detail);
        body.appendChild(detail);
      }
      item.appendChild(weight);
      item.appendChild(body);
      refs.list.appendChild(item);
    });
  }

  function renderFacts(refs, result) {
    refs.facts.textContent = '';
    var facts = result.facts || {};
    var rows = [
      ['X-Powered-By', facts.xPoweredBy],
      ['Server', facts.server],
      ['generator', facts.generator],
      ['Cookie', (facts.cookies || []).slice(0, 4).join(', ')],
      ['.php', (facts.phpResources || [])[0] || (facts.phpAnchors || [])[0]]
    ];
    rows.forEach(function (row) {
      if (!row[1]) return;
      refs.facts.appendChild(el('dt', null, row[0]));
      refs.facts.appendChild(el('dd', null, row[1]));
    });
  }

  function render(result) {
    if (!result || !result.verdict) return;
    var refs = ensure();
    state.result = result;
    if (state.hidden) {
      state.host.style.display = 'none';
      return;
    }
    state.host.style.display = 'block';

    refs.badgeEmoji.textContent = result.emoji;
    refs.badgeLabel.textContent = result.short || result.label;
    refs.badge.style.borderColor = result.color;
    refs.badge.setAttribute('aria-label', result.emoji + ' ' + result.label + '（詳細を表示）');
    refs.panelEmoji.textContent = result.emoji;
    refs.panelTitle.textContent = result.label;

    var count = (result.signals || []).filter(function (signal) { return signal.weight > 0; }).length;
    refs.summary.textContent = 'スコア ' + result.score + ' ・ PHP の手がかり ' + count + ' 件' +
      (result.confidence === 'high' ? ' ・ 決定的なシグナルあり' : '');

    renderSignals(refs, result);
    renderFacts(refs, result);
  }

  function hide() {
    state.hidden = true;
    if (state.host) state.host.style.display = 'none';
  }

  function show() {
    state.hidden = false;
    if (state.result) render(state.result);
  }

  function destroy() {
    if (state.host && state.host.parentNode) state.host.parentNode.removeChild(state.host);
    state.host = null;
    state.refs = null;
  }

  global.PHPSimpleCheckOverlay = {
    render: render,
    hide: hide,
    show: show,
    destroy: destroy,
    onClose: function (handler) { state.onClose = handler; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ---- userscript/main.js ---- */

/*!
 * PHP Simple Check — userscript entry point
 *
 * Built for Safari (Userscripts app) and Firefox for Android (Tampermonkey).
 * It runs at document-idle with @grant none, so it lives in the page world and
 * can see framework globals (window.wp / window.drupalSettings).
 *
 * Response headers are the only signal a userscript cannot read from the
 * document, so we make one extra same-origin HEAD request for them.
 */
(function () {
  'use strict';

  var RECHECK_DELAYS = [2500, 6000];
  var lastHref = location.href;
  var probed = false;
  var probedHeaders = null;

  function probeHeaders() {
    if (probed) return Promise.resolve(probedHeaders);
    probed = true;

    return fetch(location.href, {
      method: 'HEAD',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'follow'
    }).then(function (response) {
      if (!response.ok) return null;
      var headers = {};
      response.headers.forEach(function (value, name) {
        headers[name.toLowerCase()] = value;
      });
      probedHeaders = headers;
      return headers;
    }).catch(function () {
      probedHeaders = null;
      return null;
    });
  }

  function run() {
    var payload;
    try {
      payload = PHPSimpleCheckDom.collect();
    } catch (error) {
      return;
    }

    probeHeaders().then(function (headers) {
      var result;
      try {
        result = PHPSimpleCheck.evaluate({
          url: payload.url,
          headers: headers,
          cookieNames: payload.cookieNames,
          dom: payload.dom
        });
      } catch (error) {
        return;
      }
      lastHref = payload.url;
      try {
        PHPSimpleCheckOverlay.render(result);
      } catch (error) {
        /* overlay is cosmetic */
      }
      window.dispatchEvent(new CustomEvent('php-simple-check:result', { detail: result }));
    });
  }

  function schedule(delay) {
    setTimeout(function () {
      if (location.href !== lastHref) return;
      run();
    }, delay);
  }

  run();
  RECHECK_DELAYS.forEach(schedule);

  // Single-page apps swap content without a reload: re-evaluate on URL change.
  setInterval(function () {
    if (location.href === lastHref) return;
    lastHref = location.href;
    setTimeout(run, 800);
  }, 1200);

  window.addEventListener('popstate', function () { setTimeout(run, 500); });
  window.addEventListener('hashchange', function () { setTimeout(run, 500); });
})();
