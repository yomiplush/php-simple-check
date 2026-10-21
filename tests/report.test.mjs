import test from 'node:test';
import assert from 'node:assert/strict';

import '../extension/lib/report.js';

const { build } = globalThis.PHPSimpleCheckReport;

const result = {
  version: '2.2.0',
  verdict: 'php',
  label: 'PHP usage detected',
  score: 6,
  confidence: 'high',
  checkedAt: Date.UTC(2026, 9, 21, 12, 0, 0),
  signals: [
    { weight: 3, label: 'X-Powered-By reports PHP', detail: 'X-Powered-By: PHP/8.3.4' },
    { weight: -2, label: 'Static site generator', detail: '' }
  ],
  facts: {
    url: 'https://example.com/shop',
    xPoweredBy: 'PHP/8.3.4',
    server: 'nginx',
    generator: null,
    cookies: ['PHPSESSID', '_ga'],
    phpResources: ['https://example.com/cart.php'],
    phpAnchors: []
  }
};

test('the report contains the verdict, signals and observations', () => {
  const text = build(result);

  assert.match(text, /^PHP Simple Check v2\.2\.0 — PHP fingerprint report/);
  assert.match(text, /URL: https:\/\/example\.com\/shop/);
  assert.match(text, /Verdict: PHP usage detected \(score 6, confidence high\)/);
  assert.match(text, /\+3 X-Powered-By reports PHP — X-Powered-By: PHP\/8\.3\.4/);
  assert.match(text, /-2 Static site generator/);
  assert.match(text, /cookie names: PHPSESSID, _ga/);
  assert.match(text, /\.php resources: https:\/\/example\.com\/cart\.php/);
  assert.match(text, /Checked: 2026-10-21T12:00:00\.000Z/);
});

test('the report always states what it is not', () => {
  assert.match(build(result), /not a malware or security scan/);
});

test('an empty verdict produces an empty report', () => {
  assert.equal(build(null), '');
  assert.equal(build({}), '');
});
