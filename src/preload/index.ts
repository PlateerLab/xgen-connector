/**
 * Preload — the ONLY bridge between the sandboxed renderer and the native shell.
 *
 * Exposes `window.xgen`: config, auth, agents, history, chat (streamed via a
 * callback), and updater. Tokens and network calls stay in the main process;
 * the renderer only ever sees typed results and streamed ChatEvents.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS } from '../main/ipc';
import type { ChatEvent, ChatRequest, CurrentUser, AgentListQuery, AgentListResult, HistoryTurn, Conversation } from '../core/index';
import type { AvatarConfig } from '../core/preferences';
import type { ConnectorConfig, McpServerConfig } from '../main/config';

/** Local-MCP bridge status pushed to the settings UI. */
export interface McpBridgeStatusLike {
  enabled: boolean;
  connected: boolean;
  error?: string;
  servers: Array<{ name: string; connected: boolean; error?: string; tools: Array<{ name: string }> }>;
}

/** Live avatar/chat state pushed from the main window to the floating overlay. */
export interface OverlayState {
  workflowId: string;
  workflowName: string;
  /** Assistant text streamed so far this turn. */
  streamingText: string;
  /** True while a turn is actively streaming. */
  speaking: boolean;
}

let streamSeq = 0;

const api = {
  config: {
    get: (): Promise<ConnectorConfig> => ipcRenderer.invoke(CHANNELS.configGet),
    set: (patch: Partial<ConnectorConfig>): Promise<ConnectorConfig> =>
      ipcRenderer.invoke(CHANNELS.configSet, patch),
    onChange: (cb: (c: ConnectorConfig) => void): (() => void) => {
      const h = (_e: unknown, c: ConnectorConfig) => cb(c);
      ipcRenderer.on(CHANNELS.configChanged, h);
      return () => ipcRenderer.removeListener(CHANNELS.configChanged, h);
    },
  },

  auth: {
    login: (email: string, password: string): Promise<{ user: CurrentUser | null }> =>
      ipcRenderer.invoke(CHANNELS.authLogin, email, password),
    restore: (): Promise<{ user: CurrentUser | null }> => ipcRenderer.invoke(CHANNELS.authRestore),
    logout: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.authLogout),
    status: (): Promise<{ user: CurrentUser | null }> => ipcRenderer.invoke(CHANNELS.authStatus),
    onAuthFailed: (cb: () => void): (() => void) => {
      const h = () => cb();
      ipcRenderer.on(CHANNELS.authFailed, h);
      return () => ipcRenderer.removeListener(CHANNELS.authFailed, h);
    },
  },

  agents: {
    list: (query?: AgentListQuery): Promise<AgentListResult> =>
      ipcRenderer.invoke(CHANNELS.agentsList, query),
  },

  user: {
    /** The logged-in user's avatar config (preferences.avatar). Global default. */
    avatarConfig: (): Promise<AvatarConfig> => ipcRenderer.invoke(CHANNELS.userAvatarConfig),
    /** Persist an adjusted avatar config (overlay scale/position). */
    saveAvatarConfig: (cfg: AvatarConfig): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.userSaveAvatarConfig, cfg),
  },

  history: {
    turns: (workflowId: string, interactionId: string, name?: string): Promise<HistoryTurn[]> =>
      ipcRenderer.invoke(CHANNELS.historyTurns, workflowId, interactionId, name),
    conversations: (): Promise<Conversation[]> => ipcRenderer.invoke(CHANNELS.historyConversations),
  },

  chat: {
    /**
     * Start a streamed chat turn. `onEvent` is called for each ChatEvent;
     * returns a handle with `cancel()`. Resolves the terminal `end`/`error`.
     */
    stream: (req: ChatRequest, onEvent: (e: ChatEvent) => void): { cancel: () => void } => {
      const streamId = `s${Date.now()}_${streamSeq++}`;
      const h = (_e: unknown, id: string, ev: ChatEvent) => {
        if (id !== streamId) return;
        onEvent(ev);
        if (ev.kind === 'end' || ev.kind === 'error') {
          ipcRenderer.removeListener(CHANNELS.chatEvent, h);
        }
      };
      ipcRenderer.on(CHANNELS.chatEvent, h);
      void ipcRenderer.invoke(CHANNELS.chatStart, streamId, req);
      return {
        cancel: () => {
          void ipcRenderer.invoke(CHANNELS.chatCancel, streamId);
          ipcRenderer.removeListener(CHANNELS.chatEvent, h);
        },
      };
    },
  },

  /** Floating avatar overlay (Geny-style). Used by the main window
   * (setEnabled / pushState) and the overlay window (onState / windowControl). */
  overlay: {
    getEnabled: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.overlayGetEnabled),
    setEnabled: (enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.overlaySetEnabled, enabled),
    /** Main window → overlay: push the live avatar/chat state. */
    pushState: (state: OverlayState): void => ipcRenderer.send(CHANNELS.overlayPushState, state),
    /** Overlay window: subscribe to state updates. */
    onState: (cb: (s: OverlayState) => void): (() => void) => {
      const h = (_e: unknown, s: OverlayState) => cb(s);
      ipcRenderer.on(CHANNELS.overlayState, h);
      return () => ipcRenderer.removeListener(CHANNELS.overlayState, h);
    },
    /** Overlay window: toggle native click-through (false over interactive UI). */
    setClickThrough: (ignore: boolean): void =>
      ipcRenderer.send(CHANNELS.overlaySetIgnoreMouse, ignore),
    /** Overlay window: drag the OS window by a pixel delta (DPI-safe in main). */
    moveBy: (dx: number, dy: number): void => ipcRenderer.send(CHANNELS.overlayMoveBy, dx, dy),
    /** Overlay window: resize from an edge/corner (edge = combo of n/s/e/w). */
    resizeBy: (edge: string, dx: number, dy: number): void =>
      ipcRenderer.send(CHANNELS.overlayResizeBy, edge, dx, dy),
    /** Overlay window: raise/focus the main chat window. */
    focusMain: (): void => ipcRenderer.send(CHANNELS.overlayFocusMain),
    /** Overlay window: raise the main window and open its settings modal. */
    openSettings: (): void => ipcRenderer.send(CHANNELS.overlayOpenSettings),
    /** Overlay window: close the floating space. */
    hide: (): void => ipcRenderer.send(CHANNELS.overlayHide),
  },

  /** App/window management (tray-style controls). */
  appctl: {
    /** Main window: fired when the tray/overlay asks to open the settings modal. */
    onOpenSettings: (cb: () => void): (() => void) => {
      const h = () => cb();
      ipcRenderer.on(CHANNELS.openSettingsModal, h);
      return () => ipcRenderer.removeListener(CHANNELS.openSettingsModal, h);
    },
    getAutostart: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.autostartGet),
    setAutostart: (enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.autostartSet, enabled),
    resetPositions: (): void => ipcRenderer.send(CHANNELS.resetPositions),
    restart: (): void => ipcRenderer.send(CHANNELS.appRestart),
    quit: (): void => ipcRenderer.send(CHANNELS.appQuit),
  },

  /** Local MCP — host MCP servers here and bridge their tools to your agents. */
  mcp: {
    getEnabled: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.mcpGetEnabled),
    setEnabled: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke(CHANNELS.mcpSetEnabled, enabled),
    listServers: (): Promise<McpServerConfig[]> => ipcRenderer.invoke(CHANNELS.mcpListServers),
    saveServers: (servers: McpServerConfig[]): Promise<McpServerConfig[]> =>
      ipcRenderer.invoke(CHANNELS.mcpSaveServers, servers),
    testServer: (
      cfg: McpServerConfig,
    ): Promise<{ ok: boolean; tools?: Array<{ name: string; description?: string }>; error?: string }> =>
      ipcRenderer.invoke(CHANNELS.mcpTestServer, cfg),
    status: (): Promise<McpBridgeStatusLike> => ipcRenderer.invoke(CHANNELS.mcpStatus),
    onStatus: (cb: (s: McpBridgeStatusLike) => void): (() => void) => {
      const h = (_e: unknown, s: McpBridgeStatusLike) => cb(s);
      ipcRenderer.on(CHANNELS.mcpStatusEvent, h);
      return () => ipcRenderer.removeListener(CHANNELS.mcpStatusEvent, h);
    },
  },

  /** Global hotkeys (recorder support). */
  hotkeys: {
    /** Suspend all global shortcuts while a settings field records a new combo. */
    pause: (): void => ipcRenderer.send(CHANNELS.hotkeyPause),
    resume: (): void => ipcRenderer.send(CHANNELS.hotkeyResume),
  },

  /** Quick-chat — the Spotlight-style floating input bar (global hotkey). */
  quickChat: {
    getEnabled: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.quickChatGetEnabled),
    setEnabled: (enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.quickChatSetEnabled, enabled),
    getHotkey: (): Promise<string> => ipcRenderer.invoke(CHANNELS.quickChatGetHotkey),
    /** Change the quick-chat accelerator; returns false if registration failed. */
    setHotkey: (acc: string): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.quickChatSetHotkey, acc),
    /** Quick-chat window → send the typed text to the active agent chat. */
    submit: (text: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(CHANNELS.quickChatSubmit, text),
    /** Quick-chat window → dismiss the bar. */
    close: (): void => ipcRenderer.send(CHANNELS.quickChatClose),
    /** Quick-chat window: fired each time the bar is summoned. */
    onOpened: (cb: () => void): (() => void) => {
      const h = () => cb();
      ipcRenderer.on(CHANNELS.quickChatOpened, h);
      return () => ipcRenderer.removeListener(CHANNELS.quickChatOpened, h);
    },
    /** Quick-chat window: fired when main dismisses the bar. */
    onDismissed: (cb: () => void): (() => void) => {
      const h = () => cb();
      ipcRenderer.on(CHANNELS.quickChatDismissed, h);
      return () => ipcRenderer.removeListener(CHANNELS.quickChatDismissed, h);
    },
    /** Main window: subscribe to quick-chat relays → send into the active chat. */
    onQuickSend: (cb: (text: string) => void): (() => void) => {
      const h = (_e: unknown, text: string) => cb(text);
      ipcRenderer.on(CHANNELS.quickSend, h);
      return () => ipcRenderer.removeListener(CHANNELS.quickSend, h);
    },
  },

  updater: {
    check: (): Promise<{ opened?: boolean }> => ipcRenderer.invoke(CHANNELS.updaterCheck),
    getEnabled: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.updaterGetEnabled),
    setEnabled: (enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.updaterSetEnabled, enabled),
    onMessage: (cb: (msg: string) => void): (() => void) => {
      const h = (_e: unknown, msg: string) => cb(msg);
      ipcRenderer.on(CHANNELS.updaterMessage, h);
      return () => ipcRenderer.removeListener(CHANNELS.updaterMessage, h);
    },
    /** The running app version (package.json). */
    getVersion: (): Promise<string> => ipcRenderer.invoke(CHANNELS.appVersion),
  },

  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(CHANNELS.openExternal, url),
};

export type XgenBridge = typeof api;
contextBridge.exposeInMainWorld('xgen', api);
