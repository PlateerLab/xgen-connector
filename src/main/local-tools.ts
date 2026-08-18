/**
 * LocalTools — built-in tools the connector hosts ITSELF, advertised into the
 * SAME per-user MCP catalog as the user's configured MCP servers.
 *
 * Why not "just add an MCP server": the point is out-of-the-box local control.
 * Asking every user to wire an external shell-MCP server is exactly the friction
 * this removes. These tools ride the existing bridge rails (`hello` advertises
 * them, `mcp_call` dispatches to them), so the XGEN backend + agents need ZERO
 * changes — a built-in tool is indistinguishable from an MCP-server tool in the
 * catalog. The reserved server namespace is {@link LOCAL_SERVER}.
 *
 * The headline tool is {@link SHELL_TOOL} `Shell`: run a command in the machine's
 * NATIVE shell (PowerShell on Windows, the login shell / bash / sh elsewhere).
 * That single primitive is what lets an agent do "내 컴퓨터에서 메모장 켜줘"
 * (`notepad` / `open -a TextEdit` / `xdg-open`). Everything is GATED by config
 * and OFF unless the user turned the capability on — running arbitrary local
 * commands driven from a chat is powerful, so it must be visible and revocable.
 *
 * Lives in the MAIN process (only main may spawn subprocesses). Pure helpers
 * (shell resolution, result shaping, arg coercion) are exported for unit tests
 * that never touch a real process.
 */
import { spawn } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { augmentedPath, buildChildEnv } from './exec-resolve';

/** Reserved MCP "server" name for connector-hosted built-ins. Agents see the
 *  tool as `mcp_local_<Tool>` after backend sanitization — keep it stable. */
export const LOCAL_SERVER = 'local';
export const SHELL_TOOL = 'Shell';

/** Device-local shell capability config (persisted under ConnectorConfig.localShell). */
export interface LocalShellConfig {
  /** Master switch for the built-in Shell tool. Default ON (opt-out). */
  enabled?: boolean;
  /** Default working directory for commands. Empty → the user's home. */
  cwd?: string;
  /** Per-command wall-clock cap (ms). Default 120s; clamped to [1s, 1h]. */
  timeoutMs?: number;
  /**
   * Commands whose first token matches any of these (case-insensitive, exact
   * on the resolved program name) are refused. Empty → nothing blocked. This is
   * a light guardrail for the owner's own convenience (e.g. block `rm`), NOT a
   * security boundary — the agent runs as the logged-in user either way.
   */
  blocked?: string[];
}

export interface LocalToolSchema {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface LocalToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60 * 60_000;
const OUTPUT_CAP = 200_000; // chars kept from stdout+stderr

const IS_WIN = platform() === 'win32';
const IS_MAC = platform() === 'darwin';

export function shellConfig(cfg: LocalShellConfig | undefined): Required<LocalShellConfig> {
  const c = cfg || {};
  const t = typeof c.timeoutMs === 'number' && c.timeoutMs > 0 ? c.timeoutMs : DEFAULT_TIMEOUT_MS;
  return {
    enabled: c.enabled !== false, // default ON
    cwd: (c.cwd || '').trim(),
    timeoutMs: Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.round(t))),
    blocked: Array.isArray(c.blocked) ? c.blocked.map((b) => String(b).trim()).filter(Boolean) : [],
  };
}

export function shellEnabled(cfg: LocalShellConfig | undefined): boolean {
  return shellConfig(cfg).enabled;
}

/** Human label for the OS's native shell (shown in the tool description). */
export function nativeShellLabel(): string {
  if (IS_WIN) return 'PowerShell';
  if (IS_MAC) return 'zsh/bash';
  return 'bash/sh';
}

/**
 * Build the argv that runs `command` through the native shell.
 *
 * Windows → PowerShell (`-NoProfile -NonInteractive -Command <cmd>`): it is the
 * shell users expect on Windows and handles GUI-launch (`notepad`) and pipes.
 * POSIX → the user's `$SHELL` binary if given, else bash, with `-lc <cmd>` so
 * PATH/rc are loaded (GUI-launched apps otherwise miss `open`, `xdg-open`,
 * brew paths, …).
 *
 * `userShellBin` is the shell EXECUTABLE (e.g. `/bin/zsh` from `$SHELL`), NOT a
 * PATH string. `explicitShell` overrides detection: 'powershell'|'cmd'|'bash'|'sh'.
 */
