/**
 * ServerClient (HTTP) — 커넥터 로컬 실행 오케스트레이터가 서버(로그인 계정)와
 * 주고받는 인증 클라이언트. local-agent-orchestrator 의 ``ServerClient`` 계약 구현.
 *
 *   fetchLocalTurnContext → GET  /api/agentflow/geny-agent/{wf}/local-turn-context
 *   reportTurnResult      → POST /api/agentflow/geny-agent/{wf}/report-turn
 *
 * server 브릿지(url/token)는 서버가 주지 않는다(자기 public URL 을 모른다) — 여기서
 * 커넥터의 연결 정보로 채운다. 그 token 이 사이드카의 메모리 RPC 인증에 쓰인다
 * (같은 계정 vault 공유). 전송/인증은 workspace-api 와 같은 deps 패턴.
 */
import type { NetworkFetch } from './sync-transport';
import type { LocalTurnContext, ServerClient } from './local-agent-orchestrator';

export interface ServerClientDeps {
  /** 서버 base URL (예: https://xgen.example) — 세션 중 바뀔 수 있어 getter. */
  serverUrl: () => string;
  /** 로그인 세션 토큰 — 갱신될 수 있어 getter(동기/비동기). */
  token: () => string | Promise<string>;
  /** 주입 fetch(테스트/사설 인증서 정책 일원화). */
  fetch: NetworkFetch;
}

function trimTrailingSlash(u: string): string {
  return u.replace(/\/+$/, '');
}

export function makeServerClient(deps: ServerClientDeps): ServerClient {
  async function authed(path: string, init: RequestInit): Promise<Response> {
    const base = trimTrailingSlash(deps.serverUrl());
    const tok = await deps.token();
    const res = await deps.fetch(`${base}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tok}`,
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      let body = '';
      try {
        body = await res.text();
      } catch {
        /* 본문 없음 */
      }
      throw new Error(`${res.status} ${body}`.slice(0, 400).trim());
    }
    return res;
  }

  return {
    async fetchLocalTurnContext(
      workflowId: string,
      interactionId: string,
    ): Promise<LocalTurnContext> {
      const q = interactionId ? `?interaction_id=${encodeURIComponent(interactionId)}` : '';
      const res = await authed(
        `/api/agentflow/geny-agent/${encodeURIComponent(workflowId)}/local-turn-context${q}`,
        { method: 'GET' },
      );
      const ctx = (await res.json()) as LocalTurnContext;
      // 서버 브릿지(메모리 RPC 대상)는 커넥터가 자기 연결에서 채운다. 사이드카가
      // 이 token 으로 /geny-memory/{wf}/rpc 를 인증 → 같은 계정 vault 공유.
      ctx.server = {
        url: trimTrailingSlash(deps.serverUrl()),
        token: await deps.token(),
      };
      return ctx;
    },

    async reportTurnResult(
      workflowId: string,
      interactionId: string,
      result: { userText: string; agentText: string },
    ): Promise<void> {
      await authed(`/api/agentflow/geny-agent/${encodeURIComponent(workflowId)}/report-turn`, {
        method: 'POST',
        body: JSON.stringify({
          interaction_id: interactionId,
          user_text: result.userText,
          agent_text: result.agentText,
        }),
      });
    },
  };
}
