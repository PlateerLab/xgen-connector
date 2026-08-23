// 서버 버전 수렴기 — 매니페스트 디스크 캐시(감사 #40) · 런타임 업그레이드 후 사이드카/캐시 훅(감사 #17).
// 네트워크/실제 pip 없이: 서버 클라이언트 주입 + 가짜 python(sh) 으로 pip 흉내.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeManifest, ServerClient } from '../src/main/local-agent-server-client';
import {
  LocalRuntimeConverger,
  loadManifestCache,
  manifestCachePath,
  restartSidecarWhenIdle,
  saveManifestCache,
  type ConvergeDeps,
} from '../src/main/local-runtime-converge';
import { pythonExePath, runtimeVersionStampPath } from '../src/main/local-runtime-install';

const MANIFEST: RuntimeManifest = {
  protocol: 2,
  runtime: { version: '3.8.0', wheel_url: 'https://example/xgen_agent_runtime-3.8.0.whl' },
  claude: { enabled: true, target: '2.1.231' },
  codex: { enabled: true, target: '0.149.0' },
};

function server(impl: () => Promise<RuntimeManifest>): ServerClient {
  return {
    fetchLocalTurnContext: async () => assert.fail('미사용'),
    reportTurnResult: async () => {},
    fetchRuntimeManifest: impl,
  };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'converge-'));
}

/** 런타임 트리 픽스처 — python(빈 파일 또는 sh) + sidecar.py + dist-info(버전). */
function mkRuntime(root: string, version: string): string {
  const py = pythonExePath(root);
  mkdirSync(join(py, '..'), { recursive: true });
  if (!existsSync(py)) writeFileSync(py, '');
  const sp =
    process.platform === 'win32'
      ? join(root, 'python', 'Lib', 'site-packages')
      : join(root, 'python', 'lib', 'python3.12', 'site-packages');
  mkdirSync(join(sp, 'xgen_agent_runtime', 'host'), { recursive: true });
  writeFileSync(join(sp, 'xgen_agent_runtime', 'host', 'sidecar.py'), '');
  mkdirSync(join(sp, `xgen_agent_runtime-${version}.dist-info`), { recursive: true });
  writeFileSync(join(sp, `xgen_agent_runtime-${version}.dist-info`, 'METADATA'), `Version: ${version}\n`);
  return sp;
}

