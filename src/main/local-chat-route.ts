/**
 * local-chat-route — 커넥터 채팅 턴을 **로컬 실행으로 라우팅**한다 (v2).
 *
 * 규칙(제품 결정): **커넥터에서 시작한 Agent-XGeny 턴은 이 PC(사이드카)에서 돈다.**
 * 상태(에이전트 설정·자격증명·메모리·이력·파일)는 서버가 진실이고 그대로 쓴다
 * (context 페치 → 로컬 실행 → 동기화 flush → 결과 보고). 로컬에서 돌 수 없는 경우에만
 * 서버 sandbox 로 보내되, 그 사실을 **숨기지 않는다**: 이유를 돌려주고(호출부가
 * `execution_target:'sandbox'` + 상태 이벤트로 알린다) 진단 로그에 남긴다.
 *
 * 서버 폴백이 되는 경우(handled=false, 아직 렌더러에 아무것도 안 보낸 상태):
 *   · 로컬 런타임 미설치 / 사이드카 기동 불가   → runtime_missing
 *   · 문자열 입력이 아님(복합 워크플로)          → composite_input
 *   · 첨부 파일/컬렉션(서버 RAG·스토리지 기능)   → attachments
 *   · 서버가 로컬-턴 컨텍스트를 못 줌(미지원/오류) → context_unavailable
 *   · 로컬 워크스페이스(동기화 폴더) 확보 불가     → workspace_unavailable
 *   · CLI provider 바이너리 준비 실패             → cli_missing
 *   · 캔버스 공급 노드(도구·RAG 등) 로컬 미지원    → graph_suppliers
 *   · 서버 사전 점검 실패(모델 미선택·provider 비활성·미인가) → preflight (사이드카 미기동)
 * 일단 로컬 청크가 흐르기 시작하면 로컬이 그 턴을 끝까지 소유한다.
 *
 * 서버 폴백이 **아닌** 차단(handled=true, blocked=true): 서버가 local-turn-context 를
 * 429 quota_exceeded 로 거부하면 서버에서 돌려도 같은 한도에 걸리므로 상태 이벤트
 * (surface:'blocked', reason:'quota_exceeded') + error 로 턴을 끝낸다.
 */
import { frameToChatEvent } from '../core/chat';
import type { ChatEvent, ChatRequest } from '../core/types';
import {
  makeServerClient,
  QuotaExceededError,
  type ServerClient,
  type TurnReport,
  type TurnUsage,
} from './local-agent-server-client';
import type { LocalTurnRequest, SidecarEvent, SidecarTerminal } from './local-agent-sidecar';
import type { NetworkFetch } from './sync-transport';

/** 사이드카 실행기 표면 — SidecarDaemon 또는 테스트 대역. */
export interface TurnRunner {
  runTurn(
    request: LocalTurnRequest,
    onEvent: (e: SidecarEvent) => void,
    opts?: { signal?: AbortSignal },
  ): Promise<{ terminal: SidecarTerminal }>;
}

export interface LocalChatDeps {
  serverUrl: () => string;
  token: () => string | Promise<string>;
  fetch: NetworkFetch;
  /** 이 에이전트의 로컬 동기화 폴더(서버와 sync). 불가면 throw → 서버 폴백.
   *  synced=false 면 폴더는 있으나 하이드레이트가 제한시간 내 끝나지 않은 상태 — 실행은
   *  진행하되 상태 이벤트 detail 로 알린다(폴백 아님). */
  resolveWorkspaceDir: (
    workflowId: string,
    workflowName?: string,
  ) => Promise<{ dir: string; synced: boolean }>;
  /** 독립 로컬 런타임이 설치돼 있나(설치 폴더). */
  runtimeInstalled: () => Promise<boolean>;
  /** 사이드카 실행기(상주 데몬). */
  runner: TurnRunner;
  /** 이 PC 의 CLI 경로/격리 홈 settings(CODEX_BINARY_PATH·XGEN_LOCAL_CODEX_HOME 등) — 사이드카 주입. */
  cliSettings?: () => Record<string, string>;
  /** CLI provider 턴 직전 바이너리 보장(없으면 자동 설치). false = 준비 실패. */
  ensureCli?: (tool: 'codex' | 'claude') => Promise<boolean>;
  /** 서버 브릿지 TLS 검증 여부(config.allowPrivateCertificate 의 반대). 기본 true(검증). */
  tlsVerify?: () => boolean;
  /** 테스트 주입: CLI 인증 프리플라이트 대체(기본 serverCliAuth — 서버 설정만 본다). */
  cliAuth?: (
    tool: 'codex' | 'claude',
    settings: Record<string, string>,
    apiKeys: Record<string, string>,
  ) => Promise<{ ok: boolean; source: string; settings: Record<string, string> }>;
  /** 턴 종료 후 로컬 변경을 서버 인덱스로 밀어 넣는다(bounded). */
  flushSync?: (workflowId: string) => Promise<boolean>;
  /** 보고에 싣는 기기명. */
  deviceName?: () => string;
  /** 진단 로그. */
  diag?: (message: string) => void;
  /** 테스트 주입. */
  server?: ServerClient;
  signal?: AbortSignal;
}

