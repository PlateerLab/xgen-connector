/**
 * local-cli-auth — 이 PC 의 Claude Code / Codex CLI **로그인**(구독 인증) 관리.
 *
 * XGEN 관리자 LLM 탭의 로그인과 같은 흐름을 커넥터 안에서 제공한다. 자격증명은 설치 폴더의
 * **격리 홈**(local-runtime/claude-home, codex-home)에만 남는다 — 사용자의 개인 ~/.claude,
 * ~/.codex 를 건드리지 않고, 로컬 턴(사이드카)이 같은 홈을 CLAUDE_CONFIG_DIR / CODEX_HOME 으로 쓴다.
 *
 *   Claude Code : `claude auth login --claudeai`  (파이프로 동작; URL 출력 → 브라우저에서 승인 →
 *                 표시된 코드를 stdin 으로)   · 상태 `claude auth status`(JSON) · `claude auth logout`
 *   Codex       : `codex login --device-auth`     (파이프로 동작; URL + 일회용 코드 출력 → 브라우저에서
 *                 코드 입력 → CLI 가 폴링해 완료) · 상태 `codex login status` · `codex logout`
 *
 * 우선순위(로컬 턴 settings): **이 PC 로그인 > 서버가 준 설정(중앙 자격증명/API 키)**. 로그인이
 * 있으면 CLAUDE_CODE_AUTH_MODE=oauth / CODEX_AUTH_MODE=oauth 로 덮고, 서버 중앙 자격증명
 * (CLAUDE_CODE_OAUTH_TOKEN / CODEX_CREDENTIALS_JSON)은 제거한다(사이드카가 격리 홈의 로그인을
 * 덮어쓰지 않게). 둘 다 없으면 로컬 CLI 턴은 **서버로 폴백**한다(cli_auth_missing).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { CliTool } from './cli-provision';

export interface CliAuthStatus {
  tool: CliTool;
  installed: boolean;
  /** 이 PC 격리 홈에 로그인돼 있나. */
  loggedIn: boolean;
  /** 'chatgpt' | 'claudeai' | 'api_key' | null */
  method?: string | null;
  email?: string | null;
  detail?: string;
  /** 조회 시각(캐시). */
  checkedAt: number;
}

export type CliAuthEvent =
  | { channel: 'stdout'; text: string }
  | { channel: 'url'; text: string }
  | { channel: 'code'; text: string } // codex 일회용 코드 (브라우저에 입력)
  | { channel: 'prompt'; text: string } // claude: 코드 붙여넣기 대기
  | { channel: 'success'; text: string }
  | { channel: 'error'; text: string }
  | { channel: 'exit'; text: string };

export interface CliAuthDeps {
  /** 도구 실행파일 경로(설치 폴더 bin). 없으면 null. */
  binaryPath: (tool: CliTool) => string | null;
  /** 격리 홈(설치 폴더 아래). */
  homeDir: (tool: CliTool) => string;
  /** 추가 PATH 앞항목(설치 폴더 bin 등). */
  prependPath?: string[];
  log?: (m: string) => void;
  /** 테스트 주입: 스폰 명령 치환. */
  commandFor?: (tool: CliTool, argv: string[]) => { command: string; args: string[] };
}

