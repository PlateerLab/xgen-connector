import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BROWSER_CONTEXT_START,
  prependBrowserContext,
  sanitizedBrowserUrl,
  stripBrowserContext,
  type BrowserState,
} from '../src/core/browser';

const state: BrowserState = {
  enabled: true,
  activeByWorkflow: { wf: 'p1' },
  pages: [
    {
      pageId: 'p1',
      workflowId: 'wf',
      workflowName: 'Agent',
      mode: 'shared',
      url: 'https://example.com/private/path?token=secret#frag',
      title: 'Private',
      loading: 'idle',
      canGoBack: false,
      canGoForward: false,
      partition: 'persist:xgen-browser-hash',
      generation: 3,
    },
  ],
};

test('browser preamble applies only to enabled workflows with live pages', () => {
  const decorated = prependBrowserContext('원문', 'wf', state);
  assert.ok(decorated.startsWith(BROWSER_CONTEXT_START));
  assert.match(decorated, /"page_id":"p1"/);
  assert.match(decorated, /https:\/\/example\.com\/private\/path/);
  assert.ok(!decorated.includes('secret'));
  assert.ok(!decorated.includes('#frag'));
  assert.equal(stripBrowserContext(decorated), '원문');
  assert.equal(prependBrowserContext('원문', 'other', state), '원문');
  assert.equal(prependBrowserContext('원문', 'wf', { ...state, enabled: false }), '원문');
});

test('browser URL sanitizer accepts only web/about and removes query + fragment', () => {
  assert.equal(sanitizedBrowserUrl('https://x.test/a?b=1#c'), 'https://x.test/a');
  assert.equal(sanitizedBrowserUrl('about:blank'), 'about:blank');
  assert.equal(sanitizedBrowserUrl('file:///etc/passwd'), '');
  assert.equal(sanitizedBrowserUrl('javascript:alert(1)'), '');
});