export type LocalFallbackReason =
  | 'composite_input'
  | 'attachments'
  | 'runtime_missing'
  | 'context_unavailable'
  | 'workspace_unavailable'
  | 'cli_missing'
  | 'cli_auth_missing'
  | 'local_start_failed'
  | 'graph_suppliers'
  | 'preflight';

export interface LocalRouteResult {
  handled: boolean;
  reason?: LocalFallbackReason;
  detail?: string;
  /** true = 서버 폴백 없이 턴이 차단·종료됨(quota_exceeded 등; handled=true 와 함께). */
  blocked?: boolean;
}

/** 동기화 미완료 상태에서 로컬 실행을 시작할 때 상태 이벤트에 싣는 안내. */
export const WORKSPACE_UNSYNCED_DETAIL = '동기화 미완료 — 일부 파일이 아직 없을 수 있음';

/** 사이드카가 메모리 브릿지/첫 RPC 실패를 알려 왔을 때(notice code=memory_offline)
 *  상태 이벤트 detail 로 부착하는 안내. 폴백이 아니라 무기억으로 계속 진행한다. */
export const MEMORY_OFFLINE_DETAIL = '메모리 서버 연결 실패 — 이번 턴은 무기억으로 진행';

/** 사람이 읽는 폴백 사유(상태 이벤트/진단용). */
export function describeFallback(reason: LocalFallbackReason, detail?: string): string {
  const base: Record<LocalFallbackReason, string> = {
    composite_input: '복합 입력(파일/객체)은 서버에서 실행합니다',
    attachments: '첨부 파일·컬렉션이 있는 턴은 서버에서 실행합니다',
    runtime_missing: '로컬 실행 런타임이 준비되지 않아 서버 sandbox 에서 실행합니다',
    context_unavailable: '서버가 로컬 실행 컨텍스트를 주지 못해 서버 sandbox 에서 실행합니다',
    workspace_unavailable: '로컬 동기화 폴더를 확보하지 못해 서버 sandbox 에서 실행합니다',
    cli_missing: 'CLI 바이너리를 준비하지 못해 서버 sandbox 에서 실행합니다',
    cli_auth_missing:
      '서버에 이 CLI 의 인증(API 키/중앙 토큰/자격증명)이 설정되어 있지 않아 서버에서 실행합니다 (관리자 설정 → LLM)',
    local_start_failed: '로컬 실행이 시작되지 못해 서버 sandbox 에서 실행합니다',
    graph_suppliers: '캔버스 공급 노드(도구·RAG 등)는 서버에서 실행',
    preflight: '사전 점검 실패(모델 미선택·비활성·미인가) — 서버가 같은 안내 문구를 냅니다',
  };
  return detail ? `${base[reason]} (${detail})` : base[reason];
}

/**
 * CLI provider 의 인증은 **서버 일원화** — 커넥터는 서버가 turn context 로 준 것만 쓴다:
 *   Claude Code: api_key(anthropic 키) / setup_token(중앙 장수명 토큰 CLAUDE_CODE_OAUTH_TOKEN)
 *   Codex      : api_key(openai 키) / oauth(중앙 ChatGPT 자격증명 CODEX_CREDENTIALS_JSON)
 * 서버의 pod-로컬 oauth(Claude) 는 PC 로 가져올 수 없다 → 없음. 없으면 로컬에서 시작하지 않고
 * 서버에서 실행한다(서버 자원). 개별 PC 로그인은 두지 않는다(인증 이원화 금지).
 */
