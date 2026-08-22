/**
 * Local agent sidecar runner — 커넥터가 에이전트 턴을 **사용자 PC 에서** 돌린다.
 *
 * 서버 웹은 turn 을 서버에서 실행하지만(agent_geny → AgentTurnExecutor +
 * ServerHostServices), 커넥터 세션은 이 모듈이 **Python 사이드카**
 * (`xgen_agent_runtime.host.sidecar`)를 로컬 프로세스로 스폰해 **같은 AgentTurnExecutor**
 * 를 `LocalHostServices` 로 돌린다(무발산). 그러면 Bash/Read/Write 는 이 PC 에서
 * 직접 돌고, codex/claude_code 는 로컬 프로세스로 뜬다 — 서버로 tool 을 되돌려
 * 라우팅할 필요가 없다(그게 codex-local 이 서버에선 불가하고 여기선 되는 이유).
 *
 * 계약(사이드카와 공유): 요청 JSON 을 stdin 으로, 이벤트를 stdout JSON-lines 로.
 *   → { type:'chunk', text } | { type:'done', text } | { type:'error', message }
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

/** 사이드카에 보내는 turn 요청 (Python 계약과 동일 shape). 상태는 서버가 해석. */
export interface LocalTurnRequest {
  workspace_dir: string;
  provider: string;
  text: string;
  /** 서버가 로그인 계정으로 해석해 넘긴 상태(키/설정/자격증명). */
  context?: {
    api_keys?: Record<string, string>;
    base_urls?: Record<string, string>;
    credentials?: Record<string, unknown>;
    settings?: Record<string, string>;
  };
  /** 라이브 서버 브릿지(메모리 등 공유 상태). */
  server?: { url: string; token: string };
  options?: Record<string, unknown>;
}

/** 사이드카가 stdout 으로 흘리는 이벤트. */
export type SidecarEvent =
  | { type: 'chunk'; text: string }
  | { type: 'done'; text: string }
  | { type: 'error'; message: string };

/** 사이드카 실행 명령 — 번들 Python vs dev. 테스트/오버라이드용으로 주입 가능. */
export interface SidecarCommand {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Python 인터프리터 + 사이드카 엔트리를 해석한다.
 *   · 패키지 빌드: 번들된 Python(resources/python) + `-m xgen_agent_runtime.host.sidecar`.
 *   · dev / override: env(XGEN_SIDECAR_PYTHON / XGEN_SIDECAR_PYTHONPATH).
 * 실제 번들링(extraResources)은 커넥터 빌드 설정의 몫 — 여기선 경로만 조립한다.
 */
export function resolveSidecarCommand(opts?: {
  isPackaged?: boolean;
  resourcesPath?: string;
  env?: NodeJS.ProcessEnv;
}): SidecarCommand {
  const env = { ...(opts?.env ?? process.env) };
  const py = env.XGEN_SIDECAR_PYTHON;
  const pyPath = env.XGEN_SIDECAR_PYTHONPATH;
  if (py) {
    if (pyPath) env.PYTHONPATH = pyPath;
    return { command: py, args: ['-m', 'xgen_agent_runtime.host.sidecar'], env };
  }
  if (opts?.isPackaged && opts.resourcesPath) {
    // 번들 레이아웃: <resources>/python/bin/python3 (POSIX) | python.exe (win),
    // 패키지는 그 site-packages 에. 세부는 빌드 설정에서 확정.
    const isWin = process.platform === 'win32';
    const bin = isWin ? 'python\\python.exe' : 'python/bin/python3';
    return {
      command: `${opts.resourcesPath}/${bin}`,
      args: ['-m', 'xgen_agent_runtime.host.sidecar'],
      env,
    };
  }
  // 최후 폴백: 시스템 python3 (dev — 패키지가 import 가능해야 함).
  return { command: 'python3', args: ['-m', 'xgen_agent_runtime.host.sidecar'], env };
}

/**
 * 로컬 턴 실행 — 사이드카를 스폰하고 이벤트를 콜백으로 흘린다. 프로세스 종료
 * (또는 파싱 불가/스폰 실패)까지 대기하는 Promise. 사이드카가 조용히 죽으면
 * error 이벤트를 합성해 커넥터가 매달리지 않게 한다.
 */
export function runLocalTurn(
  request: LocalTurnRequest,
  onEvent: (e: SidecarEvent) => void,
  opts?: { command?: SidecarCommand; signal?: AbortSignal },
): Promise<{ code: number | null }> {
  const cmd =
    opts?.command ??
    resolveSidecarCommand({
      // 지연 require 로 electron 미존재 환경(테스트)에서도 로드된다.
      ...(() => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { app } = require('electron');
          return { isPackaged: !!app?.isPackaged, resourcesPath: process.resourcesPath };
        } catch {
          return {};
        }
      })(),
    });

  return new Promise((resolve) => {
    let child: ChildProcess;
    let emittedTerminal = false;
    const emit = (e: SidecarEvent) => {
      if (e.type === 'done' || e.type === 'error') emittedTerminal = true;
      onEvent(e);
    };
    try {
      child = spawn(cmd.command, cmd.args, { env: cmd.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      emit({ type: 'error', message: `사이드카 스폰 실패: ${(err as Error).message}` });
      resolve({ code: null });
      return;
    }

    opts?.signal?.addEventListener('abort', () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    });

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      const s = line.trim();
      if (!s) return;
      try {
        const e = JSON.parse(s) as SidecarEvent;
        if (e && typeof e.type === 'string') emit(e);
      } catch {
        // 사이드카가 JSON 아닌 줄을 뱉으면(경고 등) 무시한다.
      }
    });

    let stderr = '';
    child.stderr?.on('data', (d) => {
      stderr += String(d);
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });

    child.on('error', (err) => {
      emit({ type: 'error', message: `사이드카 오류: ${err.message}` });
    });
    child.on('close', (code) => {
      if (!emittedTerminal) {
        emit({
          type: 'error',
          message: `사이드카가 결과 없이 종료(code=${code}). ${stderr.slice(-500)}`,
        });
      }
      resolve({ code });
    });

    // 요청을 stdin 으로 밀어넣고 닫는다(사이드카는 stdin EOF 로 요청 완료를 안다).
    try {
      child.stdin!.write(JSON.stringify(request));
      child.stdin!.end();
    } catch (err) {
      emit({ type: 'error', message: `요청 전송 실패: ${(err as Error).message}` });
    }
  });
}
