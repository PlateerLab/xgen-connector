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
 * Two tools, both operating the USER'S OWN PHYSICAL COMPUTER (not the cloud
 * workspace / sandbox):
 *   · {@link SHELL_TOOL} `Shell` — run ONE command in the native shell
 *     (PowerShell on Windows, the user's `$SHELL`/bash elsewhere). Robustness
 *     is the whole game here (2026-08 field report — the tool "worked then
 *     stopped"): stdin is CLOSED so interactive programs get EOF instead of
 *     hanging to the timeout; `background:true` launches GUI apps / long-running
 *     processes detached and returns immediately (so they aren't SIGKILLed at
 *     the timeout); a foreground timeout kills the whole process TREE.
 *   · {@link OPEN_TOOL} `Open` — open a file / URL / folder with the OS default
 *     app (Windows `start`, macOS `open`, Linux `xdg-open`), non-blocking. This
 *     is the unambiguous "열어줘" primitive so the agent doesn't have to guess
 *     xdg-open vs gedit vs kate.
 *
 * Everything is GATED by config and hidden unless the user turned the capability
 * on — running arbitrary local commands from a chat is powerful, so it must be
 * visible and revocable. Lives in the MAIN process (only main may spawn
 * subprocesses). Pure helpers are exported for unit tests that never spawn.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { readFile as fsReadFile, writeFile as fsWriteFile, appendFile as fsAppendFile, readdir, stat, mkdir } from 'node:fs/promises';
import { resolve as pathResolve, relative as pathRelative, isAbsolute, join as pathJoin, dirname, extname } from 'node:path';
import { augmentedPath, buildChildEnv } from './exec-resolve';

/** Reserved MCP "server" name for connector-hosted built-ins. Agents see the
 *  tool as `mcp_local_<Tool>` after backend sanitization — keep it stable. */
export const LOCAL_SERVER = 'local';
export const SHELL_TOOL = 'Shell';
export const OPEN_TOOL = 'Open';
// 반구조화 1급 로컬 도구 — 셸 문자열 우회 없이 파일/클립보드/알림을 다룬다.
// 파일 계열은 allowedRoots 경로 스코프 안에서만 동작한다(방어적 가드).
export const READ_FILE_TOOL = 'ReadFile';
export const WRITE_FILE_TOOL = 'WriteFile';
export const LIST_DIR_TOOL = 'ListDir';
export const SEARCH_TOOL = 'Search';
export const CLIPBOARD_TOOL = 'Clipboard';
export const NOTIFY_TOOL = 'Notify';

/** Device-local shell capability config (persisted under ConnectorConfig.localShell). */
export interface LocalShellConfig {
  /** Master switch for the built-in local tools. Default OFF (opt-in) — running
   *  arbitrary local commands from the cloud must be turned on explicitly. */
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
  /**
   * Directory roots the file tools (ReadFile/WriteFile/ListDir/Search) may touch.
   * A path outside every root is refused. Empty → defaults to the user's home
   * directory. This is a real scope for the STRUCTURED file tools (unlike Shell,
   * which is unrestricted once enabled). Paths may use `~` for home.
   */
  allowedRoots?: string[];
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
/** Grace we wait for a background launch to fail (ENOENT) before reporting success. */
const BG_SETTLE_MS = 350;
/** The OS opener (start/open/xdg-open) returns fast; bound it modestly. */
const OPEN_TIMEOUT_MS = 15_000;

const IS_WIN = platform() === 'win32';
const IS_MAC = platform() === 'darwin';

export function shellConfig(cfg: LocalShellConfig | undefined): Required<LocalShellConfig> {
  const c = cfg || {};
  const t = typeof c.timeoutMs === 'number' && c.timeoutMs > 0 ? c.timeoutMs : DEFAULT_TIMEOUT_MS;
  return {
    enabled: c.enabled === true, // opt-in (default OFF) — 로컬 셸은 명시적으로 켜야 한다
    cwd: (c.cwd || '').trim(),
    timeoutMs: Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.round(t))),
    blocked: Array.isArray(c.blocked) ? c.blocked.map((b) => String(b).trim()).filter(Boolean) : [],
    allowedRoots: Array.isArray(c.allowedRoots)
      ? c.allowedRoots.map((r) => String(r).trim()).filter(Boolean)
      : [],
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

/** Argv that opens a file / URL / folder with the OS default handler. Returns
 *  fast — the opener forks the real app and exits. */
export function openerInvocation(target: string): { file: string; args: string[] } {
  const t = String(target || '').trim();
  if (IS_WIN) return { file: 'cmd.exe', args: ['/d', '/s', '/c', 'start', '', t] };
  if (IS_MAC) return { file: 'open', args: [t] };
  return { file: 'xdg-open', args: [t] };
}

/** First program token of a command line (for the blocklist check). */
export function firstToken(command: string): string {
  const m = String(command || '').trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const raw = (m && (m[1] || m[2] || m[3])) || '';
  const base = raw.split(/[\\/]/).pop() || raw;
  return base.replace(/\.(exe|cmd|bat|com|ps1)$/i, '').toLowerCase();
}

export function isBlocked(command: string, blocked: string[]): boolean {
  if (!blocked.length) return false;
  const tok = firstToken(command);
  return blocked.some((b) => firstToken(b) === tok || b.trim().toLowerCase() === tok);
}

/**
 * 되돌리기 어려운(파괴적) 명령 패턴. 일반 명령은 승인 없이 실행하되, 이 패턴에
 * 걸리는 명령만 사용자 확인을 받는다 — 마찰을 최소화하면서 사고를 막는다.
 * 보안 경계가 아니라 "실수 방지 게이트"다 (에이전트는 어차피 로그인 사용자 권한).
 */
const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+-[a-z]*[rf]/i, // rm -rf / -r / -f
  /(^|[;&|`(])\s*rm\s+\//i, // rm on an absolute path
  /\bRemove-Item\b[^\n]*-Recurse/i,
  /\brmdir\s+\/s/i,
  /\bdel\s+\/[a-z]*[sf]/i,
  /\b(mkfs|fdisk|format)\b/i,
  /\bdd\b[^\n]*\b(of|if)=/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /\bchmod\s+-R\b/i,
  /\bchown\s+-R\b/i,
  />\s*\/dev\/(sd|nvme|disk|hd)/i,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:/, // fork bomb
  /\bgit\s+push\b[^\n]*--force/i,
  /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i, // curl … | sh
  /\bsudo\s+rm\b/i,
];

/** True if the command matches a destructive pattern that warrants confirmation. */
export function isDangerousShellCommand(command: string): boolean {
  const c = String(command || '');
  return DANGEROUS_PATTERNS.some((re) => re.test(c));
}

// 세션 동안 위험 명령을 한 번 승인하면 이후 되묻지 않는다 (사용자 선택).
let sessionApprovedDangerous = false;

/** 위험 패턴이면 사용자에게 확인. false = 거부. dialog 는 main 프로세스에서만. */
async function ensureDangerousApproval(command: string): Promise<boolean> {
  if (!isDangerousShellCommand(command)) return true;
  if (sessionApprovedDangerous) return true;
  try {
    const { dialog, BrowserWindow } = await import('electron');
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    const result = await (win
      ? dialog.showMessageBox(win, dangerousDialogOptions(command))
      : dialog.showMessageBox(dangerousDialogOptions(command)));
    if (result.response === 2) {
      sessionApprovedDangerous = true;
      return true;
    }
    return result.response === 1; // 1 = 이번만 허용, 0 = 거부
  } catch {
    // dialog 를 띄울 수 없으면(창 없음 등) 안전하게 거부한다.
    return false;
  }
}

function dangerousDialogOptions(command: string) {
  return {
    type: 'warning' as const,
    buttons: ['거부', '이번만 허용', '이 세션 동안 허용'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: '위험할 수 있는 명령 실행 확인',
    message: 'XGEN 에이전트가 이 PC 에서 되돌리기 어려운 명령을 실행하려 합니다.',
    detail: command.length > 800 ? `${command.slice(0, 800)} …` : command,
  };
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
      `Run ONE command on the USER'S OWN COMPUTER (the local desktop where this connector runs), ` +
      `through its native shell (${nativeShellLabel()}), as the logged-in user. This is the ` +
      `physical machine — NOT the cloud workspace/sandbox. Use it to operate that computer: run ` +
      `scripts, read/write local files, inspect the system, launch apps.\n` +
      `IMPORTANT for reliability:\n` +
      `• Non-interactive only — stdin is closed, so REPLs/prompts (bash, python with no args, ` +
      `\`read\`, pagers) return immediately instead of hanging. Pass the full command each call.\n` +
      `• To launch a GUI app or a long-running/never-exiting process (editors like notepad/gedit, ` +
      `servers, watchers), set background:true — it starts detached and returns at once, and is ` +
      `NOT killed at the timeout. Without it, a foreground app is terminated when the timeout hits.\n` +
      `• To just open a file/URL/folder with its default app, prefer the Open tool.\n` +
      `Returns combined stdout/stderr and the exit code (foreground only).`,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command line to execute.' },
        background: {
          type: 'boolean',
          description:
            'Launch detached and return immediately (no output captured). Use for GUI apps and ' +
            'long-running processes so they keep running and are not killed at the timeout.',
        },
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
          description: 'Optional per-command timeout override (ms). Ignored when background=true.',
        },
      },
      required: ['command'],
    },
  };
}