export function serverCliAuth(
  tool: 'codex' | 'claude',
  settings: Record<string, string>,
  apiKeys: Record<string, string>,
): { ok: boolean; source: 'server_api_key' | 'server_token' | 'server_credentials' | 'none' } {
  if (tool === 'codex') {
    const mode = (settings.CODEX_AUTH_MODE || 'api_key').trim();
    if (mode === 'api_key')
      return apiKeys.openai || apiKeys.codex
        ? { ok: true, source: 'server_api_key' }
        : { ok: false, source: 'none' };
    return settings.CODEX_CREDENTIALS_JSON
      ? { ok: true, source: 'server_credentials' }
      : { ok: false, source: 'none' };
  }
  const mode = (settings.CLAUDE_CODE_AUTH_MODE || 'api_key').trim();
  if (mode === 'api_key')
    return apiKeys.anthropic || apiKeys.claude_code
      ? { ok: true, source: 'server_api_key' }
      : { ok: false, source: 'none' };
  if (mode === 'setup_token')
    return settings.CLAUDE_CODE_OAUTH_TOKEN
      ? { ok: true, source: 'server_token' }
      : { ok: false, source: 'none' };
  return { ok: false, source: 'none' };
}

function sidecarToolToChatEvent(data: Record<string, unknown>): ChatEvent | null {
  // 사이드카 tool 이벤트 data 는 웹 SSE 의 bare tool 프레임과 같은 shape
  // ({type: tool_call|tool_result|tool_error, tool_name, ...}) — 같은 매퍼를 쓴다.
  try {
    return frameToChatEvent(undefined, JSON.stringify(data));
  } catch {
    return null;
  }
}