export function shellInvocation(
  command: string,
  userShellBin: string | null,
  explicitShell?: string,
): { file: string; args: string[] } {
  const want = (explicitShell || 'default').toLowerCase();
  if (want === 'powershell' || (want === 'default' && IS_WIN)) {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', command],
    };
  }
  if (want === 'cmd') {
    return { file: 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  if (want === 'bash') return { file: 'bash', args: ['-lc', command] };
  if (want === 'sh') return { file: 'sh', args: ['-lc', command] };
  // POSIX default: the user's own shell ($SHELL) if it looks like a path, else bash.
  const bin = (userShellBin || '').trim();
  const file = bin.startsWith('/') ? bin : 'bash';
  return { file, args: ['-lc', command] };
}

/** First program token of a command line (for the blocklist check). */
export function firstToken(command: string): string {
  const m = String(command || '').trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const raw = (m && (m[1] || m[2] || m[3])) || '';
  // strip a path prefix and a Windows extension so "C:\\…\\rm.exe" → "rm".
  const base = raw.split(/[\\/]/).pop() || raw;
  return base.replace(/\.(exe|cmd|bat|com|ps1)$/i, '').toLowerCase();
}

export function isBlocked(command: string, blocked: string[]): boolean {
  if (!blocked.length) return false;
  const tok = firstToken(command);
  return blocked.some((b) => firstToken(b) === tok || b.trim().toLowerCase() === tok);
}

/** Clamp + label combined stdout/stderr into an MCP text result. */
export function shapeResult(
  stdout: string,
  stderr: string,
  code: number | null,
  signal: string | null,
): LocalToolResult {
  const parts: string[] = [];
  const out = stdout.length > OUTPUT_CAP ? stdout.slice(0, OUTPUT_CAP) + '\n…(truncated)' : stdout;
  const err = stderr.length > OUTPUT_CAP ? stderr.slice(0, OUTPUT_CAP) + '\n…(truncated)' : stderr;
  if (out.trim()) parts.push(out.replace(/\s+$/, ''));
  if (err.trim()) parts.push(`STDERR:\n${err.replace(/\s+$/, '')}`);
  const failed = signal != null || (code != null && code !== 0);
  if (signal) parts.push(`(terminated by signal ${signal})`);
  else if (code != null && code !== 0) parts.push(`(exit code ${code})`);
  return {
    content: [{ type: 'text', text: parts.join('\n\n') || '(no output)' }],
    isError: failed,
  };
}

/** The Shell tool schema advertised to the agent. */
export function shellToolSchema(): LocalToolSchema {
  return {
    name: SHELL_TOOL,
    description:
      `Run a command on the user's OWN computer through its native shell (${nativeShellLabel()}), ` +
      `as the logged-in desktop user. Use this to operate the local machine — launch apps ` +
      `(e.g. Windows: "notepad"; macOS: "open -a TextEdit"; Linux: "xdg-open <path>"), read/write ` +
      `local files, run scripts, inspect the system. Returns combined stdout/stderr and the exit ` +
      `code. Prefer non-interactive commands; long-running ones are stopped at the timeout.`,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command line to execute.' },
        cwd: {
          type: 'string',
          description: 'Working directory (absolute). Defaults to the configured directory or home.',
        },
        shell: {
          type: 'string',
          enum: ['default', 'powershell', 'cmd', 'bash', 'sh'],
          description: "Shell to use. 'default' picks the OS native shell.",
        },
        timeout_ms: {
          type: 'integer',
          description: 'Optional per-command timeout override (ms).',
        },
      },
      required: ['command'],
    },
  };
}

/** Coerce loose MCP args (agents send strings/objects) into a shell request. */
export function coerceShellArgs(args: unknown): {
  command: string;
  cwd?: string;
  shell?: string;
  timeoutMs?: number;
} {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const command = typeof a.command === 'string' ? a.command : String(a.command ?? '');
  const cwd = typeof a.cwd === 'string' && a.cwd.trim() ? a.cwd.trim() : undefined;
  const shell = typeof a.shell === 'string' ? a.shell : undefined;
  const t = a.timeout_ms ?? a.timeoutMs;
  const timeoutMs = typeof t === 'number' && t > 0 ? t : undefined;
  return { command, cwd, shell, timeoutMs };
}

