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
import type { ConnectorConfig } from '../main/config';

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
    /** Overlay window: drag the OS window by a delta. */
    moveBy: (dx: number, dy: number): void => ipcRenderer.send(CHANNELS.overlayMoveBy, dx, dy),
    /** Overlay window: raise/focus the main chat window. */
    focusMain: (): void => ipcRenderer.send(CHANNELS.overlayFocusMain),
    /** Overlay window: close the floating space. */
    hide: (): void => ipcRenderer.send(CHANNELS.overlayHide),
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
  },

  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(CHANNELS.openExternal, url),
};

export type XgenBridge = typeof api;
contextBridge.exposeInMainWorld('xgen', api);
