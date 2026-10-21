import test from 'node:test';
import assert from 'node:assert/strict';

import '../extension/lib/detector.js';

const { evaluate } = globalThis.PHPSimpleCheck;

function verdict(signals) {
  return evaluate(signals).verdict;
}

function signalIds(result) {
  return result.signals.map((signal) => signal.id);
}

test('detects PHP from the X-Powered-By header', () => {
  const result = evaluate({ url: 'https://example.com/', headers: { 'x-powered-by': 'PHP/8.3.2' } });
  assert.equal(result.verdict, 'php');
  assert.equal(result.emoji, '🔴');
  assert.equal(result.confidence, 'high');
  assert.ok(signalIds(result).includes('header-x-powered-by-php'));
  assert.equal(result.facts.xPoweredBy, 'PHP/8.3.2');
  assert.equal(result.score, 3);
});

test('accepts header values as arrays and header maps as pairs', () => {
  const fromArray = evaluate({
    url: 'https://example.com/',
    headers: [['X-Powered-By', ['PHP/7.4.33']]]
  });
  const fromPairs = evaluate({
    url: 'https://example.com/',
    headers: [{ name: 'Server', value: 'Apache/2.4 PHP/8.1' }]
  });
  assert.equal(fromArray.verdict, 'php');
  assert.equal(fromPairs.verdict, 'php');
});

test('a plain static page is green', () => {
  const result = evaluate({
    url: 'https://example.com/about',
    headers: { server: 'nginx', 'content-type': 'text/html' },
    dom: { generator: null, resources: ['https://example.com/app.js'], anchors: ['https://example.com/pricing'] }
  });
  assert.equal(result.verdict, 'none');
  assert.equal(result.emoji, '🟢');
  assert.equal(result.score, 0);
  assert.deepEqual(result.signals, []);
});

test('an empty call does not throw and is green', () => {
  assert.equal(verdict(), 'none');
  assert.equal(verdict({}), 'none');
});

test('PHPSESSID cookie is decisive', () => {
  assert.equal(verdict({ url: 'https://example.com/', cookieNames: ['PHPSESSID', '_ga'] }), 'php');
});

test('Set-Cookie header with PHPSESSID is decisive', () => {
  assert.equal(
    verdict({ url: 'https://example.com/', headers: { 'set-cookie': 'PHPSESSID=abc123; path=/; HttpOnly' } }),
    'php'
  );
});

test('a .php page URL is decisive', () => {
  const result = evaluate({ url: 'https://example.com/index.php?page=home' });
  assert.equal(result.verdict, 'php');
  assert.ok(signalIds(result).includes('url-php'));
});

test('.PHP is matched case-insensitively', () => {
  assert.equal(verdict({ url: 'https://example.com/Index.PHP' }), 'php');
});

test('.php only in the query string is not evidence', () => {
  assert.equal(verdict({ url: 'https://example.com/download?file=report.php' }), 'none');
});

test('a first-party .php subresource is decisive', () => {
  const result = evaluate({
    url: 'https://example.com/',
    dom: { resources: ['https://example.com/api/session.php?x=1', 'https://example.com/app.js'] }
  });
  assert.equal(result.verdict, 'php');
  assert.ok(signalIds(result).includes('resource-php'));
});

test('a third-party .php resource is ignored', () => {
  assert.equal(
    verdict({ url: 'https://example.com/', dom: { resources: ['https://cdn.other.net/lib.php'] } }),
    'none'
  );
});

test('a .php resource on the apex domain counts for www', () => {
  assert.equal(
    verdict({ url: 'https://www.example.com/', dom: { resources: ['https://example.com/app.php'] } }),
    'php'
  );
});

test('unrelated hosts are never treated as first party', () => {
  assert.equal(
    verdict({ url: 'https://www.example.com/', dom: { resources: ['https://static.other.example/app.php'] } }),
    'none'
  );
});

test('a same-origin .php anchor alone stays yellow', () => {
  const result = evaluate({ url: 'https://example.com/', dom: { anchors: ['https://example.com/contact.php'] } });
  assert.equal(result.verdict, 'maybe');
  assert.equal(result.emoji, '🟡');
  assert.equal(result.score, 2);
});

