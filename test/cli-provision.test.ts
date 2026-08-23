// CLI 프로비저닝 — 순수 자산명/플랫폼키/경로/상태/settings 를 검증한다.
// 실제 다운로드·실행은 실검증(리눅스: codex 0.149.0 / claude 2.1.231 관통)으로 증명.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  claudePlatformKey,
  cliBinaryPath,
  cliSettings,
  codexAssetName,
  getCliStatus,
} from '../src/main/cli-provision';

test('codexAssetName: 공식 릴리스 고정 자산명 (실검증 200)', () => {
  assert.equal(codexAssetName('linux', 'x64'), 'codex-x86_64-unknown-linux-musl.tar.gz');
  assert.equal(codexAssetName('darwin', 'arm64'), 'codex-aarch64-apple-darwin.tar.gz');
  assert.equal(codexAssetName('win32', 'x64'), 'codex-x86_64-pc-windows-msvc.exe.zip');
});

test('claudePlatformKey: manifest.json 의 플랫폼 키와 동일', () => {
  assert.equal(claudePlatformKey('linux', 'x64'), 'linux-x64');
  assert.equal(claudePlatformKey('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(claudePlatformKey('win32', 'x64'), 'win32-x64');
});

test('cliBinaryPath: bin/ 아래, win 은 .exe', () => {
  assert.equal(
    cliBinaryPath({ runtimeDir: '/rt', platform: 'linux' }, 'codex'),
    join('/rt', 'bin', 'codex'),
  );
  assert.equal(
    cliBinaryPath({ runtimeDir: '/rt', platform: 'win32' }, 'claude'),
    join('/rt', 'bin', 'claude.exe'),
  );
});

test('getCliStatus/cliSettings: 미설치 → installed=false, settings 비움', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-status-'));
  try {
    const s = getCliStatus({ runtimeDir: dir });
    assert.equal(s.codex.installed, false);
    assert.equal(s.claude.installed, false);
    const s2 = cliSettings({ runtimeDir: dir });
    // 바이너리 미설치 → 경로 settings 없음. 격리 홈(codex-home/claude-home)은 항상 준비된다.
    assert.equal(s2.CODEX_BINARY_PATH, undefined);
    assert.equal(s2.CLAUDE_CODE_BINARY_PATH, undefined);
    assert.equal(s2.XGEN_LOCAL_CODEX_HOME, join(dir, 'codex-home'));
    assert.equal(s2.XGEN_LOCAL_CLAUDE_CONFIG_DIR, join(dir, 'claude-home'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
