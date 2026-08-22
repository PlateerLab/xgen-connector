// ServerClient(HTTP) — 인증 헤더, 엔드포인트 URL, server 브릿지 주입, 보고 body,
// 오류 승격을 mock fetch 로 검증(실 서버는 러닝 환경에서 검증).
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeServerClient } from '../src/main/local-agent-server-client';

type Call = { url: string; init: RequestInit };

function mockFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Call[] = [];
  const fetch = (async (input: string | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as unknown as import('../src/main/sync-transport').NetworkFetch;
  return { fetch, calls };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const deps = (fetch: import('../src/main/sync-transport').NetworkFetch) => ({
  serverUrl: () => 'https://xgen.example/',
  token: () => 'tok-123',
  fetch,
});

test('fetchLocalTurnContext: 인증 GET + server 브릿지를 커넥터가 채운다', async () => {
  const { fetch, calls } = mockFetch(() =>
    jsonResponse({
      agent: { provider: 'codex', model: 'gpt-5.3-codex' },
      context: { api_keys: { openai: 'sk-acct' } },
    }),
  );
  const client = makeServerClient(deps(fetch));
  const ctx = await client.fetchLocalTurnContext('wf1', 'i1');

  assert.equal(
    calls[0].url,
    'https://xgen.example/api/agentflow/geny-agent/wf1/local-turn-context?interaction_id=i1',
  );
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(
    (calls[0].init.headers as Record<string, string>).Authorization,
    'Bearer tok-123',
  );
  // 서버 응답은 agent/context 만 — server 는 커넥터가 자기 연결로 채운다.
  assert.equal(ctx.agent.provider, 'codex');
  assert.equal(ctx.context.api_keys?.openai, 'sk-acct');
  assert.deepEqual(ctx.server, { url: 'https://xgen.example', token: 'tok-123' });
});

test('reportTurnResult: 인증 POST + result body', async () => {
  const { fetch, calls } = mockFetch(() => jsonResponse({ ok: true, io_id: 7 }));
  const client = makeServerClient(deps(fetch));
  await client.reportTurnResult('wf1', 'i1', { userText: '안녕', agentText: '반가워' });

  assert.equal(calls[0].url, 'https://xgen.example/api/agentflow/geny-agent/wf1/report-turn');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    interaction_id: 'i1',
    user_text: '안녕',
    agent_text: '반가워',
  });
});

test('비-2xx 는 오류로 승격(오케스트레이터가 error 이벤트로)', async () => {
  const { fetch } = mockFetch(() => jsonResponse({ detail: 'forbidden' }, false, 403));
  const client = makeServerClient(deps(fetch));
  await assert.rejects(() => client.fetchLocalTurnContext('wf1', 'i1'), /403/);
});
