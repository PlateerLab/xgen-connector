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
  /** 라이브 브릿지(메모리 등 공유 상태) — 사이드카가 이 서버로 RPC. tls 는 커넥터가 채운다. */
  server?: { url: string; token: string; tls?: { verify: boolean; ca_file?: string } };
  /** 서버 계약 버전(v2=2). 없으면 v1 서버. */
  protocol?: number;
  /** 서버가 에이전트 파라미터 옆에 싣는 추가 실행 옵션(memory 이력·output_schema 등) — 그대로 전달. */
  options?: Record<string, unknown>;
  /**
   * 캔버스 공급 노드 요약 — 이 에이전트에 연결된 입력 포트(도구·RAG 등)를 서버가 집계.
   * local_supported=false 면 로컬에서 재현할 수 없는 공급이 있다 → 서버에서 실행(graph_suppliers).
   */
  graph?: {
    suppliers?: { port: string; node_id: string; node_type: string }[];
    shipped?: string[];
    unsupported?: string[];
    local_supported?: boolean;
  };
  /**
   * 서버 사전 점검 실패 메시지(문자열이면 실패) — vLLM 모델 미선택 / provider 비활성 / 모델 미인가
   * 등. 서버가 같은 문구로 턴을 거절하므로 커넥터는 사이드카를 **시작하지 않고** 서버로 보낸다
   * (reason 'preflight'). null/없음 = 통과.
   */
  preflight_error?: string | null;
}

/** 로컬 턴 토큰 사용량(사이드카 usage 이벤트 data 와 같은 shape). */
export interface TurnUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number | null;
  cache_creation_tokens?: number | null;
  total_cost_usd?: number | null;
  model?: string | null;
  provider?: string | null;
  [k: string]: unknown;
}

/**
 * 서버가 턴 실행을 거부(HTTP 429 quota_exceeded)했을 때 — 서버 폴백 **없이** 턴을 차단해야 한다
 * (서버에서 돌려도 같은 한도에 걸린다). `authed()` 가 429 본문 detail.code 로 판정해 던진다.
 */
export class QuotaExceededError extends Error {
  readonly code = 'quota_exceeded' as const;
  readonly status = 429;
  constructor(
    message: string,
    readonly usage: unknown = null,
    readonly limit: unknown = null,
  ) {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

/** 본문에서 429 quota_exceeded 계약을 읽는다 — 아니면 null. */
export function parseQuotaExceeded(status: number, body: string): QuotaExceededError | null {
  if (status !== 429) return null;
  try {
    const j = JSON.parse(body) as { detail?: unknown };
    const d = j?.detail;
    if (d && typeof d === 'object' && (d as { code?: unknown }).code === 'quota_exceeded') {
      const det = d as { message?: unknown; usage?: unknown; limit?: unknown };
      return new QuotaExceededError(
        typeof det.message === 'string' && det.message
          ? det.message
          : '사용량 한도를 초과하여 실행할 수 없습니다',
        det.usage ?? null,
        det.limit ?? null,
      );
    }
  } catch {
    /* JSON 아님 */
  }
  return null;
}

/** 턴 결과 보고(v2) — 대화/기억이 서버에 저장되어 웹과 공유된다. */
export interface TurnReport {
  userText: string;
  agentText: string;
  status?: 'ok' | 'error' | 'cancelled';
  error?: string;
  toolEvents?: Record<string, unknown>[];
  /** 토큰 사용량(사이드카 usage 이벤트) — 서버가 output_data.usage·토큰 컬럼에 기록. */
  usage?: TurnUsage;
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
    /** 서버가 커넥터에 전달할 수 있는 인증이 있나(중앙 토큰/자격증명/API 키). 없으면 CLI 턴은 서버에서 실행. */
    auth_ready?: boolean;
    auth_source?: string | null;
  };
  codex: {
    enabled?: boolean;
    pinned?: string | null;
    target?: string | null;
    current?: string | null;
    auth_mode?: string;
    auth_ready?: boolean;
    auth_source?: string | null;
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
      const quota = parseQuotaExceeded(res.status, body);
      if (quota) throw quota;
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
