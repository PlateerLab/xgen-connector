/**
 * Auto-update via electron-updater → GitHub Releases (PlateerLab/xgen-connector).
 *
 * Feed = the `publish: github PlateerLab/xgen-connector` block in
 * electron-builder.yml (embedded as app-update.yml). electron-updater reads
 * latest*.yml from the newest release, downloads the matching installer, and
 * prompts to restart.
 *
 * Toggle (default ON, persisted in connector.json):
 *   • ON  → on launch (8s) + every 6h: check, download, prompt to restart.
 *   • OFF → still CHECK; if an update exists, show a desktop NOTIFICATION so the
 *           user knows. Clicking it (or 설정/트레이 → 업데이트 확인) updates.
 *
 * Manual "업데이트 확인" always gives explicit feedback via a native dialog
 * (up-to-date / downloading / failed) AND an inline message to the settings
 * modal — the previous silent check made it look broken.
 *
 * Platform support (unsigned): Windows (NSIS) + Linux (AppImage) self-update;
 * macOS needs a Developer-ID signature (Squirrel.Mac), so there "check" opens
 * the Releases page instead.
 */
import { app, dialog, shell, BrowserWindow, Notification } from 'electron';
import type { AppUpdater } from 'electron-updater';

const RELEASES_URL = 'https://github.com/PlateerLab/xgen-connector/releases/latest';
const SIX_HOURS = 6 * 60 * 60 * 1000;

let autoUpdate = true;
let timer: NodeJS.Timeout | null = null;
let updaterRef: AppUpdater | null = null;
let lastNotifiedVersion: string | null = null;
// Set by initUpdater so quitAndInstall can bypass the close-to-tray quit guard.
let appWillInstall: () => void = () => {};

function canSelfUpdate(): boolean {
  return app.isPackaged && process.platform !== 'darwin';
}

/** Compare dotted versions: >0 if a>b, <0 if a<b, 0 if equal. */
function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The latest published release version, via the GitHub API (works everywhere,
 * no signing/zip requirements — used for the macOS check where electron-updater
 * can't self-install). */
async function latestReleaseVersion(): Promise<string> {
  const res = await fetch(
    'https://api.github.com/repos/PlateerLab/xgen-connector/releases/latest',
    { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'xgen-connector' } },
  );
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const json = (await res.json()) as { tag_name?: string };
  return String(json.tag_name ?? '').replace(/^v/, '');
}

/** macOS (unsigned) / any non-self-updating packaged build: check the version
 * via the API and, if newer, point the user to the Releases page for the dmg. */
async function checkViaApiAndOpen(manual: boolean): Promise<void> {
  let latest: string;
  try {
    latest = await latestReleaseVersion();
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    notify('업데이트 확인 실패');
    if (manual) await dialog.showMessageBox({ type: 'error', message: '업데이트 확인에 실패했습니다.', detail });
    return;
  }
  if (!latest || cmpVersion(latest, app.getVersion()) <= 0) {
    notify(`최신 버전입니다 (v${app.getVersion()})`);
    if (manual) {
      await dialog.showMessageBox({ type: 'info', message: '최신 버전입니다.', detail: `현재 v${app.getVersion()}` });
    }
    return;
  }
  notify(`새 버전 v${latest} 이(가) 있습니다.`);
  if (manual) {
    const res = await dialog.showMessageBox({
      type: 'info',
      buttons: ['릴리스 페이지 열기', '나중에'],
      defaultId: 0,
      cancelId: 1,
      message: `새 버전 v${latest} 이(가) 있습니다.`,
      detail: `현재 v${app.getVersion()}. macOS 는 서명 문제로 앱 내 자동 설치가 안 되므로, 릴리스 페이지에서 새 dmg 를 받아 설치해 주세요.`,
    });
    if (res.response === 0) await shell.openExternal(RELEASES_URL);
  } else {
    notifyUpdateAvailable(latest);
  }
}

/** Push a short status line to the settings modal (inline feedback). */
function notify(message: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('updater:message', message);
  }
}

