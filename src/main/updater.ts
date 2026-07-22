/**
 * Auto-update via electron-updater → GitHub Releases (PlateerLab/xgen-connector).
 *
 * The releases repo is PUBLIC, so every feed URL (latest*.yml + installers) is
 * downloadable anonymously — being an org repo makes no difference. Verified:
 *   curl -sL .../releases/latest/download/latest.yml  → 200 + correct version.
 *
 * Platform behaviour:
 *   • Windows (NSIS) + Linux (AppImage): electron-updater self-updates
 *     (download → prompt → quitAndInstall).
 *   • macOS (unsigned): Squirrel.Mac can't apply an update to an unsigned /
 *     ad-hoc-signed app, so we do an ASSISTED update — auto-download the new
 *     .dmg to ~/Downloads and OPEN it, so the user just drags it to Applications.
 *
 * Robustness: all network calls use Electron's `net.fetch` (main-process HTTP,
 * system proxy/cert aware — NOT the ambiguous global fetch) with a timeout, so a
 * check ALWAYS resolves and the UI never gets stuck on "확인 중…".
 */
import { app, dialog, shell, BrowserWindow, Notification, net } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import electronUpdater, { type AppUpdater } from 'electron-updater';

// electron-updater is CommonJS: the `autoUpdater` instance lives on the DEFAULT
// export, NOT as a named export. `import { autoUpdater } from 'electron-updater'`
// (or `const { autoUpdater } = await import(...)`) resolves to `undefined` in the
// bundled main — which silently broke Windows/Linux self-update. Destructure the
// default export instead (Geny's proven pattern).
const { autoUpdater } = electronUpdater;

const REPO = 'PlateerLab/xgen-connector';
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const SIX_HOURS = 6 * 60 * 60 * 1000;

let autoUpdate = true;
let timer: NodeJS.Timeout | null = null;
let updaterRef: AppUpdater | null = null;
let lastNotifiedVersion: string | null = null;
let appWillInstall: () => void = () => {};
let busy = false; // guard against overlapping checks

function isPackagedMac(): boolean {
  return app.isPackaged && process.platform === 'darwin';
}
function canSelfUpdate(): boolean {
  return app.isPackaged && process.platform !== 'darwin';
}

function log(...args: unknown[]): void {
  console.log('[updater]', ...args);
}

/** Push a status line to the settings modal (inline feedback). */
function notify(message: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('updater:message', message);
  }
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

/** Main-process HTTP with a hard timeout, via Electron's net stack. */
async function netFetch(url: string, timeoutMs = 15000): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await net.fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'xgen-connector', Accept: 'application/vnd.github+json' },
    });
  } finally {
    clearTimeout(t);
  }
}

interface GhRelease {
  tag_name?: string;
  assets?: Array<{ name: string; browser_download_url: string; size: number }>;
}
async function latestRelease(): Promise<GhRelease> {
  const res = await netFetch(API_LATEST);
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  return (await res.json()) as GhRelease;
}

// ── electron-updater (Windows / Linux) ───────────────────────────
function getUpdater(): AppUpdater | null {
  if (!canSelfUpdate()) return null;
  if (updaterRef) return updaterRef;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m: unknown) => log('eu', m),
    warn: (m: unknown) => log('eu:warn', m),
    error: (m: unknown) => log('eu:error', m),
    debug: () => {},
  } as never;
  autoUpdater.on('download-progress', (p) => notify(`업데이트 내려받는 중… ${Math.round(p.percent)}%`));
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
    if (res.response === 0) {
      appWillInstall(); // flips appQuitting so close-to-tray can't block the quit
      // SILENT install (isSilent=true). In non-silent mode the NSIS installer
      // pops its interactive "XGEN Connector cannot be closed — Retry" dialog,
      // which RACES the app's own shutdown: the installer runs its app-running
      // check within milliseconds, before app.quit() has finished tearing the
      // windows down and exiting, so it wrongly reports the app as un-closable.
      // Silent + isForceRunAfter=true swaps the files and relaunches without any
      // dialog. (quitAndInstall also calls app.quit() itself.)
      try {
        autoUpdater.quitAndInstall(true, true);
      } catch (e) {
        log('quitAndInstall', e);
      }
      // Safety net: a tray app can linger on quit (MCP stdio child pipes, the
      // overlay/quick-chat sockets). If the process is somehow still alive a few
      // seconds later, force-exit so the installer can replace the locked files.
      setTimeout(() => {
        try {
          app.exit(0);
        } catch {
          /* already gone */
        }
      }, 3500);
    }
  });
  autoUpdater.on('error', (err) => log('error', err?.message ?? err));
  updaterRef = autoUpdater;
  return autoUpdater;
}

