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
import { basename, join, resolve, sep } from 'node:path';
import { XgenClient, type ChatEvent, type TtsSpeakOptions } from '../core/index';
import {
  loadConfig,
  saveConfig,
  resetConfig,
  normalizeServerUrl,
  type ConnectorConfig,
  type SyncPairPersistConfig,
} from './config';
import { tokenStore, credentialStore, storageStatus } from './keychain';
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
import {
  initWorkspaceManager,
  getWorkspaceManager,
} from './workspace-manager';
import { makeWorkspaceApi } from './workspace-api';
import { WorkspaceWsClient } from './sync-transport';
import { hostname } from 'os';
import { attachAgent, detachAgent, moveRoot, rootOf } from './workspace';
import { TRAY_ICON_B64 } from './tray-icon';
import { getMcpManager } from './mcp-manager';
import { getMcpBridge } from './mcp-bridge';
import { initSyncManager, getSyncManager, type SyncPairStatus } from './sync-manager';
import {
  buildSsoUrl,
  parseSsoLoginResponse,
  shouldAllowPrivateCertificate,
} from './connection-security';
import { createSsoWindowOptions } from './sso-window-options';

const IS_LINUX = process.platform === 'linux';

// Custom scheme the avatar overlay loads model assets through. Registered
// BEFORE app-ready. The renderer (a file:// / WebGL context) can't reliably
// fetch cross-origin avatar assets from the user's XGEN server (CORS/CSP vary
// by deployment); routing them through the MAIN process (Node net.fetch, no
// CORS, no CSP) makes it work regardless. `standard` lets relative sibling refs
// (moc3/textures/atlas) resolve; `corsEnabled`+`bypassCSP` keep WebGL happy.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'xgenavatar',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true },
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

function getClient(): XgenClient {
  const cfg = loadConfig();
  if (!client) {
    client = new XgenClient({
      baseUrl: normalizeServerUrl(cfg.serverUrl),
      // Chromium 네트워크 스택을 사용해 OS 프록시·인증서 정책을 공유한다.
      fetch: (input, init) => net.fetch(input, init),
      onAuthFailure: () => safeSend(mainWindow, CHANNELS.authFailed),
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
    },
  });

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
  if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)) return defaults;
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
    console.warn(`[connector] content load failed (${errorCode} ${errorDesc}); retry in ${Math.round(delay)}ms`);
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
    saveConfig({ overlayByDisplay: { ...(cfg.overlayByDisplay || {}), [displayKey(d)]: bounds }, overlayBounds: bounds });
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
function asWinBounds(b: { width: number; height: number; x?: number; y?: number } | undefined): WinBounds | undefined {
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
  // Click-through by default; the renderer flips this off over interactive regions.
  applyOverlayIgnoreMouse(overlayWindow, true);

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
  overlayWindow.on('moved', onOverlayMoved);
  overlayWindow.on('resized', () => saveOverlayGeometry());
  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
  overlayWindow.once('ready-to-show', () => {
    overlayWindow?.show();
    if (lastOverlayState) overlayWindow?.webContents.send(CHANNELS.overlayState, lastOverlayState);
  });

  loadRendererPage(overlayWindow, 'overlay.html');
}

/** 오버레이 클릭 통과 정책 (geny-connector 리눅스 강건성 이식).
 *
 * `setIgnoreMouseEvents(true, {forward:true})` 의 forward 는 darwin/win32
 * 전용이다 — 리눅스에서 클릭 통과를 켜면 마우스 이벤트가 **전혀** 오지 않아
 * 렌더러의 hover 기반 인터랙션 복귀가 영원히 불가능하다 (오버레이 영구
 * 입력 불능). 리눅스 기본값은 '항상 인터랙티브'; 사용자가 설정의
 * linuxClickThrough 로 옵트인하면 완전 클릭 통과(상호작용 불가)를 감수한다. */
function applyOverlayIgnoreMouse(win: BrowserWindow | null, ignore: boolean): void {
  if (!win || win.isDestroyed()) return;
  if (IS_LINUX) {
    win.setIgnoreMouseEvents(ignore && !!loadConfig().linuxClickThrough);
    return;
  }
  win.setIgnoreMouseEvents(ignore, { forward: true });
}

