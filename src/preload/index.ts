/**
 * Preload — the ONLY bridge between the sandboxed renderer and the native shell.
 *
 * Exposes `window.xgen`: config, auth, agents, history, chat (streamed via a
 * callback), and updater. Tokens and network calls stay in the main process;
 * the renderer only ever sees typed results and streamed ChatEvents.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS } from '../main/ipc';
import type {
  ChatEvent,
  ChatRequest,
  CurrentUser,
  AgentListQuery,
  AgentListResult,
  HistoryTurn,
  Conversation,
  VoiceConfig,
  TtsSpeakOptions,
} from '../core/index';
import type { AvatarConfig, AvatarDescriptor } from '../core/preferences';
import type { StoreAvatar } from '../core/avatars';
import type { ConnectorConfig, McpServerConfig } from '../main/config';


/** 가상 드라이브 상태 (main workspace-manager.WorkspaceStatus 미러). */
export interface WorkspaceStatusLike {
  supported: boolean;
  /** 사용자가 드라이브를 켜 두었는가. */
  enabled: boolean;
  /** 마운트를 막던 로컬 파일을 구해 낸 위치. */
  rescued?: string;
  reason?: string;
  hint?: string;
  mounted: boolean;
  path?: string;
  error?: string;
  errorHint?: string;
  /** 클라우드 스토리지가 꺼져 있는 사유 (오류가 아니다). */
  storageOff?: string;
  /**
   * 이 PC 가 **재연결** 대상이다 — 서버가 이름 없이 알고 있다.
   *
   * ⚠ 이 두 필드를 여기서 빼먹으면 main 이 아무리 정확히 판정해도 **화면에는
   * 아무 일도 일어나지 않는다.** 실제로 그랬다: 재연결 감지를 붙여 놓고
   * 미러 타입에 옮기지 않아, 사용자는 자기 PC 가 루트에 파일을 흩뿌리고
   * 있다는 사실을 끝까지 몰랐다.
   */
  needsReconnect?: boolean;
  reconnectReason?: string;
  /** 클라우드 안 이 PC 의 폴더 — `{클라우드}/{PC 이름}/(파일)`. */
  homeFolder?: string;
  agents: Array<{ workflowId: string; label: string; folder: string }>;
}

/** Local-MCP bridge status pushed to the settings UI. */
export interface McpBridgeStatusLike {
  enabled: boolean;
  connected: boolean;
  catalogSynced: boolean;
  serverToolCount: number;
  error?: string;
  servers: Array<{
    name: string;
    connected: boolean;
    error?: string;
    tools: Array<{ name: string }>;
  }>;
}

