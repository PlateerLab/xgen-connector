/**
 * Electron main process — the native shell of the XGEN connector.
 *
 * Owns: the app window, connector.json config, OS-keychain token storage, the
 * auto-updater, and the IPC surface the renderer uses to reach the XGEN API.
 * The renderer never talks to the network or keychain directly — everything
 * goes through the typed `window.xgen` bridge (see preload). The XgenClient
 * transport lives here in the main process (Node fetch), so tokens stay out of
 * the renderer.
 */
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  nativeTheme,
  screen,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  protocol,
  net,
  session,
  clipboard,
} from 'electron';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { XgenClient, type ChatEvent, type ChatRequest, type TtsSpeakOptions } from '../core/index';
import {
  loadConfig,
  saveConfig,
  resetConfig,
  normalizeServerUrl,
  type ConnectorConfig,
  type McpServerConfig,
  type WorkspacePersistConfig,
} from './config';
import {
  tokenStore,
  credentialStore,
  storageStatus,
  mcpSecretStore,
  mcpOAuthStore,
} from './keychain';
import { splitServerSecrets, withResolvedSecrets } from './mcp-secrets';
import { authorizeMcpServer, hasOAuthTokens, clearOAuth } from './mcp-oauth';
import {
  initUpdater,
  setAutoUpdate,
  setUpdateServer,
  getAutoUpdate,
  checkNow,
  checkForUpdatesAfterLogin,
  disposeUpdater,
} from './updater';
import { CHANNELS } from './ipc';
// ⚠ 정적 import 여야 한다. 런타임 require('./x') 는 번들러가 해석하지 않아
// 패키징본에서 'Cannot find module' 로 죽고, UI 는 조용히 아무 일도 하지
// 않는다 (v1.7.0 에서 에이전트 추가가 먹통이던 원인).
import { initWorkspaceManager, getWorkspaceManager } from './workspace-manager';
import { makeWorkspaceApi } from './workspace-api';
import { HttpSyncTransport, WorkspaceWsClient, type NetworkFetch } from './sync-transport';
import { LocalSyncManager } from './local-sync-manager';
import { getStatusFast as localRuntimeGetStatusFast } from './local-runtime-install';
import { SidecarDaemon, defaultSidecarCommand } from './local-agent-sidecar';
import { makeServerClient as makeLocalExecServerClient } from './local-agent-server-client';
import { LocalRuntimeConverger } from './local-runtime-converge';
import { LocalRuntimeEnsurer } from './local-runtime-ensure';
import {
  cliSettings as localCliSettings,
  getCliStatus as localCliGetStatus,
  installClaudeCli,
  installCodexCli,
} from './cli-provision';
import { runLocalChatTurn, describeFallback, type LocalChatDeps } from './local-chat-route';
import {
  consumeInstallOptions,
  resolveDataRoot,
  runtimeDirOf,
  settleDataRoot,
  writeCliInstallScripts,
} from './data-root';
import type { SyncRemote } from './local-sync';
import { isSafeRelPath } from './sync-plan';
import { hostname, userInfo } from 'os';
import { defaultDeviceName } from './device-name';
import { accountKey, describeAccount, moveRoot, rootConflict, rootOf } from './workspace';
import { TRAY_ICON_B64 } from './tray-icon';
import { getMcpManager, type McpHttpFetch } from './mcp-manager';
import { getMcpBridge } from './mcp-bridge';
import { getLocalToolProvider } from './local-tools';
import {
  clearMcpRuntimeLogs,
  mcpRuntimeLogs,
  onMcpRuntimeLog,
  setMcpRuntimeLogEnabled,
} from './mcp-runtime-log';
import {
  buildSsoUrl,
  parseSsoLoginResponse,
  shouldAllowPrivateCertificate,
  shouldIgnorePrivateCertificateError,
} from './connection-security';
import { createSsoWindowOptions } from './sso-window-options';
import { getBrowserRuntime } from './browser-runtime';
import { getBrowserToolProvider } from './browser-tools';
import { allowedBrowserUrl } from './browser-security';
import { systemMetricsSampler } from './system-metrics';

const IS_LINUX = process.platform === 'linux';

// Custom scheme the avatar overlay loads model assets through. Registered
// BEFORE app-ready. The renderer (a file:// / WebGL context) can't reliably
// fetch cross-origin avatar assets from the user's XGEN server (CORS/CSP vary
// by deployment); routing them through the MAIN process (Electron net.fetch, no
// CORS, no CSP) makes it work regardless. `standard` lets relative sibling refs
// (moc3/textures/atlas) resolve; `corsEnabled`+`bypassCSP` keep WebGL happy.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'xgenavatar',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: true,
    },
  },
]);

let tray: Tray | null = null;

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let ssoWindow: BrowserWindow | null = null;
let client: XgenClient | null = null;
const aborters = new Map<string, AbortController>();

/** The last avatar/chat state pushed from the main window, replayed to a
 * freshly-opened overlay so it isn't blank until the next stream event. */
let lastOverlayState: unknown = null;

/** Send to a window's renderer only if it (and its webContents) are still
 * alive. During app quit / auto-update restart the window can be torn down
 * while late callbacks (e.g. McpBridge.stop → status emit) still fire, and a
 * bare `win?.webContents.send` throws "Object has been destroyed" and crashes
 * the main process. This guards + swallows that race. */
function safeSend(win: BrowserWindow | null, channel: string, ...args: unknown[]): void {
  try {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, ...args);
    }
  } catch {
    /* window/webContents torn down mid-send — ignore */
  }
}

/** Broadcast a config change to every window (main + overlay + quick-chat) so
 * live prefs (theme, subtitles, avatarHidden, toggles) apply everywhere. */
function broadcastConfig(next: ConnectorConfig): void {
  for (const w of [mainWindow, overlayWindow, quickChatWindow]) {
    safeSend(w, CHANNELS.configChanged, next);
  }
}

/** Load a renderer page in either dev (Vite server) or prod (bundled file). */
function loadRendererPage(win: BrowserWindow, page: string): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) void win.loadURL(`${devUrl}/${page}`);
  else void win.loadFile(join(__dirname, `../renderer/${page}`));
}

function handleAuthFailure(): void {
  getMcpBridge().stop();
  getBrowserRuntime().configure({ enabled: false });
  safeSend(mainWindow, CHANNELS.authFailed);
}

function getClient(): XgenClient {
  const cfg = loadConfig();
  if (!client) {
    client = new XgenClient({
      baseUrl: normalizeServerUrl(cfg.serverUrl),
      // Chromium 네트워크 스택을 사용해 OS 프록시·인증서 정책을 공유한다.
      fetch: (input, init) => net.fetch(input, init),
      onAuthFailure: handleAuthFailure,
      // 토큰이 회전되는 **모든** 지점에서 keychain 을 즉시 갱신한다. 게이트웨이는
      // 회전 시 이전 토큰의 세션 키를 지우므로, 여기서 놓치면 keychain 을 읽는
      // 장수명 소비자(WS 브릿지·워크스페이스 동기화)가 폐기된 토큰으로 접속하다
      // 403(session revoked)에 갇힌다 — 실기에서 채팅은 되는데 WS 만 죽던 원인.
      onTokensRotated: (access, refresh) => {
        void tokenStore.setAccess(access);
        if (refresh) void tokenStore.setRefresh(refresh);
      },
    });
  } else {
    client.setBaseUrl(normalizeServerUrl(cfg.serverUrl));
  }
  return client;
}

/** 기본 세션의 인증서 정책을 현재 서버 설정에 맞춰 설치한다. */
function applyCertificatePolicy(): void {
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    const cfg = loadConfig();
    const allowed = shouldAllowPrivateCertificate(
      normalizeServerUrl(cfg.serverUrl),
      cfg.allowPrivateCertificate === true,
      request.hostname,
      request.verificationResult,
    );
    // 0은 이번 인증서를 승인하고, -3은 Chromium의 원래 판정을 사용한다.
    callback(allowed ? 0 : -3);
  });
}

function createWindow(): void {
  const cfg = loadConfig();
  mainWindow = new BrowserWindow({
    width: cfg.window?.width ?? 1100,
    height: cfg.window?.height ?? 760,
    x: cfg.window?.x,
    y: cfg.window?.y,
    minWidth: 860,
    minHeight: 600,
    show: false,
    title: 'XGEN Connector',
    // Hide the generic File/Edit/View/Window/Help bar (Alt still reveals it on
    // Win/Linux) so the app doesn't read as a raw Electron shell.
    autoHideMenuBar: true,
    // Paint the theme background immediately to avoid a white flash before the
    // renderer's CSS loads.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181d' : '#f7f8fa',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // 퀵 챗은 메인 창을 깨우지 않고 메시지를 전달한다 — 최소화/숨김 상태의
      // 렌더러도 스트림 이벤트를 즉시 처리하도록 스로틀링을 끈다.
      backgroundThrottling: false,
      // Shared browser pages are sandboxed <webview>s. Attachment is separately
      // allowlisted below; enabling the tag alone grants no URL/partition.
      webviewTag: true,
    },
  });

  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const runtime = getBrowserRuntime();
    const expectedPartition = runtime.partition();
    const safeUrl = allowedBrowserUrl(params.src);
    if (
      !runtime.isEnabled() ||
      !expectedPartition ||
      params.partition !== expectedPartition ||
      !safeUrl
    ) {
      event.preventDefault();
      return;
    }
    // Never accept preferences supplied by page markup. The guest has no Node,
    // preload, popup or web-security escape hatch.
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
  });
  mainWindow.webContents.on('did-attach-webview', (_event, guest) => {
    guest.setWindowOpenHandler(() => ({ action: 'deny' }));
    getBrowserRuntime().registerSharedGuest(guest);
  });
  getBrowserRuntime().setStateListener((state) =>
    safeSend(mainWindow, CHANNELS.browserStateEvent, state),
  );
  getBrowserRuntime().setConnectionListener((event) =>
    safeSend(mainWindow, CHANNELS.browserConnectionEvent, event),
  );

  mainWindow.on('ready-to-show', () => mainWindow?.show());
  mainWindow.on('close', (e) => {
    if (!mainWindow) return;
    const b = mainWindow.getBounds();
    saveConfig({ window: { width: b.width, height: b.height, x: b.x, y: b.y } });
    // Close-to-tray: closing the window HIDES it (the app keeps running in the
    // tray so the floating avatar + quick-chat hotkey stay alive). Real quit
    // goes through the tray "종료" / Cmd+Q, which sets appQuitting first.
    if (!appQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  attachContentResilience(mainWindow, () => {
    if (mainWindow) loadRendererPage(mainWindow, 'index.html');
  });
  loadRendererPage(mainWindow, 'index.html');
}

// ── Floating avatar overlay (Geny-style) ─────────────────────────
// A transparent, frameless, always-on-top, click-through window that floats the
// avatar (extension point) + a live subtitle of the active chat stream. When no
// avatar renderer is registered it shows just the streaming reply as a floating
// bubble ("아바타가 없으면 채팅만"). TTS/STT/screen-capture are intentionally omitted.
// ── overlay geometry: multi-monitor + mixed-DPI aware (ported from Geny) ──────
// Naive single-bounds persistence breaks across monitors with different scale
// factors: getBounds()/setBounds() round-trips the size through DIP↔physical and
// a WM_DPICHANGED rescale, so the saved width/height is wrong and the window
// "never sticks". The fix (Geny's) is to (1) remember bounds PER MONITOR keyed by
// a display signature, (2) suppress saves while a DPI change is settling, and
// (3) clamp restored bounds onto a currently-connected display.
type WinBounds = { x: number; y: number; width: number; height: number };
type DisplayT = ReturnType<typeof screen.getPrimaryDisplay>;

// Resolve saved bounds onto a CONNECTED display (overlap-most, else nearest), then
// clamp to its work area — a window saved on an unplugged monitor lands visibly on
// the nearest one instead of off-screen.
function restoreWinBounds(saved: WinBounds | undefined, defaults: WinBounds): WinBounds {
  if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite))
    return defaults;
  const wa = screen.getDisplayMatching(saved).workArea;
  const width = Math.max(240, Math.min(Math.round(saved.width), wa.width));
  const height = Math.max(220, Math.min(Math.round(saved.height), wa.height));
  const x = Math.round(Math.min(Math.max(saved.x, wa.x), wa.x + wa.width - width));
  const y = Math.round(Math.min(Math.max(saved.y, wa.y), wa.y + wa.height - height));
  return { x, y, width, height };
}

/** Keep a top-most window truly top-most for its lifetime (Geny 0.16.1 port).
 *
 * A one-shot `setAlwaysOnTop(true, 'screen-saver')` decays under z-order churn:
 * fullscreen/DPI transitions strip the bit, and later-created top-most peers
 * stack above us. Purely event-driven (no heartbeat) — re-assert on the exact
 * signals that can demote us, plus one settle re-check 900ms later because some
 * transitions (fullscreen entry) land after the event fires. */
function armAlwaysOnTop(win: BrowserWindow): void {
  let settle: ReturnType<typeof setTimeout> | null = null;
  const assertNow = (): void => {
    if (win.isDestroyed() || !win.isVisible() || win.isMinimized()) return;
    try {
      win.setAlwaysOnTop(true, 'screen-saver');
      if (process.platform === 'darwin') {
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      }
      win.moveTop(); // top of the topmost band — above later-created topmost peers
    } catch {
      /* window mid-teardown */
    }
  };
  const assert = (): void => {
    assertNow();
    if (settle) clearTimeout(settle);
    settle = setTimeout(() => {
      settle = null;
      assertNow();
    }, 900);
  };
  assertNow();
  win.on('show', assert);
  win.on('restore', assert);
  // Focus moved elsewhere — exactly when another window may have claimed the
  // top of the topmost band.
  win.on('blur', assert);
  // The OS actively stripped the bit (fullscreen/DPI transitions do this).
  win.on('always-on-top-changed', (_e, isOnTop) => {
    if (!isOnTop) assert();
  });
  // Display topology / fullscreen-driven metric changes (taskbar hide, work-
  // area, DPI) — the signal that fires when another app goes fullscreen.
  const onMetrics = (): void => assert();
  screen.on('display-metrics-changed', onMetrics);
  win.on('closed', () => {
    if (settle) clearTimeout(settle);
    screen.removeListener('display-metrics-changed', onMetrics);
  });
}

/** Self-recover a window's content instead of needing an app restart (Geny port):
 *  retry failed loads with backoff (server briefly down, network blip) and reload
 *  after a renderer crash. */
function attachContentResilience(win: BrowserWindow, reload: () => void): void {
  const wc = win.webContents;
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const clearRetry = () => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };
  wc.on('did-finish-load', () => {
    retries = 0;
    clearRetry();
  });
  wc.on('did-fail-load', (_e, errorCode, errorDesc, _url, isMainFrame) => {
    if (!isMainFrame) return; // ignore subresource failures
    if (errorCode === -3) return; // ERR_ABORTED — a superseding navigation, not a failure
    clearRetry();
    const delay = Math.min(2000 * Math.pow(1.6, retries), 20000); // 2s → cap 20s
    retries = Math.min(retries + 1, 10);
    console.warn(
      `[connector] content load failed (${errorCode} ${errorDesc}); retry in ${Math.round(delay)}ms`,
    );
    retryTimer = setTimeout(() => {
      if (!win.isDestroyed()) reload();
    }, delay);
  });
  wc.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return;
    console.warn(`[connector] renderer gone (${details.reason}); reloading`);
    clearRetry();
    retries = 0;
    if (!win.isDestroyed()) reload();
  });
  wc.on('destroyed', clearRetry);
}

// Set on display-metrics-changed; saves hold off until this passes so we persist
// SETTLED bounds, not the mid-DPI-rescale ones (which is how position ends up wrong).
let dpiSettleUntil = 0;

function displayKey(d: DisplayT): string {
  return `${d.bounds.x},${d.bounds.y}:${d.size.width}x${d.size.height}@${d.scaleFactor}`;
}
function overlayCurrentDisplay(): DisplayT | null {
  if (!overlayWindow || overlayWindow.isDestroyed()) return null;
  return screen.getDisplayMatching(overlayWindow.getBounds());
}
let lastOverlayDisplayKey = '';
let overlayGeomTimer: ReturnType<typeof setTimeout> | null = null;

/** Persist the overlay's geometry for the monitor it's on. Debounced, and waits
 *  out an in-flight DPI transition. `immediate` writes now (drag/resize END, or
 *  before teardown) so a fast restart can't lose it. */
function saveOverlayGeometry(immediate = false): void {
  if (overlayGeomTimer) {
    clearTimeout(overlayGeomTimer);
    overlayGeomTimer = null;
  }
  const run = () => {
    if (!overlayWindow || overlayWindow.isDestroyed() || overlayWindow.isMinimized()) return;
    const wait = dpiSettleUntil - Date.now();
    if (wait > 0 && !immediate) {
      overlayGeomTimer = setTimeout(run, wait + 100);
      return;
    }
    const d = overlayCurrentDisplay();
    if (!d) return;
    const b = overlayWindow.getBounds();
    const bounds: WinBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
    const cfg = loadConfig();
    saveConfig({
      overlayByDisplay: { ...(cfg.overlayByDisplay || {}), [displayKey(d)]: bounds },
      overlayBounds: bounds,
    });
  };
  if (immediate) run();
  else overlayGeomTimer = setTimeout(run, 450);
}