/** The Open tool schema. */
export function openToolSchema(): LocalToolSchema {
  return {
    name: OPEN_TOOL,
    description:
      `Open a file, folder, or URL on the USER'S OWN COMPUTER with its default application ` +
      `(Windows start / macOS open / Linux xdg-open). Non-blocking — the app launches and this ` +
      `returns immediately. Use this for "open <file>", "show me <folder>", "open <url>". To launch ` +
      `an app by name or run a command, use the Shell tool with background:true instead.`,
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Absolute file path, folder path, or URL to open with the default handler.',
        },
      },
      required: ['target'],
    },
  };
}

/** Coerce loose MCP args (agents send strings/objects) into a shell request. */
export function coerceShellArgs(args: unknown): {
  command: string;
  cwd?: string;
  shell?: string;
  timeoutMs?: number;
  background: boolean;
} {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const command = typeof a.command === 'string' ? a.command : String(a.command ?? '');
  const cwd = typeof a.cwd === 'string' && a.cwd.trim() ? a.cwd.trim() : undefined;
  const shell = typeof a.shell === 'string' ? a.shell : undefined;
  const t = a.timeout_ms ?? a.timeoutMs;
  const timeoutMs = typeof t === 'number' && t > 0 ? t : undefined;
  const bg = a.background ?? a.detach ?? a.detached;
  const background = bg === true || bg === 'true' || bg === 1;
  return { command, cwd, shell, timeoutMs, background };
}

