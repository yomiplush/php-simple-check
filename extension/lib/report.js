/*!
 * PHP Simple Check — copyable report
 *
 * Pure formatting of an existing verdict (no DOM, no browser APIs) so the popup
 * and the tests share the exact same text. The report is deliberately in English
 * and machine-friendly: it is meant to be pasted into a bug report or an
 * incident ticket.
 */
(function (global) {
  'use strict';

  function build(result, options) {
    if (!result || !result.verdict) return '';

    var settings = options || {};
    var facts = result.facts || {};
    var version = settings.version || result.version || '';
    var lines = [];

    lines.push('PHP Simple Check v' + version + ' — PHP fingerprint report');
    lines.push('URL: ' + (facts.url || '(unknown)'));
    lines.push(
      'Verdict: ' + (result.label || result.verdict) +
      ' (score ' + result.score + ', confidence ' + (result.confidence || 'low') + ')'
    );

    lines.push('Signals:');
    (result.signals || []).forEach(function (signal) {
      var weight = (signal.weight > 0 ? '+' : '') + signal.weight;
      lines.push('  ' + weight + ' ' + signal.label + (signal.detail ? ' — ' + signal.detail : ''));
    });

    var observed = [];
    if (facts.xPoweredBy) observed.push('X-Powered-By: ' + facts.xPoweredBy);
    if (facts.server) observed.push('Server: ' + facts.server);
    if (facts.generator) observed.push('generator: ' + facts.generator);
    if (facts.cookies && facts.cookies.length) observed.push('cookie names: ' + facts.cookies.join(', '));
    if (facts.phpResources && facts.phpResources.length) {
      observed.push('.php resources: ' + facts.phpResources.join(', '));
    }
    if (facts.phpAnchors && facts.phpAnchors.length) {
      observed.push('.php links: ' + facts.phpAnchors.join(', '));
    }
    if (observed.length) {
      lines.push('Observed:');
      observed.forEach(function (line) { lines.push('  ' + line); });
    }

    if (result.checkedAt) {
      lines.push('Checked: ' + new Date(result.checkedAt).toISOString());
    }
    lines.push('Note: stack fingerprint only — not a malware or security scan.');

    return lines.join('\n');
  }

  global.PHPSimpleCheckReport = { build: build };
})(typeof globalThis !== 'undefined' ? globalThis : this);
