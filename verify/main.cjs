// Headless (offscreen) screenshot harness for visual verification.
// Loads the built renderer with a mock bridge and captures PNGs of each screen.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const OUT = process.env.SHOTS_DIR || '/tmp/shots';
const STAGE = process.env.VERIFY_STAGE || 'workspace';
const W = 1280, H = 820;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function snap(win, name) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, name), img.toPNG());
  console.log('shot:', name);
}

// Drive a React-controlled input/textarea: set value via the native setter then
// dispatch an 'input' event so React's onChange fires.
const DRIVE = `
function setNativeValue(el, value){
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
`;

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // Overlay stage: capture the floating avatar window on a "desktop" backdrop.
  if (STAGE === 'overlay') {
    const ov = new BrowserWindow({
      width: 360, height: 480, show: false,
      backgroundColor: '#2f3d57', // stand-in wallpaper so the floating card is visible
      webPreferences: { offscreen: true, preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: false },
    });
    ov.webContents.setFrameRate(30);
    await ov.loadFile(path.join(__dirname, '..', 'out', 'renderer', 'overlay.html'));
    await sleep(1700);
    await snap(ov, 'overlay.png');
    app.quit();
    return;
  }

  const win = new BrowserWindow({
    width: W, height: H, show: false,
    webPreferences: {
      offscreen: true,
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: false,
    },
  });
  win.webContents.setFrameRate(30);
  await win.loadFile(path.join(__dirname, '..', 'out', 'renderer', 'index.html'));
  await win.webContents.executeJavaScript(DRIVE + 'true');
  await sleep(1200); // fonts + restore

  if (STAGE === 'login') {
    await snap(win, 'login.png');
    app.quit();
    return;
  }

  // workspace lands with an agent auto-selected → empty chat (header alignment + input)
  await snap(win, 'workspace-empty.png');

  // Drive a chat turn
  await win.webContents.executeJavaScript(`(() => {
    const ta = document.querySelector('.composer-input');
    if (ta) { setNativeValue(ta, '안녕하세요!'); }
    return !!ta;
  })()`);
  await sleep(150);
  await win.webContents.executeJavaScript(`(() => {
    const ta = document.querySelector('.composer-input');
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  await sleep(1900); // let the scripted stream finish
  await snap(win, 'chat.png');

  // Collapse the sidebar
  await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('.sidebar-head-actions .icon-btn')].find((b) => b.title.includes('접기'));
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(400);
  await snap(win, 'collapsed.png');

  // Expand again (toggle in the chat header)
  await win.webContents.executeJavaScript(`(() => {
    const btn = document.querySelector('.chat-title .sidebar-toggle');
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(300);

  // History tab
  await win.webContents.executeJavaScript(`(() => {
    const tabs = [...document.querySelectorAll('.side-tab')];
    const h = tabs.find((t) => t.textContent.includes('대화 기록'));
    if (h) h.click();
    return !!h;
  })()`);
  await sleep(500);
  await snap(win, 'history.png');

  // Open a past conversation → loads its turns
  await win.webContents.executeJavaScript(`(() => {
    const it = document.querySelector('.conv-item');
    if (it) it.click();
    return !!it;
  })()`);
  await sleep(900);
  await snap(win, 'resumed.png');

  // Settings modal
  await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('.sidebar-head-actions .icon-btn')].find((b) => b.title.includes('설정'));
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(500);
  await snap(win, 'settings.png');

  app.quit();
});