// On launch: apply the geometry remembered for whichever display the overlay opened on.
function restoreOverlayGeometry(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const d = overlayCurrentDisplay();
  if (!d) return;
  lastOverlayDisplayKey = displayKey(d);
  const cfg = loadConfig();
  const saved = cfg.overlayByDisplay?.[displayKey(d)] ?? asWinBounds(cfg.overlayBounds);
  if (saved) overlayWindow.setBounds(restoreWinBounds(saved, saved));
}
function asWinBounds(
  b: { width: number; height: number; x?: number; y?: number } | undefined,
): WinBounds | undefined {
  if (!b || b.x === undefined || b.y === undefined) return undefined;
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

// After a move settles on a DIFFERENT monitor, snap to THAT monitor's remembered
// size (keeping the dropped position) — fixes the DPI-move size distortion.
function applyOverlaySizeOnCross(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const d = overlayCurrentDisplay();
  if (!d) return;
  const key = displayKey(d);
  if (key === lastOverlayDisplayKey) return;
  lastOverlayDisplayKey = key;
  const saved = loadConfig().overlayByDisplay?.[key];
  if (!saved) {
    saveOverlayGeometry();
    return;
  }
  const wa = d.workArea;
  const width = Math.min(saved.width, wa.width);
  const height = Math.min(saved.height, wa.height);
  const b = overlayWindow.getBounds();
  const x = Math.round(Math.min(Math.max(b.x, wa.x), wa.x + wa.width - width));
  const y = Math.round(Math.min(Math.max(b.y, wa.y), wa.y + wa.height - height));
  overlayWindow.setBounds({ x, y, width, height });
}

// Authoritative drag rect: during a dock-handle drag we track the overlay's
// intended bounds in JS and re-assert a CONSTANT size each frame, instead of
// reading getBounds()/getPosition() (which drifts + grows the window on
// fractional DPI). See the overlay:moveBy handler for the full rationale.
let overlayMoveRect: { x: number; y: number; w: number; h: number } | null = null;
let overlayMoveIdle: ReturnType<typeof setTimeout> | null = null;
function endOverlayMove(): void {
  if (overlayMoveIdle) {
    clearTimeout(overlayMoveIdle);
    overlayMoveIdle = null;
  }
  overlayMoveRect = null;
  onOverlayMoved(); // reconcile size-on-cross + persist the settled bounds
}

// 'moved' fires during a drag + on the DPI cross; debounce, wait out the rescale,
// THEN reconcile size-on-cross and persist.
let overlayMovedTimer: ReturnType<typeof setTimeout> | null = null;
function onOverlayMoved(): void {
  if (overlayMovedTimer) clearTimeout(overlayMovedTimer);
  const run = () => {
    const wait = dpiSettleUntil - Date.now();
    if (wait > 0) {
      overlayMovedTimer = setTimeout(run, wait + 100);
      return;
    }
    applyOverlaySizeOnCross();
    saveOverlayGeometry();
  };
  overlayMovedTimer = setTimeout(run, 350);
}

// Any overlap with a work area = still (at least partly) visible.
function isVisibleOnSomeDisplay(b: WinBounds): boolean {
  return screen.getAllDisplays().some((d) => {
    const wa = d.workArea;
    const ix = Math.min(b.x + b.width, wa.x + wa.width) - Math.max(b.x, wa.x);
    const iy = Math.min(b.y + b.height, wa.y + wa.height) - Math.max(b.y, wa.y);
    return ix > 0 && iy > 0;
  });
}

// Monitor unplug/rearrange can leave a window entirely off-screen — pull only
// those back onto the nearest display; leave visible windows where the user put them.
function ensureWindowsOnScreen(): void {
  for (const win of [overlayWindow, mainWindow, quickChatWindow]) {
    if (!win || win.isDestroyed()) continue;
    const b = win.getBounds();
    if (isVisibleOnSomeDisplay(b)) continue;
    win.setBounds(restoreWinBounds(b, b));
  }
}

function createOverlay(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.show();
    return;
  }
  // Start from a sensible default near the cursor's display; restoreOverlay
  // Geometry() then applies the per-monitor remembered bounds after creation.
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const saved = loadConfig().overlayBounds;
  const width = saved?.width ?? 340;
  const height = saved?.height ?? 460;
  const x = saved?.x ?? wa.x + wa.width - width - 28;
  const y = saved?.y ?? wa.y + wa.height - height - 28;

  overlayWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: 240,
    minHeight: 220,
    transparent: true,
    frame: false,
    resizable: true,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // Float above full-screen apps — armed top-most (z-order churn/DPI 전환에도
  // 이벤트 기반으로 재선점; 일회성 setAlwaysOnTop 은 시간이 지나면 풀린다).
  armAlwaysOnTop(overlayWindow);
  attachContentResilience(overlayWindow, () => {
    if (overlayWindow) loadRendererPage(overlayWindow, 'overlay.html');
  });
  // 기본은 잠금 = 클릭 통과. 컨트롤은 별도 창이라 이 창이 통과여도 눌린다.
  applyOverlayInput();
  createOverlayChip();

  overlayWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Per-monitor geometry: restore this display's remembered bounds, then on every
  // move/resize reconcile size-on-cross + persist for the current monitor. On
  // Windows these events fire for programmatic setBounds/setPosition too; the
  // renderer also sends overlay:commitBounds on pointer-up as a cross-platform
  // guarantee (Linux doesn't emit them for programmatic bounds changes).
  restoreOverlayGeometry();
  overlayWindow.on('moved', () => {
    onOverlayMoved();
    syncChipBounds();
  });
  overlayWindow.on('resized', () => {
    saveOverlayGeometry();
    syncChipBounds();
  });
  // 아바타가 숨거나 다시 보이면 컨트롤도 같이 — 잠긴 채 숨은 아바타 위에
  // 버튼만 떠 있으면 사용자는 그게 무엇의 컨트롤인지 알 수 없다.
  overlayWindow.on('show', () => applyChipVisibility());
  overlayWindow.on('hide', () => applyChipVisibility());
  overlayWindow.on('closed', () => {
    overlayWindow = null;
    destroyOverlayChip();
  });
  overlayWindow.once('ready-to-show', () => {
    overlayWindow?.show();
    applyChipVisibility();
    if (lastOverlayState) overlayWindow?.webContents.send(CHANNELS.overlayState, lastOverlayState);
  });

  loadRendererPage(overlayWindow, 'overlay.html');
}

// ── 컨트롤 창 (잠금 시 액션바) ────────────────────────────────────────
//
// 아바타 창 바깥에 있으므로 아바타의 입력 상태와 무관하게 항상 눌린다.
// 아바타를 따라다니고, 아바타가 안 보이면 같이 숨는다.
let overlayChip: BrowserWindow | null = null;
let overlayLocked = true;

/** 컨트롤 창 크기. 렌더러가 실제 내용 폭을 재서 알려 준다 (버튼 수는
 *  STT/TTS 사용 가능 여부에 따라 달라진다). */
// 첫 보고 전 기본값은 **작게** 잡는다. 크게 잡으면 그 남는 영역이 잠깐
// 보이고, 투명해도 그만큼 데스크톱 클릭을 먹는다.
let chipSize = { w: 46, h: 38 };

/** 컨트롤 창 아래 여백 — 아바타 창 바닥에서 이만큼 띄운다. */
const CHIP_MARGIN = 6;

function chipBoundsFor(b: Electron.Rectangle): Electron.Rectangle {
  return {
    x: Math.round(b.x + (b.width - chipSize.w) / 2),
    y: Math.round(b.y + b.height - chipSize.h - CHIP_MARGIN),
    width: chipSize.w,
    height: chipSize.h,
  };
}

/** 컨트롤 창이 아바타 창 바닥을 얼마나 덮고 있는가.
 *
 * 컨트롤은 별도 창이라 아바타 페이지는 그 존재를 알 수 없다. 그대로 두면
 * 자막 말풍선 위에 버튼이 겹쳐 그려진다 — 마지막 대사가 가려진다. 메인만이
 * 두 사각형을 모두 아는 쪽이므로 여기서 알려 주고, 페이지가 바닥 기준
 * 요소들을 그만큼 들어 올린다. 잠금이 풀려 컨트롤이 숨으면 0 이다. */
function chipInsetPx(): number {
  const visible = !!overlayChip && !overlayChip.isDestroyed() && overlayChip.isVisible();
  return visible ? chipSize.h + CHIP_MARGIN * 2 : 0;
}

function publishChipInset(): void {
  try {
    overlayWindow?.webContents.send(CHANNELS.overlayChipInset, chipInsetPx());
  } catch {
    /* 창이 사라졌다 */
  }
}

/** 컨트롤을 아바타 위로 다시 올린다. 싸고 멱등하다. */
function raiseChip(): void {
  if (!overlayChip || overlayChip.isDestroyed() || !overlayChip.isVisible()) return;
  try {
    overlayChip.setAlwaysOnTop(true, 'screen-saver');
    overlayChip.moveTop();
  } catch {
    /* 정리 중 */
  }
}

function syncChipBounds(): void {
  if (!overlayChip || overlayChip.isDestroyed()) return;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  try {
    overlayChip.setBounds(chipBoundsFor(overlayWindow.getBounds()));
    raiseChip();
  } catch {
    /* 정리 중 */
  }
}

function applyChipVisibility(): void {
  if (!overlayChip || overlayChip.isDestroyed()) return;
  const shouldShow =
    overlayLocked && !!overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible();
  if (shouldShow) {
    syncChipBounds();
    // showInactive: 포커스를 가져가면 아바타가 다시 잠길 때마다 사용자가
    // 하던 일에서 끌려 나온다.
    if (!overlayChip.isVisible()) overlayChip.showInactive();
    raiseChip();
  } else if (overlayChip.isVisible()) {
    overlayChip.hide();
  }
  // 위의 show/hide 뒤에 알린다 — 화면에 실제로 있는 것을 알려야 한다.
  publishChipInset();
}

