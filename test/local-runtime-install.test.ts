// 로컬 실행 환경 설치 모듈 — 순수 경로/URL 계산 + 미설치 상태 조회를 검증한다.
// 실제 다운로드·설치는 네트워크/OS 러너가 필요(bundle 실기로 별도 증명됨).
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DEFAULT_RUNTIME_WHEEL,
  RUNTIME_WHEEL_VERSION,
  getStatus,
  pythonArchiveUrl,
  pythonExePath,
  readDistInfoVersion,
  readInstalledVersion,
  readStampVersion,
  resolveTriple,
  runtimeVersionStampPath,
  runtimeWheelUrl,
  upgradeRuntimeWheel,
  writeRuntimeVersionStamp,
} from '../src/main/local-runtime-install';

/** 런타임 트리 픽스처 — python 실행파일(빈 파일) + dist-info(버전). */
function mkRuntime(root: string, version?: string): string {
  const py = pythonExePath(root);
  mkdirSync(join(py, '..'), { recursive: true });
  writeFileSync(py, '');
  const sp =
    process.platform === 'win32'
      ? join(root, 'python', 'Lib', 'site-packages')
      : join(root, 'python', 'lib', 'python3.12', 'site-packages');
  mkdirSync(join(sp, 'xgen_agent_runtime', 'host'), { recursive: true });
  writeFileSync(join(sp, 'xgen_agent_runtime', 'host', 'sidecar.py'), '');
  if (version) {
    mkdirSync(join(sp, `xgen_agent_runtime-${version}.dist-info`), { recursive: true });
    writeFileSync(
      join(sp, `xgen_agent_runtime-${version}.dist-info`, 'METADATA'),
      `Version: ${version}\n`,
    );
  }
  return sp;
}

test('pythonExePath: OS 별 python 실행파일 경로', () => {
  const p = pythonExePath('/rt');
  if (process.platform === 'win32') assert.equal(p, join('/rt', 'python', 'python.exe'));
  else assert.equal(p, join('/rt', 'python', 'bin', 'python3'));
});

test('resolveTriple: 강제 트리플 우선, OS/arch 해석', () => {
  assert.equal(resolveTriple('x86_64-unknown-linux-gnu'), 'x86_64-unknown-linux-gnu');
  const t = resolveTriple();
  assert.match(t, /(linux-gnu|apple-darwin|windows-msvc)/);
  // arch 접두가 붙는다.
  assert.match(t, /^(x86_64|aarch64)-/);
});

test('pythonArchiveUrl: python-build-standalone install_only URL', () => {
  const url = pythonArchiveUrl('x86_64-unknown-linux-gnu');
  assert.match(url, /astral-sh\/python-build-standalone/);
  assert.match(url, /-x86_64-unknown-linux-gnu-install_only\.tar\.gz$/);
});