export function coerceOpenArgs(args: unknown): { target: string } {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const raw = a.target ?? a.path ?? a.url ?? a.file;
  return { target: typeof raw === 'string' ? raw : String(raw ?? '') };
}

interface SpawnCaptured {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  error?: Error;
  timedOut?: boolean;
}

/** Kill a child and, on POSIX, its whole process group (so a shell's children —
 *  a foreground GUI, a subprocess tree — go with it and don't orphan). */
function killTree(child: ChildProcess, detachedGroup: boolean): void {
  try {
    if (IS_WIN) {
      if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
      else child.kill('SIGKILL');
    } else if (detachedGroup && child.pid) {
      process.kill(-child.pid, 'SIGKILL'); // negative pid = the process group
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/** Extensions we never text-search (binary/asset). */
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.gz',
  '.tar', '.7z', '.rar', '.mp3', '.mp4', '.mov', '.avi', '.wav', '.ogg', '.woff',
  '.woff2', '.ttf', '.eot', '.so', '.dll', '.dylib', '.exe', '.bin', '.class', '.o',
]);

function resolveOne(p: string, base: string): string {
  const home = homedir();
  const expanded = p.startsWith('~') ? home + p.slice(1) : p;
  return isAbsolute(expanded) ? pathResolve(expanded) : pathResolve(base, expanded);
}

/**
 * Resolve a user-supplied path and confirm it stays within an allowed root.
 * Empty roots → the user's home directory. Returns the absolute path, or null
 * when it escapes every root. `~` expands to home; relative paths resolve
 * against home.
 */
export function resolveWithinRoots(input: string, roots: string[]): string | null {
  const home = homedir();
  const effective = (roots && roots.length ? roots : [home]).map((r) => resolveOne(r, home));
  const abs = resolveOne(String(input || ''), home);
  for (const root of effective) {
    const rel = pathRelative(root, abs);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return abs;
  }
  return null;
}

export function readFileToolSchema(): LocalToolSchema {
  return {
    name: READ_FILE_TOOL,
    description:
      "Read a text file on the USER'S OWN COMPUTER (the local desktop), within the " +
      'allowed folders. Prefer this over `Shell cat` — it distinguishes “not found” ' +
      'from “no permission” cleanly. Returns UTF-8 text (truncated at maxBytes).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path. Absolute, ~ for home, or relative to home.' },
        maxBytes: { type: 'number', description: `Max bytes to return (default/cap ${OUTPUT_CAP}).` },
      },
      required: ['path'],
    },
  };
}

