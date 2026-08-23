/**
 * Local agent sidecar — 커넥터가 에이전트 턴을 **사용자 PC 에서** 돌린다 (v2: 상주 데몬).
 *
 * 서버 웹은 turn 을 서버에서 실행하지만(agent_geny → AgentTurnExecutor +
 * ServerHostServices), 커넥터 세션은 이 모듈이 **Python 사이드카**
 * (`xgen_agent_runtime.host.sidecar`)를 로컬 프로세스로 띄워 **같은 AgentTurnExecutor**
 * 를 `LocalHostServices` 로 돌린다(무발산). 그러면 Bash/Read/Write 는 이 PC 에서
 * 직접 돌고, codex/claude_code 는 로컬 프로세스로 뜬다 — 서버로 tool 을 되돌려
 * 라우팅할 필요가 없다(mcp_local_* 브릿지 불필요).
 *
 * v2 (런타임 3.7.0, 프로토콜 2):
 *   · **상주 데몬** — `python -m xgen_agent_runtime.host.sidecar --serve` 한 프로세스가
 *     살아 있고, 턴마다 stdin JSON-lines 명령을 보낸다(턴마다 Python 을 새로 띄우지
 *     않아 첫 토큰 지연이 사라진다). 유휴 15분이면 스스로 내린다.
 *   · **구조화 이벤트** — chunk 외에 tool(도구 활동; 웹과 같은 shape)·canvas_command·
 *     started·cancelled. v1 은 dict 를 텍스트로 강등해 화면에 파이썬 dict 가 찍혔다.
 *   · **취소** — `cancel` 명령(협조 취소). AbortSignal → cancel → 제한시간 내 종료 안
 *     되면 데몬을 내린다(다음 턴에 재기동).
 *
 * 계약(사이드카와 공유): 명령 {id, op:'turn'|'cancel'|'ping'|'shutdown', ...} →
 * 이벤트 {id, type:'ready'|'pong'|'started'|'chunk'|'tool'|'canvas_command'|'meta'|
 * 'done'|'error'|'cancelled', ...}.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
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
  | {
      type: 'ready' | 'pong';
      pid?: number;
      protocol?: number;
      runtime_version?: string;
      python?: string;
    }
  | { type: 'started'; pid?: number; surface?: string; provider?: string; workspace_dir?: string }
  | { type: 'chunk'; text: string }
  | { type: 'tool'; data: Record<string, unknown> }
  | { type: 'canvas_command'; data: unknown }
  | { type: 'meta'; data: unknown }
  | { type: 'done'; text: string }
  | { type: 'error'; message: string }
  | { type: 'cancelled' };

export type SidecarTerminal = 'done' | 'error' | 'cancelled';

/** 사이드카 실행 명령 — 번들 Python vs dev. 테스트/오버라이드용으로 주입 가능. */
export interface SidecarCommand {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Python 인터프리터 + 사이드카 엔트리를 해석한다.
 *   · 설치 폴더의 독립 런타임(<dataRoot>/local-runtime/python) — 표준 경로.
 *   · dev / override: env(XGEN_SIDECAR_PYTHON / XGEN_SIDECAR_PYTHONPATH).
 *   · 패키지 빌드 내장 번들(<resources>/python) — 안전망.
 * 실제 번들링(extraResources)은 커넥터 빌드 설정의 몫 — 여기선 경로만 조립한다.
 */
export function resolveSidecarCommand(opts?: {
  isPackaged?: boolean;
  resourcesPath?: string;
  env?: NodeJS.ProcessEnv;
  /** 설치 폴더의 독립 로컬 런타임 python. 있으면 최우선(표준 경로). */
  localRuntimePython?: string;
  /** 데몬 모드(--serve). 기본 false(원샷, v1 호환). */
  serve?: boolean;
  /** PATH 앞에 붙일 디렉터리(설치 폴더의 CLI bin 등). */
  prependPath?: string[];
}): SidecarCommand {
  const env = { ...(opts?.env ?? process.env) };
  // Python 측 stdout 은 프로토콜 채널 — 인코딩/버퍼링을 못 박는다(Windows cp949 방지).
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONUNBUFFERED = '1';
  if (opts?.prependPath?.length) {
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    env[key] = [...opts.prependPath, env[key] ?? ''].filter(Boolean).join(delimiter);
  }
  const args = ['-m', 'xgen_agent_runtime.host.sidecar', ...(opts?.serve ? ['--serve'] : [])];
  const py = env.XGEN_SIDECAR_PYTHON;
  const pyPath = env.XGEN_SIDECAR_PYTHONPATH;
  if (py) {
    // 명시 env override(dev) — 최우선.
    if (pyPath) env.PYTHONPATH = pyPath;
    return { command: py, args, env };
  }
  if (opts?.localRuntimePython) {
    // 설치 폴더의 독립 런타임 — 커넥터의 표준 경로.
    return { command: opts.localRuntimePython, args, env };
  }
  if (opts?.isPackaged && opts.resourcesPath) {
    // 번들 레이아웃: <resources>/python/bin/python3 (POSIX) | python.exe (win).
    const isWin = process.platform === 'win32';
    const bin = isWin ? join('python', 'python.exe') : join('python', 'bin', 'python3');
    return { command: join(opts.resourcesPath, bin), args, env };
  }
  // 최후 폴백: 시스템 python3 (dev — 패키지가 import 가능해야 함).
  return { command: 'python3', args, env };
}

/** 기본 명령 해석 — electron/설치 폴더 컨텍스트에서 표준 경로를 고른다(테스트 환경 안전). */
export function defaultSidecarCommand(serve: boolean, pythonOverride?: string): SidecarCommand {
  let localRuntimePython: string | undefined = pythonOverride;
  let resourcesPath: string | undefined;
  let isPackaged = false;
  const prependPath: string[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { pythonExePath } = require('./local-runtime-install');
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { loadConfig } = require('./config');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { resolveDataRoot, runtimeDirOf } = require('./data-root');
      const runtimeDir = runtimeDirOf(resolveDataRoot(loadConfig()));
      const modern = pythonExePath(runtimeDir);
      if (!localRuntimePython && existsSync(modern)) localRuntimePython = modern;
      prependPath.push(join(runtimeDir, 'bin'));
    } catch {
      /* config 미가용(테스트) */
    }
    if (!localRuntimePython) {
      const legacy = pythonExePath(join(app.getPath('userData'), 'local-runtime'));
      if (existsSync(legacy)) localRuntimePython = legacy;
    }
    // 내장 번들이 실제로 있을 때만 packaged 경로를 쓴다(빈 번들이면 시스템 폴백).
    const bin =
      process.platform === 'win32'
        ? join(process.resourcesPath ?? '', 'python', 'python.exe')
        : join(process.resourcesPath ?? '', 'python', 'bin', 'python3');
    isPackaged = !!app?.isPackaged && !!process.resourcesPath && existsSync(bin);
    resourcesPath = process.resourcesPath;
  } catch {
    /* electron 부재(테스트) */
  }
  return resolveSidecarCommand({
    isPackaged,
    resourcesPath,
    localRuntimePython,
    serve,
    prependPath,
  });
}