function setOverlayEnabled(enabled: boolean): void {
  const next = saveConfig({ avatarOverlay: enabled });
  if (enabled) createOverlay();
  else if (overlayWindow && !overlayWindow.isDestroyed()) {
    saveOverlayGeometry(true); // persist last move/resize before tearing the window down
    overlayWindow.destroy();
    overlayWindow = null;
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
    overlayWindow.setBounds({ x: wa.x + wa.width - w - 28, y: wa.y + wa.height - h - 28, width: w, height: h });
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
  getSyncManager()?.stopAll();
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
function currentUserId(): string | null {
  return client?.user?.userId ?? null;
}
/** Reconcile MCP manager + bridge with config + login state. */
function syncMcp(): void {
  const cfg = loadConfig();
  const mcp = getMcpManager();
  mcp.configure(cfg.mcpServers);
  const bridge = getMcpBridge();
  if (!mcpStatusWired) {
    mcpStatusWired = true;
    bridge.setStatusListener((s) => safeSend(mainWindow, CHANNELS.mcpStatusEvent, s));
  }
  const userId = currentUserId();
  if (cfg.mcp && userId) {
    // start() is idempotent for the same target: it refreshes the catalog on a
    // live socket instead of tearing it down, so repeated syncMcp() (e.g. on
    // token refresh / restore) never flaps the connection status.
    bridge.start({
      serverUrl: normalizeServerUrl(cfg.serverUrl),
      userId,
      getToken: () => tokenStore.getAccess(),
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
function ensureDeviceId(): string {
  const cfg = loadConfig();
  if (cfg.deviceId) return cfg.deviceId;
  const id = randomUUID();
  saveConfig({ deviceId: id });
  return id;
}

function wireSyncManager(): void {
  initSyncManager({
    indexDir: join(app.getPath('userData'), 'sync-index'),
    serverUrl: () => normalizeServerUrl(loadConfig().serverUrl),
    token: () => tokenStore.getAccess(),
    deviceId: () => ensureDeviceId(),
    onStatus: (statuses: SyncPairStatus[]) => safeSend(mainWindow, CHANNELS.syncStatusEvent, statuses),
    log: (msg: string) => console.log(`[sync] ${msg}`),
    // 엔진의 자동 일시정지(쿼터 폭풍·에이전트 삭제)를 config 에 영속 —
    // 재시작 후에도 이유가 표시되고 재해머링하지 않는다.
    onAutoPause: (id: string, reason: string) => {
      const pairs = (loadConfig().syncPairs ?? []).map((p) =>
        p.id === id ? { ...p, paused: true, pausedReason: reason } : p,
      );
      saveConfig({ syncPairs: pairs });
      getSyncManager()?.configure(pairs);
    },
  });
  getSyncManager()?.configure(loadConfig().syncPairs ?? []);
}

/** 페어링 변경 → 저장 + 엔진 리컨사일 + 상태 브로드캐스트. */
function saveSyncPairs(pairs: SyncPairPersistConfig[]): SyncPairPersistConfig[] {
  const next = saveConfig({ syncPairs: pairs });
  getSyncManager()?.configure(next.syncPairs ?? []);
  return next.syncPairs ?? [];
}

/** 로컬 경로 중첩/중복 가드 — 같은 폴더(또는 부모/자식)를 두 페어링이 잡으면
 *  두 허브가 서로 핑퐁하며 발산한다 (geny-connector 동형). */
function syncPathOverlaps(a: string, b: string): boolean {
  const ra = resolve(a) + sep;
  const rb = resolve(b) + sep;
  return ra === rb || ra.startsWith(rb) || rb.startsWith(ra);
}

// ── IPC: config ──────────────────────────────────────────────────
ipcMain.handle(CHANNELS.configGet, () => loadConfig());
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
    // 구 서버의 workflow 를 가리키는 페어링은 새 서버에서 무의미 — 엔진을
    // 내리고 전부 일시정지로 전환한다 (재해머링·오연결 방지, 명시 재개 필요).
    getSyncManager()?.stopAll();
    void getWorkspaceManager()?.reconcile();
    patch = {
      ...patch,
      syncPairs: (loadConfig().syncPairs ?? []).map((p) => ({
        ...p,
        paused: true,
        pausedReason: 'session_gone',
      })),
    };
    void client?.logout().catch(() => undefined); // 구 서버 세션 무효화 (rebind 전 호출)
    client = null; // in-memory user/token 을 남기지 않도록 새 인스턴스로
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
  if (patch.autoUpdate !== undefined) setAutoUpdate(!!patch.autoUpdate);
  if (patch.updateServer !== undefined) setUpdateServer(patch.updateServer);
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
  getSyncManager()?.configure(loadConfig().syncPairs ?? []); // 로그인 → 페어링 재가동
  safeSend(overlayWindow, CHANNELS.avatarRefresh); // client is now authed → overlay can load the avatar
  checkForUpdatesAfterLogin();
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
  const url = buildSsoUrl(normalizeServerUrl(cfg.serverUrl), cfg.ssoPath ?? '/sso/signin', SSO_CALLBACK);
  const ssoDebug = cfg.ssoDebug === true;
  if (ssoWindow && !ssoWindow.isDestroyed()) {
    ssoWindow.show();
    ssoWindow.focus();
    throw new Error('SSO 로그인이 이미 진행 중입니다.');
  }

  return new Promise<{ user: NonNullable<XgenClient['user']>; tokenPersisted: boolean }>((resolve, reject) => {
    const win = new BrowserWindow(
      createSsoWindowOptions(join(__dirname, '../preload/sso.js'), ssoDebug, mainWindow ?? undefined),
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
  });
});

ipcMain.on(CHANNELS.authSsoComplete, (event, payload: unknown) => {
  if (!pendingSso || !ssoWindow || event.sender !== ssoWindow.webContents) return;
  let callbackOrigin: string;
  let serverOrigin: string;
  try {
    callbackOrigin = new URL(event.senderFrame.url).origin;
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

ipcMain.handle(CHANNELS.authLogin, async (_e, email: string, password: string, remember?: boolean) => {
  const c = getClient();
  const res = await c.login(email, password);
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
});

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
  const verdict = await c.restoreDetailed(access, refresh ?? undefined).catch(() => 'network' as const);
  if (verdict === 'valid') {
    const rotated = c.getAccessTokenAfterRotation();
    if (rotated && rotated !== access) await tokenStore.setAccess(rotated);
    const rotatedRefresh = c.getRefreshToken();
    if (rotatedRefresh && rotatedRefresh !== refresh) await tokenStore.setRefresh(rotatedRefresh);
    syncMcp();
    getSyncManager()?.configure(loadConfig().syncPairs ?? []);
    safeSend(overlayWindow, CHANNELS.avatarRefresh); // session restored → overlay can load the avatar
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
  getSyncManager()?.stopAll(); // 토큰 없이 401 을 반복 해머링하지 않게 (재로그인 시 재가동)
  // 가상 드라이브는 로그인 상태에서만 존재한다 — 로그아웃하면 걷어낸다.
  void getWorkspaceManager()?.reconcile();
  if (client) await client.logout();
  await tokenStore.clear();
  // An explicit logout also disables auto-login (else next launch signs right back in).
  await credentialStore.clear();
  saveConfig({ autoLogin: false });
  return true;
});

ipcMain.handle(CHANNELS.authStatus, () => ({ user: client?.user ?? null }));
ipcMain.handle(CHANNELS.userAvatarConfig, () => getClient().preferences.getAvatarConfig());
ipcMain.handle(CHANNELS.userSaveAvatarConfig, (_e, cfg) => getClient().preferences.saveAvatarConfig(cfg));
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
ipcMain.handle(CHANNELS.avatarDeleteAsset, (_e, avatarId: string) => getClient().avatars.deleteAsset(avatarId));
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
ipcMain.handle(CHANNELS.avatarStoreDownload, (_e, storeId: string) => getClient().avatars.storeDownload(storeId));
ipcMain.handle(CHANNELS.avatarStoreRate, (_e, storeId: string, stars: number) =>
  getClient().avatars.storeRate(storeId, stars),
);
ipcMain.handle(CHANNELS.avatarStoreUnpublish, (_e, storeId: string) => getClient().avatars.storeUnpublish(storeId));

// ── IPC: agents ──────────────────────────────────────────────────
ipcMain.handle(CHANNELS.agentsList, (_e, query) => getClient().agents.list(query ?? {}));

// ── IPC: voice (STT/TTS) ─────────────────────────────────────────
// The renderer captures audio via getUserMedia and hands bytes to main; main
// proxies to the backend with the Bearer token. Secrets never reach here.
ipcMain.handle(CHANNELS.voiceConfig, () => getClient().voice.getVoiceConfig());
ipcMain.handle(CHANNELS.voiceTranscribe, (_e, bytes: Uint8Array, mime: string, language?: string) => {
  // Copy to a standalone ArrayBuffer (the IPC view may span a shared buffer).
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const blob = new Blob([buf], { type: mime || 'audio/webm' });
  return getClient().voice.transcribe(blob, language);
});
ipcMain.handle(
  CHANNELS.voiceSpeak,
  async (_e, text: string, opts?: TtsSpeakOptions) => {
    const blob = await getClient().voice.speak(text, opts);
    const buf = Buffer.from(await blob.arrayBuffer());
    return { bytes: new Uint8Array(buf), mime: blob.type };
  },
);

// ── IPC: history ─────────────────────────────────────────────────
ipcMain.handle(CHANNELS.historyTurns, (_e, workflowId: string, interactionId: string, name?: string) =>
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
  (async () => {
    try {
      for await (const ev of getClient().chat.stream(req, controller.signal)) {
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
  applyOverlayIgnoreMouse(overlayWindow, !!ignore);
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
    dialog.showErrorBox(
      '설정 초기화 실패',
      err instanceof Error ? err.message : String(err),
    );
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
ipcMain.handle(CHANNELS.mcpSaveServers, (_e, servers) => {
  const next = saveConfig({ mcpServers: Array.isArray(servers) ? servers : [] });
  syncMcp();
  broadcastConfig(next);
  return next.mcpServers ?? [];
});
ipcMain.handle(CHANNELS.mcpTestServer, (e, cfg) =>
  // 첫 실행은 인터프리터·의존성 내려받기로 몇 분이 걸릴 수 있다 — 그동안의
  // 서버 출력을 요청한 창으로 그대로 흘려보낸다.
  getMcpManager().test(cfg, (lines) => {
    if (!e.sender.isDestroyed()) e.sender.send(CHANNELS.mcpTestProgressEvent, { name: cfg?.name, lines });
  }),
);
ipcMain.handle(CHANNELS.mcpStatus, () => getMcpBridge().status());

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

// ── 워크스페이스(가상 드라이브) ─────────────────────────────────
function wireWorkspaceManager(): void {
  initWorkspaceManager({
    config: () => loadConfig().workspace,
    apiFor: (workflowId: string) =>
      makeWorkspaceApi(
        {
          serverUrl: () => normalizeServerUrl(loadConfig().serverUrl),
          token: async () => (await tokenStore.getAccess()) ?? '',
          deviceId: () => ensureDeviceId(),
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
          token: async () => (await tokenStore.getAccess()) ?? '',
          deviceId: () => ensureDeviceId(),
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
          token: async () => (await tokenStore.getAccess()) ?? '',
          workflowId: owner,
          deviceId: ensureDeviceId(),
        },
        hostname(),
        () => onChanged(),
        () => undefined,
      ),
    onStatus: (s: unknown) => safeSend(mainWindow, CHANNELS.workspaceStatusEvent, s),
  });
  void getWorkspaceManager()?.reconcile();
}

/** 워크스페이스 설정 변경 → 저장 + 마운트 리컨사일. */
async function saveWorkspace(next: unknown): Promise<unknown> {
  const saved = saveConfig({ workspace: next as never });
  await getWorkspaceManager()?.reconcile();
  return saved.workspace;
}

ipcMain.handle(CHANNELS.workspaceStatus, () => {
  return getWorkspaceManager()?.status() ?? { supported: false, mounted: false, agents: [] };
});
ipcMain.handle(CHANNELS.workspaceAttach, async (_e, agent: { workflowId: string; label: string }) => {
  const cur = loadConfig().workspace ?? { agents: [] };
  const next = attachAgent(cur, { ...agent, id: randomUUID() });
  await saveWorkspace(next);
  return getWorkspaceManager()?.status();
});
ipcMain.handle(CHANNELS.workspaceDetach, async (_e, workflowId: string) => {
  const next = detachAgent(loadConfig().workspace ?? { agents: [] }, workflowId);
  await saveWorkspace(next);
  return getWorkspaceManager()?.status();
});
ipcMain.handle(CHANNELS.workspaceRoot, () => rootOf(loadConfig().workspace));
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
    const cur = loadConfig().workspace ?? { agents: [] };
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
  const cur = loadConfig().workspace ?? { agents: [] };
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
ipcMain.handle(CHANNELS.workspaceOpen, () => {
  const p = getWorkspaceManager()?.status()?.path;
  if (p) openInFileManager(p);
  return { ok: !!p };
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

// ── IPC: workspace 동기화 ────────────────────────────────────────
ipcMain.handle(CHANNELS.syncList, () => ({
  pairs: loadConfig().syncPairs ?? [],
  statuses: getSyncManager()?.statuses() ?? [],
}));
ipcMain.handle(CHANNELS.syncPickFolder, async () => {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const res = win
    ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
    : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
});
ipcMain.handle(
  CHANNELS.syncAddPair,
  (_e, workflowId: string, workflowLabel: string, localPath: string) => {
    if (!workflowId || !localPath) return { ok: false, error: 'invalid arguments' };
    const pairs = loadConfig().syncPairs ?? [];
    for (const p of pairs) {
      if (syncPathOverlaps(p.localPath, localPath)) {
        return {
          ok: false,
          error: '이미 동기화 중인 폴더(또는 그 상위/하위 폴더)입니다 — 겹치는 페어링은 서로 충돌합니다.',
        };
      }
    }
    const pair: SyncPairPersistConfig = {
      id: randomUUID(),
      workflowId,
      workflowLabel: workflowLabel || undefined,
      localPath,
    };
    return { ok: true, pairs: saveSyncPairs([...pairs, pair]) };
  },
);
ipcMain.handle(CHANNELS.syncRemovePair, (_e, id: string) => {
  const pairs = (loadConfig().syncPairs ?? []).filter((p) => p.id !== id);
  return saveSyncPairs(pairs);
});
ipcMain.handle(CHANNELS.syncSetPaused, (_e, id: string, paused: boolean) => {
  const pairs = (loadConfig().syncPairs ?? []).map((p) =>
    p.id === id ? { ...p, paused: !!paused, pausedReason: undefined } : p,
  );
  return saveSyncPairs(pairs);
});
ipcMain.handle(CHANNELS.syncNow, (_e, id: string) => {
  getSyncManager()?.syncNow(id);
  return true;
});
ipcMain.handle(CHANNELS.syncConfirmMassDelete, (_e, id: string, accept: boolean) => {
  getSyncManager()?.confirmMassDelete(id, !!accept);
  // 거부는 일시정지로 이어진다 — config 에도 반영해 재시작 후 유지.
  if (!accept) {
    const pairs = (loadConfig().syncPairs ?? []).map((p) =>
      p.id === id ? { ...p, paused: true } : p,
    );
    saveConfig({ syncPairs: pairs });
  }
  return true;
});
ipcMain.handle(CHANNELS.syncOpenFolder, (_e, id: string) => {
  const pair = (loadConfig().syncPairs ?? []).find((p) => p.id === id);
  if (pair) void shell.openPath(pair.localPath);
  return true;
});

// ── IPC: 시크릿 저장 상태 (키체인 불가 표면화) ────────────────────
ipcMain.handle(CHANNELS.secureStorageStatus, () => storageStatus());

// ── IPC: quick-chat ──────────────────────────────────────────────
ipcMain.handle(CHANNELS.quickChatGetEnabled, () => !!loadConfig().quickChat);
ipcMain.handle(CHANNELS.quickChatSetEnabled, (_e, enabled: boolean) => {
  setQuickChatEnabled(!!enabled);
  return !!enabled;
});
ipcMain.handle(CHANNELS.quickChatGetHotkey, () => loadConfig().quickChatHotkey ?? DEFAULT_QUICKCHAT);
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
    void import('./diag-log').then(({ diag }) => diag('main', `처리되지 않은 예외: ${err?.stack || err}`));
  } catch {
    /* 로깅 실패가 종료 사유가 되면 안 된다 */
  }
});
process.on('unhandledRejection', (reason) => {
  try {
    console.log(`[main] 처리되지 않은 거부: ${String(reason)}`);
    void import('./diag-log').then(({ diag }) => diag('main', `처리되지 않은 거부: ${String(reason)}`));
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
        // xgenavatar://a/<path> → <serverUrl>/<path>. Node net.fetch: no CORS/CSP.
        return await net.fetch(`${serverUrl}${u.pathname}${u.search}`, { method: 'GET' });
      } catch (e) {
        return new Response(`avatar proxy error: ${e instanceof Error ? e.message : String(e)}`, { status: 502 });
      }
    });
    // The install callback flips appQuitting so quitAndInstall isn't blocked by
    // the close-to-tray guard.
    initUpdater({
      enabled: cfg.autoUpdate ?? true,
      updateServer: cfg.updateServer ?? 'github',
      isConfigured: () => !!normalizeServerUrl(loadConfig().serverUrl),
      xgenServerUrl: () => normalizeServerUrl(loadConfig().serverUrl),
      xgenToken: () => tokenStore.getAccess(),
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
    // Workspace 동기화 엔진 — 저장된 페어링을 즉시 가동한다 (토큰이 아직
    // 없으면 changes 가 401 로 실패하고 로그인/restore 후 재가동된다).
    wireSyncManager();
    wireWorkspaceManager();
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
    appQuitting = true;
    saveOverlayGeometry(true); // don't drop a pending move/resize on quit
  });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    disposeUpdater();
    getMcpBridge().stop();
    void getMcpManager().closeAll();
    getSyncManager()?.stopAll(); // 인덱스 플러시 + 워처/WS 정리
    // ⚠ 마운트를 남긴 채 죽으면 폴더가 스테일 상태로 먹통이 된다.
    void getWorkspaceManager()?.stop();
  });
}