/**
 * The connector-hosted local tool provider. One instance in main; the bridge
 * reads {@link configure} each time config changes and asks {@link advertise}
 * for the catalog + {@link callTool} to dispatch a call.
 */
export class LocalToolProvider {
  private cfg: Required<LocalShellConfig> = shellConfig(undefined);

  configure(cfg: LocalShellConfig | undefined): void {
    this.cfg = shellConfig(cfg);
  }

  /** True iff this call frame belongs to a built-in tool (server === LOCAL_SERVER). */
  owns(server: string): boolean {
    return server === LOCAL_SERVER;
  }

  /** Tools advertised into the catalog. Empty when the capability is off. */
  advertise(): LocalToolSchema[] {
    return this.cfg.enabled ? [shellToolSchema()] : [];
  }

  async callTool(tool: string, args: unknown): Promise<LocalToolResult> {
    if (tool !== SHELL_TOOL) throw new Error(`unknown local tool: ${tool}`);
    if (!this.cfg.enabled) throw new Error('로컬 셸 접근이 꺼져 있습니다 (설정 > 로컬 도구).');
    const { command, cwd, shell, timeoutMs } = coerceShellArgs(args);
    if (!command.trim()) throw new Error('command must not be empty');
    if (isBlocked(command, this.cfg.blocked)) {
      throw new Error(`명령 '${firstToken(command)}' 은(는) 차단 목록에 있어 실행할 수 없습니다.`);
    }
    return this.runShell(command, {
      cwd: cwd || this.cfg.cwd || homedir(),
      shell,
      timeoutMs: Math.max(
        MIN_TIMEOUT_MS,
        Math.min(MAX_TIMEOUT_MS, Math.round(timeoutMs || this.cfg.timeoutMs)),
      ),
    });
  }

  private async runShell(
    command: string,
    opts: { cwd: string; shell?: string; timeoutMs: number },
  ): Promise<LocalToolResult> {
    // GUI-launched apps don't inherit the login-shell PATH; augment it so
    // `open`/`xdg-open`/brew paths are visible. The shell binary itself is the
    // user's own `$SHELL` (a path like /bin/zsh), not the PATH string.
    const pathStr = await augmentedPath();
    const userShellBin = IS_WIN ? null : process.env.SHELL || null;
    const { file, args } = shellInvocation(command, userShellBin, opts.shell);
    const env = buildChildEnv(pathStr);

    return await new Promise<LocalToolResult>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(file, args, {
          cwd: opts.cwd || homedir(),
          env,
          windowsHide: true,
          // No shell:true — we ARE the shell (file is powershell/bash); this
          // avoids a double parse and keeps `command` a single opaque string.
        });
      } catch (e) {
        resolve({
          content: [{ type: 'text', text: `셸 실행 실패: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        });
        return;
      }
      let out = '';
      let err = '';
      let done = false;
      const finish = (r: LocalToolResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        finish({
          content: [{ type: 'text', text: `명령이 ${Math.round(opts.timeoutMs / 1000)}초 안에 끝나지 않아 중단했습니다.` }],
          isError: true,
        });
      }, opts.timeoutMs);
      child.stdout?.on('data', (d) => {
        out += String(d);
        if (out.length > OUTPUT_CAP * 2) out = out.slice(-OUTPUT_CAP * 2);
      });
      child.stderr?.on('data', (d) => {
        err += String(d);
        if (err.length > OUTPUT_CAP * 2) err = err.slice(-OUTPUT_CAP * 2);
      });
      child.on('error', (e) => {
        finish({
          content: [{ type: 'text', text: `셸 실행 실패: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        });
      });
      child.on('close', (code, signal) => finish(shapeResult(out, err, code, signal)));
    });
  }
}

let _provider: LocalToolProvider | null = null;
export function getLocalToolProvider(): LocalToolProvider {
  if (!_provider) _provider = new LocalToolProvider();
  return _provider;
}