// ── 상주 데몬 ────────────────────────────────────────────────────────

export interface SidecarDaemonStatus {
  running: boolean;
  pid?: number;
  protocol?: number;
  runtimeVersion?: string;
  python?: string;
  activeTurns: number;
  lastError?: string;
  startedAt?: number;
}

export interface SidecarDaemonOptions {
  /** 스폰 명령(지연 해석 — 설치 폴더 변화 반영). */
  command: () => SidecarCommand;
  /** 유휴(활성 턴 0) 이 시간 뒤 데몬을 내린다. 기본 15분. 0 = 안 내림. */
  idleMs?: number;
  /** ready 대기 상한. 기본 90초(대형 import 의 콜드 기동). */
  readyTimeoutMs?: number;
  /** 취소 후 종료 대기 상한. 기본 10초. */
  cancelGraceMs?: number;
  log?: (message: string) => void;
}

interface PendingTurn {
  onEvent: (e: SidecarEvent) => void;
  resolve: (r: { terminal: SidecarTerminal }) => void;
  terminal?: SidecarTerminal;
}

/**
 * 사이드카 데몬 클라이언트 — 한 프로세스를 띄워 두고 턴을 다중화한다. 죽으면
 * 다음 턴에 다시 띄운다(대기 중 턴은 error 로 끝난다 — 매달리지 않게).
 */
export class SidecarDaemon {
  private child: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<string, PendingTurn>();
  private pongWaiters: Array<(e: SidecarEvent) => void> = [];
  private seq = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stderrTail = '';
  private info: Omit<SidecarDaemonStatus, 'running' | 'activeTurns'> = {};

  constructor(private opts: SidecarDaemonOptions) {}

  status(): SidecarDaemonStatus {
    return { running: !!this.child, activeTurns: this.pending.size, ...this.info };
  }

