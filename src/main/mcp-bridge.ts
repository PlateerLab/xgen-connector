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
 *
 * Reconnect UX is DEBOUNCED so a flapping socket (e.g. the backend endpoint not
 * yet deployed, or an idle proxy timeout) doesn't make the status flicker
 * "연결 대기 중 ↔ 연결됨": a connection is reported "connected" only after it stays
 * open a beat (settle), and "disconnected" only after it stays closed a beat
 * (grace). Reconnect uses exponential backoff; status emits are de-duplicated.
 */
import WebSocket from 'ws';
import { getMcpManager, type McpServerAdvert } from './mcp-manager';

const HEARTBEAT_MS = 20000;
const RECONNECT_MIN_MS = 5000;
const RECONNECT_MAX_MS = 60000;
const SETTLE_MS = 1200; // stay open this long before we call it "connected"
const GRACE_MS = 4000; // stay closed this long before we call it "disconnected"

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
  private settle: ReturnType<typeof setTimeout> | null = null;
  private grace: ReturnType<typeof setTimeout> | null = null;
  private backoff = RECONNECT_MIN_MS;
  private stopped = true;
  /** Debounced UI state — NOT the raw socket state, to avoid flicker. */
  private uiConnected = false;
  private serverUrl = '';
  private userId = '';
  private getToken: () => Promise<string | null> = async () => null;
  private lastServers: McpServerAdvert[] = [];
  private lastError: string | undefined;
  private lastEmit = '';
  private onStatus: (s: McpBridgeStatus) => void = () => {};

  setStatusListener(cb: (s: McpBridgeStatus) => void): void {
    this.onStatus = cb;
  }

  status(): McpBridgeStatus {
    return { enabled: !this.stopped, connected: this.uiConnected, error: this.lastError, servers: this.lastServers };
  }

  /** Emit only when the status actually changed (dedupe). */
  private emit(): void {
    const s = this.status();
    const key = JSON.stringify({ e: s.enabled, c: s.connected, err: s.error, n: s.servers.map((x) => [x.name, x.connected, x.tools.length]) });
    if (key === this.lastEmit) return;
    this.lastEmit = key;
    this.onStatus(s);
  }

  start(opts: { serverUrl: string; userId: string; getToken: () => Promise<string | null> }): void {
    // A no-op restart (same target, already running) must NOT tear down a live
    // socket — that alone would cause a visible flap on every auth refresh.
    const sameTarget = this.serverUrl === opts.serverUrl && this.userId === opts.userId;
    this.serverUrl = opts.serverUrl;
    this.userId = opts.userId;
    this.getToken = opts.getToken;
    if (!this.stopped && sameTarget && (this.ws || this.retry)) {
      void this.refreshCatalog();
      return;
    }
    this.stopped = false;
    this.backoff = RECONNECT_MIN_MS;
    this.reconnect(true);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    try {
      this.ws?.removeAllListeners();
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.uiConnected = false;
    this.lastError = undefined;
    this.emit();
  }

  private clearTimers(): void {
    for (const t of [this.retry, this.hb, this.settle, this.grace]) if (t) clearTimeout(t as never);
    this.retry = this.hb = this.settle = this.grace = null;
  }

  async refreshCatalog(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) await this.sendHello();
  }

  private wsUrl(): string {
    const base = this.serverUrl.replace(/\/+$/, '').replace(/^http/, 'ws');
    return `${base}/api/tools/ws/connector-mcp/${encodeURIComponent(this.userId)}`;
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retry) return;
    const delay = this.backoff;
    this.backoff = Math.min(RECONNECT_MAX_MS, Math.round(this.backoff * 1.8));
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.reconnect(false);
    }, delay);
  }

  private async reconnect(immediate: boolean): Promise<void> {
    if (this.stopped) return;
    if (immediate && this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    if (!immediate && this.retry) return;
    if (this.settle) {
      clearTimeout(this.settle);
      this.settle = null;
    }
    if (this.hb) {
      clearInterval(this.hb);
      this.hb = null;
    }
    try {
      this.ws?.removeAllListeners();
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    const token = await this.getToken();
    if (this.stopped || !this.serverUrl || !this.userId) {
      if (!this.stopped) this.scheduleRetry();
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsUrl(), { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.emit();
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      if (this.grace) {
        clearTimeout(this.grace);
        this.grace = null;
      }
      this.lastError = undefined;
      void this.sendHello();
      if (this.hb) clearInterval(this.hb);
      this.hb = setInterval(() => {
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
        } catch {
          /* ignore */
        }
      }, HEARTBEAT_MS);
      // Report "connected" only after the socket has stayed open a beat — a
      // socket that opens then immediately closes never flips the UI.
      if (this.settle) clearTimeout(this.settle);
      this.settle = setTimeout(() => {
        this.settle = null;
        if (this.ws === ws && ws.readyState === WebSocket.OPEN) {
          this.uiConnected = true;
          this.backoff = RECONNECT_MIN_MS; // a good connection resets backoff
          this.emit();
        }
      }, SETTLE_MS);
    });

    ws.on('message', (raw: WebSocket.RawData) => void this.onMessage(String(raw)));

    ws.on('close', () => {
      if (this.settle) {
        clearTimeout(this.settle);
        this.settle = null;
      }
      if (this.hb) {
        clearInterval(this.hb);
        this.hb = null;
      }
      if (this.stopped) return;
      // Only flip the UI to "disconnected" after a grace period, so a quick
      // reconnect (settle before grace) keeps the UI steady on "연결됨".
      if (this.uiConnected && !this.grace) {
        this.grace = setTimeout(() => {
          this.grace = null;
          this.uiConnected = false;
          this.emit();
        }, GRACE_MS);
      }
      this.scheduleRetry();
    });
    ws.on('error', (e: Error) => {
      this.lastError = e?.message;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  }

  private async sendHello(): Promise<void> {
    try {
      const adverts = await getMcpManager().advertise();
      this.lastServers = adverts;
      const tools = adverts
        .filter((a) => a.connected)
        .flatMap((a) => a.tools.map((t) => ({ server: a.name, name: t.name, description: t.description, inputSchema: t.inputSchema })));
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'hello', tools }));
      this.emit();
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.emit();
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