export function writeFileToolSchema(): LocalToolSchema {
  return {
    name: WRITE_FILE_TOOL,
    description:
      "Write (or append to) a text file on the USER'S OWN COMPUTER, within the allowed " +
      'folders. Creates parent directories as needed. Prefer this over shell redirection.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path. Absolute, ~ for home, or relative to home.' },
        content: { type: 'string', description: 'Text to write.' },
        mode: { type: 'string', enum: ['overwrite', 'append'], description: 'Default overwrite.' },
      },
      required: ['path', 'content'],
    },
  };
}

export function listDirToolSchema(): LocalToolSchema {
  return {
    name: LIST_DIR_TOOL,
    description: "List a directory on the USER'S OWN COMPUTER (within allowed folders). Shows type/size/name.",
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path (default: home).' } },
    },
  };
}

export function searchToolSchema(): LocalToolSchema {
  return {
    name: SEARCH_TOOL,
    description:
      "Recursively search text files under a folder on the USER'S OWN COMPUTER (within allowed " +
      'folders) for a literal substring. Skips node_modules/.git/binaries. Returns path:line: match.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Literal substring to find.' },
        path: { type: 'string', description: 'Root folder to search (default: home).' },
        maxResults: { type: 'number', description: 'Max matches (default 100, cap 500).' },
      },
      required: ['query'],
    },
  };
}

export function clipboardToolSchema(): LocalToolSchema {
  return {
    name: CLIPBOARD_TOOL,
    description: "Read or write the USER'S system clipboard (plain text).",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'write'], description: 'read (default) or write.' },
        text: { type: 'string', description: 'Text to put on the clipboard when action=write.' },
      },
    },
  };
}