function createOverlayChip(): void {
  if (overlayChip && !overlayChip.isDestroyed()) return;
  overlayChip = new BrowserWindow({
    width: chipSize.w,
    height: chipSize.h,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // armAlwaysOnTop 은 쓰지 않는다: blur/show 훅과 재선점 타이머를 건다.
  // 아바타 옆의 **두 번째** 최상위 창에 그걸 돌리면 z-order 트래픽만 늘고
  // 얻는 것이 없다 — 컨트롤은 작고, 아바타와 함께 만들어지고 사라진다.
  overlayChip.on('closed', () => {
    overlayChip = null;
  });
  overlayChip.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  // 페이지가 그려진 뒤에 띄운다 — 그 전에 show 하면 투명한 빈 사각형이
  // 잠깐 떠서 데스크톱 클릭을 먹는다.
  overlayChip.once('ready-to-show', () => applyChipVisibility());
  loadRendererPage(overlayChip, 'chip.html');
}

function destroyOverlayChip(): void {
  if (overlayChip && !overlayChip.isDestroyed()) overlayChip.destroy();
  overlayChip = null;
}

// ── 잠금과 입력: 컨트롤은 **자기 창**에 산다 ─────────────────────────
//
// 잠긴 아바타는 모든 플랫폼에서 클릭을 데스크톱으로 흘려보내야 한다. 그런데
// 입력이 통과하는 창은 **자기 잠금 해제 버튼을 담을 수 없다.**
//
// 예전에는 한 창 안에서 hover 로 입력을 되살렸다 (`setIgnoreMouseEvents(true,
// {forward:true})` → 마우스가 컨트롤 위에 오면 ignore 를 끈다). 그 방식은
// 무너진다:
//
//   * `forward` 는 darwin/win32 전용이다. 리눅스에서는 이벤트가 아예 안 와서
//     hover 복귀가 영원히 불가능하다 — 잠그면 되돌릴 방법이 없다.
//   * darwin/win32 에서도 forward 되는 것은 **이동 이벤트뿐**이고, hover 감지
//     → IPC 왕복 → ignore 해제 사이에 누른 클릭은 사라진다. 사용자에게는
//     "버튼이 보이는데 눌리지 않는다" 로 보인다.
//
// 그래서 컨트롤을 **작은 별도 창**으로 뺀다. 그 창은 언제나 인터랙티브고
// 아바타를 따라다닌다. 아바타 창은 잠금 여부만으로 입력을 정하면 된다 —
// 플랫폼 분기도, hover 곡예도 없다. (geny-connector 가 같은 버그를 이렇게
// 해결했고, 그 구조를 그대로 가져온다.)
function applyOverlayIgnoreMouse(win: BrowserWindow | null, ignore: boolean): void {
  if (!win || win.isDestroyed()) return;
  // 모든 플랫폼에서 같은 규칙. forward 는 미지원 플랫폼에서 무시된다.
  win.setIgnoreMouseEvents(ignore, IS_LINUX ? undefined : { forward: true });
}

/** 잠금 상태는 **여기가** 소유한다 — 두 창(아바타 + 컨트롤)이 서로 다르게
 *  알고 있으면 안 된다. */
function setOverlayLocked(locked: boolean): void {
  overlayLocked = locked;
  applyOverlayInput();
  applyChipVisibility();
  try {
    overlayWindow?.webContents.send(CHANNELS.overlayLocked, locked);
    overlayChip?.webContents.send(CHANNELS.overlayLocked, locked);
  } catch {
    /* 창이 사라졌다 */
  }
}

/** 오버레이의 입력 상태를 정하는 **유일한** 곳. */
function applyOverlayInput(): void {
  applyOverlayIgnoreMouse(overlayWindow, overlayLocked);
}

/** 무슨 상태에 빠졌든 사용자에게 통제권을 돌려준다 (트레이).
 *  대가는 아바타에 잘못 닿는 클릭 하나; 통제권을 잃는 것보다 싸다. */
function forceOverlayInteractive(): void {
  setOverlayLocked(false);
  try {
    overlayWindow?.setIgnoreMouseEvents(false);
    overlayWindow?.showInactive();
  } catch {
    /* ignore */
  }
}

function setOverlayEnabled(enabled: boolean): void {
  const next = saveConfig({ avatarOverlay: enabled });
  if (enabled) createOverlay();
  else if (overlayWindow && !overlayWindow.isDestroyed()) {
    saveOverlayGeometry(true); // persist last move/resize before tearing the window down
    overlayWindow.destroy();
    overlayWindow = null;
    destroyOverlayChip();
  }
  // Keep the main window's toggle in sync (e.g. when closed via the overlay ✕).
  broadcastConfig(next);
  rebuildTrayMenu();
}

/** Hide only the avatar inside the overlay (the floating chat + subtitle stay). */
function setAvatarHidden(hidden: boolean): void {
  const next = saveConfig({ avatarHidden: hidden });
  broadcastConfig(next);
  rebuildTrayMenu();
}

// ── Quick-chat: Spotlight-style floating input bar (Geny-style) ───────────────
// A permanent, transparent, top-most, click-through window: the WINDOW stays
// alive/on-screen at all times (so it layers above full-screen apps); only its
// card paints while summoned. A global hotkey toggles it; submit relays the text
// into the active agent chat in the main window.
const QUICKCHAT_W = 600;
const QUICKCHAT_H = 176;
// Ctrl + Shift + / (i.e. Ctrl + ?). NOTE: Electron globalShortcut can't tell
// left/right Shift apart — accelerators only have a generic `Shift`.
const DEFAULT_QUICKCHAT = 'Control+Shift+/';
let quickChatWindow: BrowserWindow | null = null;
let quickChatOpen = false;
let quickChatShownAt = 0;
let quickChatPosTimer: ReturnType<typeof setTimeout> | null = null;
let suppressQuickChatPosSave = false;
let appQuitting = false;

function persistQuickChatPos(): void {
  if (suppressQuickChatPosSave) return;
  if (quickChatPosTimer) clearTimeout(quickChatPosTimer);
  quickChatPosTimer = setTimeout(() => {
    if (!quickChatWindow || quickChatWindow.isDestroyed() || !quickChatOpen) return;
    const [x, y] = quickChatWindow.getPosition();
    saveConfig({ quickChatBar: { x, y } });
  }, 350);
}

function positionQuickChat(): void {
  if (!quickChatWindow) return;
  suppressQuickChatPosSave = true;
  const saved = loadConfig().quickChatBar;
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    // Multi-monitor aware: restore onto whichever display the bar was on, clamped
    // to fit (guards a closed/moved monitor). Size is fixed (QUICKCHAT_W/H).
    const rect = { x: saved.x, y: saved.y, width: QUICKCHAT_W, height: QUICKCHAT_H };
    const b = restoreWinBounds(rect, rect);
    quickChatWindow.setBounds({ x: b.x, y: b.y, width: QUICKCHAT_W, height: QUICKCHAT_H });
  } else {
    const pt = screen.getCursorScreenPoint();
    const wa = screen.getDisplayNearestPoint(pt).workArea;
    const x = Math.round(wa.x + (wa.width - QUICKCHAT_W) / 2);
    const y = Math.round(wa.y + wa.height * 0.22);
    quickChatWindow.setBounds({ x, y, width: QUICKCHAT_W, height: QUICKCHAT_H });
  }
  setTimeout(() => {
    suppressQuickChatPosSave = false;
  }, 120);
}

function createQuickChat(): void {
  if (quickChatWindow && !quickChatWindow.isDestroyed()) return;
  quickChatWindow = new BrowserWindow({
    width: QUICKCHAT_W,
    height: QUICKCHAT_H,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  armAlwaysOnTop(quickChatWindow);
  attachContentResilience(quickChatWindow, () => {
    if (quickChatWindow) loadRendererPage(quickChatWindow, 'quickchat.html');
  });
  quickChatWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  quickChatWindow.on('blur', () => {
    if (!quickChatOpen) return;
    if (Date.now() - quickChatShownAt < 450) return;
    dismissQuickChat();
  });
  quickChatWindow.on('move', persistQuickChatPos);
  quickChatWindow.on('moved', persistQuickChatPos);
  quickChatWindow.on('close', (e) => {
    if (!appQuitting) {
      e.preventDefault();
      dismissQuickChat();
    }
  });
  quickChatWindow.on('closed', () => {
    quickChatWindow = null;
  });
  loadRendererPage(quickChatWindow, 'quickchat.html');
  positionQuickChat();
  // 퀵챗은 hover 복귀가 필요 없다 (핫키 소환 시 ignore=false 를 명시 설정)
  // — 리눅스에선 미지원 forward 옵션만 뺀다.
  if (IS_LINUX) quickChatWindow.setIgnoreMouseEvents(true);
  else quickChatWindow.setIgnoreMouseEvents(true, { forward: true });
  quickChatWindow.showInactive();
}

function dismissQuickChat(): void {
  if (!quickChatWindow || quickChatWindow.isDestroyed()) return;
  quickChatOpen = false;
  if (IS_LINUX) quickChatWindow.setIgnoreMouseEvents(true);
  else quickChatWindow.setIgnoreMouseEvents(true, { forward: true });
  quickChatWindow.webContents.send(CHANNELS.quickChatDismissed);
}

function showQuickChatOnTop(): void {
  if (!quickChatWindow) return;
  quickChatOpen = true;
  quickChatShownAt = Date.now();
  quickChatWindow.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') {
    quickChatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  quickChatWindow.setIgnoreMouseEvents(false);
  quickChatWindow.moveTop();
  quickChatWindow.webContents.send(CHANNELS.quickChatOpened);
  setTimeout(() => {
    if (!quickChatWindow || !quickChatOpen) return;
    quickChatWindow.focus();
    quickChatWindow.moveTop();
  }, 110);
}

function toggleQuickChat(): void {
  if (!quickChatWindow || quickChatWindow.isDestroyed()) createQuickChat();
  if (quickChatOpen) {
    dismissQuickChat();
    return;
  }
  positionQuickChat();
  showQuickChatOnTop();
}

/** Relay a quick-chat message into the main window's active agent chat. */
function deliverQuickChat(text: string): { ok: boolean; error?: string } {
  const body = (text ?? '').trim();
  if (!body) return { ok: false, error: '메시지를 입력하세요.' };
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: '앱 창을 열어주세요.' };
  // 퀵 챗은 퀵 챗일 뿐 — 메인 창의 상태(최소화/숨김/포커스)를 절대 건드리지
  // 않는다. 숨김/최소화 창에도 IPC 는 정상 전달되고 스트림은 main 프로세스가
  // 소유하므로, 대화는 뒤에서 진행되고 나중에 창을 열면 그대로 보인다.
  mainWindow.webContents.send(CHANNELS.quickSend, body);
  return { ok: true };
}

function registerQuickChatHotkey(): void {
  const cfg = loadConfig();
  globalShortcut.unregister(cfg.quickChatHotkey ?? DEFAULT_QUICKCHAT);
  if (!cfg.quickChat) return;
  const acc = cfg.quickChatHotkey ?? DEFAULT_QUICKCHAT;
  try {
    globalShortcut.register(acc, () => toggleQuickChat());
  } catch {
    /* ignore invalid accelerator */
  }
}

function setQuickChatEnabled(enabled: boolean): void {
  const next = saveConfig({ quickChat: enabled });
  if (enabled) {
    createQuickChat();
    registerQuickChatHotkey();
  } else {
    globalShortcut.unregister(next.quickChatHotkey ?? DEFAULT_QUICKCHAT);
    if (quickChatOpen) dismissQuickChat();
  }
  broadcastConfig(next);
  rebuildTrayMenu();
}

// ── Window / app management ──────────────────────────────────────
function showMain(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    mainWindow?.once('ready-to-show', () => mainWindow?.show());
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function openMainSettings(): void {
  showMain();
  safeSend(mainWindow, CHANNELS.openSettingsModal);
}

/** 로그인 시 자동 시작 적용 — **실효 결과**를 반환한다 (UI 가 거짓 토글을
 *  보여주지 않도록; geny-connector 동형).
 *
 *  Linux: electron 의 setLoginItemSettings 는 no-op 이라 XDG autostart
 *  (.desktop) 파일을 직접 쓴다. AppImage 를 임시 마운트 경로(/tmp/.mount_*)
 *  에서 실행 중이면 재부팅 후 존재하지 않는 경로라 등록을 거부한다.
 *  Desktop-Entry 의 % 는 필드 코드라 %% 로 이스케이프한다. */
function applyAutoLaunch(enabled: boolean): boolean {
  if (!IS_LINUX) {
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: enabled, args: ['--hidden'] });
    return enabled;
  }
  const autostartDir = join(homedir(), '.config', 'autostart');
  const desktopPath = join(autostartDir, 'xgen-connector.desktop');
  if (!enabled) {
    try {
      rmSync(desktopPath, { force: true });
    } catch {
      /* best-effort */
    }
    return false;
  }
  // AppImage 는 $APPIMAGE(영속 파일)를, 그 외는 실행 바이너리를 가리킨다.
  const target = process.env.APPIMAGE || app.getPath('exe');
  if (!target || target.includes(`${sep}.mount_`) || target.startsWith('/tmp/')) {
    // 임시 마운트에서 실행 중 — 재부팅 후 깨진 경로가 된다. 등록 거부.
    return false;
  }
  try {
    mkdirSync(autostartDir, { recursive: true });
    const exec = `"${target.replace(/%/g, '%%')}" --hidden`;
    writeFileSync(
      desktopPath,
      [
        '[Desktop Entry]',
        'Type=Application',
        'Name=XGEN Connector',
        `Exec=${exec}`,
        'X-GNOME-Autostart-enabled=true',
        'NoDisplay=false',
        'Terminal=false',
      ].join('\n') + '\n',
      'utf-8',
    );
    chmodSync(desktopPath, 0o644);
    return true;
  } catch {
    return false;
  }
}

/** Linux-안전 재시작 (geny-connector 이식): `app.relaunch()` 는 리눅스에서
 *  `--type=relauncher` 헬퍼를 거치며 NoNewPrivs 를 설정한다 — 비가역이라
 *  재시작된 프로세스의 SUID chrome-sandbox 가 죽는다 (Ubuntu 24.04 SIGTRAP).
 *  리눅스는 분리된 셸로 1초 뒤 재실행; 그 외 플랫폼은 표준 relaunch. */
function relaunchSelf(): void {
  appQuitting = true;
  if (IS_LINUX) {
    const target = process.env.APPIMAGE || app.getPath('exe');
    try {
      spawn('/bin/sh', ['-c', 'sleep 1; exec "$@"', 'relaunch', target], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    } catch {
      app.relaunch(); // 폴백 — 없는 것보단 낫다
    }
    app.quit();
    return;
  }
  app.relaunch();
  app.quit();
}

function resetPositions(): void {
  saveConfig({ overlayBounds: undefined, overlayByDisplay: undefined, quickChatBar: undefined });
  lastOverlayDisplayKey = '';
  const wa = screen.getPrimaryDisplay().workArea;
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    const w = 340;
    const h = 460;
    overlayWindow.setBounds({
      x: wa.x + wa.width - w - 28,
      y: wa.y + wa.height - h - 28,
      width: w,
      height: h,
    });
    overlayWindow.show();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBounds({
      x: Math.round(wa.x + (wa.width - 1100) / 2),
      y: Math.round(wa.y + (wa.height - 760) / 2),
      width: 1100,
      height: 760,
    });
  }
  // quick-chat re-centers on its next summon now that quickChatBar is cleared.
}

/** 로컬 설정과 로그인 정보를 지운 뒤 배포 기본값으로 다시 시작한다. */
async function resetStoredSettings(): Promise<void> {
  getMcpBridge().stop();
  void client?.logout().catch(() => undefined);
  client = null;
  await Promise.allSettled([
    tokenStore.clear(),
    credentialStore.clear(),
    getWorkspaceManager()?.stop() ?? Promise.resolve(),
  ]);
  applyAutoLaunch(false);
  resetConfig();
  relaunchSelf();
}

// ── System tray (작업 표시줄) ─────────────────────────────────────
/** 트레이 생성 — 실패를 허용한다 (리눅스에서 appindicator 부재 시 throw).
 *  @returns 트레이가 실제로 생겼는지. false 면 호출자는 --hidden 시작을
 *  취소해야 한다 — 트레이도 창도 없는 좀비 프로세스 방지 (geny 동형). */
function createTray(): boolean {
  if (tray) return true;
  try {
    const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_B64}`);
    tray = new Tray(icon);
    tray.setToolTip('XGEN Connector');
    rebuildTrayMenu();
    tray.on('click', () => showMain());
    return true;
  } catch {
    tray = null;
    return false;
  }
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  const cfg = loadConfig();
  const overlayOn = !!(overlayWindow && !overlayWindow.isDestroyed());
  const menu = Menu.buildFromTemplate([
    { label: '채팅 창 열기', click: () => showMain() },
    { label: '빠른 채팅', click: () => toggleQuickChat() },
    { label: '설정', click: () => openMainSettings() },
    {
      label: overlayOn ? '미니 채팅 숨기기' : '미니 채팅 표시',
      click: () => setOverlayEnabled(!overlayOn),
    },
    {
      label: cfg.avatarHidden ? '아바타 표시' : '아바타 숨기기',
      enabled: overlayOn,
      click: () => setAvatarHidden(!cfg.avatarHidden),
    },
    { type: 'separator' },
    {
      label: '자동 업데이트',
      type: 'checkbox',
      checked: cfg.autoUpdate !== false,
      click: (item) => {
        setAutoUpdate(item.checked);
        saveConfig({ autoUpdate: item.checked });
      },
    },
    { label: '업데이트 확인', click: () => void checkNow() },
    { label: `버전 ${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    {
      label: '로그인 시 시작',
      type: 'checkbox',
      checked: cfg.autoLaunch === true,
      click: (item) => {
        // IPC 핸들러와 동일하게 **실효 결과**를 저장 (리눅스 등록 거부 시
        // 체크만 켜진 거짓 상태 방지).
        const effective = applyAutoLaunch(item.checked);
        saveConfig({ autoLaunch: effective });
        rebuildTrayMenu();
      },
    },
    {
      // 비상구. 오버레이가 어떤 상태에 빠졌든 통제권을 돌려준다 — 대가는
      // 아바타에 잘못 닿는 클릭 하나이고, 통제권을 잃는 것보다 싸다.
      label: '아바타 조작 복구',
      click: () => forceOverlayInteractive(),
    },
    { label: '위치 초기화', click: () => resetPositions() },
    { type: 'separator' },
    {
      label: '재시작',
      click: () => relaunchSelf(),
    },
    {
      label: '종료',
      click: () => {
        appQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

// ── Local MCP (connector-hosted MCP servers → user's agents) ─────
let mcpStatusWired = false;
let mcpRuntimeLogWired = false;
const mcpHttpSession = () => session.fromPartition('xgen-mcp-http');
const mcpHttpFetch: McpHttpFetch = (url, init) =>
  mcpHttpSession().fetch(url instanceof URL ? url.toString() : url, init);

/** HTTP MCP 전용 세션에만 사설 인증서 예외를 설치한다. */
function applyMcpHttpCertificatePolicy(): void {
  mcpHttpSession().setCertificateVerifyProc((request, callback) => {
    const allowed = shouldIgnorePrivateCertificateError(
      loadConfig().allowPrivateCertificate === true,
      request.verificationResult,
    );
    callback(allowed ? 0 : -3);
  });
}

function currentUserId(): string | null {
  return client?.user?.userId ?? null;
}
/**
 * 현재 유효한 액세스 토큰 — **라이브 클라이언트(회전 반영) 우선**, 없으면 keychain.
 * WS 브릿지·워크스페이스 동기화가 keychain 만 읽으면, 세션 중 회전 시점과
 * keychain 기록 사이의 틈에서 폐기된 토큰을 집는다. 단일 소스로 그 틈을 없앤다.
 */
async function liveAccessToken(): Promise<string> {
  const live = client?.getAccessTokenAfterRotation();
  if (live) return live;
  return (await tokenStore.getAccess()) ?? '';
}
/**
 * 인증 실패(401/403)를 맞은 소비자의 자가치유 — refresh 토큰으로 액세스 토큰을
 * 회전(single-flight, core 가 보장)하고 새 토큰을 돌려준다. onTokensRotated 가
 * keychain 도 함께 갱신한다. null = 회전 불가(진짜 재로그인 대상).
 */
async function refreshAuthToken(): Promise<string | null> {
  const c = client;
  if (!c) return null;
  const fallback = (await tokenStore.getRefresh()) ?? undefined;
  return c.ensureFreshAuth(fallback);
}
/** Reconcile MCP manager + bridge with config + login state. */
function syncMcp(): void {
  const cfg = loadConfig();
  setMcpRuntimeLogEnabled(cfg.mcpDebug === true);
  const mcp = getMcpManager();
  // 로컬 MCP 마스터 스위치: cfg.mcp 가 꺼져 있으면 서버 목록을 비워 넘긴다 →
  // configure 가 기존 서버를 전부 disconnect·제거한다. 이전에는 mcp:false 여도
  // 서버가 스폰되고 도구가 카탈로그에 실리던 버그가 있었다.
  mcp.configure(cfg.mcp ? cfg.mcpServers : [], {
    httpFetch: mcpHttpFetch,
    allowPrivateCertificate: cfg.allowPrivateCertificate === true,
  });
  // 서버가 도구 목록을 바꾸거나(list_changed) 죽으면 카탈로그를 에이전트에 다시 광고한다.
  mcp.setCatalogChangeListener(() => {
    void getMcpBridge().refreshCatalog();
  });
  // Browser pages and connector-hosted tools share the bridge catalog. Browser
  // state is account-scoped; without a live user configure() tears pages down.
  getBrowserRuntime().configure({
    enabled: cfg.browser?.enabled === true,
    serverUrl: normalizeServerUrl(cfg.serverUrl),
    userId: currentUserId() ?? undefined,
    newTabUrl: cfg.browser?.newTabUrl,
  });
  const browserTools = getBrowserToolProvider(getBrowserRuntime());
  browserTools.configure(cfg.browser?.enabled === true, cfg.localShell?.allowedRoots ?? []);
  getLocalToolProvider().configure(cfg.localShell, browserTools);
  const bridge = getMcpBridge();
  if (!mcpStatusWired) {
    mcpStatusWired = true;
    bridge.setStatusListener((s) => safeSend(mainWindow, CHANNELS.mcpStatusEvent, s));
  }
  if (!mcpRuntimeLogWired) {
    mcpRuntimeLogWired = true;
    onMcpRuntimeLog((entry) => safeSend(mainWindow, CHANNELS.mcpRuntimeLogEvent, entry));
  }
  const userId = currentUserId();
  // The bridge is the single conduit for BOTH external MCP servers and the
  // connector's built-in local tools. Start it when EITHER is on — the local
  // shell capability must reach the agent even if the user configured no MCP
  // servers (it is the out-of-the-box default).
  const builtinOn = getLocalToolProvider().advertise().length > 0;
  if ((cfg.mcp || builtinOn) && userId) {
    // start() is idempotent for the same target: it refreshes the catalog on a
    // live socket instead of tearing it down, so repeated syncMcp() (e.g. on
    // token refresh / restore) never flaps the connection status.
    bridge.start({
      serverUrl: normalizeServerUrl(cfg.serverUrl),
      userId,
      allowPrivateCertificate: cfg.allowPrivateCertificate === true,
      // 라이브 토큰 우선 — keychain 만 읽으면 세션 중 회전 시 폐기 토큰을 집는다.
      getToken: async () => (await liveAccessToken()) || null,
      refreshAuth: refreshAuthToken,
    });
  } else {
    bridge.stop();
  }
}
function setMcpEnabled(enabled: boolean): void {
  const next = saveConfig({ mcp: enabled });
  syncMcp();
  broadcastConfig(next);
}

// ── Workspace 동기화 (에이전트 workflow ↔ 로컬 폴더, Drive형) ─────
/** 이 설치본의 안정 디바이스 id — 최초 1회 생성 후 config 에 영속. */
/**
 * 이 PC 의 표시 이름.
 *
 * 로컬 로그인 이름은 클라우드 트리에서 아무것도 구분하지 않는다 — 클라우드는
 * 이미 XGEN 계정으로 갈린다. 그래서 호스트명 앞의 로그인 이름을 걷어낸다.
 *
 * **바꿀 수 있게 두지 않는다.** 이 이름은 서버가 이 기기를 **처음** 볼 때
 * 폴더 이름이 되고, 그 폴더는 이후 어떤 이름 변경에도 움직이지 않는다. 바꿀
 * 수 있게 하면 사용자는 주소를 옮기려 하고, 파일은 예전 자리에 남는다.
 */
function deviceNameOf(): string {
  return defaultDeviceName(hostname(), userInfo().username);
}

function ensureDeviceId(): string {
  const cfg = loadConfig();
  if (cfg.deviceId) return cfg.deviceId;
  const id = randomUUID();
  saveConfig({ deviceId: id });
  return id;
}

// ── IPC: config ──────────────────────────────────────────────────
ipcMain.handle(CHANNELS.configGet, () => loadConfig());
/** 서버 주소 확정 — 스킴이 없으면 https → http 순으로 실제로 두드려 정한다. */
ipcMain.handle(CHANNELS.configProbeServer, async (_e, input: string) => {
  const { resolveServerUrl } = await import('./server-probe');
  return resolveServerUrl(String(input ?? ''), async (url) => {
    // 상태코드는 무엇이든 좋다 — fetch 가 resolve 만 하면 그 스킴은 살아 있다.
    await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(4000),
    });
  });
});
ipcMain.handle(CHANNELS.configSet, async (_e, patch: Partial<ConnectorConfig>) => {
  // 서버 전환 = 계정 공간 전환: 구 서버의 세션/저장 자격 증명은 새 서버에서
  // 무의미하므로 여기서 전부 정리하고 재로그인을 요구한다. 원격 로그아웃은
  // best-effort 로만 시도한다 — 구 서버가 죽어서 주소를 바꾸는 경우가 흔해
  // 응답을 기다리면 설정 저장 자체가 막힌다. (최초 설정(prev 없음)은 제외.)
  const prevServer = normalizeServerUrl(loadConfig().serverUrl);
  const serverChanged =
    patch.serverUrl !== undefined &&
    !!prevServer &&
    normalizeServerUrl(patch.serverUrl) !== prevServer;
  if (serverChanged) {
    getMcpBridge().stop();
    await getBrowserRuntime().closeAll();
    getBrowserRuntime().configure({ enabled: false });
    void client?.logout().catch(() => undefined); // 구 서버 세션 무효화 (rebind 전 호출)
    client = null; // in-memory user/token 을 남기지 않도록 새 인스턴스로
    // ⚠ **client 를 비운 뒤에** 걷는다. 앞에서 부르면 아직 살아 있는
    // `client.user` 때문에 리컨사일이 "로그인 중" 으로 판단해 구 서버의
    // 마운트를 그대로 남긴다 (로그아웃 경로와 같은 함정).
    await getWorkspaceManager()?.reconcile();
    await tokenStore.clear();
    await credentialStore.clear();
    patch = { ...patch, autoLogin: false }; // 저장된 자동 로그인은 구 서버 계정
  }
  const next = saveConfig(patch);
  if (patch.serverUrl !== undefined) getClient(); // rebind base URL
  if (patch.serverUrl !== undefined || patch.allowPrivateCertificate !== undefined) {
    // 검증 결과는 network service에 캐시되므로 proc을 다시 설치하고 기존
    // 연결을 닫아 다음 요청부터 새 정책을 사용한다.
    applyCertificatePolicy();
    await session.defaultSession.closeAllConnections();
  }
  if (patch.allowPrivateCertificate !== undefined) {
    applyMcpHttpCertificatePolicy();
    await mcpHttpSession().closeAllConnections();
    syncMcp();
    getWorkspaceManager()?.restartPresence();
  }
  if (patch.autoUpdate !== undefined) setAutoUpdate(!!patch.autoUpdate);
  if (patch.updateServer !== undefined) setUpdateServer(patch.updateServer);
  // 로컬 셸 접근 토글/설정: 프로바이더를 재구성하고 카탈로그를 다시 광고한다
  // (켜면 브릿지가 없던 경우 뜨고, 끄면 도구가 카탈로그에서 빠진다).
  if (patch.localShell !== undefined || patch.browser !== undefined) syncMcp();
  // 기본 작업 폴더/토글 변경 → 에이전트 workspace 로컬 동기화도 따라간다.
  if (patch.localShell !== undefined) localSync?.reconcile();
  if (patch.theme) nativeTheme.themeSource = patch.theme;
  if (patch.linuxClickThrough !== undefined) {
    // 즉시 재적용: 클릭 통과가 켜진 오버레이는 마우스 이벤트를 못 받아
    // 렌더러 IPC 로는 다시 끌 수 없다 — 설정 토글이 유일한 복귀 경로.
    applyOverlayIgnoreMouse(overlayWindow, true);
  }
  broadcastConfig(next);
  if (serverChanged) safeSend(mainWindow, CHANNELS.authFailed); // → 로그인 화면
  return next;
});

// ── IPC: auth ────────────────────────────────────────────────────
// Persist the rotated tokens + wake dependent subsystems after any successful sign-in.
// @returns 토큰이 **영속** 저장됐는지 — false 면 재시작 시 재로그인이 필요하다
// (키체인/암호화 저장 전부 불가). 무음 실패 금지: 호출자가 UI 에 표면화한다.

async function afterAuthSuccess(refreshToken?: string): Promise<boolean> {
  const c = getClient();
  const persisted = await tokenStore.setAccess(c.getAccessTokenAfterRotation());
  if (refreshToken) await tokenStore.setRefresh(refreshToken);
  syncMcp();
  safeSend(overlayWindow, CHANNELS.avatarRefresh); // client is now authed → overlay can load the avatar
  // 가상 드라이브는 **로그인 상태에서만** 존재한다. 기동 시점의 리컨사일은
  // 아직 로그인 전이라 아무것도 붙이지 않으므로, 로그인이 끝난 지금 다시
  // 맞춰야 한다. 이 한 줄이 없어서 재시작할 때마다 "연결하지 못했습니다" 가
  // 뜨고 [다시 연결] 을 눌러야만 붙었다 (실기 신고).
  void getWorkspaceManager()?.reconcile();
  checkForUpdatesAfterLogin();
  // 로컬 실행 환경을 **서버와 같은 버전**으로(런타임 wheel·Claude Code·Codex) — 무소음.
  convergeLocalRuntimeInBackground('login');
  return persisted;
}

const SSO_CALLBACK = 'xgenConnectorSsoComplete';
let pendingSso: {
  resolve: (value: { user: NonNullable<XgenClient['user']>; tokenPersisted: boolean }) => void;
  reject: (reason: Error) => void;
} | null = null;

function settleSsoWindow(): void {
  const win = ssoWindow;
  ssoWindow = null;
  if (win && !win.isDestroyed()) win.close();
}

ipcMain.handle(CHANNELS.authSsoLogin, async () => {
  const cfg = loadConfig();
  if (!cfg.ssoEnabled) throw new Error('SSO 로그인이 활성화되지 않았습니다.');
  const url = buildSsoUrl(
    normalizeServerUrl(cfg.serverUrl),
    cfg.ssoPath ?? '/sso/signin',
    SSO_CALLBACK,
  );
  const ssoDebug = cfg.ssoDebug === true;
  if (ssoWindow && !ssoWindow.isDestroyed()) {
    ssoWindow.show();
    ssoWindow.focus();
    throw new Error('SSO 로그인이 이미 진행 중입니다.');
  }

  return new Promise<{ user: NonNullable<XgenClient['user']>; tokenPersisted: boolean }>(
    (resolve, reject) => {
      const win = new BrowserWindow(
        createSsoWindowOptions(
          join(__dirname, '../preload/sso.js'),
          ssoDebug,
          mainWindow ?? undefined,
        ),
      );
      ssoWindow = win;
      pendingSso = { resolve, reject };
      if (ssoDebug) win.webContents.openDevTools({ mode: 'detach', activate: true });
      win.once('ready-to-show', () => win.show());
      win.webContents.setWindowOpenHandler(({ url: nextUrl }) => {
        try {
          const protocol = new URL(nextUrl).protocol;
          if (protocol === 'http:' || protocol === 'https:') void win.loadURL(nextUrl);
        } catch {
          // 잘못된 팝업 URL은 무시한다.
        }
        return { action: 'deny' };
      });
      win.on('closed', () => {
        ssoWindow = null;
        if (pendingSso) {
          const pending = pendingSso;
          pendingSso = null;
          pending.reject(new Error('SSO 로그인이 취소되었습니다.'));
        }
      });
      void win.loadURL(url).catch((error) => {
        if (!pendingSso) return;
        const pending = pendingSso;
        pendingSso = null;
        settleSsoWindow();
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    },
  );
});

ipcMain.on(CHANNELS.authSsoComplete, (event, payload: unknown) => {
  if (!pendingSso || !ssoWindow || event.sender !== ssoWindow.webContents) return;
  const senderFrame = event.senderFrame;
  if (!senderFrame) return;
  let callbackOrigin: string;
  let serverOrigin: string;
  try {
    callbackOrigin = new URL(senderFrame.url).origin;
    serverOrigin = new URL(normalizeServerUrl(loadConfig().serverUrl)).origin;
  } catch {
    return;
  }
  if (callbackOrigin !== serverOrigin) return;

  const pending = pendingSso;
  pendingSso = null;
  void (async () => {
    try {
      const c = getClient();
      const result = await c.adoptLogin(parseSsoLoginResponse(payload));
      const tokenPersisted = await afterAuthSuccess(result.refreshToken);
      if (!c.user) throw new Error('SSO 사용자 정보를 확인하지 못했습니다.');
      pending.resolve({ user: c.user, tokenPersisted });
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      settleSsoWindow();
    }
  })();
});

ipcMain.handle(
  CHANNELS.authLogin,
  async (_e, email: string, password: string, remember?: boolean) => {
    const c = getClient();
    let res;
    try {
      res = await c.login(email, password);
    } catch (e) {
      // 예외를 그대로 던지면 렌더러에는 IPC 래핑 원문("Error invoking remote
      // method 'auth:login': ApiError: POST /api/auth/login → 401")이 보인다.
      // 구조화된 결과로 돌려 사람이 읽을 문장을 화면이 정하게 한다.
      const { loginErrorMessage } = await import('./server-probe');
      return { user: null, error: loginErrorMessage(e) };
    }
    const tokenPersisted = await afterAuthSuccess(res.refreshToken);
    // Remember (or forget) credentials for auto-login, per the login-form checkbox.
    let credsPersisted = true;
    if (remember) {
      credsPersisted = await credentialStore.save({ email, password });
      saveConfig({ autoLogin: credsPersisted }); // 저장 실패면 다음 실행 자동 로그인은 불가
    } else {
      await credentialStore.clear();
      saveConfig({ autoLogin: false });
    }
    return { user: c.user, tokenPersisted, credsPersisted };
  },
);

// Launch: sign in with the remembered credentials (only when 자동 로그인 is on).
ipcMain.handle(CHANNELS.authAutoLogin, async () => {
  if (!loadConfig().autoLogin) return { user: null };
  const creds = await credentialStore.get();
  if (!creds) return { user: null };
  try {
    const c = getClient();
    const res = await c.login(creds.email, creds.password);
    await afterAuthSuccess(res.refreshToken);
    return { user: c.user };
  } catch (e) {
    // 명시적 거부(서버가 응답으로 거절 = 비밀번호 변경 등)일 때만 저장
    // 자격을 폐기한다. 네트워크 일시 장애(오프라인 부팅·서버 재시작)는
    // TypeError('fetch failed')/AbortError 로 나타난다 — 이때 지우면
    // 자동 로그인이 장애 한 번에 영구 해제된다 (restoreDetailed 동일 원칙).
    const name = (e as Error)?.name ?? '';
    const transient = name === 'AbortError' || name === 'TypeError';
    if (!transient) {
      await credentialStore.clear();
      saveConfig({ autoLogin: false });
    }
    return { user: null, offline: transient };
  }
});

// Login form: prefill the remembered email + the auto-login checkbox state.
ipcMain.handle(CHANNELS.authLoginPrefill, async () => {
  const creds = await credentialStore.get();
  return { autoLogin: !!loadConfig().autoLogin, email: creds?.email ?? '' };
});

ipcMain.handle(CHANNELS.authRestore, async () => {
  const c = getClient();
  const access = await tokenStore.getAccess();
  const refresh = await tokenStore.getRefresh();
  if (!access) return { user: null };
  const verdict = await c
    .restoreDetailed(access, refresh ?? undefined)
    .catch(() => 'network' as const);
  if (verdict === 'valid') {
    const rotated = c.getAccessTokenAfterRotation();
    if (rotated && rotated !== access) await tokenStore.setAccess(rotated);
    const rotatedRefresh = c.getRefreshToken();
    if (rotatedRefresh && rotatedRefresh !== refresh) await tokenStore.setRefresh(rotatedRefresh);
    // 세션 복원도 **로그인 성공과 같은 뒷정리**가 필요하다. 예전엔 여기서
    // 같은 일을 손으로 되풀이했는데, 그러다 보니 afterAuthSuccess 에만 있는
    // 워크스페이스 리컨사일이 빠져 **재시작할 때마다 드라이브가 안 붙었다**.
    // 갈래가 둘이면 한쪽만 갱신되는 날이 온다 — 한 곳으로 모은다.
    syncMcp();
    safeSend(overlayWindow, CHANNELS.avatarRefresh); // session restored → overlay can load the avatar
    void getWorkspaceManager()?.reconcile();
    return { user: c.user };
  }
  if (verdict === 'invalid') {
    // 서버가 명시적으로 거부했을 때만 토큰 폐기 — 일시적 네트워크 장애로
    // 로그인을 날리지 않는다 (geny-connector validateAndRefreshAuth 동형).
    await tokenStore.clear();
  }
  return { user: null, offline: verdict === 'network' };
});

ipcMain.handle(CHANNELS.authLogout, async () => {
  getMcpBridge().stop();
  await getBrowserRuntime().closeAll();
  getBrowserRuntime().configure({ enabled: false });
  if (client) await client.logout();
  await tokenStore.clear();
  // 가상 드라이브는 로그인 상태에서만 존재한다 — 로그아웃하면 걷어낸다.
  //
  // ⚠ **반드시 logout 뒤에.** 앞에서 부르면 그 시점의 `client.user` 가 아직
  // 살아 있어 리컨사일이 "로그인 중" 으로 판단하고 마운트를 그대로 둔다.
  // 그러면 로그아웃했는데 이전 계정의 파일이 드라이브에 남고, 같은 PC 에서
  // 다른 계정으로 갈아탈 때 그 잔상 위에 새 계정이 얹힌다.
  await getWorkspaceManager()?.reconcile();
  // An explicit logout also disables auto-login (else next launch signs right back in).
  await credentialStore.clear();
  saveConfig({ autoLogin: false });
  return true;
});

ipcMain.handle(CHANNELS.authStatus, () => ({ user: client?.user ?? null }));
ipcMain.handle(CHANNELS.userAvatarConfig, () => getClient().preferences.getAvatarConfig());
ipcMain.handle(CHANNELS.userSaveAvatarConfig, (_e, cfg) =>
  getClient().preferences.saveAvatarConfig(cfg),
);
ipcMain.handle(CHANNELS.userSaveAvatarTransform, (_e, avatarId, tf) =>
  getClient().preferences.saveAvatarTransform(avatarId, tf),
);

// ── IPC: 아바타 설정 뷰 (등록/이름/선택/삭제 + 스토어) ─────────────
// config 를 바꾸는 op 는 저장 후 오버레이에 avatarRefresh 를 쏴서 다음 폴링을
// 기다리지 않고 즉시 반영한다.
function avatarConfigChanged<T>(result: T): T {
  safeSend(overlayWindow, CHANNELS.avatarRefresh);
  return result;
}
ipcMain.handle(CHANNELS.avatarUploadAsset, (_e, bytes: Uint8Array, filename: string) =>
  getClient().avatars.uploadAsset(bytes, filename),
);
ipcMain.handle(CHANNELS.avatarDeleteAsset, (_e, avatarId: string) =>
  getClient().avatars.deleteAsset(avatarId),
);
ipcMain.handle(CHANNELS.avatarSetEnabled, async (_e, enabled: boolean) =>
  avatarConfigChanged(await getClient().preferences.setAvatarEnabled(enabled)),
);
ipcMain.handle(CHANNELS.avatarSelect, async (_e, id: string) =>
  avatarConfigChanged(await getClient().preferences.selectAvatar(id)),
);
ipcMain.handle(CHANNELS.avatarRename, async (_e, id: string, name: string) =>
  avatarConfigChanged(await getClient().preferences.renameAvatar(id, name)),
);
ipcMain.handle(CHANNELS.avatarAdd, async (_e, descriptor, name?: string) =>
  avatarConfigChanged(await getClient().preferences.addAvatar(descriptor, name)),
);
ipcMain.handle(CHANNELS.avatarRemove, async (_e, id: string) =>
  avatarConfigChanged(await getClient().preferences.removeAvatar(id)),
);
ipcMain.handle(CHANNELS.avatarStoreList, () => getClient().avatars.storeList());
ipcMain.handle(CHANNELS.avatarStorePublish, (_e, descriptor, name: string, description: string) =>
  getClient().avatars.storePublish(descriptor, name, description),
);
ipcMain.handle(CHANNELS.avatarStoreDownload, (_e, storeId: string) =>
  getClient().avatars.storeDownload(storeId),
);
ipcMain.handle(CHANNELS.avatarStoreRate, (_e, storeId: string, stars: number) =>
  getClient().avatars.storeRate(storeId, stars),
);
ipcMain.handle(CHANNELS.avatarStoreUnpublish, (_e, storeId: string) =>
  getClient().avatars.storeUnpublish(storeId),
);

// ── IPC: agents ──────────────────────────────────────────────────
ipcMain.handle(CHANNELS.agentsList, (_e, query) => getClient().agents.list(query ?? {}));

// ── IPC: voice (STT/TTS) ─────────────────────────────────────────
// The renderer captures audio via getUserMedia and hands bytes to main; main
// proxies to the backend with the Bearer token. Secrets never reach here.
ipcMain.handle(CHANNELS.voiceConfig, () => getClient().voice.getVoiceConfig());
ipcMain.handle(
  CHANNELS.voiceTranscribe,
  (_e, bytes: Uint8Array, mime: string, language?: string) => {
    // Copy to a standalone ArrayBuffer (the IPC view may span a shared buffer).
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const blob = new Blob([buf], { type: mime || 'audio/webm' });
    return getClient().voice.transcribe(blob, language);
  },
);
ipcMain.handle(CHANNELS.voiceSpeak, async (_e, text: string, opts?: TtsSpeakOptions) => {
  const blob = await getClient().voice.speak(text, opts);
  const buf = Buffer.from(await blob.arrayBuffer());
  return { bytes: new Uint8Array(buf), mime: blob.type };
});

// ── IPC: history ─────────────────────────────────────────────────
ipcMain.handle(
  CHANNELS.historyTurns,
  (_e, workflowId: string, interactionId: string, name?: string) =>
    getClient().history.turns(workflowId, interactionId, name),
);
ipcMain.handle(CHANNELS.historyConversations, () => getClient().history.conversations());

// ── IPC: chat streaming ──────────────────────────────────────────
// The renderer starts a stream with a client-generated streamId; each ChatEvent
// is pushed back over CHANNELS.chatEvent; cancel via CHANNELS.chatCancel.
ipcMain.handle(CHANNELS.chatStart, async (e, streamId: string, req) => {
  const controller = new AbortController();
  aborters.set(streamId, controller);
  const sender = e.sender;
  const emitLocal = (ev: ChatEvent) => {
    if (!sender.isDestroyed()) sender.send(CHANNELS.chatEvent, streamId, ev);
  };
  (async () => {
    try {
      // 커넥터 로컬 실행 우선 — 독립 런타임이 설치돼 있고 서버가 로컬-턴을
      // 지원하며 로컬 동기화가 되면, 이 PC 에서 돌린다(에이전트가 네이티브
      // shell/파일을 로컬 자원으로). 안 되면 아무것도 안 보낸 채 서버로 폴백.
      // 커넥터 로컬 실행 v2 — 커넥터에서 시작한 턴은 이 PC 의 사이드카에서 돈다
      // (기억·파일·이력은 서버). 로컬이 불가능한 경우에만 서버 sandbox 로 보내되
      // 이유를 상태 이벤트·진단 로그로 드러내고, 서버에는 execution_target='sandbox'
      // 를 실어 커넥터 로컬 워크스페이스(역방향 WS) 경로를 쓰지 않게 한다.
      const serverReq: ChatRequest = { ...(req as ChatRequest) };
      if (loadConfig().localExec?.enabled !== false) {
        const local = await runLocalChatTurn(
          req as ChatRequest,
          localChatDeps(controller.signal),
          emitLocal,
        ).catch((err) => ({
          handled: false,
          reason: 'runtime_missing' as const,
          detail: err instanceof Error ? err.message : String(err),
        }));
        if (local.handled) return; // 로컬이 end 까지 처리함.
        if (local.reason) {
          serverReq.executionTarget = 'sandbox';
          emitLocal({
            kind: 'status',
            surface: 'server_sandbox',
            reason: describeFallback(local.reason, local.detail),
            detail: local.detail,
          });
        }
      } else {
        serverReq.executionTarget = 'sandbox';
        emitLocal({
          kind: 'status',
          surface: 'server_sandbox',
          reason: '로컬 실행이 꺼져 있어 서버 sandbox 에서 실행합니다',
        });
      }

      for await (const ev of getClient().chat.stream(serverReq, controller.signal)) {
        if (sender.isDestroyed()) break;
        sender.send(CHANNELS.chatEvent, streamId, ev satisfies ChatEvent);
        if (ev.kind === 'end') break;
      }
      if (!sender.isDestroyed()) sender.send(CHANNELS.chatEvent, streamId, { kind: 'end' });
    } catch (err) {
      if (!sender.isDestroyed())
        sender.send(CHANNELS.chatEvent, streamId, {
          kind: 'error',
          detail: err instanceof Error ? err.message : String(err),
        });
    } finally {
      aborters.delete(streamId);
    }
  })();
  return true;
});
ipcMain.handle(CHANNELS.chatCancel, (_e, streamId: string) => {
  aborters.get(streamId)?.abort();
  aborters.delete(streamId);
  return true;
});

// ── IPC: browser runtime ─────────────────────────────────────────
ipcMain.handle(CHANNELS.browserState, () => getBrowserRuntime().state());
ipcMain.handle(CHANNELS.browserCreate, (_e, request) => getBrowserRuntime().create(request));
ipcMain.handle(CHANNELS.browserEnsureShared, (_e, workflowId: string, workflowName?: string) =>
  getBrowserRuntime().ensureShared(workflowId, workflowName),
);
ipcMain.handle(CHANNELS.browserBindShared, (_e, pageId: string, webContentsId: number) =>
  getBrowserRuntime().bindSharedPage(pageId, webContentsId),
);
ipcMain.handle(CHANNELS.browserNavigate, (_e, request) => getBrowserRuntime().navigate(request));
ipcMain.handle(CHANNELS.browserActivate, (_e, pageId: string) =>
  getBrowserRuntime().activate(pageId),
);
ipcMain.handle(CHANNELS.browserClose, async (_e, pageId: string) => {
  await getBrowserRuntime().close(pageId);
  return true;
});
ipcMain.handle(CHANNELS.browserCloseWorkflow, async (_e, workflowId: string) => {
  await getBrowserRuntime().closeWorkflow(workflowId);
  return true;
});

// ── IPC: updater ─────────────────────────────────────────────────
ipcMain.handle(CHANNELS.updaterCheck, () => checkNow());
ipcMain.handle(CHANNELS.updaterGetEnabled, () => getAutoUpdate());
ipcMain.handle(CHANNELS.updaterSetEnabled, (_e, enabled: boolean) => {
  setAutoUpdate(enabled);
  saveConfig({ autoUpdate: enabled });
  return enabled;
});
ipcMain.handle(CHANNELS.openExternal, (_e, url: string) => shell.openExternal(url));
ipcMain.handle(CHANNELS.appVersion, () => app.getVersion());
ipcMain.handle(CHANNELS.systemMetrics, () => systemMetricsSampler.sample());

// ── IPC: floating avatar overlay ─────────────────────────────────
ipcMain.handle(CHANNELS.overlayGetEnabled, () => !!loadConfig().avatarOverlay);
ipcMain.handle(CHANNELS.overlaySetEnabled, (_e, enabled: boolean) => {
  setOverlayEnabled(!!enabled);
  return !!enabled;
});
// Main window pushes the live avatar/chat state; relay it to the overlay.
ipcMain.on(CHANNELS.overlayPushState, (_e, state: unknown) => {
  lastOverlayState = state;
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send(CHANNELS.overlayState, state);
  }
});
// Overlay renderer → native window controls.
ipcMain.on(CHANNELS.overlaySetIgnoreMouse, (_e, ignore: boolean) => {
  // 남아 있는 호출자(구버전 페이지)를 위한 호환 경로. 잠금은 이제 main 이
  // 소유하므로 이 채널로 임시로 바꾼 값은 다음 잠금 변경에 덮인다.
  applyOverlayIgnoreMouse(overlayWindow, !!ignore);
});

// ── 화면 캡처 ──
ipcMain.handle(CHANNELS.captureListSources, async () => {
  const { listSources } = await import('./screen-capture');
  return listSources();
});

ipcMain.handle(CHANNELS.captureAccessStatus, async () => {
  const { screenAccessStatus } = await import('./screen-capture');
  return screenAccessStatus();
});

ipcMain.handle(CHANNELS.captureScreen, async () => {
  const cfg = loadConfig();
  // 설정이 꺼져 있으면 **찍지 않는다.** 렌더러가 실수로 불러도 화면이 나가지
  // 않아야 한다 — 이 게이트는 서버가 아니라 사용자의 기기에 있어야 의미가 있다.
  if (!cfg.screenCapture) return { ok: false, error: '화면 캡처가 꺼져 있습니다.' };
  const { captureScreen } = await import('./screen-capture');
  return captureScreen(cfg.screenCaptureSource || undefined);
});

ipcMain.handle(CHANNELS.overlayGetLocked, () => overlayLocked);

ipcMain.on(CHANNELS.overlaySetLocked, (_e, locked: boolean) => {
  setOverlayLocked(!!locked);
});

ipcMain.on(CHANNELS.overlayChipSize, (_e, w: number, h: number) => {
  // 컨트롤 창은 내용에 맞춰야 한다 — 버튼 수가 STT/TTS 가용성에 따라 다르다.
  // 창이 내용보다 작으면 버튼이 잘리고, 크면 투명 영역이 클릭을 먹는다.
  const nw = Math.max(48, Math.round(Number(w) || 0));
  const nh = Math.max(28, Math.round(Number(h) || 0));
  if (nw === chipSize.w && nh === chipSize.h) return;
  chipSize = { w: nw, h: nh };
  syncChipBounds();
  publishChipInset();
});
ipcMain.on(CHANNELS.overlayMoveBy, (_e, dx: number, dy: number) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  // The naive setPosition(getPosition()+delta) GROWS the window on Windows
  // fractional-DPI monitors (150%): Electron's setPosition internally does
  // SetBounds(newOrigin, getBounds().size()), and getBounds() reports the
  // DIP-rounded size — each frame reads a slightly larger rounded size and
  // writes it back, so over a drag's hundreds of frames the window balloons.
  // (setBounds has the exact same read-back-and-grow flaw; the old "setPosition
  // is size-safe" comment was wrong.)
  //
  // Fix: keep an AUTHORITATIVE rect in JS. Capture the real bounds once at the
  // start of a drag, then apply deltas to the tracked position and re-assert a
  // CONSTANT captured size every frame — never reading getBounds() mid-drag. A
  // constant DIP size converts to the same physical size each call, so it can't
  // drift; it also stays put when crossing to a different-scale monitor
  // (physical size adapts), and the post-drag reconcile snaps to that monitor's
  // remembered size. The rect auto-expires shortly after the last delta, or on
  // the explicit commitBounds (pointer-up) below.
  if (!overlayMoveRect) {
    const b = overlayWindow.getBounds();
    overlayMoveRect = { x: b.x, y: b.y, w: b.width, h: b.height };
  }
  overlayMoveRect.x += dx;
  overlayMoveRect.y += dy;
  overlayWindow.setBounds({
    x: Math.round(overlayMoveRect.x),
    y: Math.round(overlayMoveRect.y),
    width: overlayMoveRect.w,
    height: overlayMoveRect.h,
  });
  if (overlayMoveIdle) clearTimeout(overlayMoveIdle);
  overlayMoveIdle = setTimeout(endOverlayMove, 300); // fallback drag-end
});
ipcMain.on(CHANNELS.overlayResizeBy, (_e, edge: string, dx: number, dy: number) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const MIN = 200;
  const b = overlayWindow.getBounds();
  let { x, y, width, height } = b;
  if (edge.includes('e')) width = Math.max(MIN, width + Math.round(dx));
  if (edge.includes('s')) height = Math.max(MIN, height + Math.round(dy));
  if (edge.includes('w')) {
    const nw = Math.max(MIN, width - Math.round(dx));
    x += width - nw;
    width = nw;
  }
  if (edge.includes('n')) {
    const nh = Math.max(MIN, height - Math.round(dy));
    y += height - nh;
    height = nh;
  }
  overlayWindow.setBounds({ x, y, width, height });
  // Persistence via 'resized' (Windows) + overlay:commitBounds on pointer-up.
});
// Drag/resize gesture ENDED (renderer pointerup) → persist the SETTLED bounds for
// the current monitor immediately, so an immediate restart can't lose it.
ipcMain.on(CHANNELS.overlayCommitBounds, () => {
  // Gesture ended (pointer-up): drop the authoritative move rect so the next
  // window event reads real bounds again, then persist immediately.
  if (overlayMoveIdle) {
    clearTimeout(overlayMoveIdle);
    overlayMoveIdle = null;
  }
  overlayMoveRect = null;
  saveOverlayGeometry(true);
});
ipcMain.on(CHANNELS.overlayFocusMain, () => showMain());
ipcMain.on(CHANNELS.overlayOpenSettings, () => openMainSettings());
ipcMain.on(CHANNELS.overlayHide, () => setOverlayEnabled(false));

// ── IPC: app / window management ─────────────────────────────────
/** 네이티브 폴더 선택 — 설정 화면(기본 작업 폴더·허용 폴더)이 쓴다. 경로를
 *  타이핑하게 두면 오타 하나로 도구 스코프가 조용히 빗나간다 — 고르게 한다. */
ipcMain.handle(CHANNELS.pickFolder, async () => {
  const win = mainWindow;
  const r = win
    ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
    : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : (r.filePaths[0] ?? null);
});
ipcMain.handle(CHANNELS.appOpenFolder, async (_e, p: unknown) => {
  const dir = typeof p === 'string' && p.trim() ? p : resolveDataRoot(loadConfig());
  try {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
  } catch {
    /* 열기에서 드러남 */
  }
  const err = await shell.openPath(dir);
  return { ok: !err, error: err || undefined };
});
ipcMain.handle(CHANNELS.autostartGet, () => loadConfig().autoLaunch === true);
ipcMain.handle(CHANNELS.autostartSet, (_e, enabled: boolean) => {
  // 실효 결과를 저장·반환 — 리눅스 AppImage 임시 마운트 등 등록이 거부되면
  // 토글도 꺼진 상태로 남는다 (UI 가 거짓말하지 않게).
  const effective = applyAutoLaunch(!!enabled);
  saveConfig({ autoLaunch: effective });
  rebuildTrayMenu();
  return effective;
});
ipcMain.on(CHANNELS.resetPositions, () => resetPositions());
ipcMain.on(CHANNELS.resetSettings, () => {
  void resetStoredSettings().catch((err) => {
    dialog.showErrorBox('설정 초기화 실패', err instanceof Error ? err.message : String(err));
  });
});
ipcMain.on(CHANNELS.appRestart, () => {
  saveOverlayGeometry(true); // persist any pending move/resize before relaunching
  relaunchSelf();
});
ipcMain.on(CHANNELS.appQuit, () => {
  appQuitting = true;
  app.quit();
});

// ── IPC: hotkeys ─────────────────────────────────────────────────
ipcMain.handle(CHANNELS.quickChatSetHotkey, (_e, acc: string) => {
  const prev = loadConfig().quickChatHotkey;
  saveConfig({ quickChatHotkey: acc });
  globalShortcut.unregister(prev ?? DEFAULT_QUICKCHAT);
  registerQuickChatHotkey();
  const ok = globalShortcut.isRegistered(acc);
  if (!ok) {
    saveConfig({ quickChatHotkey: prev ?? DEFAULT_QUICKCHAT });
    registerQuickChatHotkey();
  }
  return ok;
});
// While a settings field records a new combo, suspend global shortcuts so the
// currently-registered key isn't swallowed system-wide during capture.
ipcMain.on(CHANNELS.hotkeyPause, () => globalShortcut.unregisterAll());
ipcMain.on(CHANNELS.hotkeyResume, () => registerQuickChatHotkey());

// ── IPC: local MCP ───────────────────────────────────────────────
ipcMain.handle(CHANNELS.mcpGetEnabled, () => !!loadConfig().mcp);
ipcMain.handle(CHANNELS.mcpSetEnabled, (_e, enabled: boolean) => {
  setMcpEnabled(!!enabled);
  return !!enabled;
});
ipcMain.handle(CHANNELS.mcpListServers, () => loadConfig().mcpServers ?? []);
ipcMain.handle(CHANNELS.mcpSaveServers, async (_e, servers) => {
  // G8a: move secret env/headers values to the encrypted keychain; persist only
  // redacted configs (keys kept, values '') to connector.json.
  const incoming: McpServerConfig[] = Array.isArray(servers) ? servers : [];
  const prev = loadConfig().mcpServers ?? [];
  const redacted: McpServerConfig[] = [];
  for (const s of incoming) {
    if (!s || !s.name) continue;
    const stored = await mcpSecretStore.get(s.name).catch(() => null);
    const { redacted: safe, secrets } = splitServerSecrets(s, stored);
    await mcpSecretStore.save(s.name, secrets).catch(() => {});
    redacted.push(safe);
  }
  // Clean up secrets + OAuth state for removed servers.
  const keep = new Set(redacted.map((s) => s.name));
  for (const p of prev) {
    if (p?.name && !keep.has(p.name)) {
      await mcpSecretStore.clear(p.name).catch(() => {});
      await mcpOAuthStore.clear(p.name).catch(() => {});
    }
  }
  const next = saveConfig({ mcpServers: redacted });
  syncMcp();
  broadcastConfig(next);
  return next.mcpServers ?? [];
});
ipcMain.handle(CHANNELS.mcpTestServer, async (e, cfg) => {
  // OAuth 서버는 테스트가 임시이름(__test__)로 붙어 토큰이 없어 항상 실패하고, DCR 이
  // 돌면 임시이름으로 고아 키체인 항목을 남긴다. 브라우저 인가로 안내하고 단락한다.
  if (cfg?.auth === 'oauth') {
    const authed = cfg?.name ? await hasOAuthTokens(String(cfg.name)).catch(() => false) : false;
    return {
      ok: authed,
      message: authed
        ? '이미 인가된 OAuth 서버입니다. 저장하면 자동 연결됩니다.'
        : 'OAuth 서버는 테스트 대신 "브라우저로 인가하기" 를 사용하세요. 인가되면 자동 연결됩니다.',
    };
  }
  // 첫 실행은 인터프리터·의존성 내려받기로 몇 분이 걸릴 수 있다 — 그동안의
  // 서버 출력을 요청한 창으로 그대로 흘려보낸다.
  // G8a: 폼 값이 redacted('') 여도(저장된 서버를 테스트) 키체인 시크릿으로 채워 테스트.
  const stored = cfg?.name ? await mcpSecretStore.get(cfg.name).catch(() => null) : null;
  const resolved = cfg ? withResolvedSecrets(cfg, stored) : cfg;
  return getMcpManager().test(resolved, (lines) => {
    if (!e.sender.isDestroyed())
      e.sender.send(CHANNELS.mcpTestProgressEvent, { name: cfg?.name, lines });
  });
});
ipcMain.handle(CHANNELS.mcpAuthorize, async (_e, cfg) => {
  // G8b: interactive OAuth 2.1 (PKCE) — opens the browser + loopback listener.
  const stored = cfg?.name ? await mcpSecretStore.get(cfg.name).catch(() => null) : null;
  const resolved = cfg ? withResolvedSecrets(cfg, stored) : cfg;
  const res = await authorizeMcpServer(resolved, { fetch: mcpHttpFetch });
  if (res.ok) syncMcp(); // reconnect now that tokens exist
  return res;
});
ipcMain.handle(CHANNELS.mcpOauthStatus, async (_e, name) => ({
  authorized: await hasOAuthTokens(String(name || '')).catch(() => false),
}));
ipcMain.handle(CHANNELS.mcpClearOauth, async (_e, name) => {
  await clearOAuth(String(name || '')).catch(() => {});
  syncMcp();
  return { ok: true };
});
ipcMain.handle(CHANNELS.mcpRenameSecrets, async (_e, oldName, newName) => {
  // 서버 이름 변경 시 키체인의 시크릿/OAuth 를 old→new 로 이관한다. 안 하면 mcpSaveServers
  // 의 삭제정리(prev-but-not-new)가 옛 이름의 시크릿/토큰을 지워 데이터가 소실된다.
  const from = String(oldName || '');
  const to = String(newName || '');
  if (!from || !to || from === to) return { ok: true };
  try {
    const sec = await mcpSecretStore.get(from);
    if (sec) {
      await mcpSecretStore.save(to, sec);
    }
    const oauth = await mcpOAuthStore.load(from);
    if (oauth && (oauth.tokens || oauth.clientInformation || oauth.codeVerifier)) {
      await mcpOAuthStore.save(to, oauth);
    }
    // 옛 이름은 mcpSaveServers 의 삭제정리가 처리한다(중복 제거).
  } catch {
    /* best-effort — 저장은 계속 진행 */
  }
  return { ok: true };
});
ipcMain.handle(CHANNELS.mcpStatus, () => getMcpBridge().status());
ipcMain.handle(CHANNELS.mcpRuntimeLogs, () => mcpRuntimeLogs());
ipcMain.handle(CHANNELS.mcpClearRuntimeLogs, () => {
  clearMcpRuntimeLogs();
  return true;
});

/**
 * 파일 관리자로 경로 열기 — **shell.openPath 를 쓰면 안 된다.**
 *
 * 우리 마운트는 이 프로세스의 이벤트 루프가 서빙한다. `shell.openPath` 는
 * 경로를 **동기적으로 확인**하므로, 그 대상이 우리 마운트면 루프가 막히고
 * FUSE 콜백이 응답하지 못해 **서로를 기다리는 데드락**이 된다 (실기: "폴더
 * 열기"를 누르는 순간 앱이 응답 없음).
 *
 * 자식 프로세스로 분리하면 우리 루프는 계속 돌고 마운트도 계속 응답한다.
 */
function openInFileManager(target: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    const child = spawn(cmd, [target], { detached: true, stdio: 'ignore' });
    child.on('error', (e) => console.log(`[workspace] 폴더 열기 실패: ${e.message}`));
    child.unref();
  } catch (e) {
    console.log(`[workspace] 폴더 열기 실패: ${(e as Error).message}`);
  }
}

// ── 계정별 워크스페이스 ────────────────────────────────────────────
//
// 워크스페이스는 **로그인한 계정에 속한다**. 예전에는 전역 설정 하나여서,
// 계정을 바꿔 로그인해도 이전 계정의 루트·부착 에이전트를 그대로 물었다.
// 두 계정이 같은 폴더를 클라우드로 가리키면 서로의 파일을 덮어썼다.

/** 지금 로그인한 계정의 키. 로그아웃 상태면 null. */
function currentAccountKey(): string | null {
  const uid = client?.user?.userId;
  if (!uid) return null;
  return accountKey(normalizeServerUrl(loadConfig().serverUrl), String(uid));
}

/** 지금 계정의 워크스페이스 설정. 로그아웃 상태면 undefined(마운트하지 않는다). */
function currentWorkspace(): WorkspacePersistConfig | undefined {
  const key = currentAccountKey();
  if (!key) return undefined;
  const cfg = loadConfig();
  const byAccount = cfg.workspaces?.[key];
  if (byAccount) return byAccount;
  // 예전 전역 설정이 있으면 **최초 1회만** 이 계정으로 이관한다. 다른 계정이
  // 나중에 로그인해도 같은 것을 물려받지 않는다.
  return cfg.workspace;
}

/** 지금 계정의 워크스페이스를 저장한다 (전역 키는 더 이상 쓰지 않는다). */
function saveCurrentWorkspace(next: WorkspacePersistConfig): WorkspacePersistConfig | undefined {
  const key = currentAccountKey();
  if (!key) return undefined;
  const cfg = loadConfig();
  const saved = saveConfig({
    workspaces: { ...(cfg.workspaces ?? {}), [key]: next },
    // 이관 완료 — 전역 키를 비워 두 곳이 어긋나지 않게 한다.
    workspace: undefined as never,
  });
  return saved.workspaces?.[key];
}

/**
 * 클라우드 연결 API 한 번 — 실패하면 **던진다.**
 *
 * 조용히 삼키면 사용자는 [추가] 를 눌렀는데 목록이 그대로인 것을 보고 다시
 * 누른다. 던지면 렌더러가 오류를 띄운다.
 */
async function cloudLinkRequest(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<unknown> {
  const base = normalizeServerUrl(loadConfig().serverUrl).replace(/\/$/, '');
  const token = await liveAccessToken();
  let res = await net.fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  // 401 = 토큰 회전/세션 회수 — refresh 로 한 번 자가치유 후 재발송.
  if (res.status === 401) {
    const fresh = await refreshAuthToken().catch(() => null);
    if (fresh) {
      res = await net.fetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${fresh}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    }
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { detail?: string };
      if (j?.detail) detail = j.detail;
    } catch {
      /* 본문이 JSON 이 아니면 상태 코드로 충분하다 */
    }
    throw new Error(detail);
  }
  return res.json().catch(() => ({}));
}

// ── 워크스페이스(가상 드라이브) ─────────────────────────────────
function wireWorkspaceManager(): void {
  initWorkspaceManager({
    config: () => currentWorkspace(),
    apiFor: (workflowId: string) =>
      makeWorkspaceApi(
        {
          serverUrl: () => normalizeServerUrl(loadConfig().serverUrl),
          token: liveAccessToken,
          refreshAuth: refreshAuthToken,
          deviceId: () => ensureDeviceId(),
          fetch: (input, init) => net.fetch(input, init),
          allowPrivateCertificate: () => loadConfig().allowPrivateCertificate === true,
          tmpDir: app.getPath('userData'),
        },
        workflowId,
      ),
    loggedIn: () => !!client?.user,
    // 루트가 되는 사용자 클라우드 스토리지 — owner key 'user:<id>' 규약.
    userApi: () => {
      const uid = client?.user?.userId;
      if (!uid) return null;
      return makeWorkspaceApi(
        {
          serverUrl: () => normalizeServerUrl(loadConfig().serverUrl),
          token: liveAccessToken,
          refreshAuth: refreshAuthToken,
          deviceId: () => ensureDeviceId(),
          fetch: (input, init) => net.fetch(input, init),
          allowPrivateCertificate: () => loadConfig().allowPrivateCertificate === true,
          tmpDir: app.getPath('userData'),
        },
        `user:${uid}`,
      );
    },
    userOwner: () => {
      const uid = client?.user?.userId;
      return uid ? `user:${uid}` : null;
    },
    // 드라이브가 붙어 있는 동안 서버에 "이 PC 가 이 저장소에 있다"를 알린다.
    // 이 배선이 없으면 웹의 "PC N대 동기화 중" 칩이 영영 안 뜨고, 웹에서 올린
    // 파일이 드라이브에 늦게 나타난다 (변경 푸시를 못 받아 TTL 만료까지 대기).
    presenceFor: (owner: string, onChanged: () => void) =>
      new WorkspaceWsClient(
        {
          baseUrl: normalizeServerUrl(loadConfig().serverUrl).replace(/\/$/, ''),
          token: liveAccessToken,
          refreshAuth: refreshAuthToken,
          workflowId: owner,
          deviceId: ensureDeviceId(),
          // 이름이 쓰기 요청에도 실려야 서버가 이 PC 의 홈 폴더를 만든다.
          deviceName: deviceNameOf(),
          fetch: (input, init) => net.fetch(input, init),
          allowPrivateCertificate: loadConfig().allowPrivateCertificate === true,
        },
        deviceNameOf(),
        () => onChanged(),
        () => undefined,
      ),
    /**
     * 서버가 이 PC 를 이름 없이 알고 있으면 재연결이 필요하다.
     *
     * 서버는 이름 없는 기기를 `needs_reconnect` 로 표시한다 — 그 기기는
     * 클라우드 안에서 자기 폴더를 갖지 못해 파일이 루트에 섞인다.
     */
    // 연결된 에이전트의 **원본은 서버**다 — 커넥터 설정은 그 사본일 뿐이다.
    cloudLinks: async () => {
      const body = (await cloudLinkRequest('GET', '/api/cloud/links')) as {
        links?: Array<{
          workflow_id: string;
          label?: string;
          paused?: boolean;
          paused_reason?: string;
        }>;
      };
      return (body.links ?? []).map((l) => ({
        workflowId: l.workflow_id,
        label: l.label || l.workflow_id,
        paused: !!l.paused,
        pausedReason: l.paused_reason || '',
      }));
    },
    persist: (next) => {
      saveCurrentWorkspace(next as WorkspacePersistConfig);
    },
    cloudProbe: async () => {
      const base = normalizeServerUrl(loadConfig().serverUrl).replace(/\/$/, '');
      const token = await liveAccessToken();
      let res = await net.fetch(`${base}/api/cloud/overview`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.status === 401) {
        // 토큰 회전/세션 회수 — refresh 후 한 번 재시도 (이 프로브가 죽으면
        // homeFolder 를 몰라 이 PC 폴더 안내·라우팅이 전부 빠진다).
        const fresh = await refreshAuthToken().catch(() => null);
        if (fresh) {
          res = await net.fetch(`${base}/api/cloud/overview`, {
            headers: { Authorization: `Bearer ${fresh}` },
          });
        }
      }
      if (!res.ok) return null; // 모르면 경고하지 않는다
      const body = (await res.json()) as {
        needs_reconnect?: string[];
        devices?: Array<{ device_id: string; home_folder?: string }>;
      };
      const me = ensureDeviceId();
      // 폴더 이름은 **서버가 정한 것**을 그대로 쓴다. 여기서 hostname 으로
      // 흉내 내면(구분자 제거 규칙까지 다시 구현하면) 서버가 아는 폴더와
      // 어긋나 파일이 엉뚱한 곳으로 간다.
      return {
        needsReconnect: (body.needs_reconnect ?? []).includes(me),
        homeFolder: (body.devices ?? []).find((d) => d.device_id === me)?.home_folder ?? '',
      };
    },
    onStatus: (s: unknown) => {
      safeSend(mainWindow, CHANNELS.workspaceStatusEvent, s);
      // 연결 목록·로그인 상태가 바뀌면 로컬 동기화도 따라간다 (리컨사일은
      // 멱등·저렴 — 목록 diff 뿐이다).
      localSync?.reconcile();
    },
  });
  void getWorkspaceManager()?.reconcile();
}

// ── 로컬 동기화 (에이전트 workspace ↔ 로컬 도구 기본 작업 폴더) ────────
//
// 커넥터로 접속한 에이전트는 서버 sandbox 대신 이 폴더를 워크스페이스로 쓴다.
// sandbox 는 같은 인덱스를 attach/publish 하므로, 이 동기화가 곧 sandbox 와의
// 동기화다 (웹 세션 ↔ 커넥터 세션이 같은 파일을 본다).
let localSync: LocalSyncManager | null = null;

/** 동기화 엔진용 전송 — 드라이브의 apiFor 와 같은 자격·주소, latest_seq 포함 타입. */
function syncRemoteFor(workflowId: string): SyncRemote {
  const transport = () =>
    new HttpSyncTransport(
      {
        baseUrl: normalizeServerUrl(loadConfig().serverUrl),
        token: liveAccessToken,
        refreshAuth: refreshAuthToken,
        workflowId,
        deviceId: ensureDeviceId(),
        fetch: (input, init) => net.fetch(input, init),
        allowPrivateCertificate: loadConfig().allowPrivateCertificate === true,
      },
      join(app.getPath('userData'), 'sync-staging'),
    );
  return {
    changes: (since) => transport().changes(since),
    download: (path, toAbs) => transport().download(path, toAbs),
    put: (path, fromAbs, baseSha) => transport().put(path, fromAbs, baseSha),
    del: (path, baseSha, opts) => transport().del(path, baseSha, opts),
    mkdir: (path) => transport().mkdir(path),
  };
}

function wireLocalSync(): void {
  localSync = new LocalSyncManager({
    config: () => {
      const cfg = loadConfig();
      const shell = cfg.localShell ?? {};
      return {
        // 로컬 실행(기본 ON)은 에이전트 동기화 폴더가 전제다 — PC 컨트롤(Shell 도구)
        // 토글과 무관하게 켠다. 둘 다 꺼져 있을 때만 동기화 엔진이 쉰다.
        enabled: shell.enabled === true || cfg.localExec?.enabled !== false,
        root: (shell.cwd ?? '').trim(),
        targets: (currentWorkspace()?.agents ?? []).map((a) => ({
          workflowId: a.workflowId,
          label: a.label,
          folder: a.folder,
        })),
      };
    },
    loggedIn: () => !!client?.user,
    remoteFor: syncRemoteFor,
    presenceFor: (owner: string, onChanged: () => void) =>
      new WorkspaceWsClient(
        {
          baseUrl: normalizeServerUrl(loadConfig().serverUrl).replace(/\/$/, ''),
          token: liveAccessToken,
          refreshAuth: refreshAuthToken,
          workflowId: owner,
          deviceId: ensureDeviceId(),
          deviceName: deviceNameOf(),
          fetch: (input, init) => net.fetch(input, init),
          allowPrivateCertificate: loadConfig().allowPrivateCertificate === true,
        },
        deviceNameOf(),
        () => onChanged(),
        () => undefined,
      ),
    stateDir: () =>
      join(
        app.getPath('userData'),
        'local-sync',
        (currentAccountKey() ?? 'anon').replace(/[^A-Za-z0-9._-]/g, '_'),
      ),
    deviceName: deviceNameOf(),
    onStatus: (s) => safeSend(mainWindow, CHANNELS.syncStatusEvent, s),
  });
  localSync.reconcile();

  // 워크스페이스 브리지 — 서버의 ConnectorLocalSandbox 가 이 PC 를 실행
  // 환경으로 쓰는 내부 도구(_Exec 등). 로컬 동기화 매니저와 같은 수명이다.
  const { WorkspaceBridge } =
    require('./workspace-bridge-tools') as typeof import('./workspace-bridge-tools');
  getLocalToolProvider().configureWorkspaceBridge(
    new WorkspaceBridge({
      infoFor: (workflowId: string, workflowName?: string) => {
        // 연결(attach) 여부와 무관하게 **모든 에이전트**를 로컬로 실행할 수 있게
        // 폴더를 확보한다 — 로컬 도구 켜짐 + 기본 작업 폴더 지정이 전제.
        const dir = localSync?.ensurePair(workflowId, workflowName || workflowId) ?? null;
        if (!dir) return null;
        const agent = localSync?.status().agents.find((a) => a.workflowId === workflowId);
        return { dir, label: agent?.label ?? workflowName ?? workflowId };
      },
      ensureSynced: async (workflowId: string, workflowName?: string) => {
        // 턴 시작 — 폴더 확보 + 인덱스 하이드레이트 대기. 웹에서 만든 파일이
        // 로컬에 내려온 뒤 에이전트가 돈다 (빈 워크스페이스 오판 방지).
        const r = (await localSync?.ensureSynced(workflowId, workflowName || workflowId)) ?? {
          dir: null,
          synced: false,
        };
        if (!r.dir) return { info: null, synced: false };
        const agent = localSync?.status().agents.find((a) => a.workflowId === workflowId);
        return {
          info: { dir: r.dir, label: agent?.label ?? workflowName ?? workflowId },
          synced: r.synced,
        };
      },
      flushSync: async (workflowId: string) => (await localSync?.flushSync(workflowId)) ?? false,
      cloudDir: () => getWorkspaceManager()?.status()?.path ?? null,
      poke: (workflowId: string) => localSync?.poke(workflowId),
    }),
  );
}

// ── 로컬 실행 v2: 사이드카 데몬 + 서버 버전 수렴 ──────────────────────
/** 사이드카 데몬(상주) — 첫 턴에 기동, 유휴 15분 뒤 자가 종료, 앱 종료 시 내림. */
let sidecarDaemon: SidecarDaemon | null = null;
function getSidecarDaemon(): SidecarDaemon {
  if (!sidecarDaemon) {
    sidecarDaemon = new SidecarDaemon({
      command: () => defaultSidecarCommand(true, getLocalEnsurer().activePython()?.python),
      log: (m) => {
        void import('./diag-log')
          .then(({ diag }) => diag('local-exec', `sidecar: ${m}`))
          .catch(() => {});
      },
    });
  }
  return sidecarDaemon;
}
/** 서버 버전 수렴기 — 로그인 직후/설정 버튼에서 매니페스트를 받아 런타임·CLI 를 맞춘다. */
let localConverger: LocalRuntimeConverger | null = null;
function getLocalConverger(): LocalRuntimeConverger {
  if (!localConverger) {
    localConverger = new LocalRuntimeConverger(() => {
      const le = loadConfig().localExec ?? {};
      return {
        server: makeLocalExecServerClient({
          serverUrl: () => normalizeServerUrl(loadConfig().serverUrl),
          token: () => liveAccessToken(),
          fetch: mcpHttpFetch as unknown as NetworkFetch,
        }),
        runtimeDir: cliRuntimeDir(),
        fetch: mcpHttpFetch as unknown as typeof fetch,
        autoRuntime: le.autoRuntime,
        autoCodex: le.autoCodex,
        autoClaude: le.autoClaude,
        onProgress: (p) => {
          try {
            mainWindow?.webContents.send(CHANNELS.localRuntimeProgress, p);
          } catch {
            /* 창 없음 */
          }
        },
        log: (m) => {
          void import('./diag-log')
            .then(({ diag }) => diag('local-exec', `converge: ${m}`))
            .catch(() => {});
        },
      };
    });
  }
  return localConverger;
}
/** 로그인 직후/부팅 후 — 서버와 같은 버전으로(무소음, 실패는 상태로만). */
function convergeLocalRuntimeInBackground(why: string): void {
  if (!client?.user) return;
  void getLocalConverger()
    .converge()
    .then((st) =>
      import('./diag-log').then(({ diag }) =>
        diag('local-exec', `converge(${why}): ${st.summary ?? st.lastError ?? 'done'}`),
      ),
    )
    .catch(() => {});
}

// ── 독립 로컬 실행 환경 설치 ([설정 → 일반]) ─────────────────────────
/** userData 아래 로컬 런타임 트리 루트. */
/**
 * 통합 데이터 루트 정착(부팅 1회) — 인스톨러 선택(install-options.json)을 삼키고,
 * dataRoot 트리(workspace/·cloud/·local-runtime/)를 만들고, 미설정 경로 기본을
 * config 에 채운다. 명시 설정은 절대 덮지 않는다.
 */
function settleDataRootOnBoot(): void {
  try {
    const installPatch = consumeInstallOptions(app.getPath('userData'));
    if (installPatch) saveConfig(installPatch);
    const { root, patch } = settleDataRoot(loadConfig());
    if (Object.keys(patch).length) saveConfig(patch);
    // 설치 폴더 루트에 CLI 설치 스크립트 배치(부팅마다 최신으로 덮어씀) —
    // runtime(기본 설치) + install-codex + install-claude-code 가 한 지붕 아래.
    writeCliInstallScripts(root);
  } catch (e) {
    console.error('[data-root] 정착 실패(무시):', e);
  }
}
function localRuntimeDir(): string {
  // 통합 루트 아래가 표준. 이전 버전(userData/local-runtime)에 이미 설치돼
  // 있으면 그걸 계속 쓴다 — 마이그레이션으로 수 GB 를 다시 받게 하지 않는다.
  const legacy = join(app.getPath('userData'), 'local-runtime');
  const modern = runtimeDirOf(resolveDataRoot(loadConfig()));
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { existsSync } = require('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { pythonExePath } = require('./local-runtime-install');
    if (!existsSync(pythonExePath(modern)) && existsSync(pythonExePath(legacy))) return legacy;
  } catch {
    /* 해석 실패 — modern */
  }
  return modern;
}
/**
 * 부팅 자동 프로비저닝 — 로컬 실행 런타임은 **기본으로 존재**해야 한다(서버의
 * apply_pin_on_boot 동형). 패키지 앱은 내장 번들이 이미 있으니 no-op; dev/구버전
 * 업데이트/손상 설치처럼 번들이 없을 때만 userData 에 백그라운드 자동 설치한다.
 * 진행률은 메인 창으로 push — 설정 화면이 열려 있으면 실시간 표시된다.
 * 실패해도 앱을 막지 않는다(로컬 턴은 서버 폴백; [설치] 버튼이 수동 재시도).
 */
/**
 * 런타임 자가치유 사다리(설치 폴더 → 내장 번들 복사 → 네트워크 설치) — 서버와 무관하게
 * "항상 쓸 수 있는 런타임"을 보장하고, 상태/원인을 설정 화면에 그대로 드러낸다.
 * 진행은 메인 창으로 push(localRuntimeProgress).
 */
let localEnsurer: LocalRuntimeEnsurer | null = null;
function getLocalEnsurer(): LocalRuntimeEnsurer {
  if (!localEnsurer) {
    localEnsurer = new LocalRuntimeEnsurer({
      installDir: () => runtimeDirOf(resolveDataRoot(loadConfig())),
      bundleDir: () => (app.isPackaged && process.resourcesPath ? process.resourcesPath : null),
      legacyDir: () => join(app.getPath('userData'), 'local-runtime'),
      fetch: mcpHttpFetch as unknown as typeof fetch,
      onProgress: (p) => {
        try {
          mainWindow?.webContents.send(CHANNELS.localRuntimeProgress, p);
        } catch {
          /* 창 없음 */
        }
      },
      log: (m) => {
        void import('./diag-log')
          .then(({ diag }) => diag('local-exec', `ensure: ${m}`))
          .catch(() => {});
      },
    });
  }
  return localEnsurer;
}
async function ensureLocalRuntimeOnBoot(): Promise<void> {
  if (loadConfig().localExec?.autoRuntime === false) {
    // 인스톨러에서 런타임 체크 해제 — 복구는 하지 않되 현재 상태는 파악한다(번들/레거시 사용 가능).
    await getLocalEnsurer()
      .resolveActive()
      .catch(() => undefined);
    return;
  }
  await getLocalEnsurer().ensure('boot');
}
function localChatDeps(signal?: AbortSignal): LocalChatDeps {
  return {
    serverUrl: () => normalizeServerUrl(loadConfig().serverUrl),
    token: () => liveAccessToken(),
    fetch: mcpHttpFetch as unknown as NetworkFetch,
    resolveWorkspaceDir: async (workflowId: string) => {
      const r = await localSync?.ensureSynced(workflowId, workflowId);
      const dir = r?.dir ?? localSync?.dirFor(workflowId) ?? null;
      if (!dir) throw new Error('로컬 동기화 폴더 없음');
      return dir;
    },
    runtimeInstalled: async () => {
      // 건강한 런타임 후보(설치 폴더 → 내장 번들 → 레거시)가 있으면 로컬 실행. 없으면
      // 사다리를 한 번 돌려 본다(번들 복사/다운로드는 백그라운드로 이어진다).
      const e = getLocalEnsurer();
      if (e.activePython()) return true;
      const active = await e.resolveActive().catch(() => undefined);
      if (active) return true;
      void e.ensure('turn');
      return false;
    },
    runner: getSidecarDaemon(),
    // 이 PC 에 설치된 CLI(codex/claude) 경로 + 격리 홈을 사이드카 settings 로 주입.
    cliSettings: () => localCliSettings({ runtimeDir: cliRuntimeDir() }),
    // CLI provider 턴 직전 바이너리 보장 — 없으면 공식 배포처에서 자동 설치(서버 목표 버전).
    ensureCli: (tool) => ensureCliInstalled(tool),
    flushSync: async (workflowId) => (await localSync?.flushSync(workflowId)) ?? false,
    deviceName: () => defaultDeviceName(hostname(), userInfo().username),
    diag: (m) => {
      void import('./diag-log').then(({ diag }) => diag('local-exec', m)).catch(() => {});
    },
    signal,
  };
}
/** CLI 바이너리 자동 보장 — 도구별 single-flight(연타 턴이 중복 설치하지 않게). */
const cliEnsureInflight = new Map<string, Promise<boolean>>();
function ensureCliInstalled(tool: 'codex' | 'claude'): Promise<boolean> {
  const le = loadConfig().localExec ?? {};
  if ((tool === 'codex' ? le.autoCodex : le.autoClaude) === false) return Promise.resolve(false);
  const deps = { runtimeDir: cliRuntimeDir(), fetch: mcpHttpFetch as unknown as typeof fetch };
  const st = localCliGetStatus(deps);
  if ((tool === 'codex' ? st.codex : st.claude).installed) return Promise.resolve(true);
  const inflight = cliEnsureInflight.get(tool);
  if (inflight) return inflight;
  const p = (async () => {
    // 무소음 — 자동 경로는 UI 로 진행을 보내지 않는다(diag 만; 버튼 경로는 자체 표시).
    const emit = () => {};
    // 서버 매니페스트가 있으면 **서버와 같은 버전**으로.
    const m = localConverger?.status().manifest ?? null;
    const version = (tool === 'codex' ? m?.codex?.target : m?.claude?.target) ?? undefined;
    const r =
      tool === 'codex'
        ? await installCodexCli(deps, emit, { version })
        : await installClaudeCli(deps, emit, { version });
    return r.ok;
  })().finally(() => cliEnsureInflight.delete(tool));
  cliEnsureInflight.set(tool, p);
  return p;
}
function localExecStatus() {
  // 유일한 진실 = **설치 폴더**. 인스톨러(NSIS 복사)와 부팅 안전망(cpSync)이
  // <설치폴더>/local-runtime 을 반드시 채우므로, 여기 존재 여부만 본다(레거시
  // userData 는 폴백). 상태 판정은 라우팅(localChatDeps.runtimeInstalled)과 같다.
  const fast = localRuntimeGetStatusFast({ runtimeDir: localRuntimeDir() });
  const active = getLocalEnsurer().activePython();
  // installed = 지금 라우팅이 쓸 수 있는 건강한 런타임이 있다(설치 폴더/번들/레거시).
  const st = active
    ? {
        ...fast,
        installed: true,
        pythonPath: active.python,
        version: active.version ?? fast.version,
      }
    : fast;
  const conv = localConverger?.status() ?? { manifest: null, running: false };
  const m = conv.manifest;
  return {
    enabled: loadConfig().localExec?.enabled !== false,
    ...st,
    runtimeDir: localRuntimeDir(),
    daemon: sidecarDaemon?.status() ?? { running: false, activeTurns: 0 },
    cli: localCliGetStatus({ runtimeDir: cliRuntimeDir() }),
    server: m
      ? {
          runtime: m.runtime?.version,
          claude: m.claude?.target ?? m.claude?.pinned ?? null,
          codex: m.codex?.target ?? m.codex?.pinned ?? null,
          claudeEnabled: m.claude?.enabled,
          codexEnabled: m.codex?.enabled,
          manifestAt: conv.manifestAt,
        }
      : null,
    converge: {
      running: conv.running,
      lastRunAt: conv.lastRunAt,
      lastError: conv.lastError,
      summary: conv.summary,
    },
    ensure: getLocalEnsurer().status(),
  };
}
ipcMain.handle(CHANNELS.localRuntimeSync, async () => {
  if (client?.user) await getLocalConverger().converge();
  return localExecStatus();
});
ipcMain.handle(CHANNELS.localRuntimeStatus, async () => {
  const st = localExecStatus();
  if (!st.installed) {
    // 원인 확정용 진단(무 UI) — 스토리지 탭 [진단 로그 복사]로 회수된다.
    try {
      const { diag } = await import('./diag-log');
      const { readdirSync, existsSync } = await import('node:fs');
      const rp = process.resourcesPath ?? '(none)';
      const listing = existsSync(rp) ? readdirSync(rp).join(',') : '(missing)';
      diag(
        'local-exec',
        `런타임 미검출: dir=${localRuntimeDir()} resources=${rp} [${listing.slice(0, 300)}]`,
      );
    } catch {
      /* 진단 실패 무시 */
    }
  }
  return st;
});
ipcMain.handle(CHANNELS.localRuntimeInstall, async () => {
  // [지금 설치/복구] — 자가치유 사다리(설치 폴더 → 내장 번들 복사 → 네트워크 설치).
  const st = await getLocalEnsurer().ensure('button');
  return { ok: st.phase === 'ready' && !!st.active, status: st, error: st.lastError };
});

// CLI 바이너리(codex / Claude Code) 프로비저닝 — 진행률은 localRuntimeProgress 재사용.
/** CLI 는 항상 설치 폴더 하위(local-runtime/bin) — 설치 스크립트와 같은 목적지. */
function cliRuntimeDir(): string {
  return runtimeDirOf(resolveDataRoot(loadConfig()));
}
ipcMain.handle(CHANNELS.localCliStatus, () => localCliGetStatus({ runtimeDir: cliRuntimeDir() }));
ipcMain.handle(CHANNELS.localCliInstall, async (event, tool: unknown) => {
  // CLI 는 항상 설치 폴더 하위 — 상태/라우팅(cliRuntimeDir)과 같은 곳(레거시 userData
  // 런타임이 있어도 여기). 서버 매니페스트가 있으면 그 버전으로.
  const deps = { runtimeDir: cliRuntimeDir(), fetch: mcpHttpFetch as unknown as typeof fetch };
  const m = localConverger?.status().manifest ?? null;
  const emit = (p: unknown) => {
    try {
      event.sender.send(CHANNELS.localRuntimeProgress, p);
    } catch {
      /* 렌더러 사라짐 */
    }
  };
  if (tool === 'codex')
    return installCodexCli(deps, emit, { version: m?.codex?.target ?? undefined });
  if (tool === 'claude')
    return installClaudeCli(deps, emit, { version: m?.claude?.target ?? undefined });
  return { ok: false, error: `알 수 없는 도구: ${String(tool)}` };
});

ipcMain.handle(CHANNELS.syncStatus, () => {
  return localSync?.status() ?? { enabled: false, reason: 'disabled', agents: [] };
});
ipcMain.handle(CHANNELS.syncNow, async (_e, workflowId?: unknown) => {
  await localSync?.syncNow(typeof workflowId === 'string' ? workflowId : undefined);
  return localSync?.status();
});
/** 동기화된 에이전트 폴더 나열 — 인앱 탐색기가 로컬 실파일을 그대로 본다. */
ipcMain.handle(CHANNELS.syncList, async (_e, workflowId: unknown, rel: unknown) => {
  const dir = typeof workflowId === 'string' ? localSync?.dirFor(workflowId) : null;
  if (!dir) return [];
  const relPath = typeof rel === 'string' ? rel : '';
  if (relPath && !isSafeRelPath(relPath)) return [];
  const abs = join(dir, ...relPath.split('/').filter(Boolean));
  try {
    const { readdir, stat } = await import('fs/promises');
    const entries = await readdir(abs, { withFileTypes: true });
    const out: Array<{ name: string; isDir: boolean; size: number; mtime: number }> = [];
    for (const e of entries) {
      if (e.name === '.xgeny-session') continue;
      try {
        const st = await stat(join(abs, e.name));
        out.push({
          name: e.name,
          isDir: e.isDirectory(),
          size: e.isFile() ? st.size : 0,
          mtime: Math.floor(st.mtimeMs),
        });
      } catch {
        /* 나열 도중 사라진 항목 */
      }
    }
    return out;
  } catch {
    return [];
  }
});
ipcMain.handle(CHANNELS.syncOpenPath, (_e, workflowId: unknown, rel: unknown) => {
  const dir = typeof workflowId === 'string' ? localSync?.dirFor(workflowId) : null;
  if (!dir) return { ok: false };
  const relPath = typeof rel === 'string' ? rel : '';
  if (relPath && !isSafeRelPath(relPath)) return { ok: false };
  openInFileManager(join(dir, ...relPath.split('/').filter(Boolean)));
  return { ok: true };
});

/** 워크스페이스 설정 변경 → 저장 + 마운트 리컨사일. */
async function saveWorkspace(next: unknown): Promise<unknown> {
  const saved = { workspace: saveCurrentWorkspace(next as WorkspacePersistConfig) };
  await getWorkspaceManager()?.reconcile();
  return saved.workspace;
}

ipcMain.handle(CHANNELS.workspaceStatus, () => {
  return getWorkspaceManager()?.status() ?? { supported: false, mounted: false, agents: [] };
});
/**
 * 에이전트 추가/제거는 **서버에 쓴다.**
 *
 * 예전에는 커넥터가 자기 `connector.json` 에만 적었다. 그래서 웹의 [연결]
 * 목록과 커넥터의 목록이 서로 다른 말을 했다 — 같은 이름의 목록 둘이 각자
 * 다른 저장소를 보고 있었다. 이제 서버가 유일한 원본이고, 로컬 설정은 다음
 * 리컨사일이 서버에서 받아 적는 사본이다.
 *
 * 서버 쓰기가 실패하면 **로컬도 바꾸지 않는다.** 한쪽만 바뀌면 정확히 예전
 * 상태(두 목록이 어긋남)로 돌아간다.
 */
ipcMain.handle(
  CHANNELS.workspaceAttach,
  async (_e, agent: { workflowId: string; label: string }) => {
    await cloudLinkRequest('POST', '/api/cloud/links', {
      workflow_id: agent.workflowId,
      label: agent.label,
    });
    await getWorkspaceManager()?.reconcile();
    return getWorkspaceManager()?.status();
  },
);
ipcMain.handle(CHANNELS.workspaceDetach, async (_e, workflowId: string) => {
  await cloudLinkRequest('DELETE', `/api/cloud/links/${encodeURIComponent(workflowId)}`);
  await getWorkspaceManager()?.reconcile();
  return getWorkspaceManager()?.status();
});
ipcMain.handle(CHANNELS.workspaceRoot, () => rootOf(currentWorkspace()));
ipcMain.handle(CHANNELS.workspaceSetRoot, async () => {
  // 구글 드라이브가 드라이브 위치만 바꾸게 하는 것과 같다 — 폴더 하나를 고른다.
  const win = mainWindow;
  const r = win
    ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
    : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return getWorkspaceManager()?.status();
  // 고른 폴더 **안에** XGEN-Workspace 를 만든다 — 사용자가 문서 폴더를 골랐다고
  // 그 폴더 자체를 워크스페이스로 삼으면 기존 파일과 섞인다.
  // 고른 폴더가 이미 XGEN-Workspace 면 그 안에 또 만들지 않는다 — 그렇게 해서
  // .../XGEN-Workspace/XGEN-Workspace 가 생겼고, 사용자는 되돌리려다 갇혔다.
  const picked = r.filePaths[0];
  const target = basename(picked) === 'XGEN-Workspace' ? picked : join(picked, 'XGEN-Workspace');
  const mgr = getWorkspaceManager();
  try {
    // ⚠ **먼저 걷어낸다.** 마운트된 채로 루트만 바꾸면 옛 지점이 그대로 남아
    // 상위 폴더가 EBUSY 로 잠기고, 되돌아갈 수도 지울 수도 없게 된다.
    await mgr?.detach();
    const cur = currentWorkspace() ?? { agents: [] };
    // 다른 계정이 이미 그 폴더를 쓰고 있으면 막는다 — 두 계정이 같은 폴더를
    // 클라우드로 가리키면 마운트는 하나만 걸리고, 나중에 붙은 쪽이 조용히
    // 이겨 상대 파일을 덮어쓴다.
    const acct = currentAccountKey();
    const clash = acct ? rootConflict(loadConfig().workspaces, acct, target) : null;
    if (clash) throw new Error(`이미 ${describeAccount(clash)} 가 이 폴더를 쓰고 있습니다`);
    const oldRoot = rootOf(cur);
    const moved = moveRoot(cur, target);
    // 옛 마운트 지점이 빈 폴더로 남아 새 루트를 막지 않게 치운다 (비어 있을 때만 —
    // 사용자 파일이 남아 있으면 절대 건드리지 않는다).
    await removeIfEmptyDir(oldRoot);
    await saveWorkspace(moved.config);
  } catch (e) {
    // 여기서 던지면 렌더러는 이유를 못 받고, 최악의 경우 앱이 죽는다.
    console.log(`[workspace] 위치 변경 실패: ${(e as Error).message}`);
    const { diag } = await import('./diag-log');
    diag('workspace', `위치 변경 실패: ${(e as Error).message}`);
    return { ...(mgr?.status() ?? {}), error: `위치를 바꾸지 못했습니다: ${(e as Error).message}` };
  }
  return getWorkspaceManager()?.status();
});

/** 빈 디렉터리면 지운다. 내용이 있으면 손대지 않는다 (사용자 파일이다). */
async function removeIfEmptyDir(dir: string): Promise<void> {
  try {
    const { readdir, rmdir } = await import('fs/promises');
    if ((await readdir(dir)).length === 0) await rmdir(dir);
  } catch {
    /* 없거나 못 지우면 그대로 둔다 — 마운트 사전 점검이 다시 처리한다 */
  }
}

/** 가상 드라이브 on/off — 끄면 즉시 걷어낸다. */
ipcMain.handle(CHANNELS.workspaceSetEnabled, async (_e, enabled: boolean) => {
  const cur = currentWorkspace() ?? { agents: [] };
  if (!enabled) await getWorkspaceManager()?.detach();
  await saveWorkspace({ ...cur, enabled: !!enabled });
  return getWorkspaceManager()?.status();
});
ipcMain.handle(CHANNELS.workspaceRemount, async () => {
  await getWorkspaceManager()?.remount();
  return getWorkspaceManager()?.status();
});
ipcMain.handle(CHANNELS.workspaceRefresh, async () => {
  await getWorkspaceManager()?.refreshNow();
  return getWorkspaceManager()?.status();
});
ipcMain.handle(CHANNELS.workspaceRefreshAgents, async () => {
  await getWorkspaceManager()?.refreshLinks();
  return getWorkspaceManager()?.status();
});
ipcMain.handle(CHANNELS.workspaceOpen, () => {
  const p = getWorkspaceManager()?.status()?.path;
  if (p) openInFileManager(p);
  return { ok: !!p };
});

/** 드라이브 경로 검증 — `/` 시작, `..` 세그먼트 금지. 탐색기 IPC 공용. */
function safeDrivePath(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return null;
  const parts = raw.split('/').filter(Boolean);
  if (parts.some((s) => s === '.' || s === '..')) return null;
  return '/' + parts.join('/');
}

/** 인앱 탐색기 — 폴더 하나의 직계 자식. 마운트가 아니라 백엔드로 읽는다. */
ipcMain.handle(CHANNELS.workspaceList, async (_e, path: unknown) => {
  const p = safeDrivePath(path);
  if (!p) return [];
  try {
    return (await getWorkspaceManager()?.list(p)) ?? [];
  } catch (e) {
    const { diag } = await import('./diag-log');
    diag('workspace', `탐색기 목록 실패 ${p}: ${(e as Error).message}`);
    return [];
  }
});

/** 드라이브 안 파일/폴더를 OS 로 연다 — 마운트되어 있을 때만 가능하다. */
ipcMain.handle(CHANNELS.workspaceOpenPath, (_e, path: unknown) => {
  const root = getWorkspaceManager()?.status()?.path;
  const p = safeDrivePath(path);
  if (!root || !p) return { ok: false };
  // 마운트 경로는 이 프로세스에서 동기 접근하면 데드락 — openInFileManager 가
  // 자식 프로세스로 여는 이유다. join 은 문자열 연산이라 안전하다.
  openInFileManager(join(root, ...p.split('/').filter(Boolean)));
  return { ok: true };
});

ipcMain.handle(CHANNELS.diagCopy, async () => {
  // ⚠ 렌더러의 navigator.clipboard 는 Electron 에서 조용히 실패할 수 있다
  // (보안 컨텍스트/권한). main 의 clipboard 모듈은 항상 동작한다.
  const { diagText, diagHeader } = await import('./diag-log');
  const text = `${diagHeader({ app: app.getVersion() })}\n\n${diagText()}`;
  clipboard.writeText(text);
  return { ok: true, chars: text.length };
});
ipcMain.handle(CHANNELS.diagText, async () => {
  const { diagText } = await import('./diag-log');
  return diagText();
});
ipcMain.handle(CHANNELS.mcpRefresh, async () => {
  // 설정 화면을 열 때/테스트 성공 후 다시 붙여 본다 — 런타임을 나중에 설치한
  // 경우 예전 실패 문구가 계속 남아 있으면 안 된다.
  await getMcpBridge().refreshCatalog();
  return getMcpBridge().status();
});

// ── IPC: 시크릿 저장 상태 (키체인 불가 표면화) ────────────────────
ipcMain.handle(CHANNELS.secureStorageStatus, () => storageStatus());

// ── IPC: quick-chat ──────────────────────────────────────────────
ipcMain.handle(CHANNELS.quickChatGetEnabled, () => !!loadConfig().quickChat);
ipcMain.handle(CHANNELS.quickChatSetEnabled, (_e, enabled: boolean) => {
  setQuickChatEnabled(!!enabled);
  return !!enabled;
});
ipcMain.handle(
  CHANNELS.quickChatGetHotkey,
  () => loadConfig().quickChatHotkey ?? DEFAULT_QUICKCHAT,
);
ipcMain.handle(CHANNELS.quickChatSubmit, (_e, text: string) => {
  const r = deliverQuickChat(text);
  if (r.ok) dismissQuickChat();
  return r;
});
ipcMain.on(CHANNELS.quickChatClose, () => dismissQuickChat());

// ── app lifecycle ────────────────────────────────────────────────
/**
 * 메인 프로세스에서 예외/거부가 새어 나가면 Electron 은 **앱을 그대로 종료**한다.
 *
 * 사용자에게는 "앱이 그냥 꺼졌다"로만 보이고 원인이 어디에도 남지 않는다
 * (실기: 워크스페이스 폴더를 바꾸려는 순간 앱이 사라짐). 배경 작업 하나가
 * 실패했다고 앱 전체가 죽을 이유는 없다 — 로그에 남기고 살려 둔다.
 */
process.on('uncaughtException', (err) => {
  try {
    console.log(`[main] 처리되지 않은 예외: ${err?.stack || err}`);
    void import('./diag-log').then(({ diag }) =>
      diag('main', `처리되지 않은 예외: ${err?.stack || err}`),
    );
  } catch {
    /* 로깅 실패가 종료 사유가 되면 안 된다 */
  }
});
process.on('unhandledRejection', (reason) => {
  try {
    console.log(`[main] 처리되지 않은 거부: ${String(reason)}`);
    void import('./diag-log').then(({ diag }) =>
      diag('main', `처리되지 않은 거부: ${String(reason)}`),
    );
  } catch {
    /* 위와 같다 */
  }
});

// Single-instance: a second launch focuses the existing app instead of opening
// a duplicate (important — global hotkeys + tray must be owned by one instance).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());

  app.whenReady().then(() => {
    const cfg = loadConfig();
    if (cfg.theme) nativeTheme.themeSource = cfg.theme;
    applyCertificatePolicy();
    applyMcpHttpCertificatePolicy();

    // Voice input: the renderer calls navigator.mediaDevices.getUserMedia for the
    // push-to-talk mic. Electron denies media by default unless we approve it —
    // grant ONLY 'media', deny every other permission request.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(permission === 'media');
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');

    // Avatar asset proxy: xgenavatar://a/<path> → <serverUrl>/<path>, fetched in
    // the main process (no CORS/CSP). The renderer points the Live2D/Spine loader
    // at xgenavatar:// URLs so model3.json + its relative moc3/textures/atlas
    // siblings all resolve through here.
    protocol.handle('xgenavatar', async (request) => {
      try {
        const u = new URL(request.url);
        const serverUrl = normalizeServerUrl(loadConfig().serverUrl).replace(/\/+$/, '');
        if (!serverUrl) return new Response('avatar proxy: no server URL', { status: 502 });
        // xgenavatar://a/<path> → <serverUrl>/<path>. Electron net.fetch: no CORS/CSP.
        return await net.fetch(`${serverUrl}${u.pathname}${u.search}`, { method: 'GET' });
      } catch (e) {
        return new Response(`avatar proxy error: ${e instanceof Error ? e.message : String(e)}`, {
          status: 502,
        });
      }
    });
    // The install callback flips appQuitting so quitAndInstall isn't blocked by
    // the close-to-tray guard.
    initUpdater({
      enabled: cfg.autoUpdate ?? true,
      updateServer: cfg.updateServer ?? 'github',
      isConfigured: () => !!normalizeServerUrl(loadConfig().serverUrl),
      xgenServerUrl: () => normalizeServerUrl(loadConfig().serverUrl),
      xgenToken: async () => (await liveAccessToken()) || null,
      onWillInstall: () => {
        appQuitting = true;
      },
    });
    const trayOk = createTray();
    // `--hidden` (autostart) → start in the tray without showing the window.
    // 트레이 생성 실패(리눅스 appindicator 부재 등) 시 --hidden 을 취소한다 —
    // 트레이도 창도 없는 도달 불가 프로세스 방지 (geny-connector 동형).
    const startHidden = process.argv.includes('--hidden') && trayOk;
    createWindow();
    if (startHidden) mainWindow?.removeAllListeners('ready-to-show');
    settleDataRootOnBoot(); // 통합 루트(~/xgen-connector) 정착 — 아래 배선들이 새 기본을 읽는다.
    wireWorkspaceManager();
    wireLocalSync();
    // 부팅 자동 프로비저닝: 런타임 → CLI(체크된 것) 순차 백그라운드.
    void ensureLocalRuntimeOnBoot().then(async () => {
      const le = loadConfig().localExec ?? {};
      if (le.autoCodex !== false) await ensureCliInstalled('codex').catch(() => false);
      if (le.autoClaude !== false) await ensureCliInstalled('claude').catch(() => false);
      convergeLocalRuntimeInBackground('boot');
    });
    if (cfg.avatarOverlay) createOverlay();
    if (cfg.quickChat) {
      createQuickChat();
      registerQuickChatHotkey();
    }
    app.on('activate', () => showMain());

    // Monitor plug/unplug/rearrange or a DPI change → mark a settle window so
    // bounds saves hold off on transient rescale values, then rescue any window
    // that ended up off-screen on a now-disconnected monitor.
    let displayTimer: ReturnType<typeof setTimeout> | null = null;
    const onDisplayChange = () => {
      dpiSettleUntil = Date.now() + 1800;
      if (displayTimer) clearTimeout(displayTimer);
      displayTimer = setTimeout(ensureWindowsOnScreen, 900);
    };
    screen.on('display-removed', onDisplayChange);
    screen.on('display-added', onDisplayChange);
    screen.on('display-metrics-changed', onDisplayChange);
  });

  // Tray app — never auto-quit when the window is hidden/closed. Quit only via
  // the tray "종료" (which sets appQuitting first).
  app.on('window-all-closed', () => {
    /* stay resident in the tray */
  });
  app.on('before-quit', () => {
    sidecarDaemon?.shutdown();
    appQuitting = true;
    saveOverlayGeometry(true); // don't drop a pending move/resize on quit
  });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    disposeUpdater();
    getMcpBridge().stop();
    void getBrowserRuntime().closeAll();
    void getMcpManager().closeAll();
    // ⚠ 마운트를 남긴 채 죽으면 폴더가 스테일 상태로 먹통이 된다.
    void getWorkspaceManager()?.stop();
  });
}
