/**
 * ServerClient (HTTP) — 커넥터 로컬 실행이 서버(로그인 계정)와 주고받는 인증 클라이언트.
 *
 *   fetchLocalTurnContext → GET  /api/agentflow/geny-agent/{wf}/local-turn-context
 *   reportTurnResult      → POST /api/agentflow/geny-agent/{wf}/report-turn
 *   fetchRuntimeManifest  → GET  /api/agentflow/geny-agent/local-runtime/manifest
 *
 * server 브릿지(url/token)는 서버가 주지 않는다(자기 public URL 을 모른다) — 여기서
 * 커넥터의 연결 정보로 채운다. 그 token 이 사이드카의 메모리 RPC 인증에 쓰인다
 * (같은 계정 vault 공유). 전송/인증은 workspace-api 와 같은 deps 패턴.
 */
import type { NetworkFetch } from './sync-transport';

/** 서버가 로그인 계정으로 해석해 주는 turn context (로컬은 이걸 쓴다). */
export interface LocalTurnContext {
  /** 저장된 에이전트 설정(provider/model/system_prompt/options). run() kwargs 로. */
  agent: Record<string, unknown>;
  /** 계정 자격증명/설정 — 서버가 해석. */
  context: {
    api_keys?: Record<string, string>;
    base_urls?: Record<string, string>;
    credentials?: Record<string, unknown>;
    settings?: Record<string, string>;
  };
  /** 라이브 브릿지(메모리 등 공유 상태) — 사이드카가 이 서버로 RPC. */
  server?: { url: string; token: string };
  /** 서버 계약 버전(v2=2). 없으면 v1 서버. */
  protocol?: number;
}

/** 턴 결과 보고(v2) — 대화/기억이 서버에 저장되어 웹과 공유된다. */
export interface TurnReport {
  userText: string;
  agentText: string;
  status?: 'ok' | 'error' | 'cancelled';
  error?: string;
  toolEvents?: Record<string, unknown>[];
  usage?: { input_tokens?: number; output_tokens?: number };
  provider?: string;
  model?: string;
  durationMs?: number;
  deviceName?: string;
}

/** 서버 런타임 매니페스트 — 커넥터가 서버와 같은 버전으로 수렴하기 위한 목표. */
export interface RuntimeManifest {
  protocol: number;
  runtime: { version: string; wheel_url: string; python?: string };
  claude: {
    enabled?: boolean;
    pinned?: string | null;
    target?: string | null;
    current?: string | null;
    auth_mode?: string;
  };
  codex: {
    enabled?: boolean;
    pinned?: string | null;
    target?: string | null;
    current?: string | null;
    auth_mode?: string;
  };
}

/** 커넥터가 주입하는 서버 클라이언트(인증된 HTTP). */
export interface ServerClient {
  fetchLocalTurnContext(workflowId: string, interactionId: string): Promise<LocalTurnContext>;
  reportTurnResult(workflowId: string, interactionId: string, result: TurnReport): Promise<void>;
  fetchRuntimeManifest(): Promise<RuntimeManifest>;
}

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
      ctx.server = { url: trimTrailingSlash(deps.serverUrl()), token: await deps.token() };
      return ctx;
    },

    async reportTurnResult(
      workflowId: string,
      interactionId: string,
      result: TurnReport,
    ): Promise<void> {
      await authed(`/api/agentflow/geny-agent/${encodeURIComponent(workflowId)}/report-turn`, {
        method: 'POST',
        body: JSON.stringify({
          interaction_id: interactionId,
          user_text: result.userText,
          agent_text: result.agentText,
          status: result.status ?? 'ok',
          error: result.error ?? '',
          tool_events: result.toolEvents ?? null,
          usage: result.usage ?? null,
          provider: result.provider ?? '',
          model: result.model ?? '',
          duration_ms: result.durationMs ?? null,
          device_name: result.deviceName ?? '',
        }),
      });
    },

    async fetchRuntimeManifest(): Promise<RuntimeManifest> {
      const res = await authed('/api/agentflow/geny-agent/local-runtime/manifest', {
        method: 'GET',
      });
      return (await res.json()) as RuntimeManifest;
    },
  };
}
