/* Manual/CI smoke for Electron webContents.debugger -> isolated CDP proxy -> agent-browser. */
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');

const proxyModule = process.argv[2];
const binary = process.argv[3];
if (!proxyModule || !binary)
  throw new Error('usage: electron browser-cdp-smoke.cjs <compiled-proxy.cjs> <agent-browser>');
const { CdpPageProxy } = require(proxyModule);

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (data) => {
      out += String(data);
    });
    child.stderr.on('data', (data) => {
      err += String(data);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(err || out || `exit ${code}`)),
    );
  });
}

app
  .whenReady()
  .then(async () => {
    const session = `xgen-cdp-smoke-${Date.now()}`;
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    const proxy = new CdpPageProxy('smoke-page', win.webContents, () => {});
    try {
      await win.loadURL('data:text/html,<button id="go">Smoke button</button>');
      const port = await proxy.start();
      const common = ['--session', session, '--cdp', String(port), '--json'];
      const snapshot = await run([...common, 'snapshot', '-i']);
      if (!snapshot.includes('Smoke button') || !snapshot.includes('e1')) {
        throw new Error(`unexpected snapshot: ${snapshot}`);
      }
      console.log('browser CDP smoke: ok');
    } finally {
      await run(['--session', session, '--json', 'close']).catch(() => undefined);
      await proxy.stop();
      if (!win.isDestroyed()) win.destroy();
    }
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
