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
