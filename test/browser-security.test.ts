import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  normalizeBrowserUrl,
  resolveBrowserAddress,
  type BrowserConnectionEvent,
  type BrowserPageInfo,
} from '../src/core/browser';
import { BrowserRuntime } from '../src/main/browser-runtime';
import { BROWSER_TABS_TOOL, BrowserToolProvider } from '../src/main/browser-tools';
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

test('browser URL input adds https only when a protocol was omitted', () => {
  assert.equal(normalizeBrowserUrl('example.com/path'), 'https://example.com/path');
  assert.equal(normalizeBrowserUrl('http://example.com/path'), 'http://example.com/path');
  assert.equal(normalizeBrowserUrl('https://example.com/path'), 'https://example.com/path');
});

test('address search falls back to Google only when enabled', () => {
  assert.equal(resolveBrowserAddress('example.com', { enabled: false }), 'https://example.com/');
  assert.equal(resolveBrowserAddress('오늘 날씨', { enabled: false }), null);
  assert.equal(
    resolveBrowserAddress('오늘 날씨', { enabled: true, provider: 'google' }),
    `https://www.google.com/search?q=${encodeURIComponent('오늘 날씨')}`,
  );
  assert.equal(
    resolveBrowserAddress('javascript:alert(1)', { enabled: true, provider: 'google' }),
    null,
  );
});

test('shared navigation asks for its agent and resumes after the webview connects', async () => {
  const runtime = new BrowserRuntime();
  const page = {
    info: {
      pageId: 'shared-page',
      workflowId: 'workflow-25',
      workflowName: 'Agentflow (25)',
      mode: 'shared',
      url: 'about:blank',
      title: '새 탭',
      loading: 'idle',
      canGoBack: false,
      canGoForward: false,
      partition: 'persist:test',
      generation: 0,
    } satisfies BrowserPageInfo,
    contents: null,
    window: null,
    proxy: null,
    automationReset: null,
  };
  const internals = runtime as unknown as {
    enabled: boolean;
    accountPartition: string;
    pages: Map<string, typeof page>;
    resolvePendingConnection: (runtimePage: typeof page, contents: unknown) => void;
  };
  internals.enabled = true;
  internals.accountPartition = 'persist:test';
  internals.pages.set(page.info.pageId, page);

  const events: BrowserConnectionEvent[] = [];
  runtime.setConnectionListener((event) => events.push(event));
  let loaded = '';
  const contents = {
    isDestroyed: () => false,
    loadURL: async (url: string) => {
      loaded = url;
    },
  };
  const navigating = runtime.navigate({
    pageId: page.info.pageId,
    action: 'goto',
    url: 'example.com',
  });
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(events.at(-1)?.phase, 'required');
  internals.resolvePendingConnection(page, contents);
  await navigating;

  assert.equal(loaded, 'https://example.com/');
  assert.deepEqual(events.map((event) => event.phase), ['required', 'connected']);
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

test('an agent-created shared page requests visible browser UI', async () => {
  const basePage: BrowserPageInfo = {
    pageId: 'agent-page',
    workflowId: 'workflow-25',
    workflowName: 'Agentflow (25)',
    mode: 'shared',
    url: 'https://example.com/',
    title: '새 탭',
    loading: 'idle',
    canGoBack: false,
    canGoForward: false,
    partition: 'persist:test',
    generation: 0,
  };
  const createdModes: string[] = [];
  const createdWorkflows: string[] = [];
  const fakeRuntime = {
    create: async (request: { mode?: string; workflowId: string }) => {
      const mode = request.mode === 'shared' ? 'shared' : 'background';
      createdModes.push(mode);
      createdWorkflows.push(request.workflowId);
      return { ...basePage, mode } as BrowserPageInfo;
    },
  } as unknown as BrowserRuntime;
  const provider = new BrowserToolProvider(fakeRuntime);
  const revealed: string[] = [];
  provider.configure(true, [], (page) => revealed.push(page.pageId));

  await provider.callTool(BROWSER_TABS_TOOL, {
    action: 'create',
    mode: 'shared',
    url: 'https://example.com',
  }, { workflowId: 'workflow-25', workflowName: 'Agentflow (25)' });
  await provider.callTool(BROWSER_TABS_TOOL, {
    action: 'create',
    mode: 'background',
  }, { workflowId: 'workflow-25', workflowName: 'Agentflow (25)' });

  assert.deepEqual(createdModes, ['shared', 'background']);
  assert.deepEqual(createdWorkflows, ['workflow-25', 'workflow-25']);
  assert.deepEqual(revealed, ['agent-page']);

  await assert.rejects(
    () => provider.callTool(BROWSER_TABS_TOOL, { action: 'create', mode: 'shared' }),
    /mcp_call\.context\.workflow_id/,
  );

  await assert.rejects(
    () => provider.callTool(
      BROWSER_TABS_TOOL,
      { action: 'create', workflow_id: 'another-workflow' },
      { workflowId: 'workflow-25' },
    ),
    /일치하지 않습니다/,
  );
});
