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
} from 'electron';
import { join } from 'node:path';
import { XgenClient, type ChatEvent } from '../core/index';
import { loadConfig, saveConfig, normalizeServerUrl, type ConnectorConfig } from './config';
import { tokenStore } from './keychain';
import { initUpdater, setAutoUpdate, getAutoUpdate, checkNow, disposeUpdater } from './updater';
import { CHANNELS } from './ipc';
import { TRAY_ICON_B64 } from './tray-icon';

let tray: Tray | null = null;

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let client: XgenClient | null = null;
const aborters = new Map<string, AbortController>();

/** The last avatar/chat state pushed from the main window, replayed to a
 * freshly-opened overlay so it isn't blank until the next stream event. */
let lastOverlayState: unknown = null;

/** Broadcast a config change to every window (main + overlay + quick-chat) so
 * live prefs (theme, subtitles, avatarHidden, toggles) apply everywhere. */
function broadcastConfig(next: ConnectorConfig): void {
  for (const w of [mainWindow, overlayWindow, quickChatWindow]) {
    if (w && !w.isDestroyed()) w.webContents.send(CHANNELS.configChanged, next);
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
      onAuthFailure: () => mainWindow?.webContents.send(CHANNELS.authFailed),
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
    minWidth: 720,
    minHeight: 520,
    show: false,
    title: 'XGEN Connector',
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

  loadRendererPage(mainWindow, 'index.html');
}

// ── Floating avatar overlay (Geny-style) ─────────────────────────
// A transparent, frameless, always-on-top, click-through window that floats the
// avatar (extension point) + a live subtitle of the active chat stream. When no
// avatar renderer is registered it shows just the streaming reply as a floating
// bubble ("아바타가 없으면 채팅만"). TTS/STT/screen-capture are intentionally omitted.
let overlayBoundsTimer: ReturnType<typeof setTimeout> | null = null;
function saveOverlayBounds(): void {
  if (overlayBoundsTimer) clearTimeout(overlayBoundsTimer);
  overlayBoundsTimer = setTimeout(() => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    const b = overlayWindow.getBounds();
    saveConfig({ overlayBounds: { width: b.width, height: b.height, x: b.x, y: b.y } });
  }, 400);
}

function createOverlay(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.show();
    return;
  }
  const wa = screen.getPrimaryDisplay().workArea;
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

  // Float above full-screen apps too (macOS).
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') {
    overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  // Click-through by default; the renderer flips this off over interactive regions.
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });

  overlayWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  overlayWindow.on('moved', saveOverlayBounds);
  overlayWindow.on('resized', saveOverlayBounds);
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
    quickChatWindow.setBounds({ x: saved.x, y: saved.y, width: QUICKCHAT_W, height: QUICKCHAT_H });
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
  quickChatWindow.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') {
    quickChatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
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
  mainWindow?.webContents.send(CHANNELS.openSettingsModal);
}

function applyAutoLaunch(enabled: boolean): void {
  // No-op on Linux (electron ignores setLoginItemSettings there); best-effort.
  if (process.platform === 'linux') return;
  app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: enabled, args: ['--hidden'] });
}

function resetPositions(): void {
  saveConfig({ overlayBounds: undefined, quickChatBar: undefined });
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

// ── IPC: config ──────────────────────────────────────────────────
ipcMain.handle(CHANNELS.configGet, () => loadConfig());
ipcMain.handle(CHANNELS.configSet, (_e, patch: Partial<ConnectorConfig>) => {
  const next = saveConfig(patch);
  if (patch.serverUrl !== undefined) getClient(); // rebind base URL
  if (patch.autoUpdate !== undefined) setAutoUpdate(!!patch.autoUpdate);
  if (patch.theme) nativeTheme.themeSource = patch.theme;
  broadcastConfig(next);
  return next;
});

// ── IPC: auth ────────────────────────────────────────────────────
ipcMain.handle(CHANNELS.authLogin, async (_e, email: string, password: string) => {
  const c = getClient();
  const res = await c.login(email, password);
  await tokenStore.setAccess(c.getAccessTokenAfterRotation());
  if (res.refreshToken) await tokenStore.setRefresh(res.refreshToken);
  return { user: c.user };
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
    return { user: c.user };
  }
  await tokenStore.clear();
  return { user: null };
});

ipcMain.handle(CHANNELS.authLogout, async () => {
  if (client) await client.logout();
  await tokenStore.clear();
  return true;
});

ipcMain.handle(CHANNELS.authStatus, () => ({ user: client?.user ?? null }));

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
  });

  // Tray app — never auto-quit when the window is hidden/closed. Quit only via
  // the tray "종료" (which sets appQuitting first).
  app.on('window-all-closed', () => {
    /* stay resident in the tray */
  });
  app.on('before-quit', () => {
    appQuitting = true;
  });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    disposeUpdater();
  });
}
