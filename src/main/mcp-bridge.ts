/**
 * McpBridge — the connector side of the XGEN "connector-hosted Local MCP" bridge.
 *
 * Opens a WebSocket to the XGEN backend (through the gateway) at
 * `/api/tools/ws/connector-mcp/{user_id}`, advertises the aggregated local MCP
 * tool catalog via a `hello` frame, then answers `mcp_call` frames by invoking
 * the local MCP server through MCPManager and replying with `mcp_result`.
 *
 * The XGEN backend auto-injects these tools into the user's running agents
 * (agent_xgen / agent_harness / agent_geny), so any chat with the logged-in
 * user can call the connector-hosted tools.
 *
 * Lives in the MAIN process: tokens + subprocess spawning stay out of the
 * renderer. Uses `ws` (Node global WebSocket isn't stable on Electron's Node).
 */
import WebSocket from 'ws';
import { getMcpManager, type McpServerAdvert } from './mcp-manager';

const HEARTBEAT_MS = 25000;
const RECONNECT_MS = 5000;

export interface McpBridgeStatus {
  enabled: boolean;
  connected: boolean;
  error?: string;
  servers: McpServerAdvert[];
}

export class McpBridge {
  private ws: WebSocket | null = null;
  private hb: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private serverUrl = '';
  private userId = '';
  private getToken: () => Promise<string | null> = async () => null;
  private lastServers: McpServerAdvert[] = [];
  private onStatus: (s: McpBridgeStatus) => void = () => {};

  setStatusListener(cb: (s: McpBridgeStatus) => void): void {
    this.onStatus = cb;
  }

  status(): McpBridgeStatus {
    return {
      enabled: !this.stopped,
      connected: this.ws?.readyState === WebSocket.OPEN,
      servers: this.lastServers,
    };
  }

  private emit(error?: string): void {
    this.onStatus({ ...this.status(), error });
  }

  /** Start (or restart) the bridge for a logged-in user. */
  start(opts: { serverUrl: string; userId: string; getToken: () => Promise<string | null> }): void {
    this.serverUrl = opts.serverUrl;
    this.userId = opts.userId;
    this.getToken = opts.getToken;
    this.stopped = false;
    this.reconnect(true);
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    if (this.hb) clearInterval(this.hb);
    this.hb = null;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.emit();
  }

  /** Re-advertise the current catalog (e.g. after the server list changed). */
  async refreshCatalog(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) await this.sendHello();
  }

  private wsUrl(): string {
    const base = this.serverUrl.replace(/\/+$/, '').replace(/^http/, 'ws');
    return `${base}/api/tools/ws/connector-mcp/${encodeURIComponent(this.userId)}`;
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.reconnect(false);
    }, RECONNECT_MS);
  }

  private async reconnect(immediate: boolean): Promise<void> {
    if (this.stopped) return;
    if (!immediate && this.retry) return;
    try {
      this.ws?.removeAllListeners();
      this.ws?.close();
    } catch {
      /* ignore */
    }
    const token = await this.getToken();
    if (this.stopped) return;
    if (!this.serverUrl || !this.userId) {
      this.scheduleRetry();
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsUrl(), {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
    } catch (e) {
      this.emit(e instanceof Error ? e.message : String(e));
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      void this.sendHello();
      if (this.hb) clearInterval(this.hb);
      this.hb = setInterval(() => {
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
        } catch {
          /* ignore */
        }
      }, HEARTBEAT_MS);
      this.emit();
    });

    ws.on('message', (raw: WebSocket.RawData) => void this.onMessage(String(raw)));

    ws.on('close', () => {
      if (this.hb) clearInterval(this.hb);
      this.hb = null;
      if (!this.stopped) {
        this.emit();
        this.scheduleRetry();
      }
    });
    ws.on('error', (e: Error) => {
      this.emit(e?.message);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  }

  private async sendHello(): Promise<void> {
    try {
      const mcp = getMcpManager();
      const adverts = await mcp.advertise();
      this.lastServers = adverts;
      const tools = adverts
        .filter((a) => a.connected)
        .flatMap((a) =>
          a.tools.map((t) => ({
            server: a.name,
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        );
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'hello', tools }));
      }
      this.emit();
    } catch (e) {
      this.emit(e instanceof Error ? e.message : String(e));
    }
  }

  private async onMessage(text: string): Promise<void> {
    let msg: { type?: string; request_id?: string; server?: string; tool?: string; args?: unknown };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === 'mcp_call') {
      const { request_id, server, tool, args } = msg;
      let payload: Record<string, unknown>;
      try {
        const result = await getMcpManager().callTool(String(server), String(tool), args ?? {});
        payload = { request_id, ok: true, result };
      } catch (e) {
        payload = { request_id, ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      try {
        this.ws?.send(JSON.stringify({ type: 'mcp_result', ...payload }));
      } catch {
        /* socket gone */
      }
    }
    // 'pong' / 'ready' — nothing to do.
  }
}

let _bridge: McpBridge | null = null;
export function getMcpBridge(): McpBridge {
  if (!_bridge) _bridge = new McpBridge();
  return _bridge;
}