export function notifyToolSchema(): LocalToolSchema {
  return {
    name: NOTIFY_TOOL,
    description: "Show a desktop notification on the USER'S OWN COMPUTER.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Notification title.' },
        body: { type: 'string', description: 'Notification body.' },
      },
      required: ['title'],
    },
  };
}

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
    if (!this.cfg.enabled) return [];
    return [
      shellToolSchema(),
      openToolSchema(),
      readFileToolSchema(),
      writeFileToolSchema(),
      listDirToolSchema(),
      searchToolSchema(),
      clipboardToolSchema(),
      notifyToolSchema(),
    ];
  }

  async callTool(tool: string, args: unknown): Promise<LocalToolResult> {
    if (!this.cfg.enabled) throw new Error('로컬 도구 접근이 꺼져 있습니다 (설정 > 로컬 도구).');
    if (tool === SHELL_TOOL) return this.shell(args);
    if (tool === OPEN_TOOL) return this.open(args);
    if (tool === READ_FILE_TOOL) return this.readFile(args);
    if (tool === WRITE_FILE_TOOL) return this.writeFile(args);
    if (tool === LIST_DIR_TOOL) return this.listDir(args);
    if (tool === SEARCH_TOOL) return this.search(args);
    if (tool === CLIPBOARD_TOOL) return this.clipboard(args);
    if (tool === NOTIFY_TOOL) return this.notify(args);
    throw new Error(`unknown local tool: ${tool}`);
  }

  /** Resolve + scope-check a file path against allowedRoots (throws if outside). */
  private guardPath(p: unknown): string {
    const abs = resolveWithinRoots(String(p ?? ''), this.cfg.allowedRoots);
    if (!abs) {
      throw new Error(
        `경로가 허용된 범위 밖입니다: ${String(p ?? '')} ` +
          `(설정 > 로컬 도구 > 허용 폴더에서 범위를 넓힐 수 있습니다).`,
      );
    }
    return abs;
  }

  private async readFile(args: unknown): Promise<LocalToolResult> {
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
    const abs = this.guardPath(a.path);
    const maxBytes = Math.max(1, Math.min(OUTPUT_CAP, Number(a.maxBytes) || OUTPUT_CAP));
    try {
      const buf = await fsReadFile(abs);
      const text = buf.subarray(0, maxBytes).toString('utf8');
      const suffix = buf.byteLength > maxBytes ? `\n…(truncated, ${buf.byteLength} bytes total)` : '';
      return { content: [{ type: 'text', text: (text || '(empty file)') + suffix }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `읽기 실패: ${(e as Error).message}` }], isError: true };
    }
  }

  private async writeFile(args: unknown): Promise<LocalToolResult> {
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
    const abs = this.guardPath(a.path);
    const content = typeof a.content === 'string' ? a.content : String(a.content ?? '');
    const append = a.mode === 'append' || a.append === true;
    try {
      await mkdir(dirname(abs), { recursive: true });
      if (append) await fsAppendFile(abs, content, 'utf8');
      else await fsWriteFile(abs, content, 'utf8');
      return {
        content: [{ type: 'text', text: `${append ? '이어썼습니다' : '저장했습니다'}: ${abs} (${Buffer.byteLength(content)} bytes)` }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `쓰기 실패: ${(e as Error).message}` }], isError: true };
    }
  }

  private async listDir(args: unknown): Promise<LocalToolResult> {
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
    const abs = this.guardPath(a.path ?? '~');
    try {
      const names = await readdir(abs);
      const rows: string[] = [];
      for (const name of names.slice(0, 1000)) {
        try {
          const s = await stat(pathJoin(abs, name));
          rows.push(`${s.isDirectory() ? 'd' : '-'} ${String(s.size).padStart(10)}  ${name}`);
        } catch {
          rows.push(`?          ?  ${name}`);
        }
      }
      const more = names.length > 1000 ? `\n…(${names.length} entries, first 1000 shown)` : '';
      return { content: [{ type: 'text', text: rows.join('\n') + more || '(empty directory)' }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `목록 실패: ${(e as Error).message}` }], isError: true };
    }
  }

  private async search(args: unknown): Promise<LocalToolResult> {
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
    const query = String(a.query ?? '');
    if (!query) throw new Error('query must not be empty');
    const abs = this.guardPath(a.path ?? '~');
    const maxResults = Math.max(1, Math.min(500, Number(a.maxResults) || 100));
    const hits: string[] = [];
    const skipDirs = new Set(['node_modules', '.git', '.venv', 'dist', 'out', '.next', '__pycache__']);
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (hits.length >= maxResults || depth > 8) return;
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (hits.length >= maxResults) return;
        const full = pathJoin(dir, name);
        let s;
        try {
          s = await stat(full);
        } catch {
          continue;
        }
        if (s.isDirectory()) {
          if (!skipDirs.has(name) && !name.startsWith('.')) await walk(full, depth + 1);
        } else if (s.size <= 2_000_000 && !BINARY_EXT.has(extname(name).toLowerCase())) {
          try {
            const text = await fsReadFile(full, 'utf8');
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes(query)) {
                hits.push(`${full}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
                if (hits.length >= maxResults) return;
              }
            }
          } catch {
            /* unreadable/binary — skip */
          }
        }
      }
    };
    await walk(abs, 0);
    return {
      content: [{ type: 'text', text: hits.length ? hits.join('\n') : `'${query}' 를 찾지 못했습니다 (${abs}).` }],
    };
  }

  private async clipboard(args: unknown): Promise<LocalToolResult> {
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
    const action = String(a.action ?? 'read');
    try {
      const { clipboard } = await import('electron');
      if (action === 'write') {
        clipboard.writeText(String(a.text ?? ''));
        return { content: [{ type: 'text', text: '클립보드에 복사했습니다.' }] };
      }
      const text = clipboard.readText();
      return { content: [{ type: 'text', text: text || '(클립보드가 비어 있습니다)' }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `클립보드 접근 실패: ${(e as Error).message}` }], isError: true };
    }
  }

  private async notify(args: unknown): Promise<LocalToolResult> {
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
    const title = String(a.title ?? 'XGEN');
    const body = String(a.body ?? '');
    try {
      const { Notification } = await import('electron');
      if (!Notification.isSupported()) {
        return { content: [{ type: 'text', text: '이 OS 에서 알림을 지원하지 않습니다.' }], isError: true };
      }
      new Notification({ title, body }).show();
      return { content: [{ type: 'text', text: '알림을 표시했습니다.' }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `알림 실패: ${(e as Error).message}` }], isError: true };
    }
  }

  private async shell(args: unknown): Promise<LocalToolResult> {
    const { command, cwd, shell, timeoutMs, background } = coerceShellArgs(args);
    if (!command.trim()) throw new Error('command must not be empty');
    if (isBlocked(command, this.cfg.blocked)) {
      throw new Error(`명령 '${firstToken(command)}' 은(는) 차단 목록에 있어 실행할 수 없습니다.`);
    }
    // 되돌리기 어려운 명령은 사용자 승인을 받는다 (위험 패턴만 — 일반 명령은 확인 없이).
    if (!(await ensureDangerousApproval(command))) {
      return {
        content: [{ type: 'text', text: '사용자가 이 명령의 실행을 거부했습니다 (위험할 수 있는 명령).' }],
        isError: true,
      };
    }
    const pathStr = await augmentedPath();
    const userShellBin = IS_WIN ? null : process.env.SHELL || null;
    const { file, args: argv } = shellInvocation(command, userShellBin, shell);
    const env = buildChildEnv(pathStr);
    const runCwd = cwd || this.cfg.cwd || homedir();

    if (background) return this.spawnBackground(file, argv, env, runCwd);

    const timeout = Math.max(
      MIN_TIMEOUT_MS,
      Math.min(MAX_TIMEOUT_MS, Math.round(timeoutMs || this.cfg.timeoutMs)),
    );
    const r = await this.spawnCapture(file, argv, env, runCwd, timeout);
    if (r.error) return { content: [{ type: 'text', text: `셸 실행 실패: ${r.error.message}` }], isError: true };
    if (r.timedOut) {
      return {
        content: [
          {
            type: 'text',
            text:
              `명령이 ${Math.round(timeout / 1000)}초 안에 끝나지 않아 중단했습니다. ` +
              `대화형 명령이거나 종료되지 않는 프로그램(에디터·서버 등)이면 background:true 로 실행하세요.` +
              (r.stdout || r.stderr ? `\n\n--- 중단 전 출력 ---\n${(r.stdout + '\n' + r.stderr).trim().slice(-2000)}` : ''),
          },
        ],
        isError: true,
      };
    }
    return shapeResult(r.stdout, r.stderr, r.code, r.signal);
  }

  private async open(args: unknown): Promise<LocalToolResult> {
    const { target } = coerceOpenArgs(args);
    if (!target.trim()) throw new Error('target must not be empty');
    const pathStr = await augmentedPath();
    const env = buildChildEnv(pathStr);
    const { file, args: argv } = openerInvocation(target);
    const r = await this.spawnCapture(file, argv, env, homedir(), OPEN_TIMEOUT_MS);
    if (r.error) {
      return {
        content: [{ type: 'text', text: `열기 실패: ${r.error.message} (opener: ${file})` }],
        isError: true,
      };
    }
    // Openers fork the app and exit 0. A non-zero exit is a real failure
    // (no handler, bad path); a timeout means the opener itself hung (rare) —
    // treat as launched since the app is likely up.
    if (r.timedOut || r.code === 0 || r.code == null) {
      return { content: [{ type: 'text', text: `열었습니다: ${target}` }] };
    }
    return {
      content: [{ type: 'text', text: `열기 실패 (${file} exit ${r.code}): ${(r.stderr || r.stdout || '(no output)').trim()}` }],
      isError: true,
    };
  }

  /** Foreground: capture output, close stdin (no interactive hang), tree-kill on timeout. */
  private spawnCapture(
    file: string,
    argv: string[],
    env: Record<string, string>,
    cwd: string,
    timeoutMs: number,
  ): Promise<SpawnCaptured> {
    // POSIX: run in its own process group so the timeout can reap the whole tree.
    const detachedGroup = !IS_WIN;
    return new Promise<SpawnCaptured>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(file, argv, {
          cwd: cwd || homedir(),
          env,
          windowsHide: true,
          detached: detachedGroup,
          // stdin IGNORED → interactive programs get EOF immediately instead of
          // blocking to the timeout (the "대화형 쉘 타임아웃" report).
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        resolve({ code: null, signal: null, stdout: '', stderr: '', error: e as Error });
        return;
      }
      let out = '';
      let err = '';
      let done = false;
      const finish = (r: SpawnCaptured) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        killTree(child, detachedGroup);
        finish({ code: null, signal: 'SIGKILL', stdout: out, stderr: err, timedOut: true });
      }, timeoutMs);
      child.stdout?.on('data', (d) => {
        out += String(d);
        if (out.length > OUTPUT_CAP * 2) out = out.slice(-OUTPUT_CAP * 2);
      });
      child.stderr?.on('data', (d) => {
        err += String(d);
        if (err.length > OUTPUT_CAP * 2) err = err.slice(-OUTPUT_CAP * 2);
      });
      child.on('error', (e) => finish({ code: null, signal: null, stdout: out, stderr: err, error: e }));
      child.on('close', (code, signal) => finish({ code, signal, stdout: out, stderr: err }));
    });
  }

  /** Background: detached + unref, return immediately. The launched app survives
   *  this connector and is never killed at a timeout. */
  private spawnBackground(
    file: string,
    argv: string[],
    env: Record<string, string>,
    cwd: string,
  ): Promise<LocalToolResult> {
    return new Promise<LocalToolResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(file, argv, {
          cwd: cwd || homedir(),
          env,
          windowsHide: true,
          detached: true,
          stdio: 'ignore',
        });
      } catch (e) {
        resolve({
          content: [{ type: 'text', text: `백그라운드 실행 실패: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        });
        return;
      }
      let settled = false;
      const done = (r: LocalToolResult) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };
      // A launch that can't even start (ENOENT) fires 'error' synchronously-ish;
      // give it a brief grace so we report the failure instead of a false success.
      child.on('error', (e) =>
        done({ content: [{ type: 'text', text: `백그라운드 실행 실패: ${e.message}` }], isError: true }),
      );
      child.unref();
      setTimeout(
        () =>
          done({
            content: [
              {
                type: 'text',
                text: `백그라운드로 시작했습니다 (pid ${child.pid ?? '?'}). 계속 실행되며, 출력은 캡처하지 않습니다.`,
              },
            ],
          }),
        BG_SETTLE_MS,
      );
    });
  }
}

let _provider: LocalToolProvider | null = null;
export function getLocalToolProvider(): LocalToolProvider {
  if (!_provider) _provider = new LocalToolProvider();
  return _provider;
}
