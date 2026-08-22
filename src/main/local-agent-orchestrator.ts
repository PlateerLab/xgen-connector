/**
 * Local agent orchestrator — 커넥터-세션 턴을 **로컬 실행**하되 상태는 서버와 공유.
 *
 * 웹이든 커넥터든 에이전트는 **로그인 계정의 것**을 그대로 쓴다. 로컬↔웹의 유일한
 * 차이는 실행 환경뿐 — 나머지(에이전트 설정·자격증명·설정·메모리·이력)는 서버가
 * 진실이고 여기서 그대로 흘려준다. 흐름:
 *
 *   1) 서버에서 이 계정·에이전트의 **turn context**(config/키/설정)를 받는다.
 *   2) 그 context + 로컬 워크스페이스 + 서버 브릿지(메모리 등)로 **사이드카를
 *      스폰**해 서버 웹과 같은 AgentTurnExecutor 를 사용자 PC 에서 돌린다.
 *   3) 출력을 UI 로 스트리밍한다.
 *   4) 턴 결과(대화·기억 반영)를 **서버에 보고**한다 — 모든 정보가 서버에 정확히
 *      저장되도록(웹에서 이어서 봐도 동일). 파일은 커넥터 동기화 엔진이 sync.
 *
 * 서버 통신은 ``ServerClient`` 로 추상화 — 실제 HTTP/인증 구현은 커넥터가 주입.
 */
import { runLocalTurn, type LocalTurnRequest, type SidecarEvent } from './local-agent-sidecar';

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
}

/** 커넥터가 주입하는 서버 클라이언트(인증된 HTTP). */
export interface ServerClient {
  /** 이 계정·에이전트의 turn context 를 서버에서 해석해 받는다. */
  fetchLocalTurnContext(workflowId: string, interactionId: string): Promise<LocalTurnContext>;
  /** 턴 결과를 서버에 보고 — 대화/기억이 서버에 저장되어 웹과 공유된다. */
  reportTurnResult(
    workflowId: string,
    interactionId: string,
    result: { userText: string; agentText: string },
  ): Promise<void>;
}

export interface ConnectorLocalTurnInput {
  workflowId: string;
  interactionId: string;
  workspaceDir: string; // 로컬 동기화 폴더(서버와 sync)
  text: string;
}

export interface OrchestratorDeps {
  server: ServerClient;
  onEvent: (e: SidecarEvent) => void;
  /** 사이드카 실행 — 기본은 실제 runLocalTurn, 테스트는 주입. */
  runTurn?: typeof runLocalTurn;
}

/**
 * 커넥터-세션 턴을 로컬 실행하고 결과를 서버에 반영한다.
 * 실패는 error 이벤트로 승격(커넥터 무매달림). 반환: 최종 agent 텍스트.
 */
export async function runConnectorLocalTurn(
  input: ConnectorLocalTurnInput,
  deps: OrchestratorDeps,
): Promise<{ agentText: string; ok: boolean }> {
  const runTurn = deps.runTurn ?? runLocalTurn;

  // 1) 서버에서 계정·에이전트 context 를 받는다(웹과 같은 것을 쓰기 위해).
  let ctx: LocalTurnContext;
  try {
    ctx = await deps.server.fetchLocalTurnContext(input.workflowId, input.interactionId);
  } catch (err) {
    deps.onEvent({ type: 'error', message: `서버 컨텍스트 조회 실패: ${(err as Error).message}` });
    return { agentText: '', ok: false };
  }

  // 2) 사이드카 요청 — 서버 해석 상태 + 로컬 워크스페이스 + 서버 브릿지.
  const provider = String((ctx.agent.provider as string) || 'openai');
  const request: LocalTurnRequest = {
    workspace_dir: input.workspaceDir,
    provider,
    text: input.text,
    context: ctx.context,
    server: ctx.server,
    // 저장된 에이전트 설정을 run() kwargs 로(+ 실행 식별자). 서버 저장 값 우선.
    options: {
      ...ctx.agent,
      workflow_id: input.workflowId,
      interaction_id: input.interactionId,
      streaming: true,
    },
  };

  // 3) 로컬 실행 + UI 스트리밍. 최종 텍스트 수집.
  let agentText = '';
  let sawError = false;
  await runTurn(request, (e) => {
    if (e.type === 'chunk') agentText += e.text;
    else if (e.type === 'done') agentText = e.text || agentText;
    else if (e.type === 'error') sawError = true;
    deps.onEvent(e);
  });

  // 4) 결과를 서버에 보고 — 대화/기억이 서버에 저장(웹과 공유). 파일은 동기화 엔진.
  if (!sawError) {
    try {
      await deps.server.reportTurnResult(input.workflowId, input.interactionId, {
        userText: input.text,
        agentText,
      });
    } catch (err) {
      // 보고 실패는 치명은 아니지만(턴은 이미 났다) 알린다 — 서버 상태가 뒤처진다.
      deps.onEvent({
        type: 'error',
        message: `턴 결과 서버 보고 실패(로컬은 완료): ${(err as Error).message}`,
      });
    }
  }

  return { agentText, ok: !sawError };
}