async function getUpdater(): Promise<AppUpdater | null> {
  if (!canSelfUpdate()) return null;
  if (updaterRef) return updaterRef;
  const { autoUpdater } = await import('electron-updater');
  // We download explicitly (per the toggle / manual action), not automatically.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('download-progress', (p) => {
    notify(`업데이트 내려받는 중… ${Math.round(p.percent)}%`);
  });
  autoUpdater.on('update-downloaded', async (info) => {
    notify(`업데이트 준비됨 (v${info.version})`);
    const res = await dialog.showMessageBox({
      type: 'info',
      buttons: ['지금 재시작', '나중에'],
      defaultId: 0,
      cancelId: 1,
      title: '업데이트 준비됨',
      message: `XGEN Connector ${info.version} 가 다운로드됐습니다.`,
      detail: '지금 재시작하면 새 버전이 설치됩니다.',
    });
    // isForceRunAfter=true → relaunch after install so the user doesn't have to
    // start it manually.
    if (res.response === 0) {
      appWillInstall();
      autoUpdater.quitAndInstall(false, true);
    }
  });
  autoUpdater.on('error', (err) => {
    console.error('[updater]', err?.message ?? err);
  });
  updaterRef = autoUpdater;
  return autoUpdater;
}

async function runCheck(manual: boolean): Promise<void> {
  if (!canSelfUpdate()) {
    // macOS (packaged, unsigned): can't self-install, but we CAN check the
    // version via the API and point the user to the dmg. Runs on auto-checks too
    // so the OFF-toggle notification path works on mac as well.
    if (process.platform === 'darwin' && app.isPackaged) {
      await checkViaApiAndOpen(manual);
      return;
    }
    // Dev build → nothing to update.
    if (manual) {
      notify('개발 모드에서는 업데이트를 확인할 수 없습니다.');
      await dialog.showMessageBox({ message: '개발 모드에서는 업데이트를 확인하지 않습니다.' });
    }
    return;
  }

  const u = await getUpdater();
  if (!u) return;

  if (manual) notify('업데이트 확인 중…');
  let latest: string | undefined;
  try {
    const result = await u.checkForUpdates();
    latest = result?.updateInfo?.version;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error('[updater] check failed', detail);
    notify('업데이트 확인 실패');
    if (manual) {
      await dialog.showMessageBox({ type: 'error', message: '업데이트 확인에 실패했습니다.', detail });
    }
    return;
  }

  if (!latest || latest === app.getVersion()) {
    notify(`최신 버전입니다 (v${app.getVersion()})`);
    if (manual) {
      await dialog.showMessageBox({
        type: 'info',
        message: '최신 버전입니다.',
        detail: `현재 v${app.getVersion()}`,
      });
    }
    return;
  }

  // An update exists.
  if (manual || autoUpdate) {
    notify(`새 버전 v${latest} 내려받는 중…`);
    if (manual) {
      await dialog.showMessageBox({
        type: 'info',
        message: `새 버전 v${latest} 을(를) 내려받는 중입니다.`,
        detail: '완료되면 재시작 여부를 물어봅니다.',
      });
    }
    await u.downloadUpdate().catch((e) => console.error('[updater] download', e));
  } else {
    // Auto-update OFF → notify only; the user updates on demand.
    notifyUpdateAvailable(latest);
  }
}

function notifyUpdateAvailable(version: string): void {
  if (lastNotifiedVersion === version) return; // don't re-nag for the same version
  lastNotifiedVersion = version;
  notify(`새 버전 v${version} 이(가) 있습니다.`);
  if (Notification.isSupported()) {
    const n = new Notification({
      title: 'XGEN Connector 업데이트',
      body: `새 버전 v${version} — 클릭하면 지금 업데이트합니다.`,
    });
    n.on('click', () => void getUpdater().then((u) => u?.downloadUpdate().catch(() => undefined)));
    n.show();
  }
}

export function initUpdater(enabled: boolean, onWillInstall?: () => void): void {
  autoUpdate = enabled;
  if (onWillInstall) appWillInstall = onWillInstall;
  // Schedule background checks in any PACKAGED build (win/linux self-update;
  // macOS notifies + points to the dmg). Dev builds never check.
  if (!app.isPackaged) return;
  setTimeout(() => void runCheck(false), 8000);
  timer = setInterval(() => void runCheck(false), SIX_HOURS);
}

export function setAutoUpdate(enabled: boolean): void {
  autoUpdate = enabled;
  // Re-enabling → check right away so a pending update is picked up.
  if (enabled) void runCheck(false);
}

export function getAutoUpdate(): boolean {
  return autoUpdate;
}

/** Manual "업데이트 확인" (settings/tray) — always gives explicit feedback. */
export async function checkNow(): Promise<{ opened?: boolean }> {
  await runCheck(true);
  return {};
}

export function disposeUpdater(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