/** 앱 실행 중에만 유지되는 로컬 MCP 카탈로그·도구 호출 로그. */
export interface McpRuntimeLogEntryLike {
  id: number;
  timestamp: number;
  kind: 'catalog' | 'call' | 'result';
  message: string;
  requestId?: string;
  server?: string;
  tool?: string;
  ok?: boolean;
  durationMs?: number;
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
    login: (
      email: string,
      password: string,
      remember?: boolean,
    ): Promise<{ user: CurrentUser | null; tokenPersisted?: boolean; credsPersisted?: boolean }> =>
      ipcRenderer.invoke(CHANNELS.authLogin, email, password, remember),
    ssoLogin: (): Promise<{ user: CurrentUser; tokenPersisted: boolean }> =>
      ipcRenderer.invoke(CHANNELS.authSsoLogin),
    restore: (): Promise<{ user: CurrentUser | null; offline?: boolean }> =>
      ipcRenderer.invoke(CHANNELS.authRestore),
    /** 시크릿 저장 백엔드 상태 — persistent=false 면 재시작 시 재로그인 필요. */
    secureStorageStatus: (): Promise<{ backend: string; persistent: boolean }> =>
      ipcRenderer.invoke(CHANNELS.secureStorageStatus),
    /** Launch: sign in with saved credentials when 자동 로그인 is enabled. */
    autoLogin: (): Promise<{ user: CurrentUser | null; offline?: boolean }> =>
      ipcRenderer.invoke(CHANNELS.authAutoLogin),
    /** Login form: remembered email + auto-login checkbox state. */
    loginPrefill: (): Promise<{ autoLogin: boolean; email: string }> =>
      ipcRenderer.invoke(CHANNELS.authLoginPrefill),
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
    /** Persist ONE avatar's transform — read-modify-write server-side state
     *  so it can never clobber a selection changed on the web in between. */
    saveAvatarTransform: (
      avatarId: string,
      tf: { scale: number; position: { x: number; y: number } },
    ): Promise<void> => ipcRenderer.invoke(CHANNELS.userSaveAvatarTransform, avatarId, tf),
    /** Overlay: fired when auth becomes ready / config changes → refetch now. */
    onAvatarRefresh: (cb: () => void): (() => void) => {
      const h = () => cb();
      ipcRenderer.on(CHANNELS.avatarRefresh, h);
      return () => ipcRenderer.removeListener(CHANNELS.avatarRefresh, h);
    },
  },

  /** 아바타 설정 뷰 — 에셋 업로드/삭제, config 부분수정(read-modify-write), 스토어. */
  avatars: {
    uploadAsset: (bytes: Uint8Array, filename: string): Promise<AvatarDescriptor> =>
      ipcRenderer.invoke(CHANNELS.avatarUploadAsset, bytes, filename),
    deleteAsset: (avatarId: string): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.avatarDeleteAsset, avatarId),
    setEnabled: (enabled: boolean): Promise<AvatarConfig> =>
      ipcRenderer.invoke(CHANNELS.avatarSetEnabled, enabled),
    select: (id: string): Promise<AvatarConfig> => ipcRenderer.invoke(CHANNELS.avatarSelect, id),
    rename: (id: string, name: string): Promise<AvatarConfig> =>
      ipcRenderer.invoke(CHANNELS.avatarRename, id, name),
    add: (descriptor: AvatarDescriptor, name?: string): Promise<AvatarConfig> =>
      ipcRenderer.invoke(CHANNELS.avatarAdd, descriptor, name),
    remove: (id: string): Promise<AvatarConfig> => ipcRenderer.invoke(CHANNELS.avatarRemove, id),
    storeList: (): Promise<StoreAvatar[]> => ipcRenderer.invoke(CHANNELS.avatarStoreList),
    storePublish: (
      descriptor: AvatarDescriptor,
      name: string,
      description: string,
    ): Promise<StoreAvatar> =>
      ipcRenderer.invoke(CHANNELS.avatarStorePublish, descriptor, name, description),
    storeDownload: (storeId: string): Promise<AvatarDescriptor> =>
      ipcRenderer.invoke(CHANNELS.avatarStoreDownload, storeId),
    storeRate: (storeId: string, stars: number): Promise<StoreAvatar> =>
      ipcRenderer.invoke(CHANNELS.avatarStoreRate, storeId, stars),
    storeUnpublish: (storeId: string): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.avatarStoreUnpublish, storeId),
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

  /** Voice — STT (mic→text) and TTS (text→audio). Audio is captured in the
   *  renderer (getUserMedia) and shuttled to main as bytes; secrets stay in main. */
  voice: {
    /** preferences.stt / preferences.tts (UI hints only — no secrets). */
    getConfig: (): Promise<VoiceConfig> => ipcRenderer.invoke(CHANNELS.voiceConfig),
    /** Send a recorded clip → transcript text. */
    transcribe: async (blob: Blob, language?: string): Promise<string> => {
      const buf = await blob.arrayBuffer();
      return ipcRenderer.invoke(CHANNELS.voiceTranscribe, new Uint8Array(buf), blob.type, language);
    },
    /** Synthesize `text` → a playable audio Blob. */
    speak: async (text: string, opts?: TtsSpeakOptions): Promise<Blob> => {
      const r = (await ipcRenderer.invoke(CHANNELS.voiceSpeak, text, opts)) as {
        bytes: Uint8Array;
        mime: string;
      };
      const buf = r.bytes.buffer.slice(
        r.bytes.byteOffset,
        r.bytes.byteOffset + r.bytes.byteLength,
      ) as ArrayBuffer;
      return new Blob([buf], { type: r.mime || 'audio/wav' });
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
    /** Overlay window: drag/resize gesture ENDED → persist bounds immediately. */
    commitBounds: (): void => ipcRenderer.send(CHANNELS.overlayCommitBounds),
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
    resetSettings: (): void => ipcRenderer.send(CHANNELS.resetSettings),
    restart: (): void => ipcRenderer.send(CHANNELS.appRestart),
    quit: (): void => ipcRenderer.send(CHANNELS.appQuit),
  },

  /** 가상 드라이브(WebDAV 마운트) 검증 — 이 컴퓨터에서 실제로 붙는지. */
  workspace: {
    diagText: (): Promise<string> => ipcRenderer.invoke(CHANNELS.diagText),
    /** 진단 로그를 **main 의 clipboard 로** 복사 (렌더러 clipboard 는 막힐 수 있다). */
    diagCopy: (): Promise<{ ok: boolean; chars: number }> => ipcRenderer.invoke(CHANNELS.diagCopy),

    /** 실제 워크스페이스(가상 드라이브) — 에이전트 부착/해제 + 상태. */
    status: (): Promise<WorkspaceStatusLike> => ipcRenderer.invoke(CHANNELS.workspaceStatus),
    attach: (agent: { workflowId: string; label: string }): Promise<WorkspaceStatusLike> =>
      ipcRenderer.invoke(CHANNELS.workspaceAttach, agent),
    detach: (workflowId: string): Promise<WorkspaceStatusLike> =>
      ipcRenderer.invoke(CHANNELS.workspaceDetach, workflowId),
    open: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(CHANNELS.workspaceOpen),
    root: (): Promise<string> => ipcRenderer.invoke(CHANNELS.workspaceRoot),
    setRoot: (): Promise<WorkspaceStatusLike> => ipcRenderer.invoke(CHANNELS.workspaceSetRoot),
    setEnabled: (enabled: boolean): Promise<WorkspaceStatusLike> =>
      ipcRenderer.invoke(CHANNELS.workspaceSetEnabled, enabled),
    /** 실패한 마운트를 걷고 다시 붙인다. */
    remount: (): Promise<WorkspaceStatusLike> => ipcRenderer.invoke(CHANNELS.workspaceRemount),
    /** 서버 상태를 지금 다시 읽는다 (캐시 폐기 + 보류 업로드 재시도). */
    refresh: (): Promise<WorkspaceStatusLike> => ipcRenderer.invoke(CHANNELS.workspaceRefresh),
    onStatus: (cb: (s: WorkspaceStatusLike) => void): (() => void) => {
      const h = (_e: unknown, s: WorkspaceStatusLike) => cb(s);
      ipcRenderer.on(CHANNELS.workspaceStatusEvent, h);
      return () => ipcRenderer.removeListener(CHANNELS.workspaceStatusEvent, h);
    },
  },

  /** Local MCP — host MCP servers here and bridge their tools to your agents. */
  mcp: {
    getEnabled: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.mcpGetEnabled),
    setEnabled: (enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.mcpSetEnabled, enabled),
    listServers: (): Promise<McpServerConfig[]> => ipcRenderer.invoke(CHANNELS.mcpListServers),
    saveServers: (servers: McpServerConfig[]): Promise<McpServerConfig[]> =>
      ipcRenderer.invoke(CHANNELS.mcpSaveServers, servers),
    testServer: (
      cfg: McpServerConfig,
    ): Promise<{
      ok: boolean;
      tools?: Array<{ name: string; description?: string }>;
      error?: string;
      /** 런타임 미설치 등 해결 가능한 실패일 때의 조치 안내. */
      hints?: string[];
    }> => ipcRenderer.invoke(CHANNELS.mcpTestServer, cfg),
    /** 테스트 중인 서버가 뱉는 출력 (첫 실행 다운로드 진행 상황 등). */
    onTestProgress: (cb: (p: { name?: string; lines: string[] }) => void): (() => void) => {
      const h = (_e: unknown, p: { name?: string; lines: string[] }) => cb(p);
      ipcRenderer.on(CHANNELS.mcpTestProgressEvent, h);
      return () => ipcRenderer.removeListener(CHANNELS.mcpTestProgressEvent, h);
    },
    status: (): Promise<McpBridgeStatusLike> => ipcRenderer.invoke(CHANNELS.mcpStatus),
    /** 서버들에 다시 붙어 상태를 갱신한다 (설정 화면 진입/테스트 성공 후). */
    refresh: (): Promise<McpBridgeStatusLike> => ipcRenderer.invoke(CHANNELS.mcpRefresh),
    runtimeLogs: (): Promise<McpRuntimeLogEntryLike[]> =>
      ipcRenderer.invoke(CHANNELS.mcpRuntimeLogs),
    clearRuntimeLogs: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.mcpClearRuntimeLogs),
    onRuntimeLog: (cb: (entry: McpRuntimeLogEntryLike) => void): (() => void) => {
      const h = (_e: unknown, entry: McpRuntimeLogEntryLike) => cb(entry);
      ipcRenderer.on(CHANNELS.mcpRuntimeLogEvent, h);
      return () => ipcRenderer.removeListener(CHANNELS.mcpRuntimeLogEvent, h);
    },
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
