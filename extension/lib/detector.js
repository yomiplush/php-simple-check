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
