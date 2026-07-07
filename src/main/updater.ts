/**
 * Auto-update via electron-updater → GitHub Releases (PlateerLab/xgen-connector).
 *
 * Mirrors geny-connector: checks on launch (8s delay) and every 6h. When
 * `autoUpdate` is on it downloads + prompts to restart; when off it only
 * notifies so the user updates on demand. Self-update is only possible in a
 * packaged build and not on macOS (unsigned) — there "check" opens the
 * Releases page.
 */
import { app, dialog, shell, BrowserWindow } from 'electron';
import type { AppUpdater } from 'electron-updater';

const RELEASES_URL = 'https://github.com/PlateerLab/xgen-connector/releases';
const SIX_HOURS = 6 * 60 * 60 * 1000;

let autoUpdate = true;
let timer: NodeJS.Timeout | null = null;
let updaterRef: AppUpdater | null = null;

function canSelfUpdate(): boolean {
  return app.isPackaged && process.platform !== 'darwin';
}

async function getUpdater(): Promise<AppUpdater | null> {
  if (!canSelfUpdate()) return null;
  if (updaterRef) return updaterRef;
  const { autoUpdater } = await import('electron-updater');
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', async (info) => {
    if (autoUpdate) {
      await autoUpdater.downloadUpdate().catch(() => {});
    } else {
      notify(`새 버전 ${info.version} 이 있습니다. 설정에서 업데이트할 수 있습니다.`);
    }
  });
  autoUpdater.on('update-downloaded', async () => {
    const res = await dialog.showMessageBox({
      type: 'info',
      buttons: ['지금 재시작', '나중에'],
      defaultId: 0,
      message: '업데이트가 준비되었습니다',
      detail: '재시작하면 새 버전이 적용됩니다.',
    });
    if (res.response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on('error', () => {
    /* update errors are non-fatal */
  });
  updaterRef = autoUpdater;
  return autoUpdater;
}

function notify(message: string): void {
  const win = BrowserWindow.getAllWindows()[0];
  win?.webContents.send('updater:message', message);
}

async function runCheck(): Promise<void> {
  const u = await getUpdater();
  if (!u) return;
  await u.checkForUpdates().catch(() => {});
}

export function initUpdater(enabled: boolean): void {
  autoUpdate = enabled;
  if (!canSelfUpdate()) return;
  setTimeout(() => void runCheck(), 8000);
  timer = setInterval(() => void runCheck(), SIX_HOURS);
}

export function setAutoUpdate(enabled: boolean): void {
  autoUpdate = enabled;
}

export function getAutoUpdate(): boolean {
  return autoUpdate;
}

/** Manual "check for updates" (from settings/tray). */
export async function checkNow(): Promise<{ opened?: boolean }> {
  if (!canSelfUpdate()) {
    await shell.openExternal(RELEASES_URL);
    return { opened: true };
  }
  await runCheck();
  return {};
}

export function disposeUpdater(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
