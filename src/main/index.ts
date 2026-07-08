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
import { app, BrowserWindow, ipcMain, shell, nativeTheme, screen } from 'electron';
import { join } from 'node:path';
import { XgenClient, type ChatEvent } from '../core/index';
import { loadConfig, saveConfig, normalizeServerUrl, type ConnectorConfig } from './config';
import { tokenStore } from './keychain';
import { initUpdater, setAutoUpdate, getAutoUpdate, checkNow, disposeUpdater } from './updater';
import { CHANNELS } from './ipc';

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let client: XgenClient | null = null;
const aborters = new Map<string, AbortController>();

/** The last avatar/chat state pushed from the main window, replayed to a
 * freshly-opened overlay so it isn't blank until the next stream event. */
let lastOverlayState: unknown = null;

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
  mainWindow.on('close', () => {
    if (!mainWindow) return;
    const b = mainWindow.getBounds();
    saveConfig({ window: { width: b.width, height: b.height, x: b.x, y: b.y } });
    // The overlay is a helper of the main window — tear it down so the app quits.
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
    overlayWindow = null;
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
  mainWindow?.webContents.send(CHANNELS.configChanged, next);
}

// ── IPC: config ──────────────────────────────────────────────────
ipcMain.handle(CHANNELS.configGet, () => loadConfig());
ipcMain.handle(CHANNELS.configSet, (_e, patch: Partial<ConnectorConfig>) => {
  const next = saveConfig(patch);
  if (patch.serverUrl !== undefined) getClient(); // rebind base URL
  if (patch.autoUpdate !== undefined) setAutoUpdate(!!patch.autoUpdate);
  if (patch.theme) nativeTheme.themeSource = patch.theme;
  mainWindow?.webContents.send(CHANNELS.configChanged, next);
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
  const b = overlayWindow.getBounds();
  overlayWindow.setBounds({ ...b, x: Math.round(b.x + dx), y: Math.round(b.y + dy) });
});
ipcMain.on(CHANNELS.overlayFocusMain, () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});
ipcMain.on(CHANNELS.overlayHide, () => setOverlayEnabled(false));

// ── app lifecycle ────────────────────────────────────────────────
app.whenReady().then(() => {
  const cfg = loadConfig();
  if (cfg.theme) nativeTheme.themeSource = cfg.theme;
  initUpdater(cfg.autoUpdate ?? true);
  createWindow();
  if (cfg.avatarOverlay) createOverlay();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('will-quit', () => disposeUpdater());