/** 커넥터 로컬 턴 1건 시도. handled=false 면 호출부가 서버(sandbox)로 폴백. */
export async function runLocalChatTurn(
  req: ChatRequest,
  deps: LocalChatDeps,
  emit: (e: ChatEvent) => void,
): Promise<LocalRouteResult> {
  const diag = deps.diag ?? (() => {});
  const fallback = (reason: LocalFallbackReason, detail?: string): LocalRouteResult => {
    diag(
      `fallback → server sandbox: ${reason}${detail ? ` (${detail})` : ''} wf=${req.workflowId}`,
    );
    return { handled: false, reason, detail };
  };

  // 복합 입력(객체/배열)은 로컬 단일-에이전트 경로 밖 → 서버.
  if (typeof req.input !== 'string' || !req.input.trim()) return fallback('composite_input');
  // 첨부/컬렉션은 서버 스토리지·RAG 기능 — 서버.
  if ((req.selectedFiles?.length ?? 0) > 0 || (req.selectedCollections?.length ?? 0) > 0) {
    return fallback('attachments');
  }
  if (!(await deps.runtimeInstalled().catch(() => false))) return fallback('runtime_missing');

  const server =
    deps.server ??
    makeServerClient({ serverUrl: deps.serverUrl, token: deps.token, fetch: deps.fetch });

  // 1) 서버 turn context — 실패하면 아무것도 안 보낸 채 서버 폴백.
  //    단, 429 quota_exceeded 는 폴백이 아니라 **차단**(서버에서 돌려도 같은 한도).
  let ctx;
  try {
    ctx = await server.fetchLocalTurnContext(req.workflowId, req.interactionId);
  } catch (err) {
    if (
      err instanceof QuotaExceededError ||
      (err as { code?: unknown })?.code === 'quota_exceeded'
    ) {
      const message = (err as Error).message || '사용량 한도를 초과하여 실행할 수 없습니다';
      diag(`blocked: quota_exceeded wf=${req.workflowId} (${message.slice(0, 200)})`);
      emit({ kind: 'status', surface: 'blocked', reason: 'quota_exceeded', detail: message });
      emit({ kind: 'error', detail: message });
      emit({ kind: 'end' });
      return { handled: true, blocked: true, detail: message };
    }
    return fallback('context_unavailable', (err as Error).message?.slice(0, 200));
  }

  // 서버 사전 점검 실패(vLLM 모델 미선택·provider 비활성·모델 미인가 등) — 로컬에서 돌려도 같은
  // 이유로 실패한다. 사이드카를 시작하지 않고 서버로 보낸다(서버가 같은 안내 문구를 낸다).
  if (typeof ctx.preflight_error === 'string' && ctx.preflight_error.trim()) {
    return fallback('preflight', ctx.preflight_error.trim().slice(0, 120));
  }

  // 캔버스 공급 노드(도구·RAG 등 입력 포트)를 로컬에서 재현할 수 없으면 서버에서 실행.
  if (ctx.graph && ctx.graph.local_supported === false) {
    const unsupported = (ctx.graph.unsupported ?? []).filter(Boolean).join(',');
    return fallback('graph_suppliers', unsupported || undefined);
  }

  // 2) 로컬 동기화 폴더 — 불가면 서버 폴백(로컬 자원 사용 불가).
  let workspaceDir: string;
  let workspaceSynced = true;
  try {
    const ws = await deps.resolveWorkspaceDir(req.workflowId, req.workflowName);
    workspaceDir = ws.dir;
    workspaceSynced = ws.synced !== false;
    if (!workspaceDir) throw new Error('로컬 동기화 폴더 없음');
  } catch (err) {
    return fallback('workspace_unavailable', (err as Error).message?.slice(0, 200));
  }

  const provider = String((ctx.agent.provider as string) || 'openai');
  const model = String((ctx.agent.model as string) || '');
  // CLI provider 는 바이너리가 있어야 로컬 실행이 된다 — 없으면 **여기서 자동
  // 설치**한다(부팅 자동 프로비저닝과 동형; 아직 아무것도 emit 안 한 시점이라
  // 실패하면 깨끗이 서버로 폴백된다).
  const cliTool = provider === 'codex' ? 'codex' : provider === 'claude_code' ? 'claude' : null;
  if (cliTool && deps.ensureCli) {
    const ready = await deps.ensureCli(cliTool).catch(() => false);
    if (!ready) return fallback('cli_missing', cliTool);
  }

  // CLI 바이너리 경로/격리 홈은 **이 PC 의 것**이 유일하게 유효하다 — 서버가 보낸
  // settings 위에 로컬 설치 경로를 덮어써 codex/claude_code 가 로컬 설치본을 쓴다.
  const localSettings = deps.cliSettings?.() ?? {};
  let settings: Record<string, string> = { ...(ctx.context?.settings ?? {}), ...localSettings };
  // CLI 인증 프리플라이트 — **서버가 준 인증만**(일원화). 없으면 서버에서 실행(서버 자원).
  if (cliTool) {
    const auth = deps.cliAuth
      ? await deps
          .cliAuth(cliTool, settings, ctx.context?.api_keys ?? {})
          .catch(() => ({ ok: false, source: 'none', settings }))
      : { ...serverCliAuth(cliTool, settings, ctx.context?.api_keys ?? {}), settings };
    settings = auth.settings;
    if (!auth.ok) return fallback('cli_auth_missing', cliTool);
    diag(`cli auth source=${auth.source} tool=${cliTool}`);
  }

  // 여기부터 로컬이 이 턴을 소유한다(handled=true) — 단, 시작 단계에서 죽으면(첫 출력 전
  // 오류: 인증 만료·바이너리 실행 실패 등) 서버로 폴백한다(아직 내용을 보여 준 게 없다).
  if (!workspaceSynced) diag(`workspace unsynced at turn start wf=${req.workflowId}`);
  emit({
    kind: 'status',
    surface: 'connector_local',
    provider,
    workspaceDir,
    ...(workspaceSynced ? {} : { detail: WORKSPACE_UNSYNCED_DETAIL }),
  });
  const mergedContext = { ...ctx.context, settings };
  // 서버 브릿지 TLS 정책 — 커넥터의 사설 인증서 허용 설정을 사이드카에도 동일 적용.
  const tlsVerify = deps.tlsVerify ? deps.tlsVerify() !== false : true;
  const serverBridge = ctx.server
    ? { ...ctx.server, tls: { ...(ctx.server.tls ?? {}), verify: tlsVerify } }
    : undefined;

  const startedAt = Date.now();
  let agentText = '';
  let errorDetail = '';
  let usage: TurnUsage | undefined;
  let sawOutput = false; // 텍스트/도구 이벤트를 하나라도 보여 줬나(시작 실패 폴백 판정)
  const toolEvents: Record<string, unknown>[] = [];
  const result = await deps.runner.runTurn(
    {
      workspace_dir: workspaceDir,
      provider,
      text: req.input,
      context: mergedContext,
      server: serverBridge,
      options: {
        // 에이전트 파라미터 + 서버가 옆에 실은 추가 옵션(memory 이력·output_schema 등)을
        // 그대로 통과시킨다 — 서버가 진실이라 키를 골라내지 않는다.
        ...ctx.agent,
        ...(ctx.options ?? {}),
        workflow_id: req.workflowId,
        interaction_id: req.interactionId,
        streaming: true,
      },
    },
    (se: SidecarEvent) => {
      switch (se.type) {
        case 'chunk':
          // 실행기 시작 실패는 "[ERROR] geny agent could not start: …" 텍스트로 온다 — 시작 전이면
          // 화면에 내보내지 않고 폴백 판정으로 보낸다.
          if (!sawOutput && /^\s*\[ERROR\]/.test(se.text)) {
            errorDetail = se.text.trim();
            break;
          }
          sawOutput = true;
          agentText += se.text;
          emit({ kind: 'text', content: se.text });
          break;
        case 'tool': {
          sawOutput = true;
          toolEvents.push(se.data);
          const ev = sidecarToolToChatEvent(se.data);
          if (ev) emit(ev);
          break;
        }
        case 'notice':
          // 진단 신호(첫 chunk 이전) — 폴백이 아니다. 로컬 실행은 계속되고, 무기억
          // degrade 사실만 surface 상태 이벤트 detail 로 부착해 알린다.
          if (se.data?.code === 'memory_offline') {
            emit({
              kind: 'status',
              surface: 'connector_local',
              provider,
              workspaceDir,
              detail: se.data.message || MEMORY_OFFLINE_DETAIL,
            });
          }
          break;
        case 'usage':
          // 파이프라인 종료 후 1회 — 보고(report-turn) usage 로 서버에 기록(토큰 컬럼·output_data.usage).
          if (se.data && typeof se.data === 'object') usage = se.data as TurnUsage;
          break;
        case 'done':
          if (se.text) agentText = se.text;
          break;
        case 'error':
          errorDetail = se.message;
          if (sawOutput) emit({ kind: 'error', detail: se.message });
          break;
        default:
          break; // started/canvas_command/meta — 화면 표시 없음
      }
    },
    { signal: deps.signal },
  );

  // 시작 단계 실패(아무 내용도 보여 주기 전) → 서버 폴백. 인증 만료/키 없음/바이너리 실행 실패 등.
  if (!sawOutput && (result.terminal === 'error' || errorDetail)) {
    return fallback('local_start_failed', (errorDetail || '').slice(0, 200));
  }

  // 3) 로컬 변경 → 서버 인덱스(bounded) → 결과 보고. 보고 실패해도 턴은 완료.
  try {
    await deps.flushSync?.(req.workflowId);
  } catch {
    /* 동기화는 watcher 가 따라잡는다 */
  }
  const status: TurnReport['status'] =
    result.terminal === 'cancelled' ? 'cancelled' : result.terminal === 'error' ? 'error' : 'ok';
  try {
    await server.reportTurnResult(req.workflowId, req.interactionId, {
      userText: req.input,
      agentText,
      status,
      error: errorDetail || undefined,
      toolEvents,
      usage,
      provider,
      model,
      durationMs: Date.now() - startedAt,
      deviceName: deps.deviceName?.(),
    });
  } catch (err) {
    diag(`report-turn 실패(로컬 턴은 완료): ${(err as Error).message}`);
  }
  emit({ kind: 'end' });
  return { handled: true };
}