test('manifest 캐시: 서버가 준 매니페스트를 <runtimeDir>/server-manifest.json 에 영속하고, 새 인스턴스가 복원한다', async () => {
  const dir = tmp();
  try {
    let calls = 0;
    const deps = (): ConvergeDeps => ({
      server: server(async () => (calls++, MANIFEST)),
      runtimeDir: dir,
      autoRuntime: false,
      autoCodex: false,
      autoClaude: false,
    });
    const c1 = new LocalRuntimeConverger(deps);
    assert.equal(c1.status().manifest, null); // 캐시 없음
    const m = await c1.refreshManifest();
    assert.deepEqual(m, MANIFEST);
    assert.equal(c1.status().manifestSource, 'server');
    const file = manifestCachePath(dir);
    assert.equal(file, join(dir, 'server-manifest.json'));
    assert.ok(existsSync(file));
    assert.deepEqual(loadManifestCache(file)?.manifest, MANIFEST);

    // 다음 부팅(새 인스턴스) — 서버가 답하기 전에도 status() 가 마지막 매니페스트를 안다.
    const c2 = new LocalRuntimeConverger(deps);
    const st = c2.status();
    assert.deepEqual(st.manifest, MANIFEST);
    assert.equal(st.manifestSource, 'cache');
    assert.equal(calls, 1); // 복원은 네트워크 없이
    // 서버 조회 실패(오프라인) → 캐시 값은 그대로 남는다.
    const c3 = new LocalRuntimeConverger(() => ({
      ...deps(),
      server: server(async () => {
        throw new Error('offline');
      }),
    }));
    assert.equal(await c3.refreshManifest(), null);
    assert.deepEqual(c3.status().manifest, MANIFEST);
    assert.equal(c3.status().manifestSource, 'cache');
    // converge 도 캐시로 계획한다(서버 조회 실패 → 캐시 매니페스트의 목표로 plan; 이 트리엔
    // python 이 없으니 런타임은 skip, CLI 자동은 꺼 둠 — 에러 없음).
    const logs: string[] = [];
    const c3b = new LocalRuntimeConverger(() => ({
      ...deps(),
      log: (m) => logs.push(m),
      server: server(async () => {
        throw new Error('offline');
      }),
    }));
    const r = await c3b.converge();
    assert.equal(r.lastError, undefined);
    assert.equal(r.summary, '런타임 미설치(Python 없음)');
    const plan = logs.find((l) => l.startsWith('plan '));
    assert.ok(plan, 'plan 로그');
    assert.match(plan!, /"runtime":\{[^}]*"target":"3\.8\.0"/); // 캐시 매니페스트의 목표 버전으로 계획
    assert.match(plan!, /"codex":\{[^}]*"target":"0\.149\.0"/);
    // 잊기 — 메모리+디스크.
    c3.clearManifest();
    assert.equal(c3.status().manifest, null);
    assert.equal(existsSync(file), false);
    assert.equal(new LocalRuntimeConverger(deps).status().manifest, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manifest 캐시: 깨진 파일/형식 이상은 null, manifestFile:null 이면 영속하지 않는다', async () => {
  const dir = tmp();
  try {
    const file = join(dir, 'x.json');
    writeFileSync(file, '{not json');
    assert.equal(loadManifestCache(file), null);
    writeFileSync(file, JSON.stringify({ manifest: { protocol: 2 } }));
    assert.equal(loadManifestCache(file), null); // runtime 없음
    assert.equal(saveManifestCache(file, MANIFEST, 7), true);
    assert.deepEqual(loadManifestCache(file), { manifest: MANIFEST, at: 7 });
    const c = new LocalRuntimeConverger(() => ({
      server: server(async () => MANIFEST),
      runtimeDir: dir,
      manifestFile: null,
      autoRuntime: false,
      autoCodex: false,
      autoClaude: false,
    }));
    await c.refreshManifest();
    assert.equal(existsSync(manifestCachePath(dir)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restartSidecarWhenIdle: 유휴면 즉시 shutdown, 바쁘면 끝난 뒤, 미기동이면 손대지 않는다', async () => {
  // 폴링 타이머는 unref(앱 종료를 막지 않게) — 테스트 프로세스가 먼저 끝나지 않게 붙잡아 둔다.
  const keep = setInterval(() => {}, 50);
  const log: string[] = [];
  const mk = (running: boolean, active: number) => {
    const d = {
      running,
      active,
      shutdowns: 0,
      status() {
        return { running: this.running, activeTurns: this.active };
      },
      shutdown() {
        this.shutdowns++;
        this.running = false;
      },
    };
    return d;
  };
  const idle = mk(true, 0);
  assert.equal(await restartSidecarWhenIdle(idle, { log: (m) => log.push(m) }).done, 'shutdown');
  assert.equal(idle.shutdowns, 1);

  const off = mk(false, 0);
  assert.equal(await restartSidecarWhenIdle(off).done, 'not-running');
  assert.equal(off.shutdowns, 0);

  const busy = mk(true, 2);
  const h = restartSidecarWhenIdle(busy, { pollMs: 5, maxWaitMs: 5_000 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(busy.shutdowns, 0); // 턴이 도는 동안은 내리지 않는다
  busy.active = 0; // 현재 턴 종료
  assert.equal(await h.done, 'shutdown');
  assert.equal(busy.shutdowns, 1);

  const stuck = mk(true, 1);
  assert.equal(await restartSidecarWhenIdle(stuck, { pollMs: 2, maxWaitMs: 10 }).done, 'timeout');
  assert.equal(stuck.shutdowns, 0);

  const cancelled = mk(true, 1);
  const hc = restartSidecarWhenIdle(cancelled, { pollMs: 5, maxWaitMs: 5_000 });
  hc.cancel();
  assert.equal(await hc.done, 'not-running');
  assert.equal(cancelled.shutdowns, 0);
  clearInterval(keep);
});

test(
  'converge: 런타임 wheel 업그레이드 성공 → 스탬프 갱신 + onRuntimeUpgraded 훅, 재수렴은 "서버와 동일" (감사 #16/#17)',
  { skip: process.platform === 'win32' ? 'sh 가짜 python 은 POSIX 전용' : false },
  async () => {
    const dir = tmp();
    try {
      const sp = mkRuntime(dir, '3.7.0');
      writeFileSync(runtimeVersionStampPath(dir), '3.7.0\n3.12.11+20250808\n');
      const py = pythonExePath(dir);
      writeFileSync(
        py,
        `#!/bin/sh
if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then
  echo "$@" >> "${join(dir, 'pip.log')}"
  rm -rf "${join(sp, 'xgen_agent_runtime-3.7.0.dist-info')}"
  mkdir -p "${join(sp, 'xgen_agent_runtime-3.8.0.dist-info')}"
  printf 'Version: 3.8.0\\n' > "${join(sp, 'xgen_agent_runtime-3.8.0.dist-info', 'METADATA')}"
fi
exit 0
`,
      );
      chmodSync(py, 0o755);
      const upgraded: Array<{ from?: string; to?: string }> = [];
      const logs: string[] = [];
      const c = new LocalRuntimeConverger(() => ({
        server: server(async () => MANIFEST),
        runtimeDir: dir,
        autoCodex: false,
        autoClaude: false,
        onRuntimeUpgraded: (i) => upgraded.push(i),
        log: (m) => logs.push(m),
      }));
      const st = await c.converge();
      assert.equal(st.lastError, undefined);
      assert.match(st.summary ?? '', /런타임 3\.7\.0→3\.8\.0/);
      assert.deepEqual(upgraded, [{ from: '3.7.0', to: '3.8.0' }]);
      assert.match(readFileSync(join(dir, 'pip.log'), 'utf-8'), /--upgrade https:\/\/example\/xgen_agent_runtime-3\.8\.0\.whl/);
      // 스탬프가 새 버전으로 — 다음 수렴은 'upgrade' 를 다시 계획하지 않는다.
      assert.equal(readFileSync(runtimeVersionStampPath(dir), 'utf-8'), '3.8.0\n3.12.11+20250808\n');
      const again = await c.converge();
      assert.equal(again.summary, '서버와 동일');
      assert.equal(upgraded.length, 1);
      assert.equal(readFileSync(join(dir, 'pip.log'), 'utf-8').split('\n').filter(Boolean).length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('converge: 런타임 업그레이드 실패면 훅을 부르지 않고 lastError 만 남긴다', async () => {
  const dir = tmp();
  try {
    // python 없음 → skip-missing-python (훅 없음)
    const upgraded: unknown[] = [];
    const c = new LocalRuntimeConverger(() => ({
      server: server(async () => MANIFEST),
      runtimeDir: dir,
      autoCodex: false,
      autoClaude: false,
      onRuntimeUpgraded: (i) => upgraded.push(i),
    }));
    const st = await c.converge();
    assert.equal(upgraded.length, 0);
    assert.match(st.summary ?? '', /런타임 미설치/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