  /** 데몬을 띄우고 ready 까지 기다린다(이미 떠 있으면 즉시). */
  ensure(): Promise<void> {
    if (this.child && this.ready) return this.ready;
    const cmd = this.opts.command();
    let child: ChildProcess;
    try {
      child = spawn(cmd.command, cmd.args, { env: cmd.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      const msg = `사이드카 스폰 실패: ${(err as Error).message}`;
      this.info.lastError = msg;
      return Promise.reject(new Error(msg));
    }
    this.child = child;
    this.stderrTail = '';
    this.info = { startedAt: Date.now() };
    this.opts.log?.(`spawn ${cmd.command} ${cmd.args.join(' ')} (pid ${child.pid})`);

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => this.onLine(line));
    child.stderr?.on('data', (d) => {
      this.stderrTail += String(d);
      if (this.stderrTail.length > 8192) this.stderrTail = this.stderrTail.slice(-8192);
    });
    const ready = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        reject(
          new Error(
            `사이드카 ready 시간 초과(${this.opts.readyTimeoutMs ?? 90_000}ms). ${this.stderrTail.slice(-400)}`,
          ),
        );
        this.kill();
      }, this.opts.readyTimeoutMs ?? 90_000);
      t.unref?.();
      this.readyResolve = () => {
        clearTimeout(t);
        resolve();
      };
      this.readyReject = (e: Error) => {
        clearTimeout(t);
        reject(e);
      };
    });
    this.ready = ready;
    child.on('error', (err) => {
      this.info.lastError = `사이드카 오류: ${err.message}`;
      this.readyReject?.(new Error(this.info.lastError));
      this.failAll(`사이드카 오류: ${err.message}`);
    });
    child.on('close', (code) => {
      this.opts.log?.(`exit code=${code} ${this.stderrTail.slice(-200)}`);
      const tail = this.stderrTail.slice(-500);
      this.child = null;
      this.ready = null;
      this.readyReject?.(new Error(`사이드카가 기동 중 종료(code=${code}). ${tail}`));
      this.failAll(`사이드카가 결과 없이 종료(code=${code}). ${tail}`);
      this.clearIdle();
    });
    return ready;
  }

  private readyResolve: (() => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;

  private onLine(line: string): void {
    const s = line.trim();
    if (!s) return;
    let e: (SidecarEvent & { id?: string }) | null = null;
    try {
      e = JSON.parse(s) as SidecarEvent & { id?: string };
    } catch {
      return; // 사이드카가 JSON 아닌 줄을 뱉으면(경고 등) 무시한다.
    }
    if (!e || typeof e.type !== 'string') return;
    if (e.type === 'ready') {
      this.info = {
        ...this.info,
        pid: e.pid,
        protocol: e.protocol,
        runtimeVersion: e.runtime_version,
        python: e.python,
      };
      this.readyResolve?.();
      this.armIdle();
      return;
    }
    if (e.type === 'pong') {
      this.info = {
        ...this.info,
        protocol: e.protocol,
        runtimeVersion: e.runtime_version,
        python: e.python,
      };
      const w = this.pongWaiters.shift();
      w?.(e);
      return;
    }
    const id = e.id ?? '';
    const p = this.pending.get(id);
    if (!p) return;
    const { id: _drop, ...ev } = e;
    void _drop;
    if (ev.type === 'done' || ev.type === 'error' || ev.type === 'cancelled') {
      p.terminal = ev.type;
      p.onEvent(ev as SidecarEvent);
      this.pending.delete(id);
      p.resolve({ terminal: ev.type });
      this.armIdle();
      return;
    }
    p.onEvent(ev as SidecarEvent);
  }

  private send(obj: Record<string, unknown>): boolean {
    if (!this.child?.stdin || this.child.stdin.destroyed) return false;
    try {
      this.child.stdin.write(JSON.stringify(obj) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  private failAll(message: string): void {
    for (const [id, p] of [...this.pending]) {
      this.pending.delete(id);
      if (p.terminal) continue;
      p.terminal = 'error';
      p.onEvent({ type: 'error', message });
      p.resolve({ terminal: 'error' });
    }
    for (const w of this.pongWaiters.splice(0)) w({ type: 'pong' });
  }

  private armIdle(): void {
    this.clearIdle();
    const ms = this.opts.idleMs ?? 15 * 60_000;
    if (ms <= 0 || this.pending.size > 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0) {
        this.opts.log?.('idle — shutdown');
        this.shutdown();
      }
    }, ms);
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** 살아 있으면 pong(런타임 버전 등), 아니면 null. 띄우지는 않는다. */
  async ping(timeoutMs = 5000): Promise<SidecarEvent | null> {
    if (!this.child) return null;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        const i = this.pongWaiters.indexOf(w);
        if (i >= 0) this.pongWaiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      t.unref?.();
      const w = (e: SidecarEvent) => {
        clearTimeout(t);
        resolve(e);
      };
      this.pongWaiters.push(w);
      if (!this.send({ op: 'ping' })) {
        clearTimeout(t);
        this.pongWaiters.pop();
        resolve(null);
      }
    });
  }

  /**
   * 턴 1건 — 데몬이 없으면 띄운다. 이벤트는 콜백으로, 종료(done/error/cancelled)까지
   * 대기하는 Promise. AbortSignal → cancel 명령(협조 취소) → 유예 후 강제 종료.
   */
  async runTurn(
    request: LocalTurnRequest,
    onEvent: (e: SidecarEvent) => void,
    opts?: { signal?: AbortSignal },
  ): Promise<{ terminal: SidecarTerminal }> {
    try {
      await this.ensure();
    } catch (err) {
      onEvent({ type: 'error', message: (err as Error).message });
      return { terminal: 'error' };
    }
    const id = `t${++this.seq}-${Date.now().toString(36)}`;
    this.clearIdle();
    return new Promise((resolve) => {
      const entry: PendingTurn = { onEvent, resolve };
      this.pending.set(id, entry);
      const onAbort = () => {
        if (entry.terminal) return;
        this.send({ op: 'cancel', id });
        const grace = setTimeout(() => {
          if (!entry.terminal) {
            // 협조 취소가 안 먹었다 — 데몬을 내려 확실히 멈춘다(다음 턴에 재기동).
            this.opts.log?.('cancel grace exceeded — kill daemon');
            this.kill();
          }
        }, this.opts.cancelGraceMs ?? 10_000);
        grace.unref?.();
      };
      if (opts?.signal?.aborted) {
        onAbort();
      } else {
        opts?.signal?.addEventListener('abort', onAbort, { once: true });
      }
      if (!this.send({ id, op: 'turn', ...request })) {
        this.pending.delete(id);
        onEvent({ type: 'error', message: '요청 전송 실패(사이드카 stdin 닫힘)' });
        resolve({ terminal: 'error' });
      }
    });
  }

  /** 정상 종료 요청(shutdown) 후 잠시 기다렸다가 kill. */
  shutdown(): void {
    if (!this.child) return;
    this.send({ op: 'shutdown' });
    try {
      this.child.stdin?.end();
    } catch {
      /* ignore */
    }
    const c = this.child;
    const t = setTimeout(() => {
      try {
        c.kill();
      } catch {
        /* gone */
      }
    }, 3000);
    t.unref?.();
  }

  /** 즉시 강제 종료. */
  kill(): void {
    const c = this.child;
    if (!c) return;
    try {
      c.kill();
    } catch {
      /* already gone */
    }
  }
}

