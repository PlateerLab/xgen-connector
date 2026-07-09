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
      if (cfg.transport === 'stdio') {
        if (!cfg.command) throw new Error('stdio server has no command');
        const [command, ...args] = tokenize(cfg.command);
        if (!command) throw new Error('empty command');
        transport = new StdioClientTransport({
          command,
          args,
          env: { ...(process.env as Record<string, string>), ...(cfg.env || {}) },
        });
      } else {
        if (!cfg.url) throw new Error('http server has no url');
        transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
          requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
        });
      }
      const client = new Client({ name: 'xgen-connector', version: '1.0.0' }, { capabilities: {} });
      await withTimeout(client.connect(transport), 20000, `connect ${name}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const listed: any = await withTimeout(client.listTools(), 15000, `listTools ${name}`);
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
  async test(config: McpServerConfig): Promise<{ ok: boolean; tools?: McpToolSchema[]; error?: string }> {
    const tmp = `__test__${config.name || 'srv'}`;
    this.states.set(tmp, { config: { ...config, name: tmp }, client: null, tools: [] });
    try {
      await this.connect(tmp);
      const tools = this.states.get(tmp)?.tools || [];
      return { ok: true, tools };
    } catch (e) {
      return { ok: false, error: String((e as Error).message) };
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
