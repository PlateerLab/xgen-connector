// afterPack — ad-hoc code-sign the macOS .app.
//
// The connector ships UN-notarized (no paid Apple Developer ID yet). On Apple
// Silicon an *unsigned* app is hard-blocked at launch with "손상되었기 때문에
// 열 수 없습니다 — 휴지통으로 이동" (right-click → Open does NOT bypass it). An
// *ad-hoc* signature is a valid signature for execution, so Gatekeeper
// downgrades that to the bypassable "확인되지 않은 개발자" prompt, and the
// `xattr -dr com.apple.quarantine` escape hatch always works.
//
// When a real Developer ID is configured (CSC_LINK / CSC_IDENTITY present),
// electron-builder already signs properly — skip the ad-hoc pass so we don't
// clobber it. Notarization can then layer on via @electron/notarize.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK || process.env.CSC_IDENTITY) return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  console.log(`[afterPack] ad-hoc signing ${appPath}`);
  // --deep so the nested Electron Framework + Helper bundles are covered.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });
  console.log('[afterPack] ad-hoc signature applied');
};