const URL_RE = /https?:\/\/[^\s"')\]<>`]+/g;
const CODEX_CODE_RE = /\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/;
const ANSI_RE =
  /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
const LOGIN_TIMEOUT_MS = 15 * 60_000;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

interface Job {
  id: string;
  tool: CliTool;
  child: ChildProcess;
  history: CliAuthEvent[];
  listeners: Set<(e: CliAuthEvent) => void>;
  done: boolean;
  accum: string;
  urls: Set<string>;
  code?: string;
  success: boolean;
  cancelled?: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export class LocalCliAuth {
  private jobs = new Map<string, Job>();
  private seq = 0;
  private statusCache = new Map<CliTool, CliAuthStatus>();

  constructor(private deps: CliAuthDeps) {}

  private env(tool: CliTool): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    const bin = this.deps.binaryPath(tool);
    const pre = [...(this.deps.prependPath ?? []), ...(bin ? [dirname(bin)] : [])];
    if (pre.length) env[key] = [...pre, env[key] ?? ''].filter(Boolean).join(delimiter);
    const home = this.deps.homeDir(tool);
    if (tool === 'codex') env.CODEX_HOME = home;
    else env.CLAUDE_CONFIG_DIR = home;
    // CLI 자체 자동 업데이트/텔레메트리 배너 억제 — 버전은 커넥터가 관리
    env.DISABLE_AUTOUPDATER = '1';
    env.CODEX_DISABLE_UPDATE_CHECK = '1';
    env.NO_COLOR = '1';
    env.FORCE_COLOR = '0';
    delete env.ANTHROPIC_API_KEY; // 로그인 상태 조회가 API 키를 '로그인됨'으로 오인하지 않게
    delete env.OPENAI_API_KEY;
    return env;
  }

  private spawnTool(tool: CliTool, argv: string[]): { child: ChildProcess } | { error: string } {
    const bin = this.deps.binaryPath(tool);
    if (!bin && !this.deps.commandFor) return { error: `${tool} CLI 가 설치되어 있지 않습니다.` };
    const cmd = this.deps.commandFor?.(tool, argv) ?? { command: bin as string, args: argv };
    // 격리 홈은 반드시 실재해야 한다 — codex 는 CODEX_HOME 이 없으면 "Error loading configuration" 으로 즉시 종료.
    try {
      mkdirSync(this.deps.homeDir(tool), { recursive: true });
    } catch {
      /* 생성 실패는 실행 오류로 드러난다 */
    }
    try {
      const child = spawn(cmd.command, cmd.args, {
        env: this.env(tool),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      return { child };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async run(
    tool: CliTool,
    argv: string[],
    timeoutMs = 20_000,
  ): Promise<{ code: number | null; out: string }> {
    const r = this.spawnTool(tool, argv);
    if ('error' in r) return { code: null, out: r.error };
    const { child } = r;
    let out = '';
    child.stdout?.on('data', (d) => (out += String(d)));
    child.stderr?.on('data', (d) => (out += String(d)));
    try {
      child.stdin?.end();
    } catch {
      /* ignore */
    }
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        resolve({ code: null, out: out + '\n[timeout]' });
      }, timeoutMs);
      t.unref?.();
      child.on('error', (e) => {
        clearTimeout(t);
        resolve({ code: null, out: out + '\n' + e.message });
      });
      child.on('close', (code) => {
        clearTimeout(t);
        resolve({ code, out });
      });
    });
  }

  /** 로그인 상태(격리 홈 기준). 캐시 30초 — 턴 전 프리플라이트가 자주 부른다. */
  async status(tool: CliTool, opts?: { fresh?: boolean }): Promise<CliAuthStatus> {
    const cached = this.statusCache.get(tool);
    if (cached && !opts?.fresh && Date.now() - cached.checkedAt < 30_000) return cached;
    const bin = this.deps.binaryPath(tool);
    const base: CliAuthStatus = {
      tool,
      installed: !!bin || !!this.deps.commandFor,
      loggedIn: false,
      checkedAt: Date.now(),
    };
    if (!base.installed) {
      this.statusCache.set(tool, base);
      return base;
    }
    const r =
      tool === 'codex'
        ? await this.run(tool, ['login', 'status'])
        : await this.run(tool, ['auth', 'status']);
    const out = stripAnsi(r.out);
    const st: CliAuthStatus = { ...base, detail: out.trim().slice(-300) };
    if (tool === 'codex') {
      // 줄 단위로만 판정 — 오류 출력에 섞인 소스/문구("…logged in…")에 속지 않게.
      const lines = out.split(/\r?\n/).map((l) => l.trim().toLowerCase());
      if (lines.some((l) => l.startsWith('not logged in'))) st.loggedIn = false;
      else {
        const hit = lines.find((l) => l.startsWith('logged in'));
        if (hit) {
          st.loggedIn = true;
          st.method = hit.includes('api key') ? 'api_key' : 'chatgpt';
        }
      }
    } else {
      try {
        const j = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) as {
          loggedIn?: boolean;
          authMethod?: string;
          email?: string;
        };
        st.loggedIn = !!j.loggedIn;
        st.method = j.authMethod ?? null;
        st.email = j.email ?? null;
      } catch {
        st.loggedIn = /logged in:\s*true|"loggedIn":\s*true/i.test(out);
      }
    }
    this.statusCache.set(tool, st);
    return st;
  }

  invalidate(tool?: CliTool): void {
    if (tool) this.statusCache.delete(tool);
    else this.statusCache.clear();
  }

  /** 로그인 시작 — 이벤트는 onEvent 로(+history 리플레이). job id 반환. */
  startLogin(
    tool: CliTool,
    onEvent?: (e: CliAuthEvent) => void,
  ): { ok: boolean; jobId?: string; error?: string } {
    const argv = tool === 'codex' ? ['login', '--device-auth'] : ['auth', 'login', '--claudeai'];
    const r = this.spawnTool(tool, argv);
    if ('error' in r) return { ok: false, error: r.error };
    const id = `auth${++this.seq}-${Date.now().toString(36)}`;
    const job: Job = {
      id,
      tool,
      child: r.child,
      history: [],
      listeners: new Set(onEvent ? [onEvent] : []),
      done: false,
      accum: '',
      urls: new Set(),
      success: false,
    };
    this.jobs.set(id, job);
    const emit = (e: CliAuthEvent) => {
      job.history.push(e);
      for (const l of job.listeners) {
        try {
          l(e);
        } catch {
          /* ignore */
        }
      }
    };
    const feed = (raw: string) => {
      const clean = stripAnsi(raw.replace(/\r\n?/g, '\n'));
      job.accum = (job.accum + clean).slice(-16384);
      for (const u of job.accum.match(URL_RE) ?? []) {
        if (!job.urls.has(u)) {
          job.urls.add(u);
          emit({ channel: 'url', text: u });
        }
      }
      if (tool === 'codex' && !job.code) {
        const m = CODEX_CODE_RE.exec(job.accum);
        if (m) {
          job.code = m[0];
          emit({ channel: 'code', text: m[0] });
        }
      }
      const low = job.accum.toLowerCase();
      if (
        tool === 'claude' &&
        /paste code here/i.test(job.accum) &&
        !job.history.some((h) => h.channel === 'prompt')
      ) {
        emit({ channel: 'prompt', text: '브라우저에서 승인 후 표시되는 코드를 입력하세요' });
      }
      if (
        !job.success &&
        (low.includes('successfully logged in') ||
          low.includes('login successful') ||
          low.includes('logged in as') ||
          low.includes('you are now logged in'))
      ) {
        job.success = true;
      }
      for (const line of clean.split('\n')) {
        const t = line.trim();
        if (t) emit({ channel: 'stdout', text: t });
      }
    };
    const rl = createInterface({ input: r.child.stdout! });
    rl.on('line', (l) => feed(l + '\n'));
    r.child.stderr?.on('data', (d) => feed(String(d)));
    r.child.on('error', (e) => {
      emit({ channel: 'error', text: `실행 오류: ${e.message}` });
    });
    r.child.on('close', async (code) => {
      if (job.timer) clearTimeout(job.timer);
      job.done = true;
      this.invalidate(tool);
      if (job.cancelled) {
        emit({ channel: 'error', text: '로그인이 취소되었습니다.' });
      } else if (code === 0) {
        // 종료 코드만 믿지 않고 상태를 다시 확인한다.
        const st = await this.status(tool, { fresh: true }).catch(() => null);
        if (st?.loggedIn)
          emit({
            channel: 'success',
            text: `${tool === 'codex' ? 'ChatGPT' : 'Claude'} 로그인 완료${st.email ? ` (${st.email})` : ''}`,
          });
        else
          emit({
            channel: 'error',
            text: '로그인이 완료되지 않았습니다(상태 확인 실패). 다시 시도해 주세요.',
          });
      } else if (code !== null) {
        emit({
          channel: 'error',
          text: `로그인 실패(rc=${code}). ${job.accum.trim().slice(-300)}`,
        });
      } else {
        emit({ channel: 'error', text: '로그인이 취소되었거나 중단되었습니다.' });
      }
      emit({ channel: 'exit', text: String(code) });
      setTimeout(() => this.jobs.delete(id), 10 * 60_000).unref?.();
    });
    job.timer = setTimeout(() => {
      if (!job.done) {
        emit({
          channel: 'error',
          text: `로그인이 제한 시간(${LOGIN_TIMEOUT_MS / 60000}분) 안에 완료되지 않았습니다.`,
        });
        try {
          r.child.kill();
        } catch {
          /* ignore */
        }
      }
    }, LOGIN_TIMEOUT_MS);
    job.timer.unref?.();
    this.deps.log?.(`login start ${tool} job=${id}`);
    return { ok: true, jobId: id };
  }

  /** 렌더러가 나중에 붙어도 지난 이벤트를 리플레이한다. */
  subscribe(jobId: string, l: (e: CliAuthEvent) => void): () => void {
    const job = this.jobs.get(jobId);
    if (!job) {
      l({ channel: 'error', text: 'unknown job' });
      return () => {};
    }
    for (const e of job.history) l(e);
    job.listeners.add(l);
    return () => job.listeners.delete(l);
  }

  /** 코드 입력(claude: 브라우저가 준 코드; codex: 보통 불필요). */
  submitInput(jobId: string, text: string): { ok: boolean; error?: string } {
    const job = this.jobs.get(jobId);
    if (!job || job.done) return { ok: false, error: '진행 중인 로그인이 없습니다.' };
    try {
      job.child.stdin?.write((text ?? '').trim() + '\n');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  cancel(jobId: string): { ok: boolean } {
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false };
    if (!job.done) {
      job.cancelled = true;
      try {
        job.child.kill();
      } catch {
        /* ignore */
      }
    }
    return { ok: true };
  }

  async logout(tool: CliTool): Promise<{ ok: boolean; error?: string }> {
    const r =
      tool === 'codex'
        ? await this.run(tool, ['logout'])
        : await this.run(tool, ['auth', 'logout']);
    this.invalidate(tool);
    // 격리 홈의 자격증명 파일도 제거(CLI 가 남겨도 확실히).
    try {
      const { rmSync } = await import('node:fs');
      const home = this.deps.homeDir(tool);
      for (const f of tool === 'codex' ? ['auth.json'] : ['.credentials.json']) {
        const p = join(home, f);
        if (existsSync(p)) rmSync(p, { force: true });
      }
    } catch {
      /* ignore */
    }
    return r.code === 0 || r.code === null
      ? { ok: true }
      : { ok: false, error: stripAnsi(r.out).slice(-300) };
  }

  /**
   * 로컬 턴 settings 덮어쓰기 — 이 PC 로그인이 있으면 oauth 모드로 고정하고 서버 중앙 자격증명을 뺀다.
   * (서버 설정은 서버가 준 것 그대로; 여기서는 로컬 로그인만 얹는다.)
   */
  async overlaySettings(
    serverSettings: Record<string, string>,
    opts?: { codex?: boolean; claude?: boolean },
  ): Promise<{ settings: Record<string, string>; local: { codex: boolean; claude: boolean } }> {
    const out = { ...serverSettings };
    const local = { codex: false, claude: false };
    if (opts?.codex !== false) {
      const st = await this.status('codex').catch(() => null);
      if (st?.loggedIn && st.method !== 'api_key') {
        local.codex = true;
        out.CODEX_AUTH_MODE = 'oauth';
        delete out.CODEX_CREDENTIALS_JSON;
      }
    }
    if (opts?.claude !== false) {
      const st = await this.status('claude').catch(() => null);
      if (st?.loggedIn && st.method !== 'api_key' && st.method !== 'none') {
        local.claude = true;
        out.CLAUDE_CODE_AUTH_MODE = 'oauth';
        delete out.CLAUDE_CODE_OAUTH_TOKEN;
      }
    }
    return { settings: out, local };
  }
}

/**
 * CLI provider 턴을 로컬에서 시작할 인증이 있는가 — 없으면 서버로 폴백해야 한다.
 *   · 이 PC 로그인(oauth) · 서버 설정: api_key 모드 + 키 / setup_token + 토큰 / oauth + 중앙 자격증명
 */
export function cliAuthAvailable(
  tool: CliTool,
  settings: Record<string, string>,
  apiKeys: Record<string, string>,
  localLoggedIn: boolean,
): {
  ok: boolean;
  source: 'local_login' | 'server_api_key' | 'server_token' | 'server_credentials' | 'none';
} {
  if (localLoggedIn) return { ok: true, source: 'local_login' };
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
  // oauth(서버 파드 로컬 로그인) — 커넥터 PC 엔 그 자격증명이 없다.
  return { ok: false, source: 'none' };
}
