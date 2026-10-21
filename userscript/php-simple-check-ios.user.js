// ==UserScript==
// @name         PHP Simple Check (iOS)
// @namespace    https://github.com/yomiplush/php-simple-check
// @version      2.2.1
// @description  For Safari on iOS, iPadOS and macOS (Userscripts app). Checks response headers, cookies and the DOM to tell whether a site is served by PHP (🔴 PHP / 🟢 no PHP).
// @author       yomiplush
// @homepageURL  https://github.com/yomiplush/php-simple-check
// @supportURL   https://github.com/yomiplush/php-simple-check/issues
// @downloadURL  https://raw.githubusercontent.com/yomiplush/php-simple-check/main/userscript/php-simple-check-ios.user.js
// @updateURL    https://raw.githubusercontent.com/yomiplush/php-simple-check/main/userscript/php-simple-check-ios.user.js
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

  var VERSION = '2.2.1';

  var VERDICTS = {
    php: {
      key: 'php',
      emoji: '🔴',
      label: 'PHP usage detected',
      short: 'PHP detected',
      badge: 'PHP',
      color: '#d32f2f'
    },
    maybe: {
      key: 'maybe',
      emoji: '🟡',
      label: 'Possibly PHP (weak signals only)',
      short: 'Likely PHP',
      badge: '?',
      color: '#f9a825'
    },
    none: {
      key: 'none',
      emoji: '🟢',
      label: 'No PHP signals found',
      short: 'No PHP',
      badge: 'OK',
      color: '#2e7d32'
    }
  };

  /** Matches `/index.php`, `/api.php/v1` … but not `/data.php.bak`. */
  var PHP_EXTENSION = /\.php(?:\/|$)/i;
  var STATIC_GENERATOR = /^(?:hugo|jekyll|gatsby|eleventy|astro|next\.js|nuxt|docusaurus|hexo|pelican|mkdocs|vitepress|vuepress|sphinx|zola|11ty)\b/i;

  /** Cookie names that only PHP stacks hand out. */
  var COOKIE_SIGNATURES = [
    { id: 'cookie-php-session', weight: 3, label: 'PHP session cookie', pattern: /^PHPSESSID/i },
    { id: 'cookie-wordpress', weight: 3, label: 'WordPress cookie', pattern: /^(?:wordpress(?:_sec)?_|wp-settings-|wp_woocommerce_session_)/i },
    { id: 'cookie-laravel', weight: 3, label: 'Laravel session cookie', pattern: /^laravel_session$/i },
    { id: 'cookie-codeigniter', weight: 3, label: 'CodeIgniter session cookie', pattern: /^ci_session/i },
    { id: 'cookie-cakephp', weight: 3, label: 'CakePHP session cookie', pattern: /^CAKEPHP$/i },
    { id: 'cookie-craft', weight: 3, label: 'Craft CMS cookie', pattern: /^(?:CraftSessionId|CRAFT_CSRF_TOKEN)$/i },
    { id: 'cookie-typo3', weight: 3, label: 'TYPO3 cookie', pattern: /^fe_typo_user$/i },
    { id: 'cookie-drupal', weight: 3, label: 'Drupal / Symfony session cookie', pattern: /^S?SESS[0-9a-f]{32}$/i },
    { id: 'cookie-symfony', weight: 3, label: 'Symfony cookie', pattern: /^(?:sf_redirect|symfony)$/i },
    { id: 'cookie-joomla', weight: 3, label: 'Joomla cookie', pattern: /^joomla_/i },
    { id: 'cookie-phpbb', weight: 3, label: 'phpBB cookie', pattern: /^phpbb\d*_(?:sid|data)$/i },
    { id: 'cookie-xsrf', weight: 1, label: 'XSRF-TOKEN cookie (common in PHP frameworks)', pattern: /^XSRF-TOKEN$/i }
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
    { id: 'header-drupal', weight: 3, label: 'Drupal response header', prefix: 'x-drupal' },
    { id: 'header-typo3', weight: 3, label: 'TYPO3 response header', prefix: 'x-typo3' },
    { id: 'header-symfony', weight: 3, label: 'Symfony response header', prefix: 'x-symfony' },
    { id: 'header-laravel', weight: 3, label: 'Laravel response header', prefix: 'x-laravel' }
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
      label: 'X-Powered-By reports PHP',
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
      label: 'X-Powered-By reports something else',
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
      label: 'Server header mentions PHP / HHVM',
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
      label: 'Set-Cookie carries a PHP session',
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
      label: 'X-Generator names a PHP CMS',
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
      label: 'PHP framework cookie',
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
      label: 'generator meta names a PHP CMS',
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
      label: 'Static site generator',
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
      label: 'Page URL ends in .php',
      test: function (ctx) {
        if (!ctx.pageUrl || !PHP_EXTENSION.test(ctx.pageUrl.pathname)) return null;
        return { detail: ctx.pageUrl.pathname };
      }
    },
    {
      id: 'resource-php',
      source: 'dom',
      weight: 3,
      label: 'Loads PHP files',
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
      label: 'Same-site links to .php',
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
      label: 'PHP-like query parameters',
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
      label: 'WordPress paths (/wp-content/, /wp-includes/)',
      test: function (ctx) {
        var all = ctx.resources.concat(ctx.anchors);
        var hit = all.filter(function (url) { return /\/wp-(?:content|includes)\//i.test(url.pathname); });
        if (!hit.length && !ctx.markers.inlineHasWpPaths) return null;
        return { detail: hit.length ? hit[0].pathname : '/wp-content/ inside inline scripts' };
      }
    },
    {
      id: 'wp-api',
      source: 'dom',
      weight: 3,
      label: 'Reference to the WordPress REST API',
      test: function (ctx) {
        var hit = ctx.apiLinks.filter(function (url) { return /api\.w\.org|\/wp-json/i.test(url.href); });
        if (hit.length) return { detail: hit[0].href };
        if (ctx.markers.inlineHasWpJson) return { detail: 'wp-json inside inline scripts' };
        return null;
      }
    },
    {
      id: 'wp-globals',
      source: 'dom',
      weight: 3,
      label: 'WordPress globals present',
      test: function (ctx) {
        if (!ctx.markers.wpSettings) return null;
        return { detail: 'window.wp is present' };
      }
    },
    {
      id: 'drupal-markers',
      source: 'dom',
      weight: 3,
      label: 'Drupal markers',
      test: function (ctx) {
        var hit = ctx.resources.filter(function (url) { return /\/sites\/default\/files\//i.test(url.pathname); });
        if (!hit.length && !ctx.markers.drupalSettings) return null;
        return { detail: hit.length ? hit[0].pathname : 'drupalSettings is present' };
      }
    },
    {
      id: 'joomla-markers',
      source: 'dom',
      weight: 3,
      label: 'Joomla markers',
      test: function (ctx) {
        var hit = ctx.resources.filter(function (url) { return /\/media\/system\//i.test(url.pathname); });
        if (!hit.length && !ctx.markers.joomlaOptions) return null;
        return { detail: hit.length ? hit[0].pathname : 'window.Joomla is present' };
      }
    },
    {
      id: 'inline-php-url',
      source: 'dom',
      weight: 2,
      label: '.php URL inside inline scripts',
      test: function (ctx) {
        if (!ctx.markers.inlineHasPhpUrl) return null;
        return { detail: '.php found in a script string' };
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

/* ---- extension/lib/i18n-data.js ---- */

/*!
 * PHP Simple Check — translation table
 * Generated from locales/*.json by tools/build.mjs. Do not edit by hand.
 */
var PHPSimpleCheckStrings = {
  "ar": {
    "banner.allow": "السماح",
    "banner.leave": "مغادرة",
    "banner.text": "يبدو أن {host} يستخدم PHP. سيقوم وضع الحماية بحجبه في الزيارة التالية.",
    "blocked.allow": "السماح والفتح",
    "blocked.back": "رجوع",
    "blocked.detected": "وقت الاكتشاف",
    "blocked.disable": "إيقاف وضع الحماية والفتح",
    "blocked.heading": "تم حجب هذا الموقع",
    "blocked.lede": "تم اكتشاف استخدام PHP على هذا المضيف، لذا أوقف وضع الحماية التحميل. راجع الأدلة أدناه واسمح به فقط إذا كنت تثق بالموقع.",
    "blocked.missing": "لم يتم العثور على سجل لهذا المضيف (قد يكون قد أُزيل). لا يزال «السماح والفتح» يكمل التحميل.",
    "blocked.note": "ينطبق الحجب على الزيارات المستقبلية لهذا المضيف. عند السماح تُحذف القاعدة ويُضاف المضيف إلى قائمة السماح.",
    "blocked.score": "النقاط",
    "blocked.signals": "الإشارات التي أدت إلى الحجب",
    "blocked.unknown": "(مضيف غير معروف)",
    "extDescription": "يفحص ترويسات الاستجابة وملفات تعريف الارتباط وDOM لبيان ما إذا كان الموقع يعمل بـ PHP (🔴 PHP / 🟢 بدون PHP).",
    "extName": "PHP Simple Check",
    "overlay.close": "إغلاق",
    "overlay.decisive": "إشارة حاسمة",
    "overlay.details": "اضغط لعرض التفاصيل",
    "overlay.empty": "لم يتم اكتشاف أي إشارة",
    "overlay.hide": "إخفاء في هذا الموقع",
    "overlay.note": "الفحص من جانب العميل يرى الإشارات فقط. إذا كان PHP يعمل دون أثر في الاستجابة فستبقى النتيجة 🟢.",
    "overlay.summary": "النقاط {score} · إشارات PHP {count}",
    "popup.allowed": "مسموحة",
    "popup.blockAgain": "حجب مرة أخرى",
    "popup.blocked": "محجوبة",
    "popup.copied": "تم النسخ",
    "popup.copy": "نسخ التقرير",
    "popup.copyFailed": "تعذّر النسخ",
    "popup.facts": "القيم الملاحظة",
    "popup.failed": "تعذّر تقييم هذه الصفحة. أعد تحميلها ثم حاول مرة أخرى.",
    "popup.guard": "وضع الحماية",
    "popup.guardHint": "يتم التقييم بعد تحميل الصفحة، لذا يسري الحجب من الزيارة التالية.",
    "popup.guardToggle": "حجب المواقع التي تستخدم PHP",
    "popup.meta": "النقاط {score} · {time}",
    "popup.noTab": "لم يتم العثور على علامة تبويب نشطة.",
    "popup.noVerdict": "لا توجد نتيجة بعد — جارٍ الفحص تلقائيًا.",
    "popup.notJudged": "لم يتم التقييم بعد",
    "popup.note": "الفحص من جانب العميل يرى الإشارات فقط. إذا كان PHP يعمل دون ترك أثر في الاستجابة فستظهر 🟢. تتم المعالجة على جهازك ولا يتم إرسال أي شيء.",
    "popup.overlay": "إظهار الشارة على الصفحة",
    "popup.recorded": "مسجّلة (وضع الحماية متوقف)",
    "popup.reload": "أعد تحميل الصفحة أو اضغط «إعادة الفحص»",
    "popup.reloadToScan": "أعد تحميل الصفحة لفحصها. لا يمكن فحص صفحات Chrome الداخلية ومتجر Chrome.",
    "popup.remove": "إزالة",
    "popup.rescan": "إعادة الفحص",
    "popup.scanning": "جارٍ الفحص…",
    "popup.signals": "الإشارات المكتشفة",
    "popup.unsupported": "لا يمكن تقييم هذه الصفحة (صفحات chrome:// ومتجر Chrome وغيرها خارج النطاق).",
    "status.idle": "PHP Simple Check — جارٍ التقييم…",
    "toast.hidden": "تم إخفاء PHP Simple Check في هذا الموقع",
    "toast.undo": "تراجع",
    "verdict.maybe": "قد يكون PHP (إشارات ضعيفة فقط)",
    "verdict.maybe.short": "ربما PHP",
    "verdict.none": "لم يتم العثور على إشارات PHP",
    "verdict.none.short": "لا يوجد PHP",
    "verdict.php": "تم اكتشاف استخدام PHP",
    "verdict.php.short": "تم اكتشاف PHP"
  },
  "de": {
    "banner.allow": "Erlauben",
    "banner.leave": "Verlassen",
    "banner.text": "{host} scheint PHP zu nutzen. Der Wachmodus blockiert die Seite beim nächsten Besuch.",
    "blocked.allow": "Erlauben und öffnen",
    "blocked.back": "Zurück",
    "blocked.detected": "Erkannt",
    "blocked.disable": "Wachmodus aus und öffnen",
    "blocked.heading": "Diese Seite wurde blockiert",
    "blocked.lede": "Auf diesem Host wurde PHP-Nutzung erkannt, daher hat der Wachmodus das Laden gestoppt. Prüfe die Hinweise unten und erlaube die Seite nur, wenn du ihr vertraust.",
    "blocked.missing": "Für diesen Host wurde kein Eintrag gefunden (vielleicht bereits entfernt). „Erlauben und öffnen“ setzt das Laden trotzdem fort.",
    "blocked.note": "Die Blockade gilt für künftige Besuche dieses Hosts. Beim Erlauben wird die Regel entfernt und der Host in die Erlaubnisliste aufgenommen.",
    "blocked.score": "Punkte",
    "blocked.signals": "Auslösende Signale",
    "blocked.unknown": "(unbekannter Host)",
    "extDescription": "Prüft Header, Cookies und DOM und zeigt, ob eine Seite mit PHP ausgeliefert wird (🔴 PHP / 🟢 kein PHP).",
    "extName": "PHP Simple Check",
    "overlay.close": "Schließen",
    "overlay.decisive": "entscheidendes Signal",
    "overlay.details": "Für Details klicken",
    "overlay.empty": "Keine Signale erkannt",
    "overlay.hide": "Auf dieser Seite ausblenden",
    "overlay.note": "Clientseitige Prüfungen sehen nur Signale. Läuft PHP ohne Spuren in der Antwort, bleibt das Ergebnis 🟢.",
    "overlay.summary": "Punkte {score} · {count} PHP-Signale",
    "popup.allowed": "Erlaubt",
    "popup.blockAgain": "Wieder blockieren",
    "popup.blocked": "Blockiert",
    "popup.copied": "Kopiert",
    "popup.copy": "Bericht kopieren",
    "popup.copyFailed": "Kopieren fehlgeschlagen",
    "popup.facts": "Beobachtete Werte",
    "popup.failed": "Diese Seite konnte nicht geprüft werden. Neu laden und erneut versuchen.",
    "popup.guard": "Wachmodus",
    "popup.guardHint": "Die Prüfung erfolgt nach dem Laden, daher greift die Blockade ab dem nächsten Besuch.",
    "popup.guardToggle": "Seiten mit PHP blockieren",
    "popup.meta": "Punkte {score} · {time}",
    "popup.noTab": "Kein aktiver Tab gefunden.",
    "popup.noVerdict": "Noch kein Ergebnis – automatische Prüfung läuft.",
    "popup.notJudged": "Noch nicht geprüft",
    "popup.note": "Clientseitige Prüfungen sehen nur Signale. Läuft PHP ohne Spuren in der Antwort, erscheint 🟢. Alles wird lokal verarbeitet – nichts wird gesendet.",
    "popup.overlay": "Badge auf der Seite anzeigen",
    "popup.recorded": "Erfasst (Wachmodus aus)",
    "popup.reload": "Seite neu laden oder „Erneut prüfen“ drücken",
    "popup.reloadToScan": "Lade die Seite neu, um sie zu prüfen. Chrome-interne Seiten und der Chrome Web Store können nicht geprüft werden.",
    "popup.remove": "Entfernen",
    "popup.rescan": "Erneut prüfen",
    "popup.scanning": "Prüfe…",
    "popup.signals": "Erkannte Signale",
    "popup.unsupported": "Diese Seite kann nicht geprüft werden (chrome://-Seiten, Chrome Web Store usw. ausgenommen).",
    "status.idle": "PHP Simple Check — prüfe…",
    "toast.hidden": "PHP Simple Check ist auf dieser Seite ausgeblendet",
    "toast.undo": "Rückgängig",
    "verdict.maybe": "Wahrscheinlich PHP (nur schwache Signale)",
    "verdict.maybe.short": "Wahrscheinlich PHP",
    "verdict.none": "Keine PHP-Signale gefunden",
    "verdict.none.short": "Kein PHP",
    "verdict.php": "PHP-Nutzung erkannt",
    "verdict.php.short": "PHP erkannt"
  },
  "en": {
    "banner.allow": "Allow",
    "banner.leave": "Leave",
    "banner.text": "{host} looks like it runs PHP. Guard mode will block it on the next visit.",
    "blocked.allow": "Allow and open",
    "blocked.back": "Go back",
    "blocked.detected": "Detected",
    "blocked.disable": "Turn guard mode off and open",
    "blocked.heading": "This site was blocked",
    "blocked.lede": "PHP usage was detected on this host, so guard mode stopped the load. Review the evidence below and allow it if you trust the site.",
    "blocked.missing": "No record for this host was found (it may already have been removed). “Allow and open” still continues the load.",
    "blocked.note": "The block applies to future visits to this host. Allowing removes the rule and adds the host to your allow list.",
    "blocked.score": "Score",
    "blocked.signals": "Signals that triggered this",
    "blocked.unknown": "(unknown host)",
    "extDescription": "Checks response headers, cookies and the DOM to tell whether a site is served by PHP (🔴 PHP / 🟢 no PHP).",
    "extName": "PHP Simple Check",
    "overlay.close": "Close",
    "overlay.decisive": "decisive signal",
    "overlay.details": "Click for details",
    "overlay.empty": "No signals detected",
    "overlay.hide": "Hide on this site",
    "overlay.note": "Client-side checks only see signals. If PHP runs without leaving traces in the response, the result stays 🟢.",
    "overlay.summary": "Score {score} · {count} PHP signals",
    "popup.allowed": "Allowed",
    "popup.blockAgain": "Block again",
    "popup.blocked": "Blocked",
    "popup.copied": "Copied",
    "popup.copy": "Copy report",
    "popup.copyFailed": "Copy failed",
    "popup.facts": "Observed values",
    "popup.failed": "This page could not be judged. Reload it and try again.",
    "popup.guard": "Guard mode",
    "popup.guardHint": "Detection happens after the page loads, so blocking applies from the next visit.",
    "popup.guardToggle": "Block sites that use PHP",
    "popup.meta": "Score {score} · {time}",
    "popup.noTab": "No active tab found.",
    "popup.noVerdict": "No verdict yet — scanning automatically.",
    "popup.notJudged": "Not judged yet",
    "popup.note": "Client-side checks only see signals. PHP running without traces in the response will show 🟢. Everything is processed on your device — nothing is sent anywhere.",
    "popup.overlay": "Show the page badge",
    "popup.recorded": "Recorded (guard mode off)",
    "popup.reload": "Reload the page or press Rescan",
    "popup.reloadToScan": "Reload the page to scan it. Chrome internal pages and the Web Store cannot be scanned.",
    "popup.remove": "Remove",
    "popup.rescan": "Rescan",
    "popup.scanning": "Scanning…",
    "popup.signals": "Detected signals",
    "popup.unsupported": "This page cannot be judged (chrome:// pages, the Web Store, etc. are out of scope).",
    "status.idle": "PHP Simple Check — analysing…",
    "toast.hidden": "PHP Simple Check is hidden on this site",
    "toast.undo": "Undo",
    "verdict.maybe": "Possibly PHP (weak signals only)",
    "verdict.maybe.short": "Likely PHP",
    "verdict.none": "No PHP signals found",
    "verdict.none.short": "No PHP",
    "verdict.php": "PHP usage detected",
    "verdict.php.short": "PHP detected"
  },
  "es": {
    "banner.allow": "Permitir",
    "banner.leave": "Salir",
    "banner.text": "Parece que {host} usa PHP. El modo vigilancia lo bloqueará en la próxima visita.",
    "blocked.allow": "Permitir y abrir",
    "blocked.back": "Volver",
    "blocked.detected": "Detectado",
    "blocked.disable": "Desactivar la vigilancia y abrir",
    "blocked.heading": "Este sitio fue bloqueado",
    "blocked.lede": "Se detectó uso de PHP en este host, así que el modo vigilancia detuvo la carga. Revisa las pruebas y permítelo solo si confías en el sitio.",
    "blocked.missing": "No se encontró ningún registro para este host (puede que ya se haya eliminado). «Permitir y abrir» sigue cargando la página.",
    "blocked.note": "El bloqueo se aplica a futuras visitas a este host. Al permitirlo se elimina la regla y se añade el host a tu lista de permitidos.",
    "blocked.score": "Puntuación",
    "blocked.signals": "Señales que lo provocaron",
    "blocked.unknown": "(host desconocido)",
    "extDescription": "Revisa cabeceras, cookies y el DOM para indicar si un sitio se sirve con PHP (🔴 PHP / 🟢 sin PHP).",
    "extName": "PHP Simple Check",
    "overlay.close": "Cerrar",
    "overlay.decisive": "señal decisiva",
    "overlay.details": "Haz clic para ver detalles",
    "overlay.empty": "No se detectaron señales",
    "overlay.hide": "Ocultar en este sitio",
    "overlay.note": "Las comprobaciones del lado del cliente solo ven señales. Si PHP se ejecuta sin dejar rastro, el resultado sigue siendo 🟢.",
    "overlay.summary": "Puntuación {score} · {count} señales de PHP",
    "popup.allowed": "Permitidos",
    "popup.blockAgain": "Bloquear de nuevo",
    "popup.blocked": "Bloqueados",
    "popup.copied": "Copiado",
    "popup.copy": "Copiar informe",
    "popup.copyFailed": "No se pudo copiar",
    "popup.facts": "Valores observados",
    "popup.failed": "No se pudo analizar esta página. Recárgala e inténtalo de nuevo.",
    "popup.guard": "Modo vigilancia",
    "popup.guardHint": "La detección ocurre después de cargar la página, así que el bloqueo se aplica desde la próxima visita.",
    "popup.guardToggle": "Bloquear sitios que usan PHP",
    "popup.meta": "Puntuación {score} · {time}",
    "popup.noTab": "No se encontró ninguna pestaña activa.",
    "popup.noVerdict": "Aún no hay resultado: analizando automáticamente.",
    "popup.notJudged": "Aún sin analizar",
    "popup.note": "Las comprobaciones del lado del cliente solo ven señales. Si PHP se ejecuta sin dejar rastro, se mostrará 🟢. Todo se procesa en tu dispositivo: no se envía nada.",
    "popup.overlay": "Mostrar la insignia en la página",
    "popup.recorded": "Registrados (modo vigilancia desactivado)",
    "popup.reload": "Recarga la página o pulsa «Volver a analizar»",
    "popup.reloadToScan": "Recarga la página para analizarla. Las páginas internas de Chrome y la Chrome Web Store no se pueden analizar.",
    "popup.remove": "Quitar",
    "popup.rescan": "Volver a analizar",
    "popup.scanning": "Analizando…",
    "popup.signals": "Señales detectadas",
    "popup.unsupported": "No se puede analizar esta página (las páginas chrome://, la Chrome Web Store, etc. quedan fuera).",
    "status.idle": "PHP Simple Check — analizando…",
    "toast.hidden": "PHP Simple Check está oculto en este sitio",
    "toast.undo": "Deshacer",
    "verdict.maybe": "Posiblemente PHP (solo señales débiles)",
    "verdict.maybe.short": "Probablemente PHP",
    "verdict.none": "No se detectaron señales de PHP",
    "verdict.none.short": "Sin PHP",
    "verdict.php": "Uso de PHP detectado",
    "verdict.php.short": "PHP detectado"
  },
  "fr": {
    "banner.allow": "Autoriser",
    "banner.leave": "Quitter",
    "banner.text": "{host} semble utiliser PHP. Le mode vigilance le bloquera à la prochaine visite.",
    "blocked.allow": "Autoriser et ouvrir",
    "blocked.back": "Retour",
    "blocked.detected": "Détecté",
    "blocked.disable": "Désactiver la vigilance et ouvrir",
    "blocked.heading": "Ce site a été bloqué",
    "blocked.lede": "Une utilisation de PHP a été détectée sur cet hôte : le mode vigilance a interrompu le chargement. Examinez les preuves ci-dessous et autorisez-le uniquement si vous faites confiance au site.",
    "blocked.missing": "Aucun enregistrement pour cet hôte (il a peut-être déjà été retiré). « Autoriser et ouvrir » poursuit tout de même le chargement.",
    "blocked.note": "Le blocage s’applique aux futures visites de cet hôte. L’autorisation supprime la règle et ajoute l’hôte à votre liste d’autorisation.",
    "blocked.score": "Score",
    "blocked.signals": "Signaux à l’origine du blocage",
    "blocked.unknown": "(hôte inconnu)",
    "extDescription": "Examine les en-têtes, les cookies et le DOM pour indiquer si un site est servi par PHP (🔴 PHP / 🟢 pas de PHP).",
    "extName": "PHP Simple Check",
    "overlay.close": "Fermer",
    "overlay.decisive": "signal décisif",
    "overlay.details": "Cliquez pour les détails",
    "overlay.empty": "Aucun signal détecté",
    "overlay.hide": "Masquer sur ce site",
    "overlay.note": "Une vérification côté client ne voit que des signaux. Si PHP s’exécute sans laisser de trace, le résultat reste 🟢.",
    "overlay.summary": "Score {score} · {count} signaux PHP",
    "popup.allowed": "Autorisés",
    "popup.blockAgain": "Bloquer à nouveau",
    "popup.blocked": "Bloqués",
    "popup.copied": "Copié",
    "popup.copy": "Copier le rapport",
    "popup.copyFailed": "Échec de la copie",
    "popup.facts": "Valeurs observées",
    "popup.failed": "Impossible d’analyser cette page. Rechargez-la et réessayez.",
    "popup.guard": "Mode vigilance",
    "popup.guardHint": "La détection a lieu après le chargement : le blocage s’applique à partir de la visite suivante.",
    "popup.guardToggle": "Bloquer les sites qui utilisent PHP",
    "popup.meta": "Score {score} · {time}",
    "popup.noTab": "Aucun onglet actif trouvé.",
    "popup.noVerdict": "Pas encore de résultat : analyse automatique en cours.",
    "popup.notJudged": "Pas encore analysé",
    "popup.note": "Une vérification côté client ne voit que des signaux. Si PHP s’exécute sans laisser de trace, le résultat reste 🟢. Tout est traité sur votre appareil : rien n’est envoyé.",
    "popup.overlay": "Afficher le badge sur la page",
    "popup.recorded": "Enregistrés (vigilance désactivée)",
    "popup.reload": "Rechargez la page ou cliquez sur « Réanalyser »",
    "popup.reloadToScan": "Rechargez la page pour l’analyser. Les pages internes de Chrome et le Chrome Web Store ne peuvent pas être analysés.",
    "popup.remove": "Retirer",
    "popup.rescan": "Réanalyser",
    "popup.scanning": "Analyse…",
    "popup.signals": "Signaux détectés",
    "popup.unsupported": "Cette page ne peut pas être analysée (pages chrome://, Chrome Web Store, etc. exclus).",
    "status.idle": "PHP Simple Check — analyse…",
    "toast.hidden": "PHP Simple Check est masqué sur ce site",
    "toast.undo": "Annuler",
    "verdict.maybe": "PHP possible (signaux faibles uniquement)",
    "verdict.maybe.short": "PHP probable",
    "verdict.none": "Aucun signal PHP détecté",
    "verdict.none.short": "Pas de PHP",
    "verdict.php": "Utilisation de PHP détectée",
    "verdict.php.short": "PHP détecté"
  },
  "hi": {
    "banner.allow": "अनुमति दें",
    "banner.leave": "छोड़ें",
    "banner.text": "{host} संभवतः PHP का उपयोग करता है। सतर्कता मोड इसे अगली विज़िट पर ब्लॉक कर देगा।",
    "blocked.allow": "अनुमति दें और खोलें",
    "blocked.back": "वापस",
    "blocked.detected": "पता चला",
    "blocked.disable": "सतर्कता मोड बंद करके खोलें",
    "blocked.heading": "यह साइट ब्लॉक कर दी गई",
    "blocked.lede": "इस होस्ट पर PHP का उपयोग मिला, इसलिए सतर्कता मोड ने लोड रोक दिया। नीचे सबूत देखें और साइट पर भरोसा हो तभी अनुमति दें।",
    "blocked.missing": "इस होस्ट का कोई रिकॉर्ड नहीं मिला (शायद पहले ही हटा दिया गया)। «अनुमति दें और खोलें» फिर भी लोड जारी रखेगा।",
    "blocked.note": "यह ब्लॉक इस होस्ट की आगे की विज़िट पर लागू होगा। अनुमति देने पर नियम हट जाता है और होस्ट अनुमत सूची में जुड़ जाता है।",
    "blocked.score": "स्कोर",
    "blocked.signals": "ब्लॉक करने वाले संकेत",
    "blocked.unknown": "(अज्ञात होस्ट)",
    "extDescription": "रेस्पॉन्स हेडर, कुकी और DOM देखकर बताता है कि साइट PHP से चल रही है या नहीं (🔴 PHP / 🟢 PHP नहीं)।",
    "extName": "PHP Simple Check",
    "overlay.close": "बंद करें",
    "overlay.decisive": "निर्णायक संकेत",
    "overlay.details": "विवरण के लिए क्लिक करें",
    "overlay.empty": "कोई संकेत नहीं मिला",
    "overlay.hide": "इस साइट पर छिपाएँ",
    "overlay.note": "क्लाइंट-साइड जाँच केवल संकेत देखती है। अगर PHP बिना निशान छोड़े चल रहा हो तो परिणाम 🟢 ही रहेगा।",
    "overlay.summary": "स्कोर {score} · {count} PHP संकेत",
    "popup.allowed": "अनुमत",
    "popup.blockAgain": "फिर ब्लॉक करें",
    "popup.blocked": "ब्लॉक किए गए",
    "popup.copied": "कॉपी हुआ",
    "popup.copy": "रिपोर्ट कॉपी करें",
    "popup.copyFailed": "कॉपी नहीं हो सका",
    "popup.facts": "देखे गए मान",
    "popup.failed": "इस पेज की जाँच नहीं हो सकी। रीलोड करके फिर कोशिश करें।",
    "popup.guard": "सतर्कता मोड",
    "popup.guardHint": "जाँच पेज लोड होने के बाद होती है, इसलिए ब्लॉक अगली विज़िट से लागू होगा।",
    "popup.guardToggle": "PHP वाली साइटें ब्लॉक करें",
    "popup.meta": "स्कोर {score} · {time}",
    "popup.noTab": "कोई सक्रिय टैब नहीं मिला।",
    "popup.noVerdict": "अभी कोई परिणाम नहीं — स्वचालित रूप से जाँच हो रही है।",
    "popup.notJudged": "अभी जाँच नहीं हुई",
    "popup.note": "क्लाइंट-साइड जाँच केवल संकेत देखती है। अगर PHP बिना निशान छोड़े चल रहा हो तो 🟢 दिखेगा। सब कुछ आपके डिवाइस पर होता है — कहीं कुछ नहीं भेजा जाता।",
    "popup.overlay": "पेज पर बैज दिखाएँ",
    "popup.recorded": "दर्ज (सतर्कता मोड बंद)",
    "popup.reload": "पेज रीलोड करें या «फिर जाँचें» दबाएँ",
    "popup.reloadToScan": "जाँच के लिए पेज को रीलोड करें। Chrome के आंतरिक पेज और Chrome Web Store की जाँच नहीं हो सकती।",
    "popup.remove": "हटाएँ",
    "popup.rescan": "फिर जाँचें",
    "popup.scanning": "जाँच हो रही है…",
    "popup.signals": "मिले हुए संकेत",
    "popup.unsupported": "इस पेज की जाँच नहीं हो सकती (chrome:// पेज, Chrome Web Store आदि शामिल नहीं हैं)।",
    "status.idle": "PHP Simple Check — जाँच हो रही है…",
    "toast.hidden": "इस साइट पर PHP Simple Check छिपा है",
    "toast.undo": "पूर्ववत करें",
    "verdict.maybe": "संभवतः PHP (केवल कमज़ोर संकेत)",
    "verdict.maybe.short": "संभवतः PHP",
    "verdict.none": "PHP के कोई संकेत नहीं मिले",
    "verdict.none.short": "PHP नहीं",
    "verdict.php": "PHP का उपयोग पाया गया",
    "verdict.php.short": "PHP मिला"
  },
  "ja": {
    "banner.allow": "許可する",
    "banner.leave": "離れる",
    "banner.text": "{host} は PHP 使用の兆候あり。警戒モードにより次回からブロックします。",
    "blocked.allow": "許可して開く",
    "blocked.back": "戻る",
    "blocked.detected": "検出時刻",
    "blocked.disable": "警戒モードをオフにして開く",
    "blocked.heading": "このサイトはブロックされました",
    "blocked.lede": "このホストでは PHP 使用の兆候が検出されたため、警戒モードが読み込みを止めました。内容を確認し、信頼できる場合のみ許可してください。",
    "blocked.missing": "このホストの記録が見つかりませんでした（すでに解除された可能性があります）。「許可して開く」で読み込みを続けられます。",
    "blocked.note": "ブロックはこのホストへの今後のアクセスに適用されます。許可するとルールを削除し、許可リストに追加します。",
    "blocked.score": "スコア",
    "blocked.signals": "検出していたシグナル",
    "blocked.unknown": "（不明なホスト）",
    "extDescription": "レスポンスヘッダー・Cookie・DOM から、サイトが PHP で動いているかを判定します（🔴 PHP / 🟢 非 PHP）。",
    "extName": "PHP Simple Check",
    "overlay.close": "閉じる",
    "overlay.decisive": "決定的なシグナルあり",
    "overlay.details": "クリックで詳細を表示",
    "overlay.empty": "検出できたシグナルはありません",
    "overlay.hide": "このサイトでは表示しない",
    "overlay.note": "クライアント側で観測できるのは「兆候」だけです。応答に痕跡が出ない場合は 🟢 になります。",
    "overlay.summary": "スコア {score} ・ PHP の手がかり {count} 件",
    "popup.allowed": "許可済み",
    "popup.blockAgain": "ブロックに戻す",
    "popup.blocked": "ブロック中",
    "popup.copied": "コピーしました",
    "popup.copy": "レポートをコピー",
    "popup.copyFailed": "コピーできませんでした",
    "popup.facts": "確認できた値",
    "popup.failed": "このページは判定できませんでした。再読み込みしてから試してください。",
    "popup.guard": "警戒モード",
    "popup.guardHint": "判定はページ読み込み後に行うため、ブロックは次回以降のアクセスに適用されます。",
    "popup.guardToggle": "PHP を検出したサイトをブロック",
    "popup.meta": "スコア {score} ・ {time}",
    "popup.noTab": "アクティブなタブが見つかりません。",
    "popup.noVerdict": "判定結果がまだありません。自動で再スキャンします。",
    "popup.notJudged": "まだ判定していません",
    "popup.note": "クライアント側で観測できるのは「兆候」だけです。応答に痕跡がない場合は 🟢 になります。判定は端末内で完結し、外部へ送信しません。",
    "popup.overlay": "ページ上にバッジを表示",
    "popup.recorded": "記録済み（警戒モード OFF）",
    "popup.reload": "再読み込みするか「再スキャン」を押してください",
    "popup.reloadToScan": "ページを再読み込みすると判定します。Chrome の内部ページやウェブストアは対象外です。",
    "popup.remove": "解除",
    "popup.rescan": "再スキャン",
    "popup.scanning": "スキャン中…",
    "popup.signals": "検出したシグナル",
    "popup.unsupported": "このページでは判定できません（chrome:// や Web Store などは対象外です）。",
    "status.idle": "PHP Simple Check — 判定中…",
    "toast.hidden": "このサイトではバッジを表示しません",
    "toast.undo": "元に戻す",
    "verdict.maybe": "PHP の可能性あり（弱い兆候のみ）",
    "verdict.maybe.short": "要確認",
    "verdict.none": "PHP の兆候なし",
    "verdict.none.short": "PHP 非検出",
    "verdict.php": "PHP 使用の兆候あり",
    "verdict.php.short": "PHP 検出"
  },
  "ko": {
    "banner.allow": "허용",
    "banner.leave": "나가기",
    "banner.text": "{host}은(는) PHP를 사용하는 것으로 보입니다. 경계 모드가 다음 방문부터 차단합니다.",
    "blocked.allow": "허용하고 열기",
    "blocked.back": "뒤로",
    "blocked.detected": "감지 시각",
    "blocked.disable": "경계 모드를 끄고 열기",
    "blocked.heading": "이 사이트를 차단했습니다",
    "blocked.lede": "이 호스트에서 PHP 사용이 감지되어 경계 모드가 로드를 중단했습니다. 아래 근거를 확인하고 신뢰하는 경우에만 허용하세요.",
    "blocked.missing": "이 호스트의 기록을 찾을 수 없습니다 (이미 해제되었을 수 있습니다). '허용하고 열기'로 계속 진행할 수 있습니다.",
    "blocked.note": "차단은 이 호스트의 이후 방문에 적용됩니다. 허용하면 규칙이 삭제되고 허용 목록에 추가됩니다.",
    "blocked.score": "점수",
    "blocked.signals": "차단을 유발한 신호",
    "blocked.unknown": "(알 수 없는 호스트)",
    "extDescription": "응답 헤더, 쿠키, DOM을 확인해 사이트가 PHP로 제공되는지 판정합니다 (🔴 PHP / 🟢 PHP 없음).",
    "extName": "PHP Simple Check",
    "overlay.close": "닫기",
    "overlay.decisive": "결정적 신호 있음",
    "overlay.details": "클릭하여 자세히 보기",
    "overlay.empty": "감지된 신호가 없습니다",
    "overlay.hide": "이 사이트에서 숨기기",
    "overlay.note": "클라이언트에서는 징후만 볼 수 있습니다. 응답에 흔적이 없으면 결과는 🟢입니다.",
    "overlay.summary": "점수 {score} · PHP 신호 {count}개",
    "popup.allowed": "허용됨",
    "popup.blockAgain": "다시 차단",
    "popup.blocked": "차단됨",
    "popup.copied": "복사됨",
    "popup.copy": "보고서 복사",
    "popup.copyFailed": "복사 실패",
    "popup.facts": "확인된 값",
    "popup.failed": "이 페이지를 판정할 수 없습니다. 새로 고친 후 다시 시도하세요.",
    "popup.guard": "경계 모드",
    "popup.guardHint": "판정은 페이지 로드 후에 이루어지므로 차단은 다음 방문부터 적용됩니다.",
    "popup.guardToggle": "PHP를 사용하는 사이트 차단",
    "popup.meta": "점수 {score} · {time}",
    "popup.noTab": "활성 탭을 찾을 수 없습니다.",
    "popup.noVerdict": "아직 결과가 없습니다. 자동으로 다시 검사합니다.",
    "popup.notJudged": "아직 판정하지 않음",
    "popup.note": "클라이언트에서는 징후만 볼 수 있습니다. 응답에 흔적이 없으면 🟢로 표시됩니다. 모든 처리는 기기 안에서 이루어지며 외부로 전송하지 않습니다.",
    "popup.overlay": "페이지에 배지 표시",
    "popup.recorded": "기록됨 (경계 모드 꺼짐)",
    "popup.reload": "페이지를 새로 고치거나 '다시 검사'를 누르세요",
    "popup.reloadToScan": "페이지를 새로 고치면 검사합니다. Chrome 내부 페이지와 웹 스토어는 검사할 수 없습니다.",
    "popup.remove": "해제",
    "popup.rescan": "다시 검사",
    "popup.scanning": "검사 중…",
    "popup.signals": "감지된 신호",
    "popup.unsupported": "이 페이지는 판정할 수 없습니다 (chrome:// 페이지, 웹 스토어 등은 대상이 아닙니다).",
    "status.idle": "PHP Simple Check — 판정 중…",
    "toast.hidden": "이 사이트에서 배지를 숨겼습니다",
    "toast.undo": "되돌리기",
    "verdict.maybe": "PHP일 가능성 (약한 신호만)",
    "verdict.maybe.short": "PHP 가능성",
    "verdict.none": "PHP 신호 없음",
    "verdict.none.short": "PHP 없음",
    "verdict.php": "PHP 사용 감지됨",
    "verdict.php.short": "PHP 감지"
  },
  "pt-br": {
    "banner.allow": "Permitir",
    "banner.leave": "Sair",
    "banner.text": "{host} parece usar PHP. O modo vigilância vai bloquear na próxima visita.",
    "blocked.allow": "Permitir e abrir",
    "blocked.back": "Voltar",
    "blocked.detected": "Detectado",
    "blocked.disable": "Desativar a vigilância e abrir",
    "blocked.heading": "Este site foi bloqueado",
    "blocked.lede": "Foi detectado uso de PHP neste host, então o modo vigilância interrompeu o carregamento. Revise as evidências abaixo e permita apenas se confiar no site.",
    "blocked.missing": "Nenhum registro encontrado para este host (talvez já tenha sido removido). «Permitir e abrir» continua o carregamento mesmo assim.",
    "blocked.note": "O bloqueio vale para futuras visitas a este host. Permitir remove a regra e adiciona o host à sua lista de permitidos.",
    "blocked.score": "Pontuação",
    "blocked.signals": "Sinais que acionaram o bloqueio",
    "blocked.unknown": "(host desconhecido)",
    "extDescription": "Verifica cabeçalhos, cookies e o DOM para indicar se um site é servido por PHP (🔴 PHP / 🟢 sem PHP).",
    "extName": "PHP Simple Check",
    "overlay.close": "Fechar",
    "overlay.decisive": "sinal decisivo",
    "overlay.details": "Clique para ver detalhes",
    "overlay.empty": "Nenhum sinal detectado",
    "overlay.hide": "Ocultar neste site",
    "overlay.note": "Verificações no cliente só veem sinais. Se o PHP rodar sem deixar rastros na resposta, o resultado continua 🟢.",
    "overlay.summary": "Pontuação {score} · {count} sinais de PHP",
    "popup.allowed": "Permitidos",
    "popup.blockAgain": "Bloquear novamente",
    "popup.blocked": "Bloqueados",
    "popup.copied": "Copiado",
    "popup.copy": "Copiar relatório",
    "popup.copyFailed": "Falha ao copiar",
    "popup.facts": "Valores observados",
    "popup.failed": "Não foi possível analisar esta página. Recarregue e tente de novo.",
    "popup.guard": "Modo vigilância",
    "popup.guardHint": "A detecção acontece após o carregamento, então o bloqueio vale a partir da próxima visita.",
    "popup.guardToggle": "Bloquear sites que usam PHP",
    "popup.meta": "Pontuação {score} · {time}",
    "popup.noTab": "Nenhuma aba ativa encontrada.",
    "popup.noVerdict": "Ainda sem resultado — analisando automaticamente.",
    "popup.notJudged": "Ainda não analisado",
    "popup.note": "Verificações no cliente só veem sinais. Se o PHP rodar sem deixar rastros na resposta, o resultado será 🟢. Tudo é processado no seu dispositivo — nada é enviado.",
    "popup.overlay": "Mostrar o selo na página",
    "popup.recorded": "Registrados (vigilância desativada)",
    "popup.reload": "Recarregue a página ou clique em «Analisar novamente»",
    "popup.reloadToScan": "Recarregue a página para analisá-la. Páginas internas do Chrome e a Chrome Web Store não podem ser analisadas.",
    "popup.remove": "Remover",
    "popup.rescan": "Analisar novamente",
    "popup.scanning": "Analisando…",
    "popup.signals": "Sinais detectados",
    "popup.unsupported": "Não é possível analisar esta página (páginas chrome://, Chrome Web Store etc. ficam de fora).",
    "status.idle": "PHP Simple Check — analisando…",
    "toast.hidden": "PHP Simple Check está oculto neste site",
    "toast.undo": "Desfazer",
    "verdict.maybe": "Possivelmente PHP (apenas sinais fracos)",
    "verdict.maybe.short": "Provavelmente PHP",
    "verdict.none": "Nenhum sinal de PHP encontrado",
    "verdict.none.short": "Sem PHP",
    "verdict.php": "Uso de PHP detectado",
    "verdict.php.short": "PHP detectado"
  },
  "ru": {
    "banner.allow": "Разрешить",
    "banner.leave": "Уйти",
    "banner.text": "Похоже, {host} использует PHP. Режим бдительности заблокирует его при следующем визите.",
    "blocked.allow": "Разрешить и открыть",
    "blocked.back": "Назад",
    "blocked.detected": "Обнаружено",
    "blocked.disable": "Выключить режим и открыть",
    "blocked.heading": "Сайт заблокирован",
    "blocked.lede": "На этом хосте обнаружено использование PHP, поэтому режим бдительности остановил загрузку. Проверьте признаки ниже и разрешите сайт, только если доверяете ему.",
    "blocked.missing": "Запись для этого хоста не найдена (возможно, уже удалена). «Разрешить и открыть» всё равно продолжит загрузку.",
    "blocked.note": "Блокировка действует для последующих визитов на этот хост. При разрешении правило удаляется, а хост добавляется в список разрешённых.",
    "blocked.score": "Баллы",
    "blocked.signals": "Признаки, вызвавшие блокировку",
    "blocked.unknown": "(неизвестный хост)",
    "extDescription": "Проверяет заголовки, cookie и DOM, чтобы показать, отдаётся ли сайт на PHP (🔴 PHP / 🟢 без PHP).",
    "extName": "PHP Simple Check",
    "overlay.close": "Закрыть",
    "overlay.decisive": "решающий признак",
    "overlay.details": "Нажмите, чтобы увидеть подробности",
    "overlay.empty": "Признаков не обнаружено",
    "overlay.hide": "Скрыть на этом сайте",
    "overlay.note": "Клиентская проверка видит только признаки. Если PHP работает без следов в ответе, результат останется 🟢.",
    "overlay.summary": "Баллы {score} · признаков PHP: {count}",
    "popup.allowed": "Разрешены",
    "popup.blockAgain": "Заблокировать снова",
    "popup.blocked": "Заблокированы",
    "popup.copied": "Скопировано",
    "popup.copy": "Скопировать отчёт",
    "popup.copyFailed": "Не удалось скопировать",
    "popup.facts": "Наблюдаемые значения",
    "popup.failed": "Не удалось проверить страницу. Перезагрузите её и попробуйте снова.",
    "popup.guard": "Режим бдительности",
    "popup.guardHint": "Проверка выполняется после загрузки, поэтому блокировка действует со следующего визита.",
    "popup.guardToggle": "Блокировать сайты на PHP",
    "popup.meta": "Баллы {score} · {time}",
    "popup.noTab": "Активная вкладка не найдена.",
    "popup.noVerdict": "Результата пока нет — выполняется автоматическая проверка.",
    "popup.notJudged": "Ещё не проверено",
    "popup.note": "Клиентская проверка видит только признаки. Если PHP работает без следов в ответе, будет 🟢. Всё обрабатывается на устройстве — данные никуда не отправляются.",
    "popup.overlay": "Показывать значок на странице",
    "popup.recorded": "Записаны (режим выключен)",
    "popup.reload": "Перезагрузите страницу или нажмите «Проверить снова»",
    "popup.reloadToScan": "Перезагрузите страницу для проверки. Внутренние страницы Chrome и Chrome Web Store не проверяются.",
    "popup.remove": "Убрать",
    "popup.rescan": "Проверить снова",
    "popup.scanning": "Проверка…",
    "popup.signals": "Обнаруженные признаки",
    "popup.unsupported": "Эту страницу нельзя проверить (страницы chrome://, Chrome Web Store и т. п. не поддерживаются).",
    "status.idle": "PHP Simple Check — проверка…",
    "toast.hidden": "PHP Simple Check скрыт на этом сайте",
    "toast.undo": "Отменить",
    "verdict.maybe": "Возможно, PHP (только слабые признаки)",
    "verdict.maybe.short": "Возможно, PHP",
    "verdict.none": "Признаков PHP не найдено",
    "verdict.none.short": "PHP нет",
    "verdict.php": "Обнаружено использование PHP",
    "verdict.php.short": "PHP обнаружен"
  },
  "zh-cn": {
    "banner.allow": "允许",
    "banner.leave": "离开",
    "banner.text": "{host} 可能使用 PHP。警戒模式将在下次访问时阻止。",
    "blocked.allow": "允许并打开",
    "blocked.back": "返回",
    "blocked.detected": "检测时间",
    "blocked.disable": "关闭警戒模式并打开",
    "blocked.heading": "此网站已被阻止",
    "blocked.lede": "在此主机上检测到 PHP 使用迹象，警戒模式已停止加载。请查看下面的证据，确认可信后再允许。",
    "blocked.missing": "未找到该主机的记录（可能已被解除）。仍可使用「允许并打开」继续加载。",
    "blocked.note": "阻止会应用于此后访问该主机的请求。允许后将删除规则并加入允许列表。",
    "blocked.score": "分数",
    "blocked.signals": "触发阻止的信号",
    "blocked.unknown": "（未知主机）",
    "extDescription": "通过响应头、Cookie 与 DOM 判断网站是否由 PHP 提供（🔴 PHP / 🟢 非 PHP）。",
    "extName": "PHP Simple Check",
    "overlay.close": "关闭",
    "overlay.decisive": "存在决定性信号",
    "overlay.details": "点击查看详情",
    "overlay.empty": "未检测到任何信号",
    "overlay.hide": "在此网站隐藏",
    "overlay.note": "客户端只能观测到迹象。若响应中没有痕迹，结果仍为 🟢。",
    "overlay.summary": "分数 {score} · PHP 信号 {count} 个",
    "popup.allowed": "已允许",
    "popup.blockAgain": "重新阻止",
    "popup.blocked": "已阻止",
    "popup.copied": "已复制",
    "popup.copy": "复制报告",
    "popup.copyFailed": "复制失败",
    "popup.facts": "观测到的值",
    "popup.failed": "无法判定此页面，请重新加载后再试。",
    "popup.guard": "警戒模式",
    "popup.guardHint": "判定在页面加载后进行，因此阻止从下次访问开始生效。",
    "popup.guardToggle": "阻止使用 PHP 的网站",
    "popup.meta": "分数 {score} · {time}",
    "popup.noTab": "未找到活动标签页。",
    "popup.noVerdict": "尚无判定结果，正在自动重新检测。",
    "popup.notJudged": "尚未判定",
    "popup.note": "客户端只能观测到迹象。若响应中没有痕迹，即使运行 PHP 也会显示 🟢。所有处理都在本机完成，不会向外发送。",
    "popup.overlay": "在页面上显示徽标",
    "popup.recorded": "已记录（警戒模式关闭）",
    "popup.reload": "请重新加载页面或点击「重新检测」",
    "popup.reloadToScan": "请重新加载页面以进行检测。Chrome 内部页面和网上应用商店无法检测。",
    "popup.remove": "解除",
    "popup.rescan": "重新检测",
    "popup.scanning": "检测中…",
    "popup.signals": "检测到的信号",
    "popup.unsupported": "无法判定此页面（chrome:// 页面、应用商店等不在范围内）。",
    "status.idle": "PHP Simple Check — 判定中…",
    "toast.hidden": "已在此网站隐藏徽标",
    "toast.undo": "撤销",
    "verdict.maybe": "可能使用 PHP（仅有微弱迹象）",
    "verdict.maybe.short": "可能是 PHP",
    "verdict.none": "未发现 PHP 迹象",
    "verdict.none.short": "无 PHP",
    "verdict.php": "检测到使用 PHP",
    "verdict.php.short": "检测到 PHP"
  },
  "zh-tw": {
    "banner.allow": "允許",
    "banner.leave": "離開",
    "banner.text": "{host} 可能使用 PHP。警戒模式將在下次造訪時封鎖。",
    "blocked.allow": "允許並開啟",
    "blocked.back": "返回",
    "blocked.detected": "偵測時間",
    "blocked.disable": "關閉警戒模式並開啟",
    "blocked.heading": "此網站已被封鎖",
    "blocked.lede": "在此主機上偵測到 PHP 使用跡象，警戒模式已停止載入。請檢視下方證據，確認可信後再允許。",
    "blocked.missing": "找不到該主機的記錄（可能已解除）。仍可使用「允許並開啟」繼續載入。",
    "blocked.note": "封鎖會套用於此後造訪該主機的請求。允許後將刪除規則並加入允許清單。",
    "blocked.score": "分數",
    "blocked.signals": "觸發封鎖的訊號",
    "blocked.unknown": "（未知主機）",
    "extDescription": "透過回應標頭、Cookie 與 DOM 判斷網站是否由 PHP 提供（🔴 PHP / 🟢 非 PHP）。",
    "extName": "PHP Simple Check",
    "overlay.close": "關閉",
    "overlay.decisive": "存在決定性訊號",
    "overlay.details": "點擊查看詳情",
    "overlay.empty": "未偵測到任何訊號",
    "overlay.hide": "在此網站隱藏",
    "overlay.note": "用戶端只能觀測到跡象。若回應中沒有痕跡，結果仍為 🟢。",
    "overlay.summary": "分數 {score} · PHP 訊號 {count} 個",
    "popup.allowed": "已允許",
    "popup.blockAgain": "重新封鎖",
    "popup.blocked": "已封鎖",
    "popup.copied": "已複製",
    "popup.copy": "複製報告",
    "popup.copyFailed": "複製失敗",
    "popup.facts": "觀測到的值",
    "popup.failed": "無法判定此頁面，請重新載入後再試。",
    "popup.guard": "警戒模式",
    "popup.guardHint": "判定在頁面載入後進行，因此封鎖會從下次造訪開始生效。",
    "popup.guardToggle": "封鎖使用 PHP 的網站",
    "popup.meta": "分數 {score} · {time}",
    "popup.noTab": "找不到使用中的分頁。",
    "popup.noVerdict": "尚無判定結果，正在自動重新偵測。",
    "popup.notJudged": "尚未判定",
    "popup.note": "用戶端只能觀測到跡象。若回應中沒有痕跡，即使執行 PHP 也會顯示 🟢。所有處理都在本機完成，不會對外傳送。",
    "popup.overlay": "在頁面上顯示標章",
    "popup.recorded": "已記錄（警戒模式關閉）",
    "popup.reload": "請重新載入頁面或按下「重新偵測」",
    "popup.reloadToScan": "請重新載入頁面以進行偵測。Chrome 內部頁面與線上應用程式商店無法偵測。",
    "popup.remove": "解除",
    "popup.rescan": "重新偵測",
    "popup.scanning": "偵測中…",
    "popup.signals": "偵測到的訊號",
    "popup.unsupported": "無法判定此頁面（chrome:// 頁面、應用程式商店等不在範圍內）。",
    "status.idle": "PHP Simple Check — 判定中…",
    "toast.hidden": "已在此網站隱藏標章",
    "toast.undo": "復原",
    "verdict.maybe": "可能使用 PHP（僅有微弱跡象）",
    "verdict.maybe.short": "可能是 PHP",
    "verdict.none": "未發現 PHP 跡象",
    "verdict.none.short": "無 PHP",
    "verdict.php": "偵測到使用 PHP",
    "verdict.php.short": "偵測到 PHP"
  }
};

/* ---- extension/lib/i18n.js ---- */

/*!
 * PHP Simple Check — runtime translations
 *
 * The UI is localised from a plain table (`lib/i18n-data.js`) instead of
 * chrome.i18n so the very same code runs in the extension, in extension pages
 * and in the userscript (where chrome.i18n does not exist).
 *
 * Lookup order: Chrome UI language -> browser languages -> English.
 * Placeholders use {name}; unknown keys fall back to English, then to the key.
 */
(function (global) {
  'use strict';

  var DATA = global.PHPSimpleCheckStrings || {};
  var FALLBACK = 'en';
  var RTL_LANGUAGES = ['ar', 'he', 'fa', 'ur', 'yi'];

  function normalize(tag) {
    return String(tag || '').replace(/_/g, '-').toLowerCase();
  }

  function resolve(tag) {
    var value = normalize(tag);
    if (!value) return null;
    if (DATA[value]) return value;
    if (value.indexOf('zh') === 0) {
      // Script subtags win over region: zh-Hant-HK is traditional.
      var traditional = value.indexOf('hant') !== -1 || value === 'zh-tw' || value === 'zh-hk' || value === 'zh-mo';
      var preferred = traditional ? 'zh-tw' : 'zh-cn';
      var secondary = traditional ? 'zh-cn' : 'zh-tw';
      if (DATA[preferred]) return preferred;
      return DATA[secondary] ? secondary : null;
    }
    var base = value.split('-')[0];
    return DATA[base] ? base : null;
  }

  function detect() {
    try {
      if (global.chrome && chrome.i18n && typeof chrome.i18n.getUILanguage === 'function') {
        var fromChrome = resolve(chrome.i18n.getUILanguage());
        if (fromChrome) return fromChrome;
      }
    } catch (error) {
      /* not an extension context */
    }
    var navigatorObject = global.navigator;
    if (!navigatorObject) return FALLBACK;
    var candidates = navigatorObject.languages && navigatorObject.languages.length
      ? Array.prototype.slice.call(navigatorObject.languages)
      : [navigatorObject.language];
    for (var i = 0; i < candidates.length; i += 1) {
      var match = resolve(candidates[i]);
      if (match) return match;
    }
    return FALLBACK;
  }

  var locale = detect();
  var table = DATA[locale] || DATA[FALLBACK] || {};

  function format(template, vars) {
    return String(template).replace(/\{(\w+)\}/g, function (match, key) {
      return vars && Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match;
    });
  }

  function t(key, vars) {
    var template = table[key];
    if (template == null && DATA[FALLBACK]) template = DATA[FALLBACK][key];
    if (template == null) return key;
    return format(template, vars);
  }

  function n(key, count) {
    return t(key, { count: count });
  }

  var base = locale.split('-')[0];

  global.PHPSimpleCheckI18n = {
    locale: locale,
    t: t,
    n: n,
    dir: RTL_LANGUAGES.indexOf(base) !== -1 ? 'rtl' : 'ltr',
    languages: Object.keys(DATA)
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

  /**
   * Reads the response headers of this document with one same-origin HEAD
   * request. Running it from the content script (instead of the worker) means
   * the extension needs no host permissions and no webRequest access: the
   * request is indistinguishable from the page asking for its own headers.
   */
  function probeHeaders(url) {
    return fetch(url || location.href, {
      method: 'HEAD',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'follow'
    })
      .then(function (response) {
        if (!response.ok) return null;
        var headers = {};
        response.headers.forEach(function (value, name) {
          var key = name.toLowerCase();
          (headers[key] = headers[key] || []).push(value);
        });
        return Object.keys(headers).length ? headers : null;
      })
      .catch(function () {
        return null;
      });
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

  global.PHPSimpleCheckDom = { collect: collect, probeHeaders: probeHeaders };
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

  var t = global.PHPSimpleCheckI18n.t;
  var textDirection = global.PHPSimpleCheckI18n.dir;

  var HOST_ID = 'php-simple-check-badge';
  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box}',
    '.wrap{display:flex;flex-direction:column;align-items:flex-end;gap:8px;font:400 12px/1.45 system-ui,-apple-system,"Segoe UI","Hiragino Sans","Noto Sans JP",sans-serif;color:#111}',
    '.badge{display:inline-flex;align-items:center;gap:6px;padding:6px 11px;border-radius:999px;border:1px solid #d0d7de;background:#fff;color:#111;font:inherit;font-weight:600;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;box-shadow:0 2px 10px rgba(0,0,0,.18);transition:transform .12s ease,box-shadow .12s ease}',
    '.badge:hover{transform:translateY(-1px);box-shadow:0 4px 14px rgba(0,0,0,.24)}',
    '.badge:focus-visible{outline:2px solid #0969da;outline-offset:2px}',
    '.badge-emoji{font-size:13px;line-height:1}',
    '.panel{width:min(340px,calc(100vw - 32px));max-height:min(60vh,520px);overflow:auto;overscroll-behavior:contain;padding:12px;border-radius:12px;border:1px solid #d0d7de;background:#fff;box-shadow:0 8px 28px rgba(0,0,0,.22)}',
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
    '.site-dismiss{display:block;width:100%;margin:0 0 8px;padding:7px 8px;border:1px solid #d0d7de;border-radius:8px;background:transparent;color:#57606a;font:inherit;font-size:11px;cursor:pointer}',
    '.site-dismiss:hover{background:#f3f4f6;color:#111}',
    '.site-dismiss[hidden]{display:none}',
    /* Phones / tablets: bigger tap targets and a taller scrollable panel. */
    '@media (pointer:coarse){',
    '.badge{padding:8px 13px;font-size:13px}',
    '.badge-emoji{font-size:15px}',
    '.panel{width:min(360px,calc(100vw - 24px));max-height:min(70vh,560px);padding:14px}',
    '.close{font-size:20px;padding:6px 8px}',
    '.signal-label{font-size:12px}',
    '.signal-detail{font-size:11px}',
    '.site-dismiss{padding:10px 8px;font-size:12px}',
    '}',
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
    '.site-dismiss{color:#8b949e;border-color:#30363d}',
    '.site-dismiss:hover{background:#21262d;color:#e6edf3}',
    '}'
  ].join('\n');

  /* ------------------------------------------------------------ guard banner */

  var BANNER_ID = 'php-simple-check-banner';
  var BANNER_CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box}',
    '.bar{display:flex;align-items:center;gap:10px;padding:10px 14px;background:#8e1f1a;color:#fff;',
    'font:400 12px/1.45 system-ui,-apple-system,"Segoe UI","Hiragino Sans","Noto Sans JP",sans-serif;',
    'box-shadow:0 2px 12px rgba(0,0,0,.28)}',
    '.icon{font-size:15px;line-height:1;flex:0 0 auto}',
    '.text{flex:1 1 auto;min-width:0}',
    '.host{font-weight:700;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}',
    '.actions{display:flex;gap:6px;flex:0 0 auto}',
    '.actions button{border:1px solid rgba(255,255,255,.5);border-radius:7px;background:transparent;color:#fff;',
    'font:inherit;font-weight:600;padding:5px 9px;cursor:pointer;touch-action:manipulation}',
    '.actions button.allow{background:#fff;color:#8e1f1a;border-color:#fff}',
    '.actions button:focus-visible{outline:2px solid #fff;outline-offset:1px}',
    '@media (pointer:coarse){.bar{padding:12px 14px;font-size:12.5px}.actions button{padding:8px 12px}}',
    '@media (max-width:560px){.bar{flex-wrap:wrap}.actions{width:100%;justify-content:flex-end}}'
  ].join('\n');

  var banner = { host: null, onAllow: null, onLeave: null };

  function hideGuardBanner() {
    if (banner.host && banner.host.parentNode) banner.host.parentNode.removeChild(banner.host);
    banner.host = null;
  }

  function showGuardBanner(options) {
    var settings = options || {};
    hideGuardBanner();

    var host = el('div');
    host.id = BANNER_ID;
    host.style.cssText = 'all:initial;position:fixed;left:0;right:0;top:0;z-index:2147483647;display:block;';
    var shadow = host.attachShadow({ mode: 'open' });

    var style = el('style');
    style.textContent = BANNER_CSS;

    var bar = el('div', 'bar');
    bar.setAttribute('role', 'alert');
    bar.appendChild(el('span', 'icon', '⚠'));

    // Keep the host visually distinct while letting each language put it
    // wherever its grammar needs it.
    var template = t('banner.text', { host: '\u0000host\u0000' });
    var segments = template.split('\u0000host\u0000');
    var text = el('span', 'text');
    text.appendChild(el('span', null, segments[0]));
    text.appendChild(el('span', 'host', settings.host || ''));
    if (segments[1]) text.appendChild(el('span', null, segments[1]));

    var actions = el('span', 'actions');

    var allow = el('button', 'allow', t('banner.allow'));
    allow.type = 'button';
    allow.addEventListener('click', function () {
      hideGuardBanner();
      if (banner.onAllow) banner.onAllow();
    });

    var leave = el('button', null, t('banner.leave'));
    leave.type = 'button';
    leave.addEventListener('click', function () {
      if (banner.onLeave) banner.onLeave();
      else hideGuardBanner();
    });

    var close = el('button', null, '×');
    close.type = 'button';
    close.setAttribute('aria-label', t('overlay.close'));
    close.addEventListener('click', hideGuardBanner);

    actions.appendChild(allow);
    actions.appendChild(leave);
    actions.appendChild(close);

    bar.setAttribute('dir', textDirection);
    bar.appendChild(text);
    bar.appendChild(actions);
    shadow.appendChild(style);
    shadow.appendChild(bar);
    document.documentElement.appendChild(host);

    banner.host = host;
    banner.onAllow = settings.onAllow || null;
    banner.onLeave = settings.onLeave || null;
  }

  var state = {
    host: null,
    refs: null,
    result: null,
    hidden: false,
    onClose: null,
    onSiteDismiss: null
  };

  function translatedVerdict(result, suffix) {
    var key = 'verdict.' + result.verdict + (suffix || '');
    var value = t(key);
    if (value === key) return suffix ? result.short || result.label : result.label;
    return value;
  }

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
    // Sit a little higher on touch devices so Safari's bottom bar does not
    // cover the badge.
    var coarsePointer = false;
    try {
      coarsePointer = Boolean(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    } catch (error) {
      coarsePointer = false;
    }
    var offset = coarsePointer ? 26 : 16;
    host.style.cssText =
      'all:initial;position:fixed;right:calc(' + offset + 'px + env(safe-area-inset-right, 0px));' +
      'bottom:calc(' + offset + 'px + env(safe-area-inset-bottom, 0px));z-index:2147483647;display:block;';
    var shadow = host.attachShadow({ mode: 'open' });

    var style = el('style');
    style.textContent = CSS;

    var wrap = el('div', 'wrap');

    var panel = el('section', 'panel');
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'PHP Simple Check');

    var head = el('div', 'panel-head');
    var panelEmoji = el('span', 'panel-emoji');
    var panelTitle = el('span', 'panel-title');
    var close = el('button', 'close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', t('overlay.close'));
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
    var note = el('p', 'note', t('overlay.note'));

    var siteDismiss = el('button', 'site-dismiss', t('overlay.hide'));
    siteDismiss.type = 'button';
    siteDismiss.hidden = true;
    siteDismiss.addEventListener('click', function () {
      hide();
      if (state.onSiteDismiss) state.onSiteDismiss();
    });

    panel.appendChild(head);
    panel.appendChild(summary);
    panel.appendChild(list);
    panel.appendChild(facts);
    panel.appendChild(siteDismiss);
    panel.appendChild(note);

    var badge = el('button', 'badge');
    badge.type = 'button';
    badge.title = t('overlay.details');
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
    wrap.setAttribute('dir', textDirection);

    state.refs = {
      shadow: shadow,
      wrap: wrap,
      panel: panel,
      panelEmoji: panelEmoji,
      panelTitle: panelTitle,
      summary: summary,
      list: list,
      facts: facts,
      siteDismiss: siteDismiss,
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
      empty.appendChild(el('span', 'signal-label', t('overlay.empty')));
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

  function render(result, options) {
    if (!result || !result.verdict) return;
    var refs = ensure();
    state.result = result;
    if (options && (options.onSiteDismiss || options.allowSiteDismiss)) {
      state.onSiteDismiss = options.onSiteDismiss || null;
      refs.siteDismiss.hidden = false;
    } else {
      refs.siteDismiss.hidden = true;
    }
    if (state.hidden) {
      state.host.style.display = 'none';
      return;
    }
    state.host.style.display = 'block';

    refs.badgeEmoji.textContent = result.emoji;
    refs.badgeLabel.textContent = translatedVerdict(result, '.short');
    refs.badge.style.borderColor = result.color;
    refs.badge.setAttribute('aria-label', result.emoji + ' ' + translatedVerdict(result) + ' — ' + t('overlay.details'));
    refs.panelEmoji.textContent = result.emoji;
    refs.panelTitle.textContent = translatedVerdict(result);

    var count = (result.signals || []).filter(function (signal) { return signal.weight > 0; }).length;
    refs.summary.textContent = t('overlay.summary', { score: result.score, count: count }) +
      (result.confidence === 'high' ? ' · ' + t('overlay.decisive') : '');

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

    showGuardBanner: showGuardBanner,
    hideGuardBanner: hideGuardBanner,

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
 *
 * Mobile extras:
 *   - "Hide on this site" is remembered per hostname in localStorage
 *     (with an undo toast), because on a phone there is no other way to get the
 *     badge out of the way.
 */
(function () {
  'use strict';

  var t = PHPSimpleCheckI18n.t;

  var RECHECK_DELAYS = [2500, 6000];
  var HIDDEN_PREFIX = 'php-simple-check:hidden:';

  var lastHref = location.href;
  var probed = false;
  var probedHeaders = null;

  /* ---------------------------------------------------------- per-site hide */

  function hiddenKey() {
    return HIDDEN_PREFIX + location.hostname;
  }

  function isHidden() {
    try {
      return window.localStorage.getItem(hiddenKey()) === '1';
    } catch (error) {
      return false; /* private mode / storage disabled */
    }
  }

  function setHidden(hidden) {
    try {
      if (hidden) window.localStorage.setItem(hiddenKey(), '1');
      else window.localStorage.removeItem(hiddenKey());
    } catch (error) {
      /* ignore */
    }
  }

  function showToast(message, actionLabel, onAction) {
    var host = document.createElement('div');
    host.setAttribute('data-php-simple-check-toast', '');
    host.style.cssText =
      'all:initial;position:fixed;left:50%;bottom:calc(76px + env(safe-area-inset-bottom, 0px));' +
      'transform:translateX(-50%);z-index:2147483647;';
    var shadow = host.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent =
      '.toast{display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:10px;' +
      'background:#1f2937;color:#f9fafb;box-shadow:0 6px 22px rgba(0,0,0,.3);' +
      'font:400 12px/1.4 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;' +
      'max-width:calc(100vw - 32px)}' +
      '.toast button{border:0;background:transparent;color:#93c5fd;font:inherit;font-weight:700;' +
      'cursor:pointer;padding:6px;touch-action:manipulation}';

    var box = document.createElement('div');
    box.className = 'toast';
    var text = document.createElement('span');
    text.textContent = message;
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = actionLabel;
    button.addEventListener('click', function () {
      cleanup();
      onAction();
    });

    box.appendChild(text);
    box.appendChild(button);
    shadow.appendChild(style);
    shadow.appendChild(box);
    document.documentElement.appendChild(host);

    var timer = setTimeout(cleanup, 8000);

    function cleanup() {
      clearTimeout(timer);
      if (host.parentNode) host.parentNode.removeChild(host);
    }
  }

  /* ------------------------------------------------------------- header probe */

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

  /* --------------------------------------------------------------------- run */

  function run() {
    if (isHidden()) return;

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
        PHPSimpleCheckOverlay.render(result, {
          onSiteDismiss: function () {
            setHidden(true);
            showToast(t('toast.hidden'), t('toast.undo'), function () {
              setHidden(false);
              PHPSimpleCheckOverlay.show();
              run();
            });
          }
        });
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
    if (document.hidden) return; // keep mobile battery usage low
    if (location.href === lastHref) return;
    lastHref = location.href;
    setTimeout(run, 800);
  }, 1200);

  window.addEventListener('popstate', function () { setTimeout(run, 500); });
  window.addEventListener('hashchange', function () { setTimeout(run, 500); });
})();
