// 번들 레이아웃 계약 — resources/python/<python.exe|bin/python3> 이어야 앱(pythonExePath)·
// 인스톨러(NSIS CopyFiles)·부팅 복사가 전부 같은 경로를 본다. v1.62~1.66 은 extraResources 의
// from 이 상위 폴더라 한 단계 더 깊게 들어가 "런타임 없음" 이 났다 — 다시는 못 깨지게 못 박는다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pythonExePath, resolvePythonExe } from '../src/main/local-runtime-install';

test('electron-builder extraResources: from=resources/python-sidecar/python → to=python', () => {
  const yml = readFileSync(join(__dirname, '..', 'electron-builder.yml'), 'utf-8');
  const m = /extraResources:\s*\n\s*- from:\s*(\S+)\s*\n\s*to:\s*(\S+)/.exec(yml);
  assert.ok(m, 'extraResources 블록');
  assert.equal(m![1], 'resources/python-sidecar/python');
  assert.equal(m![2], 'python');
});

test('bundle script 는 resources/python-sidecar/python 아래에 python 실행파일을 놓는다', () => {
  const src = readFileSync(join(__dirname, '..', 'scripts', 'bundle-python-sidecar.mjs'), 'utf-8');
  assert.match(src, /const PY_DIR = join\(OUT, 'python'\)/);
  assert.match(src, /mkdirSync\(PY_DIR, \{ recursive: true \}\)/);
});

test('NSIS 는 resources\\python 을 <dataRoot>\\local-runtime 으로 복사하고 install.log 를 남긴다', () => {
  const nsh = readFileSync(join(__dirname, '..', 'build', 'installer.nsh'), 'utf-8');
  assert.match(
    nsh,
    /CopyFiles \/SILENT "\$INSTDIR\\resources\\python" "\$XgenDataRoot\\local-runtime"/,
  );
  assert.match(nsh, /install\.log/);
  assert.match(nsh, /smoke (OK|FAILED)/);
});

test('resolvePythonExe: 표준 레이아웃 우선, 중첩(python/python) 레이아웃도 인정', () => {
  const root = mkdtempSync(join(tmpdir(), 'layout-'));
  try {
    const none = resolvePythonExe(root);
    assert.equal(none.exists, false);
    assert.equal(none.python, pythonExePath(root));
    // 중첩
    const nestedPy = pythonExePath(join(root, 'python'));
    mkdirSync(join(nestedPy, '..'), { recursive: true });
    writeFileSync(nestedPy, '');
    const nested = resolvePythonExe(root);
    assert.equal(nested.exists, true);
    assert.equal(nested.python, nestedPy);
    assert.equal(nested.root, join(root, 'python'));
    // 표준이 생기면 표준 우선
    const stdPy = pythonExePath(root);
    mkdirSync(join(stdPy, '..'), { recursive: true });
    writeFileSync(stdPy, '');
    const std = resolvePythonExe(root);
    assert.equal(std.python, stdPy);
    assert.equal(std.root, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
