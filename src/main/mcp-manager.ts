/**
 * MCPManager — hosts MCP CLIENTS to the user's LOCAL MCP servers so the XGEN
 * agents can use them THROUGH this connector (the conduit). Lives in the
 * Electron MAIN process (only main can spawn stdio subprocesses). The bridge
 * (mcp-bridge.ts) advertises the aggregated tool catalog to the XGEN backend over
 * the `/api/tools/ws/connector-mcp/{user_id}` WebSocket and answers `mcp_call`
 * frames by dispatching to `callTool` here.
 *
 * The @modelcontextprotocol/sdk is lazy-imported so a build that can't resolve
 * it still boots — MCP just reports unavailable. Ported from geny-connector.
 */
import type { McpServerConfig } from './config';
import { homedir } from 'os';
import {
  augmentedPath,
  buildChildEnv,
  diagnoseMissing,
  ExecNotFoundError,
  resetPathCache,
  resolveExecutable,
} from './exec-resolve';

export interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** What we advertise to the backend (per configured, enabled server). */
export interface McpServerAdvert {
  name: string;
  connected: boolean;
  error?: string;
  tools: McpToolSchema[];
}

/** A flat tool entry advertised in the bridge `hello` frame. */
export interface AdvertisedTool {
  server: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface ServerState {
  config: McpServerConfig;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any | null;
  tools: McpToolSchema[];
  error?: string;
  connecting?: Promise<void>;
}

/** Quote-aware split of a command line into [command, ...args]. */
function tokenize(cmd: string): string[] {
  const m = cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  return m.map((t) => t.replace(/^["']|["']$/g, ''));
}

/**
 * 자식 프로세스 stderr 의 마지막 몇 줄을 뽑는다.
 *
 * MCP 서버가 기동에 실패하면 SDK 는 `MCP error -32000: Connection closed` 만
 * 준다 — 진짜 원인(패키지 없음, ImportError, 인증 실패…)은 전부 자식의
 * stderr 에 있다. 그걸 버리면 사용자는 고칠 방법이 없다.
 */
export function tailLines(text: string, maxLines = 12, maxChars = 200): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter(Boolean)
    .slice(-maxLines)
    .map((l) => (l.length > maxChars ? `${l.slice(0, maxChars)}…` : l));
}

/** 기동 실패 원인을 UI 로 실어 나르는 오류 (stderr 꼬리를 hints 로). */
export class McpStartError extends Error {
  readonly hints: string[];
  constructor(message: string, hints: string[]) {
    super(message);
    this.name = 'McpStartError';
    this.hints = hints;
  }
}

/** transport.stderr 를 상한선(기본 64KB)까지만 모아 두고 꼬리를 돌려준다. */
function collectStderr(transport: { stderr?: NodeJS.ReadableStream | null }, cap = 64 * 1024): () => string {
  let buf = '';
  const stream = transport.stderr;
  stream?.on?.('data', (chunk: Buffer | string) => {
    buf += String(chunk);
    if (buf.length > cap) buf = buf.slice(-cap); // 무한 로그 서버 방어
  });
  return () => buf;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _sdk: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadSdk(): Promise<any> {
  if (_sdk) return _sdk;
  const [{ Client }, { StdioClientTransport }, { StreamableHTTPClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
  ]);
  _sdk = { Client, StdioClientTransport, StreamableHTTPClientTransport };
  return _sdk;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t!);
  }
}

export class MCPManager {
  private states = new Map<string, ServerState>();

  /** Reconcile the configured server list into live state (drops removed,
   *  reconnects changed configs lazily). Does NOT connect yet. */
  configure(servers: McpServerConfig[] | undefined): void {
    const next = new Map<string, McpServerConfig>();
    for (const s of servers || []) if (s && s.name) next.set(s.name, s);
    for (const [name, st] of [...this.states]) {
      const cfg = next.get(name);
      if (!cfg || JSON.stringify(cfg) !== JSON.stringify(st.config)) {
        void this.disconnect(name);
        this.states.delete(name);
      }
    }
    for (const [name, cfg] of next) {
      if (!this.states.has(name)) this.states.set(name, { config: cfg, client: null, tools: [] });
    }
  }

  private async connect(name: string): Promise<void> {
    const st = this.states.get(name);
    if (!st) throw new Error(`unknown MCP server: ${name}`);
    if (st.client) return;
    if (st.connecting) return st.connecting;
    st.connecting = (async () => {
      const { Client, StdioClientTransport, StreamableHTTPClientTransport } = await loadSdk();
      const cfg = st.config;
      let transport;
      let readStderr: (() => string) | null = null;
      if (cfg.transport === 'stdio') {
        if (!cfg.command) throw new Error('stdio server has no command');
        // args 가 있으면(표준 JSON 가져오기) command 는 실행 파일 그 자체다 —
        // 재분해하지 않아야 공백/따옴표가 든 인자가 그대로 전달된다.
        const [command, ...args] = cfg.args?.length
          ? [cfg.command.trim(), ...cfg.args]
          : tokenize(cfg.command);
        if (!command) throw new Error('empty command');
        // GUI 로 실행된 앱은 로그인 셸 PATH 를 상속하지 않는다 → uvx/npx 를
        // 못 찾아 'spawn uvx ENOENT'. PATH 를 보강하고 실행 파일을 **절대
        // 경로로 해석**해 넘긴다 (Windows 는 .cmd/.exe 확장자까지).
        let pathStr = await augmentedPath();
        let resolved = resolveExecutable(command, pathStr);
        if (!resolved) {
          // 방금 설치했을 수 있다 — 캐시를 버리고 한 번 더 (앱 재시작 불필요).
          resetPathCache();
          pathStr = await augmentedPath();
          resolved = resolveExecutable(command, pathStr);
        }
        if (!resolved) throw new ExecNotFoundError(diagnoseMissing(command, pathStr));
        transport = new StdioClientTransport({
          command: resolved,
          args,
          env: buildChildEnv(pathStr, cfg.env),
          // 작업 디렉터리를 홈으로 고정한다. 안 정하면 앱을 어떻게 띄웠는지에
          // 따라(터미널 vs Finder/시작 메뉴) `/` 나 `C:\Windows\System32` 가
          // 되어 상대 경로 인자와 캐시 위치가 플랫폼마다 달라진다.
          cwd: homedir(),
          // 기동 실패 원인을 읽으려면 파이프여야 한다 (기본 'inherit' 는
          // Electron 콘솔로 흘려보내 사용자에게 안 보인다).
          stderr: 'pipe',
        });
        readStderr = collectStderr(transport as { stderr?: NodeJS.ReadableStream | null });
      } else {
        if (!cfg.url) throw new Error('http server has no url');
        transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
          requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
        });
      }
      const client = new Client({ name: 'xgen-connector', version: '1.0.0' }, { capabilities: {} });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let listed: any;
      try {
        await withTimeout(client.connect(transport), 20000, `connect ${name}`);
        listed = await withTimeout(client.listTools(), 15000, `listTools ${name}`);
      } catch (e) {
        // 'Connection closed' 만으로는 고칠 수 없다 — 서버가 stderr 에 남긴
        // 진짜 원인을 함께 올린다.
        const tail = readStderr ? tailLines(readStderr()) : [];
        if (tail.length) {
          throw new McpStartError(
            `${(e as Error).message} — 서버가 기동하지 못했습니다. 아래 출력을 확인하세요.`,
            tail,
          );
        }
        throw e;
      }
      st.client = client;
      st.tools = (listed?.tools || []).map((t: McpToolSchema) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      st.error = undefined;
    })();
    try {
      await st.connecting;
    } catch (e) {
      st.error = String((e as Error).message);
      st.client = null;
      throw e;
    } finally {
      st.connecting = undefined;
    }
  }

  private async disconnect(name: string): Promise<void> {
    const st = this.states.get(name);
    if (!st) return;
    const c = st.client;
    st.client = null;
    st.tools = [];
    try {
      await c?.close?.();
    } catch {
      /* ignore */
    }
  }

  /** Connect every enabled server + return their tool catalogs. */
  async advertise(): Promise<McpServerAdvert[]> {
    const out: McpServerAdvert[] = [];
    for (const [name, st] of this.states) {
      if (st.config.enabled === false) continue;
      try {
        await this.connect(name);
        out.push({ name, connected: true, tools: st.tools });
      } catch (e) {
        out.push({ name, connected: false, error: String((e as Error).message), tools: [] });
      }
    }
    return out;
  }

  /** Flat catalog for the bridge `hello` frame (only connected servers' tools). */
  async advertisedTools(): Promise<AdvertisedTool[]> {
    const adverts = await this.advertise();
    const flat: AdvertisedTool[] = [];
    for (const a of adverts) {
      if (!a.connected) continue;
      for (const t of a.tools) {
        flat.push({ server: a.name, name: t.name, description: t.description, inputSchema: t.inputSchema });
      }
    }
    return flat;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async callTool(name: string, tool: string, args: any): Promise<any> {
    await this.connect(name);
    const st = this.states.get(name);
    if (!st?.client) throw new Error(`MCP server ${name} not connected`);
    try {
      return await withTimeout(
        st.client.callTool({ name: tool, arguments: args || {} }),
        120000,
        `callTool ${name}.${tool}`,
      );
    } catch (e) {
      // The server may have died mid-call; drop the client so the NEXT call
      // reconnects fresh instead of hanging on a stale transport.
      await this.disconnect(name);
      throw e;
    }
  }

  /** One-shot connect → list → disconnect, for the settings "테스트" button. */
  async test(
    config: McpServerConfig,
  ): Promise<{ ok: boolean; tools?: McpToolSchema[]; error?: string; hints?: string[] }> {
    const tmp = `__test__${config.name || 'srv'}`;
    this.states.set(tmp, { config: { ...config, name: tmp }, client: null, tools: [] });
    try {
      await this.connect(tmp);
      const tools = this.states.get(tmp)?.tools || [];
      return { ok: true, tools };
    } catch (e) {
      const err = e as Error & { hints?: string[] };
      // 런타임 미설치(ExecNotFoundError) 는 설치 안내를, 기동 실패
      // (McpStartError) 는 서버 stderr 꼬리를 함께 돌려준다.
      const hints = Array.isArray(err.hints) && err.hints.length ? err.hints : undefined;
      return { ok: false, error: String(err.message), hints };
    } finally {
      await this.disconnect(tmp);
      this.states.delete(tmp);
    }
  }

  listServers(): McpServerConfig[] {
    return [...this.states.values()].map((s) => s.config);
  }

  async closeAll(): Promise<void> {
    for (const name of [...this.states.keys()]) await this.disconnect(name);
  }
}

let _manager: MCPManager | null = null;
export function getMcpManager(): MCPManager {
  if (!_manager) _manager = new MCPManager();
  return _manager;
}
