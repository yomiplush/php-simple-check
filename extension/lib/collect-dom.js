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
