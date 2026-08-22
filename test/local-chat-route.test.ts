// 커넥터 채팅 로컬 라우팅 — 로컬 시도 vs 서버 폴백 + SidecarEvent→ChatEvent 매핑.
// 핵심: 폴백은 "아무것도 렌더러에 안 보낸 채" handled=false (무회귀).
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatEvent, ChatRequest } from '../src/core/types';
import type { LocalTurnRequest, SidecarEvent } from '../src/main/local-agent-sidecar';
import { runLocalChatTurn, type LocalChatDeps } from '../src/main/local-chat-route';

const REQ: ChatRequest = {
  workflowId: 'wf1',
  workflowName: 'A',
  input: '안녕',
  interactionId: 'i1',
};

const CTX = {
  agent: { provider: 'codex', model: 'gpt-5.3-codex' },
  context: { api_keys: { openai: 'sk' } },
  server: { url: 'https://s', token: 't' },
};

function baseDeps(over: Partial<LocalChatDeps>): LocalChatDeps {
  return {
    serverUrl: () => 'https://s',
    token: () => 't',
    fetch: (async () => new Response()) as never,
    resolveWorkspaceDir: async () => '/ws',
    runtimeInstalled: async () => true,
    server: {
      fetchLocalTurnContext: async () => CTX,
      reportTurnResult: async () => {},
    },
    runTurn: (async (_req: LocalTurnRequest, onEvent: (e: SidecarEvent) => void) => {
      onEvent({ type: 'chunk', text: '반' });
      onEvent({ type: 'chunk', text: '가워' });
      onEvent({ type: 'done', text: '반가워' });
      return { code: 0 };
    }) as never,
    ...over,
  };
}

test('런타임 미설치 → handled=false, 아무것도 emit 안 함(서버 폴백)', async () => {
  const events: ChatEvent[] = [];
  const r = await runLocalChatTurn(REQ, baseDeps({ runtimeInstalled: async () => false }), (e) =>
    events.push(e),
  );
  assert.equal(r.handled, false);
  assert.equal(events.length, 0);
});

test('복합 입력(문자열 아님) → handled=false', async () => {
  const events: ChatEvent[] = [];
  const r = await runLocalChatTurn(
    { ...REQ, input: { some: 'object' } },
    baseDeps({}),
    (e) => events.push(e),
  );
  assert.equal(r.handled, false);
  assert.equal(events.length, 0);
});

test('서버 context 미지원(fetch throw) → handled=false, 폴백(무 emit)', async () => {
  const events: ChatEvent[] = [];
  const r = await runLocalChatTurn(
    REQ,
    baseDeps({
      server: {
        fetchLocalTurnContext: async () => {
          throw new Error('404 (서버가 아직 로컬-턴 엔드포인트 없음)');
        },
        reportTurnResult: async () => {},
      },
    }),
    (e) => events.push(e),
  );
  assert.equal(r.handled, false);
  assert.equal(events.length, 0);
});

test('로컬 동기화 폴더 불가 → handled=false, 폴백', async () => {
  const events: ChatEvent[] = [];
  const r = await runLocalChatTurn(
    REQ,
    baseDeps({
      resolveWorkspaceDir: async () => {
        throw new Error('no sync');
      },
    }),
    (e) => events.push(e),
  );
  assert.equal(r.handled, false);
  assert.equal(events.length, 0);
});

test('로컬 성공 → text 청크 + end 스트리밍, 서버 보고, handled=true', async () => {
  const events: ChatEvent[] = [];
  const reports: unknown[] = [];
  const r = await runLocalChatTurn(
    REQ,
    baseDeps({
      server: {
        fetchLocalTurnContext: async () => CTX,
        reportTurnResult: async (wf, iid, res) => {
          reports.push({ wf, iid, res });
        },
      },
    }),
    (e) => events.push(e),
  );
  assert.equal(r.handled, true);
  assert.deepEqual(events, [
    { kind: 'text', content: '반' },
    { kind: 'text', content: '가워' },
    { kind: 'end' },
  ]);
  // 결과가 서버에 보고된다(웹과 공유).
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0], {
    wf: 'wf1',
    iid: 'i1',
    res: { userText: '안녕', agentText: '반가워' },
  });
});

test('사이드카 error → error 이벤트 emit, 보고 안 함, handled=true(로컬이 소유)', async () => {
  const events: ChatEvent[] = [];
  const reports: unknown[] = [];
  const r = await runLocalChatTurn(
    REQ,
    baseDeps({
      server: {
        fetchLocalTurnContext: async () => CTX,
        reportTurnResult: async () => {
          reports.push(1);
        },
      },
      runTurn: (async (_req: LocalTurnRequest, onEvent: (e: SidecarEvent) => void) => {
        onEvent({ type: 'error', message: 'boom' });
        return { code: 1 };
      }) as never,
    }),
    (e) => events.push(e),
  );
  assert.equal(r.handled, true);
  assert.ok(events.some((e) => e.kind === 'error' && e.detail === 'boom'));
  assert.equal(reports.length, 0); // 오류 턴은 보고 안 함
});
