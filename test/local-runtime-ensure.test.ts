// 런타임 자가치유 사다리 — 설치 폴더 건강 → 끝 / 손상·없음 → 내장 번들 복사(검증) /
// 번들 없음 → 네트워크 설치 / 복사 실패해도 번들로 라우팅 유지. 스모크·복사·설치는 주입.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalRuntimeEnsurer, longPath } from '../src/main/local-runtime-ensure';
import { pythonExePath } from '../src/main/local-runtime-install';

function mkRuntime(root: string, version = '3.7.0'): void {
  const py = pythonExePath(root);
  mkdirSync(join(py, '..'), { recursive: true });
  writeFileSync(py, '');
  const sp =
    process.platform === 'win32'
      ? join(root, 'python', 'Lib', 'site-packages')
      : join(root, 'python', 'lib', 'python3.12', 'site-packages');
  mkdirSync(join(sp, `xgen_agent_runtime-${version}.dist-info`), { recursive: true });
  writeFileSync(
    join(sp, `xgen_agent_runtime-${version}.dist-info`, 'METADATA'),
    `Version: ${version}\n`,
  );
  mkdirSync(join(sp, 'xgen_agent_runtime', 'host'), { recursive: true });
  writeFileSync(join(sp, 'xgen_agent_runtime', 'host', 'sidecar.py'), '');
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'ensure-'));
}

test('설치 폴더가 건강하면 아무것도 하지 않는다(active=install)', async () => {
  const root = tmp();
  try {
    const install = join(root, 'local-runtime');
    mkRuntime(install);
    const smoked: string[] = [];
    const e = new LocalRuntimeEnsurer({
      installDir: () => install,
      bundleDir: () => null,
      smoke: async (py) => (smoked.push(py), { ok: true }),
      copyTree: async () => assert.fail('copy 금지'),
      download: async () => assert.fail('download 금지'),
    });
    const st = await e.ensure('test');
    assert.equal(st.phase, 'ready');
    assert.equal(st.active?.source, 'install');
    assert.equal(st.active?.version, '3.7.0');
    assert.equal(smoked.length, 1);
    // 두 번째 ensure 는 캐시(스모크 재실행 없음)
    await e.ensure('again');
    assert.equal(smoked.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('설치 폴더가 손상(스모크 실패)이면 번들을 복사·검증해 교체하고, 그동안 번들로 라우팅한다', async () => {
  const root = tmp();
  try {
    const install = join(root, 'local-runtime');
    const bundle = join(root, 'resources');
    mkRuntime(install, '3.6.0'); // 존재하지만 손상으로 취급
    mkRuntime(bundle, '3.7.0');
    let copied = false;
    const e = new LocalRuntimeEnsurer({
      installDir: () => install,
      bundleDir: () => bundle,
      smoke: async (py) => {
        // 교체 전의 설치 폴더 python 만 스모크 실패(손상), 스테이징/교체 후엔 건강
        const damaged = py.startsWith(install) && !py.includes('.python.new') && !copied;
        return damaged ? { ok: false, error: 'ImportError: damaged' } : { ok: true };
      },
      copyTree: async (src, dst) => {
        // 실제 복사 흉내: 번들 트리를 staging 으로
        const { cpSync } = await import('node:fs');
        cpSync(src, dst, { recursive: true });
        copied = true;
      },
      download: async () => assert.fail('download 금지'),
    });
    const st = await e.ensure('test');
    assert.equal(st.phase, 'ready');
    assert.equal(st.active?.source, 'install'); // 교체 후 설치 폴더가 active
    assert.equal(st.active?.version, '3.7.0');
    assert.ok(!existsSync(join(install, '.python.new')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('번들 복사가 실패해도 라우팅은 번들(active=bundle)로 유지하고 원인을 남긴다', async () => {
  const root = tmp();
  try {
    const install = join(root, 'local-runtime');
    const bundle = join(root, 'resources');
    mkRuntime(bundle);
    const e = new LocalRuntimeEnsurer({
      installDir: () => install,
      bundleDir: () => bundle,
      smoke: async () => ({ ok: true }),
      copyTree: async () => {
        throw new Error('ENAMETOOLONG');
      },
      download: async () => assert.fail('download 금지'),
    });
    const st = await e.ensure('test');
    assert.equal(st.phase, 'ready');
    assert.equal(st.active?.source, 'bundle');
    assert.match(st.lastError ?? '', /ENAMETOOLONG/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('번들이 없으면 네트워크 설치로 내려가고, 실패하면 failed + 원인', async () => {
  const root = tmp();
  try {
    const install = join(root, 'local-runtime');
    let downloaded = 0;
    const e = new LocalRuntimeEnsurer({
      installDir: () => install,
      bundleDir: () => null,
      smoke: async () => ({ ok: true }),
      download: async (dir) => {
        downloaded++;
        assert.equal(dir, install);
        return { ok: false, error: '네트워크 없음' };
      },
    });
    const st = await e.ensure('test');
    assert.equal(downloaded, 1);
    assert.equal(st.phase, 'failed');
    assert.match(st.lastError ?? '', /네트워크 없음/);
    assert.equal(st.active, undefined);
    // 설치 성공 시나리오
    const e2 = new LocalRuntimeEnsurer({
      installDir: () => install,
      bundleDir: () => null,
      smoke: async () => ({ ok: true }),
      download: async (dir) => {
        mkRuntime(dir);
        return { ok: true };
      },
    });
    const st2 = await e2.ensure('test');
    assert.equal(st2.phase, 'ready');
    assert.equal(st2.active?.source, 'install');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('longPath: Windows 에서만 \\\\?\\ 접두', () => {
  if (process.platform === 'win32') {
    assert.equal(longPath('C:\\a\\b'), '\\\\?\\C:\\a\\b');
    assert.equal(longPath('\\\\?\\C:\\a'), '\\\\?\\C:\\a');
  } else {
    assert.equal(longPath('/a/b'), '/a/b');
  }
});
