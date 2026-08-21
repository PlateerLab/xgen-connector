import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  BROWSER_PARTITION_PREFIX,
  allowedBrowserUrl,
  browserPartition,
  browserPathWithinRoots,
} from '../src/main/browser-security';

test('browser scheme allowlist normalizes host input and blocks privileged schemes', () => {
  assert.equal(allowedBrowserUrl('example.com')?.startsWith('https://example.com'), true);
  assert.equal(allowedBrowserUrl('about:blank'), 'about:blank');
  for (const url of ['file:///tmp/a', 'javascript:alert(1)', 'data:text/html,x', 'ftp://x.test']) {
    assert.equal(allowedBrowserUrl(url), null, url);
  }
});

test('account partition is stable per server/user without exposing account ids', () => {
  const one = browserPartition('https://x.test/', 'user-secret');
  assert.ok(one.startsWith(BROWSER_PARTITION_PREFIX));
  assert.equal(one, browserPartition('https://x.test', 'user-secret'));
  assert.notEqual(one, browserPartition('https://x.test', 'other'));
  assert.ok(!one.includes('user-secret'));
});

test('upload/download paths stay inside allowedRoots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xgen-browser-'));
  assert.equal(browserPathWithinRoots(join(root, 'a.txt'), [root]), join(root, 'a.txt'));
  assert.equal(browserPathWithinRoots(join(root, '..', 'escape.txt'), [root]), null);
});