/** Wrap a promise with a timeout so a hung check can't leave the UI stuck. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms)),
  ]);
}

// ── macOS assisted update (download the dmg + open it) ────────────
async function macAssistedUpdate(version: string, manual: boolean): Promise<void> {
  try {
    notify(`새 버전 v${version} 내려받는 중…`);
    const rel = await latestRelease();
    const asset = (rel.assets ?? []).find((a) => /\.dmg$/i.test(a.name));
    if (!asset) throw new Error('no dmg asset');
    const res = await netFetch(asset.browser_download_url, 180000);
    if (!res.ok) throw new Error(`download ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const dest = join(app.getPath('downloads'), asset.name);
    writeFileSync(dest, buf);
    notify('다운로드 완료 — 설치 창을 엽니다');
    await shell.openPath(dest);
    if (manual) {
      await dialog.showMessageBox({
        type: 'info',
        message: `새 버전 v${version} 다운로드 완료`,
        detail: `열린 디스크 이미지에서 'XGEN Connector' 를 Applications 폴더로 드래그해 설치하세요.\n파일 위치: ${dest}`,
      });
    }
  } catch (e) {
    log('mac assisted update failed', e);
    notify('릴리스 페이지를 엽니다');
    await shell.openExternal(RELEASES_URL);
    if (manual) {
      await dialog.showMessageBox({
        type: 'info',
        message: `새 버전 v${version} 이(가) 있습니다.`,
        detail: '자동 다운로드에 실패해 릴리스 페이지를 열었습니다. 새 dmg 를 받아 설치해 주세요.',
      });
    }
  }
}

async function macCheck(manual: boolean): Promise<void> {
  let latest: string;
  try {
    latest = String((await latestRelease()).tag_name ?? '').replace(/^v/, '');
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    log('mac check failed', detail);
    notify('업데이트 확인 실패');
    if (manual) await dialog.showMessageBox({ type: 'error', message: '업데이트 확인에 실패했습니다.', detail });
    return;
  }
  if (!latest || cmpVersion(latest, app.getVersion()) <= 0) {
    notify(`최신 버전입니다 (v${app.getVersion()})`);
    if (manual) await dialog.showMessageBox({ type: 'info', message: '최신 버전입니다.', detail: `현재 v${app.getVersion()}` });
    return;
  }
  // Update available.
  if (manual) {
    const res = await dialog.showMessageBox({
      type: 'info',
      buttons: ['지금 업데이트', '나중에'],
      defaultId: 0,
      cancelId: 1,
      message: `새 버전 v${latest} 이(가) 있습니다.`,
      detail: `현재 v${app.getVersion()}. 새 버전을 내려받아 설치 창을 열어드립니다.`,
    });
    if (res.response === 0) await macAssistedUpdate(latest, true);
    else notify(`새 버전 v${latest} 이(가) 있습니다.`);
  } else if (lastNotifiedVersion !== latest) {
    lastNotifiedVersion = latest;
    notifyUpdateAvailable(latest, () => void macAssistedUpdate(latest, false));
  }
}

// ── Windows / Linux check ────────────────────────────────────────
async function winLinuxCheck(manual: boolean): Promise<void> {
  const u = getUpdater();
  if (!u) return;
  if (manual) notify('업데이트 확인 중…');
  let latest: string | undefined;
  try {
    const result = await withTimeout(u.checkForUpdates(), 20000, 'checkForUpdates');
    latest = result?.updateInfo?.version;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    log('check failed', detail);
    notify('업데이트 확인 실패');
    if (manual) await dialog.showMessageBox({ type: 'error', message: '업데이트 확인에 실패했습니다.', detail });
    return;
  }
  if (!latest || latest === app.getVersion()) {
    notify(`최신 버전입니다 (v${app.getVersion()})`);
    if (manual) await dialog.showMessageBox({ type: 'info', message: '최신 버전입니다.', detail: `현재 v${app.getVersion()}` });
    return;
  }
  if (manual || autoUpdate) {
    notify(`새 버전 v${latest} 내려받는 중…`);
    if (manual) {
      await dialog.showMessageBox({
        type: 'info',
        message: `새 버전 v${latest} 을(를) 내려받는 중입니다.`,
        detail: '완료되면 재시작 여부를 물어봅니다.',
      });
    }
    await u.downloadUpdate().catch((e) => log('download', e));
  } else {
    if (lastNotifiedVersion !== latest) {
      lastNotifiedVersion = latest;
      notifyUpdateAvailable(latest, () => void u.downloadUpdate().catch(() => undefined));
    }
  }
}

async function runCheck(manual: boolean): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    if (isPackagedMac()) return await macCheck(manual);
    if (canSelfUpdate()) return await winLinuxCheck(manual);
    // Dev build.
    if (manual) {
      notify('개발 모드에서는 업데이트를 확인할 수 없습니다.');
      await dialog.showMessageBox({ message: '개발 모드에서는 업데이트를 확인하지 않습니다.' });
    }
  } catch (e) {
    // Safety net — a manual check must NEVER end without feedback.
    const detail = e instanceof Error ? e.message : String(e);
    log('runCheck error', detail);
    notify('업데이트 확인 실패');
    if (manual) await dialog.showMessageBox({ type: 'error', message: '업데이트 확인 중 오류가 발생했습니다.', detail });
  } finally {
    busy = false;
  }
}

function notifyUpdateAvailable(version: string, onAccept: () => void): void {
  notify(`새 버전 v${version} 이(가) 있습니다.`);
  if (Notification.isSupported()) {
    const n = new Notification({
      title: 'XGEN Connector 업데이트',
      body: `새 버전 v${version} — 클릭하면 지금 업데이트합니다.`,
    });
    n.on('click', onAccept);
    n.show();
  }
}

export function initUpdater(enabled: boolean, onWillInstall?: () => void): void {
  autoUpdate = enabled;
  if (onWillInstall) appWillInstall = onWillInstall;
  if (!app.isPackaged) return; // dev builds never check
  setTimeout(() => void runCheck(false), 8000);
  timer = setInterval(() => void runCheck(false), SIX_HOURS);
}

export function setAutoUpdate(enabled: boolean): void {
  autoUpdate = enabled;
  if (enabled) void runCheck(false);
}

export function getAutoUpdate(): boolean {
  return autoUpdate;
}

/** Manual "업데이트 확인" — always resolves with explicit feedback. */
export async function checkNow(): Promise<{ opened?: boolean }> {
  await runCheck(true);
  return {};
}

export function disposeUpdater(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
