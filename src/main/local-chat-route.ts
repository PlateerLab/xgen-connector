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
 * 일단 로컬 청크가 흐르기 시작하면 로컬이 그 턴을 끝까지 소유한다.
 */
import { frameToChatEvent } from '../core/chat';
import type { ChatEvent, ChatRequest } from '../core/types';
import { makeServerClient, type ServerClient, type TurnReport } from './local-agent-server-client';
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
  /** 이 에이전트의 로컬 동기화 폴더(서버와 sync). 불가면 throw → 서버 폴백. */
  resolveWorkspaceDir: (workflowId: string) => Promise<string>;
  /** 독립 로컬 런타임이 설치돼 있나(설치 폴더). */
  runtimeInstalled: () => Promise<boolean>;
  /** 사이드카 실행기(상주 데몬). */
  runner: TurnRunner;
  /** 이 PC 의 CLI 경로/격리 홈 settings(CODEX_BINARY_PATH·XGEN_LOCAL_CODEX_HOME 등) — 사이드카 주입. */
  cliSettings?: () => Record<string, string>;
  /** CLI provider 턴 직전 바이너리 보장(없으면 자동 설치). false = 준비 실패. */
  ensureCli?: (tool: 'codex' | 'claude') => Promise<boolean>;
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
  | 'cli_missing';

export interface LocalRouteResult {
  handled: boolean;
  reason?: LocalFallbackReason;
  detail?: string;
}

/** 사람이 읽는 폴백 사유(상태 이벤트/진단용). */
export function describeFallback(reason: LocalFallbackReason, detail?: string): string {
  const base: Record<LocalFallbackReason, string> = {
    composite_input: '복합 입력(파일/객체)은 서버에서 실행합니다',
    attachments: '첨부 파일·컬렉션이 있는 턴은 서버에서 실행합니다',
    runtime_missing: '로컬 실행 런타임이 준비되지 않아 서버 sandbox 에서 실행합니다',
    context_unavailable: '서버가 로컬 실행 컨텍스트를 주지 못해 서버 sandbox 에서 실행합니다',
    workspace_unavailable: '로컬 동기화 폴더를 확보하지 못해 서버 sandbox 에서 실행합니다',
    cli_missing: 'CLI 바이너리를 준비하지 못해 서버 sandbox 에서 실행합니다',
  };
  return detail ? `${base[reason]} (${detail})` : base[reason];
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
  let ctx;
  try {
    ctx = await server.fetchLocalTurnContext(req.workflowId, req.interactionId);
  } catch (err) {
    return fallback('context_unavailable', (err as Error).message?.slice(0, 200));
  }

  // 2) 로컬 동기화 폴더 — 불가면 서버 폴백(로컬 자원 사용 불가).
  let workspaceDir: string;
  try {
    workspaceDir = await deps.resolveWorkspaceDir(req.workflowId);
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

  // 여기부터 로컬이 이 턴을 소유한다(handled=true). 상태 → 청크 → 끝.
  emit({ kind: 'status', surface: 'connector_local', provider, workspaceDir });

  // CLI 바이너리 경로/격리 홈은 **이 PC 의 것**이 유일하게 유효하다 — 서버가 보낸
  // settings 위에 로컬 설치 경로를 덮어써 codex/claude_code 가 로컬 설치본을 쓴다.
  const localSettings = deps.cliSettings?.() ?? {};
  const mergedContext = {
    ...ctx.context,
    settings: { ...(ctx.context?.settings ?? {}), ...localSettings },
  };

  const startedAt = Date.now();
  let agentText = '';
  let errorDetail = '';
  const toolEvents: Record<string, unknown>[] = [];
  const result = await deps.runner.runTurn(
    {
      workspace_dir: workspaceDir,
      provider,
      text: req.input,
      context: mergedContext,
      server: ctx.server,
      options: {
        ...ctx.agent,
        workflow_id: req.workflowId,
        interaction_id: req.interactionId,
        streaming: true,
      },
    },
    (se: SidecarEvent) => {
      switch (se.type) {
        case 'chunk':
          agentText += se.text;
          emit({ kind: 'text', content: se.text });
          break;
        case 'tool': {
          toolEvents.push(se.data);
          const ev = sidecarToolToChatEvent(se.data);
          if (ev) emit(ev);
          break;
        }
        case 'done':
          if (se.text) agentText = se.text;
          break;
        case 'error':
          errorDetail = se.message;
          emit({ kind: 'error', detail: se.message });
          break;
        default:
          break; // started/canvas_command/meta — 화면 표시 없음
      }
    },
    { signal: deps.signal },
  );

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
