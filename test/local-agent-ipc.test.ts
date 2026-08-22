// Local-agent IPC 코어 — 렌더러 요청 → 서버 context → 로컬 사이드카 → 서버 보고,
// 이벤트 스트리밍 봉투를 mock 으로 전 흐름 검증(electron 비의존).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  handleLocalAgentTurn,
  registerLocalAgentIpc,
  type LocalAgentEventEnvelope,
  type LocalAgentIpcDeps,
} from '../src/main/local-agent-ipc';
import type { LocalTurnRequest, SidecarEvent } from '../src/main/local-agent-sidecar';
import type { NetworkFetch } from '../src/main/sync-transport';

function fetchStub() {
  const calls: string[] = [];
  const fetch = (async (input: string | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/local-turn-context')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          agent: { provider: 'codex', model: 'gpt-5.3-codex' },
          context: { api_keys: { openai: 'sk-acct' } },
        }),
        text: async () => '',
      } as unknown as Response;
    }
    // report-turn
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' } as unknown as Response;
  }) as unknown as NetworkFetch;
  return { fetch, calls };
}

function deps(fetch: NetworkFetch, runTurn: LocalAgentIpcDeps['runTurn']): LocalAgentIpcDeps {
  return {
    serverUrl: () => 'https://xgen.example',
    token: () => 'tok',
    fetch,
    resolveWorkspaceDir: () => '/local/sync/wf1',
    runTurn,
  };
}

test('handleLocalAgentTurn: context→사이드카→보고, 서버 상태가 사이드카로 전달', async () => {
  const { fetch, calls } = fetchStub();
  let sentReq: LocalTurnRequest | undefined;
  const events: SidecarEvent[] = [];

  const runTurn = (async (req: LocalTurnRequest, onEvent: (e: SidecarEvent) => void) => {
    sentReq = req;
    onEvent({ type: 'chunk', text: '반' });
    onEvent({ type: 'done', text: '반가워' });
    return { code: 0 };
  }) as LocalAgentIpcDeps['runTurn'];

  const res = await handleLocalAgentTurn(
    { workflowId: 'wf1', interactionId: 'i1', text: '안녕' },
    deps(fetch, runTurn),
    (e) => events.push(e),
  );

  assert.equal(res.ok, true);
  assert.equal(res.agentText, '반가워');
  // 로컬 워크스페이스 + 서버 해석 상태가 사이드카 요청에.
  assert.equal(sentReq!.workspace_dir, '/local/sync/wf1');
  assert.equal(sentReq!.provider, 'codex');
  assert.equal(sentReq!.context?.api_keys?.openai, 'sk-acct');
  assert.deepEqual(sentReq!.server, { url: 'https://xgen.example', token: 'tok' });
  // context GET → report POST 순서로 서버를 두 번 친다.
  assert.equal(calls.length, 2);
  assert.match(calls[0], /local-turn-context/);
  assert.match(calls[1], /report-turn/);
  // 스트리밍 이벤트가 그대로 흘렀다.
  assert.deepEqual(events, [
    { type: 'chunk', text: '반' },
    { type: 'done', text: '반가워' },
  ]);
});

test('registerLocalAgentIpc: 이벤트를 봉투(interactionId)로 sender 에 push', async () => {
  const { fetch } = fetchStub();
  const runTurn = (async (_req: LocalTurnRequest, onEvent: (e: SidecarEvent) => void) => {
    onEvent({ type: 'chunk', text: 'x' });
    onEvent({ type: 'done', text: 'x' });
    return { code: 0 };
  }) as LocalAgentIpcDeps['runTurn'];

  let handler:
    | ((event: { sender: { send: (c: string, p: unknown) => void } }, msg: { workflowId: string; interactionId: string; text: string }) => Promise<unknown>)
    | undefined;
  const sent: Array<{ channel: string; payload: unknown }> = [];

  registerLocalAgentIpc({
    handle: (_channel, listener) => {
      handler = listener;
    },
    runChannel: 'local-agent:run',
    eventChannel: 'local-agent:event',
    deps: deps(fetch, runTurn),
  });

  assert.ok(handler);
  const sender = { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) };
  await handler!({ sender }, { workflowId: 'wf1', interactionId: 'i9', text: '안녕' });

  assert.equal(sent.length, 2);
  assert.equal(sent[0].channel, 'local-agent:event');
  const env = sent[0].payload as LocalAgentEventEnvelope;
  assert.equal(env.interactionId, 'i9');
  assert.deepEqual(env.event, { type: 'chunk', text: 'x' });
});