test('an external .php anchor is ignored', () => {
  assert.equal(verdict({ url: 'https://example.com/', dom: { anchors: ['https://other.example/index.php'] } }), 'none');
});

test('WordPress generator meta is decisive', () => {
  const result = evaluate({ url: 'https://example.com/', dom: { generator: 'WordPress 6.6.1' } });
  assert.equal(result.verdict, 'php');
  assert.ok(signalIds(result).includes('generator-cms'));
});

test('WordPress paths and generator stack up', () => {
  const result = evaluate({
    url: 'https://example.com/',
    dom: {
      generator: 'WordPress 6.6.1',
      resources: ['https://example.com/wp-content/themes/x/style.css']
    }
  });
  assert.equal(result.verdict, 'php');
  assert.ok(result.score >= 6);
});

test('framework cookies are decisive', () => {
  ['laravel_session', 'ci_session', 'CakePHP', 'CraftSessionId', 'fe_typo_user', 'SESS0123456789abcdef0123456789abcdef'].forEach(
    (cookie) => {
      assert.equal(verdict({ url: 'https://example.com/', cookieNames: [cookie] }), 'php', cookie);
    }
  );
});

test('a lone XSRF-TOKEN cookie is only a hint', () => {
  assert.equal(verdict({ url: 'https://example.com/', cookieNames: ['XSRF-TOKEN'] }), 'maybe');
});

test('PHP-ish query parameters are only a hint', () => {
  assert.equal(verdict({ url: 'https://example.com/?page_id=12' }), 'maybe');
  assert.equal(verdict({ url: 'https://example.com/?utm_source=x' }), 'none');
});

test('page markers from inline scripts are decisive', () => {
  assert.equal(
    verdict({ url: 'https://example.com/', dom: { markers: { wpSettings: true } } }),
    'php'
  );
  assert.equal(
    verdict({ url: 'https://example.com/', dom: { markers: { inlineHasWpPaths: true } } }),
    'php'
  );
});

test('Drupal and Joomla markers are recognised', () => {
  assert.equal(
    verdict({ url: 'https://example.com/', dom: { resources: ['https://example.com/sites/default/files/a.css'] } }),
    'php'
  );
  assert.equal(
    verdict({ url: 'https://example.com/', dom: { resources: ['https://example.com/media/system/js/core.js'] } }),
    'php'
  );
  assert.equal(verdict({ url: 'https://example.com/', headers: { 'x-generator': 'Drupal 10' } }), 'php');
});

test('non-PHP runtimes are reported as negative evidence', () => {
  const result = evaluate({ url: 'https://example.com/', headers: { 'x-powered-by': 'Express' } });
  assert.equal(result.verdict, 'none');
  assert.ok(signalIds(result).includes('header-x-powered-by-other'));
  assert.ok(result.signals.some((signal) => signal.weight < 0));
});

test('a static site generator generator meta is negative evidence', () => {
  const result = evaluate({ url: 'https://example.com/', dom: { generator: 'Hugo 0.126.1' } });
  assert.equal(result.verdict, 'none');
  assert.ok(signalIds(result).includes('generator-static'));
});

test('positives sort before negatives and score sums only positives', () => {
  const result = evaluate({
    url: 'https://example.com/',
    headers: { 'x-powered-by': 'PHP/8.2', server: 'nginx' },
    cookieNames: ['PHPSESSID']
  });
  assert.equal(result.verdict, 'php');
  assert.equal(result.score, 6);
  const weights = result.signals.map((signal) => signal.weight);
  assert.deepEqual(weights, [...weights].sort((a, b) => b - a));
  assert.equal(result.facts.cookies[0], 'PHPSESSID');
});

test('the verdict exposes the emoji/label/colour contract used by the UI', () => {
  const labels = ['php', 'maybe', 'none'].map((key) => globalThis.PHPSimpleCheck.verdicts[key]);
  assert.deepEqual(labels.map((entry) => entry.emoji), ['🔴', '🟡', '🟢']);
  labels.forEach((entry) => {
    assert.match(entry.color, /^#[0-9a-f]{6}$/i);
    assert.ok(entry.badge.length >= 1 && entry.badge.length <= 4);
  });
});