// ── 원샷(v1 호환) ─────────────────────────────────────────────────────

/**
 * 로컬 턴 실행(원샷) — 사이드카를 스폰하고 이벤트를 콜백으로 흘린다. 프로세스 종료
 * (또는 파싱 불가/스폰 실패)까지 대기하는 Promise. 사이드카가 조용히 죽으면
 * error 이벤트를 합성해 커넥터가 매달리지 않게 한다. (데몬이 표준; 이건 진단/테스트용.)
 */
export function runLocalTurn(
  request: LocalTurnRequest,
  onEvent: (e: SidecarEvent) => void,
  opts?: { command?: SidecarCommand; signal?: AbortSignal },
): Promise<{ code: number | null }> {
  const cmd = opts?.command ?? defaultSidecarCommand(false);

  return new Promise((resolve) => {
    let child: ChildProcess;
    let emittedTerminal = false;
    const emit = (e: SidecarEvent) => {
      if (e.type === 'done' || e.type === 'error' || e.type === 'cancelled') emittedTerminal = true;
      onEvent(e);
    };
    try {
      child = spawn(cmd.command, cmd.args, { env: cmd.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      emit({ type: 'error', message: `사이드카 스폰 실패: ${(err as Error).message}` });
      resolve({ code: null });
      return;
    }

    let aborted = false;
    opts?.signal?.addEventListener('abort', () => {
      aborted = true;
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
        if (aborted) emit({ type: 'cancelled' });
        else
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
