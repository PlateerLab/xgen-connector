// 커넥터 로컬 실행 오케스트레이터 — 서버 context 페치 → 사이드카 → 서버 보고
// 흐름을 검증한다. 서버/사이드카는 mock(실 HTTP·실행은 다른 곳에서 증명됨).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  runConnectorLocalTurn,
  type LocalTurnContext,
  type ServerClient,
} from '../src/main/local-agent-orchestrator';
import type { LocalTurnRequest, SidecarEvent } from '../src/main/local-agent-sidecar';

function mockServer(ctx: LocalTurnContext): { client: ServerClient; reports: unknown[] } {
  const reports: unknown[] = [];
  return {
    reports,
    client: {
      fetchLocalTurnContext: async () => ctx,
      reportTurnResult: async (wf, iid, r) => {
        reports.push({ wf, iid, r });
      },
    },
  };
}

const CTX: LocalTurnContext = {
  agent: { provider: 'codex', model: 'gpt-5.3-codex', system_prompt: '너는 도우미' },
  context: { api_keys: { openai: 'sk-acct' }, settings: { CODEX_BINARY_PATH: '/x/codex' } },
  server: { url: 'https://xgen.example', token: 'tok' },
};

test('서버 context 를 받아 사이드카 요청을 만들고 결과를 서버에 보고한다', async () => {
  const { client, reports } = mockServer(CTX);
  let sentReq: LocalTurnRequest | undefined;
  const events: SidecarEvent[] = [];

  const { agentText, ok } = await runConnectorLocalTurn(
    { workflowId: 'wf1', interactionId: 'i1', workspaceDir: '/ws', text: '안녕' },
    {
      server: client,
      onEvent: (e) => events.push(e),
      runTurn: async (req, onEvent) => {
        sentReq = req;
        onEvent({ type: 'chunk', text: '반' });
        onEvent({ type: 'chunk', text: '가워' });
        onEvent({ type: 'done', text: '반가워' });
        return { code: 0 };
      },
    },
  );

  assert.equal(ok, true);
  assert.equal(agentText, '반가워');
  // 서버 해석 상태가 사이드카로 그대로 전달된다(계정 키/설정/에이전트 설정).
  assert.equal(sentReq!.provider, 'codex'); // 저장된 에이전트의 provider
  assert.equal(sentReq!.context?.api_keys?.openai, 'sk-acct'); // 계정 키
  assert.equal((sentReq!.options as Record<string, unknown>).model, 'gpt-5.3-codex');
  assert.equal((sentReq!.options as Record<string, unknown>).workflow_id, 'wf1');
  assert.deepEqual(sentReq!.server, CTX.server); // 메모리 브릿지
  // 결과가 서버에 보고된다(웹과 공유되도록).
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0], {
    wf: 'wf1',
    iid: 'i1',
    r: { userText: '안녕', agentText: '반가워' },
  });
});

test('서버 context 조회 실패는 error 이벤트, 사이드카는 안 돈다', async () => {
  const events: SidecarEvent[] = [];
  let ran = false;
  const client: ServerClient = {
    fetchLocalTurnContext: async () => {
      throw new Error('401');
    },
    reportTurnResult: async () => {},
  };
  const { ok } = await runConnectorLocalTurn(
    { workflowId: 'wf1', interactionId: 'i1', workspaceDir: '/ws', text: 'x' },
    {
      server: client,
      onEvent: (e) => events.push(e),
      runTurn: async () => {
        ran = true;
        return { code: 0 };
      },
    },
  );
  assert.equal(ok, false);
  assert.equal(ran, false);
  assert.equal(events[0].type, 'error');
});

test('사이드카 error 면 서버 보고를 하지 않는다(불완전 결과 저장 금지)', async () => {
  const { client, reports } = mockServer(CTX);
  const { ok } = await runConnectorLocalTurn(
    { workflowId: 'wf1', interactionId: 'i1', workspaceDir: '/ws', text: 'x' },
    {
      server: client,
      onEvent: () => {},
      runTurn: async (_req, onEvent) => {
        onEvent({ type: 'error', message: 'boom' });
        return { code: 1 };
      },
    },
  );
  assert.equal(ok, false);
  assert.equal(reports.length, 0);
});

test('보고 실패는 error 이벤트로 알리되 턴은 완료로 본다', async () => {
  const client: ServerClient = {
    fetchLocalTurnContext: async () => CTX,
    reportTurnResult: async () => {
      throw new Error('report down');
    },
  };
  const events: SidecarEvent[] = [];
  const { agentText } = await runConnectorLocalTurn(
    { workflowId: 'wf1', interactionId: 'i1', workspaceDir: '/ws', text: 'x' },
    {
      server: client,
      onEvent: (e) => events.push(e),
      runTurn: async (_req, onEvent) => {
        onEvent({ type: 'done', text: '답' });
        return { code: 0 };
      },
    },
  );
  assert.equal(agentText, '답');
  assert.ok(events.some((e) => e.type === 'error' && /보고 실패/.test(e.message)));
});
