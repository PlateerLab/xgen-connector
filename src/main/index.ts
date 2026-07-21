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
} from 'electron';
import { join } from 'node:path';
import { XgenClient, type ChatEvent } from '../core/index';
import { loadConfig, saveConfig, normalizeServerUrl, type ConnectorConfig } from './config';
import { tokenStore, credentialStore } from './keychain';
import { initUpdater, setAutoUpdate, getAutoUpdate, checkNow, disposeUpdater } from './updater';
import { CHANNELS } from './ipc';
import { TRAY_ICON_B64 } from './tray-icon';
import { getMcpManager } from './mcp-manager';
import { getMcpBridge } from './mcp-bridge';

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
      // Node 18+ global fetch (undici) — long-lived SSE supported.
      onAuthFailure: () => safeSend(mainWindow, CHANNELS.authFailed),
    });
  } else {
    client.setBaseUrl(normalizeServerUrl(cfg.serverUrl));
  }
  return client;
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
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });

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
  quickChatWindow.setIgnoreMouseEvents(true, { forward: true });
  quickChatWindow.showInactive();
}

function dismissQuickChat(): void {
  if (!quickChatWindow || quickChatWindow.isDestroyed()) return;
  quickChatOpen = false;
  quickChatWindow.setIgnoreMouseEvents(true, { forward: true });
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
  if (mainWindow.isMinimized()) mainWindow.restore();
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

function applyAutoLaunch(enabled: boolean): void {
  // No-op on Linux (electron ignores setLoginItemSettings there); best-effort.
  if (process.platform === 'linux') return;
  app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: enabled, args: ['--hidden'] });
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

// ── System tray (작업 표시줄) ─────────────────────────────────────
function createTray(): void {
  if (tray) return;
  const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_B64}`);
  tray = new Tray(icon);
  tray.setToolTip('XGEN Connector');
  rebuildTrayMenu();
  tray.on('click', () => showMain());
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
        saveConfig({ autoLaunch: item.checked });
        applyAutoLaunch(item.checked);
      },
    },
    { label: '위치 초기화', click: () => resetPositions() },
    { type: 'separator' },
    {
      label: '재시작',
      click: () => {
        appQuitting = true;
        app.relaunch();
        app.quit();
      },
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
    void client?.logout().catch(() => undefined); // 구 서버 세션 무효화 (rebind 전 호출)
    client = null; // in-memory user/token 을 남기지 않도록 새 인스턴스로
    await tokenStore.clear();
    await credentialStore.clear();
    patch = { ...patch, autoLogin: false }; // 저장된 자동 로그인은 구 서버 계정
  }
  const next = saveConfig(patch);
  if (patch.serverUrl !== undefined) getClient(); // rebind base URL
  if (patch.autoUpdate !== undefined) setAutoUpdate(!!patch.autoUpdate);
  if (patch.theme) nativeTheme.themeSource = patch.theme;
  broadcastConfig(next);
  if (serverChanged) safeSend(mainWindow, CHANNELS.authFailed); // → 로그인 화면
  return next;
});

// ── IPC: auth ────────────────────────────────────────────────────
// Persist the rotated tokens + wake dependent subsystems after any successful sign-in.
async function afterAuthSuccess(refreshToken?: string): Promise<void> {
  const c = getClient();
  await tokenStore.setAccess(c.getAccessTokenAfterRotation());
  if (refreshToken) await tokenStore.setRefresh(refreshToken);
  syncMcp();
  safeSend(overlayWindow, CHANNELS.avatarRefresh); // client is now authed → overlay can load the avatar
}

ipcMain.handle(CHANNELS.authLogin, async (_e, email: string, password: string, remember?: boolean) => {
  const c = getClient();
  const res = await c.login(email, password);
  await afterAuthSuccess(res.refreshToken);
  // Remember (or forget) credentials for auto-login, per the login-form checkbox.
  if (remember) {
    await credentialStore.save({ email, password });
    saveConfig({ autoLogin: true });
  } else {
    await credentialStore.clear();
    saveConfig({ autoLogin: false });
  }
  return { user: c.user };
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
  } catch {
    // Stale password (changed server-side) → stop retrying it on every launch.
    await credentialStore.clear();
    saveConfig({ autoLogin: false });
    return { user: null };
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
  const ok = await c.restore(access, refresh ?? undefined);
  if (ok) {
    const rotated = c.getAccessTokenAfterRotation();
    if (rotated && rotated !== access) await tokenStore.setAccess(rotated);
    const rotatedRefresh = c.getRefreshToken();
    if (rotatedRefresh && rotatedRefresh !== refresh) await tokenStore.setRefresh(rotatedRefresh);
    syncMcp();
    safeSend(overlayWindow, CHANNELS.avatarRefresh); // session restored → overlay can load the avatar
    return { user: c.user };
  }
  await tokenStore.clear();
  return { user: null };
});

ipcMain.handle(CHANNELS.authLogout, async () => {
  getMcpBridge().stop();
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
  overlayWindow?.setIgnoreMouseEvents(!!ignore, { forward: true });
});
ipcMain.on(CHANNELS.overlayMoveBy, (_e, dx: number, dy: number) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  // Use getPosition/setPosition (NOT setBounds): on fractional-DPI displays
  // (e.g. Windows 150% scaling) setBounds round-trips width/height through the
  // scale factor and the window creeps larger on every drag delta. setPosition
  // only touches x/y, so the size is rock-stable while moving. (Geny's fix.)
  const [x, y] = overlayWindow.getPosition();
  overlayWindow.setPosition(Math.round(x + dx), Math.round(y + dy));
  // Persistence: 'moved' fires on Windows (→ onOverlayMoved, DPI-aware) and the
  // renderer sends overlay:commitBounds on pointer-up for all platforms.
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
  saveOverlayGeometry(true);
});
ipcMain.on(CHANNELS.overlayFocusMain, () => showMain());
ipcMain.on(CHANNELS.overlayOpenSettings, () => openMainSettings());
ipcMain.on(CHANNELS.overlayHide, () => setOverlayEnabled(false));

// ── IPC: app / window management ─────────────────────────────────
ipcMain.handle(CHANNELS.autostartGet, () => loadConfig().autoLaunch === true);
ipcMain.handle(CHANNELS.autostartSet, (_e, enabled: boolean) => {
  saveConfig({ autoLaunch: !!enabled });
  applyAutoLaunch(!!enabled);
  rebuildTrayMenu();
  return !!enabled;
});
ipcMain.on(CHANNELS.resetPositions, () => resetPositions());
ipcMain.on(CHANNELS.appRestart, () => {
  appQuitting = true;
  saveOverlayGeometry(true); // persist any pending move/resize before relaunching
  app.relaunch();
  app.quit();
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
ipcMain.handle(CHANNELS.mcpTestServer, (_e, cfg) => getMcpManager().test(cfg));
ipcMain.handle(CHANNELS.mcpStatus, () => getMcpBridge().status());

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
    initUpdater(cfg.autoUpdate ?? true, () => {
      appQuitting = true;
    });
    createTray();
    // `--hidden` (autostart) → start in the tray without showing the window.
    const startHidden = process.argv.includes('--hidden');
    createWindow();
    if (startHidden) mainWindow?.removeAllListeners('ready-to-show');
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
  });
}
