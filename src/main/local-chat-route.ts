/**
 * local-chat-route — 커넥터 채팅 턴을 **로컬 실행으로 라우팅**하고, 안 되면 서버로
 * 조용히 폴백한다. 이것이 로컬 실행의 "켜는 스위치"다.
 *
 * 동작(사용자 비전): 커넥터에서 에이전트가 그냥 shell/파일을 쓰면 **이 PC 의
 * 자원**에서 돈다 — 서버로 되돌리는 mcp__connector__mcp_local_Shell 없이, 모든
 * provider 에서. 상태(에이전트 설정·자격증명·메모리·이력)는 서버가 진실이고
 * 그대로 쓴다(무발산).
 *
 * 폴백 규칙(사용자 요구: "로컬 sync/자원 불가면 서버 자원을 쓰되 제대로"):
 *   · 독립 로컬 런타임 미설치        → 서버
 *   · 문자열 입력이 아님(복합 워크플로) → 서버
 *   · 서버가 로컬-턴 엔드포인트 미지원  → 서버 (context 페치 실패 = 조용히 폴백)
 *   · 로컬 워크스페이스 동기화 불가     → 서버
 * 위 어느 것이든 **아직 렌더러에 아무것도 안 보낸 상태**에서 handled=false 를
 * 돌려주면, 호출부(chatStart)가 기존 서버 스트림으로 이어간다(무회귀).
 * 일단 로컬 청크가 흐르기 시작하면 로컬이 그 턴을 끝까지 소유한다.
 */
import type { ChatEvent, ChatRequest } from '../core/types';
import type { ServerClient } from './local-agent-orchestrator';
import { makeServerClient } from './local-agent-server-client';
import { runLocalTurn, type SidecarEvent } from './local-agent-sidecar';
import type { NetworkFetch } from './sync-transport';

export interface LocalChatDeps {
  serverUrl: () => string;
  token: () => string | Promise<string>;
  fetch: NetworkFetch;
  /** 이 에이전트의 로컬 동기화 폴더(서버와 sync). 불가면 throw → 서버 폴백. */
  resolveWorkspaceDir: (workflowId: string) => Promise<string>;
  /** 독립 로컬 런타임이 설치돼 있나(설치 버튼/내장 번들). */
  runtimeInstalled: () => Promise<boolean>;
  /** 이 PC 에 설치된 CLI 경로 settings(CODEX_BINARY_PATH 등) — 사이드카 주입. */
  cliSettings?: () => Record<string, string>;
  /** CLI provider 턴 직전 바이너리 보장(없으면 자동 설치). false = 준비 실패. */
  ensureCli?: (tool: 'codex' | 'claude') => Promise<boolean>;
  /** 테스트 주입. */
  server?: ServerClient;
  runTurn?: typeof runLocalTurn;
  signal?: AbortSignal;
}

/** 커넥터 로컬 턴 1건 시도. handled=false 면 호출부가 서버로 폴백. */
export async function runLocalChatTurn(
  req: ChatRequest,
  deps: LocalChatDeps,
  emit: (e: ChatEvent) => void,
): Promise<{ handled: boolean }> {
  // 복합 입력(객체/배열)은 로컬 단일-에이전트 경로 밖 → 서버.
  if (typeof req.input !== 'string' || !req.input.trim()) return { handled: false };
  if (!(await deps.runtimeInstalled())) return { handled: false };

  const server =
    deps.server ??
    makeServerClient({ serverUrl: deps.serverUrl, token: deps.token, fetch: deps.fetch });

  // 1) 서버 turn context — 실패하면 아무것도 안 보낸 채 서버 폴백.
  //    (서버가 develop 의 local-turn-context 엔드포인트를 아직 안 가진 경우 등)
  let ctx;
  try {
    ctx = await server.fetchLocalTurnContext(req.workflowId, req.interactionId);
  } catch {
    return { handled: false };
  }

  // 2) 로컬 동기화 폴더 — 불가면 서버 폴백(로컬 자원 사용 불가).
  let workspaceDir: string;
  try {
    workspaceDir = await deps.resolveWorkspaceDir(req.workflowId);
  } catch {
    return { handled: false };
  }

  // 여기부터 로컬이 이 턴을 소유한다(handled=true). 청크를 흘리며 실행.
  const runTurn = deps.runTurn ?? runLocalTurn;
  const provider = String((ctx.agent.provider as string) || 'openai');
  let agentText = '';
  let sawError = false;
  // CLI provider 는 바이너리가 있어야 로컬 실행이 된다 — 없으면 **여기서 자동
  // 설치**한다(부팅 자동 프로비저닝과 동형; 아직 아무것도 emit 안 한 시점이라
  // 실패하면 깨끗이 서버로 폴백된다).
  const cliTool = provider === 'codex' ? 'codex' : provider === 'claude_code' ? 'claude' : null;
  if (cliTool && deps.ensureCli) {
    const ready = await deps.ensureCli(cliTool).catch(() => false);
    if (!ready) return { handled: false };
  }

  // CLI 바이너리 경로는 **이 PC 의 것**이 유일하게 유효하다 — 서버가 보낸
  // settings 위에 로컬 설치 경로를 덮어써 codex/claude_code 가 로컬 설치본을 쓴다.
  const localSettings = deps.cliSettings?.() ?? {};
  const mergedContext = {
    ...ctx.context,
    settings: { ...(ctx.context?.settings ?? {}), ...localSettings },
  };
  await runTurn(
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
      if (se.type === 'chunk') {
        agentText += se.text;
        emit({ kind: 'text', content: se.text });
      } else if (se.type === 'done') {
        if (se.text) agentText = se.text;
      } else if (se.type === 'error') {
        sawError = true;
        emit({ kind: 'error', detail: se.message });
      }
    },
    { signal: deps.signal },
  );

  // 3) 결과를 서버에 보고 — 대화/기억이 서버에 저장(웹과 공유). 실패해도 턴 완료.
  if (!sawError) {
    try {
      await server.reportTurnResult(req.workflowId, req.interactionId, {
        userText: req.input,
        agentText,
      });
    } catch {
      /* 보고 실패 — 로컬 턴은 이미 났다. 다음 sync/조회로 따라잡는다. */
    }
  }
  emit({ kind: 'end' });
  return { handled: true };
}
