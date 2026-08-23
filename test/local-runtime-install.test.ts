// 로컬 실행 환경 설치 모듈 — 순수 경로/URL 계산 + 미설치 상태 조회를 검증한다.
// 실제 다운로드·설치는 네트워크/OS 러너가 필요(bundle 실기로 별도 증명됨).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DEFAULT_RUNTIME_WHEEL,
  getStatus,
  pythonArchiveUrl,
  pythonExePath,
  resolveTriple,
} from '../src/main/local-runtime-install';

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

test('DEFAULT_RUNTIME_WHEEL: 릴리스된 runtime(host 포함) wheel 을 가리킨다', () => {
  assert.match(DEFAULT_RUNTIME_WHEEL, /xgen-agent-runtime\/releases\/download\/v3\.7\.0\//);
  assert.match(DEFAULT_RUNTIME_WHEEL, /\.whl$/);
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
