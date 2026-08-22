/**
 * Local-agent IPC glue — 렌더러(커넥터 창의 웹 UI)가 **로컬 실행** 턴을 시작하고
 * 이벤트를 스트리밍으로 받는 통로. 서버 웹처럼 turn 을 서버에서 돌리는 대신,
 * 이 경로는 runConnectorLocalTurn 으로 **사용자 PC** 에서 돌린다(무발산: 같은
 * AgentTurnExecutor). 상태(에이전트/자격증명/메모리/이력)는 서버가 진실이고,
 * ServerClient(HTTP)로 받고 되돌린다.
 *
 * 코어(handleLocalAgentTurn)는 electron 에 의존하지 않는다 — 테스트가 mock deps
 * 로 전 흐름을 검증한다. registerLocalAgentIpc 는 그 코어를 ipcMain 에 얇게 건다.
 */
import { runConnectorLocalTurn } from './local-agent-orchestrator';
import { makeServerClient } from './local-agent-server-client';
import type { NetworkFetch } from './sync-transport';
import { runLocalTurn, type SidecarEvent } from './local-agent-sidecar';

export interface LocalAgentIpcDeps {
  /** 서버 base URL — 세션 중 바뀔 수 있어 getter. */
  serverUrl: () => string;
  /** 라이브 세션 토큰(회전 반영) — getter. */
  token: () => string | Promise<string>;
  /** 사설 인증서 정책이 반영된 주입 fetch. */
  fetch: NetworkFetch;
  /** 이 에이전트의 **로컬 동기화 폴더**(서버와 sync) 절대경로. */
  resolveWorkspaceDir: (workflowId: string) => string | Promise<string>;
  /** 사이드카 실행 — 기본 runLocalTurn, 테스트는 주입. */
  runTurn?: typeof runLocalTurn;
}

/** 렌더러 → 메인: 로컬 턴 시작 요청. */
export interface RunTurnMessage {
  workflowId: string;
  interactionId: string;
  text: string;
}

/** 메인 → 렌더러: 턴 이벤트(스트리밍) 봉투. */
export interface LocalAgentEventEnvelope {
  interactionId: string;
  event: SidecarEvent;
}

/**
 * 로컬 턴 1건 실행 — 서버 context 페치 → 사이드카 → 서버 보고. 이벤트는 emit 로
 * 스트리밍. electron 비의존(테스트 가능). 반환: 최종 텍스트 + 성공 여부.
 */
export async function handleLocalAgentTurn(
  msg: RunTurnMessage,
  deps: LocalAgentIpcDeps,
  emit: (e: SidecarEvent) => void,
): Promise<{ agentText: string; ok: boolean }> {
  const server = makeServerClient({
    serverUrl: deps.serverUrl,
    token: deps.token,
    fetch: deps.fetch,
  });
  const workspaceDir = await deps.resolveWorkspaceDir(msg.workflowId);
  return runConnectorLocalTurn(
    {
      workflowId: msg.workflowId,
      interactionId: msg.interactionId,
      workspaceDir,
      text: msg.text,
    },
    { server, onEvent: emit, runTurn: deps.runTurn },
  );
}

/** ipcMain.handle 와 sender.send 의 최소 표면(테스트가 mock 으로 대체). */
export interface IpcRegistrar {
  handle: (
    channel: string,
    listener: (
      event: { sender: { send: (channel: string, payload: unknown) => void } },
      msg: RunTurnMessage,
    ) => Promise<unknown>,
  ) => void;
  runChannel: string;
  eventChannel: string;
  deps: LocalAgentIpcDeps;
}

/**
 * 로컬 턴 IPC 를 등록한다. 렌더러가 ``runChannel`` 로 invoke 하면 로컬 실행하고,
 * 진행 이벤트를 ``eventChannel`` 로 같은 sender 에 push 한다(interactionId 로 구분).
 */
export function registerLocalAgentIpc(reg: IpcRegistrar): void {
  reg.handle(reg.runChannel, async (event, msg) => {
    const emit = (e: SidecarEvent) => {
      try {
        const envelope: LocalAgentEventEnvelope = { interactionId: msg.interactionId, event: e };
        event.sender.send(reg.eventChannel, envelope);
      } catch {
        /* 렌더러가 사라졌으면 무시 */
      }
    };
    return handleLocalAgentTurn(msg, reg.deps, emit);
  });
}