test('DEFAULT_RUNTIME_WHEEL: 릴리스된 runtime(host 포함) wheel v3.8.9 을 가리킨다', () => {
  assert.equal(RUNTIME_WHEEL_VERSION, '3.8.9');
  assert.equal(
    DEFAULT_RUNTIME_WHEEL,
    'https://github.com/PlateerLab/xgen-agent-runtime/releases/download/v3.8.9/xgen_agent_runtime-3.8.9-py3-none-any.whl',
  );
  assert.match(DEFAULT_RUNTIME_WHEEL, /xgen-agent-runtime\/releases\/download\/v3\.8\.9\//);
  assert.match(DEFAULT_RUNTIME_WHEEL, /\.whl$/);
  // URL 패턴은 버전만 바뀐다(3.7.0 과 동일 패턴).
  assert.equal(
    runtimeWheelUrl('v3.7.0'),
    'https://github.com/PlateerLab/xgen-agent-runtime/releases/download/v3.7.0/xgen_agent_runtime-3.7.0-py3-none-any.whl',
  );
});

test('readInstalledVersion: dist-info 우선, 없으면 RUNTIME_VERSION 스탬프 (감사 #16)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-ver-'));
  try {
    // 스탬프만(번들은 dist-info 를 지운다) → 스탬프.
    mkRuntime(dir);
    writeFileSync(runtimeVersionStampPath(dir), '3.7.0\n3.12.11+20250808\n');
    assert.equal(readStampVersion(dir), '3.7.0');
    assert.equal(readDistInfoVersion(dir), undefined);
    assert.equal(readInstalledVersion(dir), '3.7.0');
    // pip 로 wheel 을 올리면 dist-info 가 새 버전으로 생긴다 → 낡은 스탬프보다 dist-info.
    mkRuntime(dir, '3.8.5');
    assert.equal(readDistInfoVersion(dir), '3.8.5');
    assert.equal(readInstalledVersion(dir), '3.8.5');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeRuntimeVersionStamp: 첫 줄만 바꾸고 python 태그 줄은 보존, 없으면 생성', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-stamp-'));
  try {
    mkRuntime(dir);
    writeFileSync(runtimeVersionStampPath(dir), '3.7.0\n3.12.11+20250808\n');
    assert.equal(writeRuntimeVersionStamp(dir, '3.8.5'), true);
    assert.equal(readFileSync(runtimeVersionStampPath(dir), 'utf-8'), '3.8.5\n3.12.11+20250808\n');
    rmSync(runtimeVersionStampPath(dir));
    assert.equal(writeRuntimeVersionStamp(dir, '3.8.5'), true);
    assert.equal(readFileSync(runtimeVersionStampPath(dir), 'utf-8'), '3.8.5\n');
    assert.equal(readStampVersion(dir), '3.8.5');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'upgradeRuntimeWheel: 성공 시 RUNTIME_VERSION 스탬프를 dist-info 버전으로 다시 쓴다 (감사 #16)',
  { skip: process.platform === 'win32' ? 'sh 가짜 python 은 POSIX 전용' : false },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lr-upgrade-'));
    try {
      const sp = mkRuntime(dir, '3.7.0');
      writeFileSync(runtimeVersionStampPath(dir), '3.7.0\n3.12.11+20250808\n');
      // 가짜 python: `-m pip install …` 이면 dist-info 를 3.7.0 → 3.8.5 으로 바꾼다(pip 흉내), 그 외 0.
      const py = pythonExePath(dir);
      writeFileSync(
        py,
        `#!/bin/sh
if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then
  rm -rf "${join(sp, 'xgen_agent_runtime-3.7.0.dist-info')}"
  mkdir -p "${join(sp, 'xgen_agent_runtime-3.8.5.dist-info')}"
  printf 'Version: 3.8.5\\n' > "${join(sp, 'xgen_agent_runtime-3.8.5.dist-info', 'METADATA')}"
fi
exit 0
`,
      );
      chmodSync(py, 0o755);
      const phases: string[] = [];
      const r = await upgradeRuntimeWheel({ runtimeDir: dir }, 'https://example/x.whl', (p) =>
        phases.push(p.phase),
      );
      assert.equal(r.ok, true, r.error);
      assert.equal(r.version, '3.8.5');
      assert.deepEqual(phases, ['pip', 'smoke', 'done']);
      assert.equal(
        readFileSync(runtimeVersionStampPath(dir), 'utf-8'),
        '3.8.5\n3.12.11+20250808\n',
      );
      assert.equal(readInstalledVersion(dir), '3.8.5');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('upgradeRuntimeWheel: python 미설치면 ok=false (비파괴)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-upgrade-none-'));
  try {
    const r = await upgradeRuntimeWheel({ runtimeDir: dir }, 'https://example/x.whl', () => {});
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /설치되어 있지 않습니다/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getStatus: 미설치 디렉터리는 installed=false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-status-'));
  try {
    const s = await getStatus({ runtimeDir: dir });
    assert.equal(s.installed, false);
    assert.equal(s.pythonPath, pythonExePath(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
