/**
 * A loopback-only CDP facade that exposes exactly one Electron WebContents.
 * agent-browser connects to the browser-shaped endpoint while all commands are
 * forwarded through Electron's webContents.debugger API.
 */
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { WebSocketServer, type WebSocket } from 'ws';

interface CdpRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export class CdpPageProxy {
  private server: Server | null = null;
  private socketServer: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private targetId = randomUUID().replace(/-/g, '');
  private sessionId = randomUUID().replace(/-/g, '');
  private _port = 0;

  constructor(
    readonly pageId: string,
    private contents: WebContents,
    private onDetach: () => void,
  ) {}

  get port(): number {
    return this._port;
  }

  async start(): Promise<number> {
    if (this.server) return this._port;
    this.attachDebugger();
    const server = createServer((request, response) => {
      const host = `127.0.0.1:${this._port}`;
      const target = this.targetInfo(host);
      const body =
        request.url === '/json/version'
          ? {
              Browser: 'Electron/XGEN',
              'Protocol-Version': '1.3',
              webSocketDebuggerUrl: `ws://${host}/devtools/browser/${this.pageId}`,
            }
          : request.url?.startsWith('/json')
            ? [target]
            : null;
      if (body == null) {
        response.writeHead(404).end('not found');
        return;
      }
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify(body));
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      const address = (socket as Socket).remoteAddress;
      if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
    });
    wss.on('connection', (ws) => {
      this.clients.add(ws);
      ws.on('message', (raw) => void this.handle(ws, String(raw)));
      ws.on('close', () => this.clients.delete(ws));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('CDP 프록시 포트를 열지 못했습니다.');
    this.server = server;
    this.socketServer = wss;
    this._port = address.port;
    return this._port;
  }

  private attachDebugger(): void {
    if (!this.contents.debugger.isAttached()) this.contents.debugger.attach('1.3');
    this.contents.debugger.on('message', this.forwardEvent);
    this.contents.debugger.on('detach', this.detached);
  }

  private forwardEvent = (_event: Electron.Event, method: string, params: unknown): void => {
    this.broadcast({ method, params, sessionId: this.sessionId });
  };

  private detached = (): void => {
    this.onDetach();
  };

  private targetInfo(host: string): Record<string, unknown> {
    return {
      id: this.targetId,
      targetId: this.targetId,
      type: 'page',
      title: this.contents.getTitle() || 'XGEN Browser',
      url: this.contents.getURL() || 'about:blank',
      attached: true,
      browserContextId: 'xgen',
      webSocketDebuggerUrl: `ws://${host}/devtools/page/${this.targetId}`,
      devtoolsFrontendUrl: '',
    };
  }

  private send(ws: WebSocket, payload: unknown): void {
    try {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
    } catch {
      /* client disconnected between readyState and send */
    }
  }

  private broadcast(payload: unknown): void {
    for (const ws of this.clients) this.send(ws, payload);
  }

  private async handle(ws: WebSocket, raw: string): Promise<void> {
    let message: CdpRequest;
    try {
      message = JSON.parse(raw) as CdpRequest;
    } catch {
      return;
    }
    const { id, method, params = {} } = message;
    try {
      let result: unknown;
      if (method === 'Browser.getVersion') {
        result = {
          protocolVersion: '1.3',
          product: 'Electron/XGEN',
          revision: 'xgen',
          userAgent: this.contents.getUserAgent(),
          jsVersion: process.versions.v8,
        };
      } else if (method === 'Target.getTargets') {
        result = { targetInfos: [this.targetInfo(`127.0.0.1:${this._port}`)] };
      } else if (method === 'Target.getTargetInfo') {
        result = { targetInfo: this.targetInfo(`127.0.0.1:${this._port}`) };
      } else if (method === 'Target.getBrowserContexts') {
        result = { browserContextIds: ['xgen'] };
      } else if (method === 'Target.attachToTarget') {
        result = { sessionId: this.sessionId };
      } else if (method === 'Target.setDiscoverTargets' || method === 'Target.setAutoAttach') {
        result = {};
        if (params.discover === true || params.autoAttach === true) {
          this.send(ws, {
            method: 'Target.attachedToTarget',
            params: {
              sessionId: this.sessionId,
              targetInfo: this.targetInfo(`127.0.0.1:${this._port}`),
              waitingForDebugger: false,
            },
          });
        }
      } else if (method === 'Target.activateTarget' || method === 'Target.detachFromTarget') {
        result = {};
      } else if (method === 'Browser.getWindowForTarget') {
        result = { windowId: 1, bounds: { windowState: 'normal' } };
      } else if (method.startsWith('Browser.') || method.startsWith('Target.')) {
        throw new Error(`CDP method is not available for this isolated page: ${method}`);
      } else {
        if (!this.contents.debugger.isAttached()) this.attachDebugger();
        result = await this.contents.debugger.sendCommand(method, params);
      }
      this.send(ws, { id, result, sessionId: message.sessionId });
    } catch (error) {
      this.send(ws, {
        id,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
        sessionId: message.sessionId,
      });
    }
  }

  async stop(): Promise<void> {
    this.contents.debugger.removeListener('message', this.forwardEvent);
    this.contents.debugger.removeListener('detach', this.detached);
    try {
      if (this.contents.debugger.isAttached()) this.contents.debugger.detach();
    } catch {
      /* page already destroyed */
    }
    // terminate (not graceful close): agent-browser keeps the external-CDP
    // socket open between commands, and a close handshake can otherwise hold
    // app shutdown until the TCP timeout.
    for (const client of this.clients) client.terminate();
    this.clients.clear();
    this.socketServer?.close();
    this.socketServer = null;
    const server = this.server;
    this.server = null;
    this._port = 0;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
