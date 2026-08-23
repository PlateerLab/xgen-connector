// 통합 데이터 루트 — 해석/정착/인스톨러 옵션 1회 소비를 검증한다.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  cloudDirOf,
  consumeInstallOptions,
  INSTALL_OPTIONS_FILE,
  resolveDataRoot,
  runtimeDirOf,
  settleDataRoot,
  workspaceDirOf,
} from '../src/main/data-root';
import type { ConnectorConfig } from '../src/main/config';

const HOME = '/home/tester';

test('resolveDataRoot: 기본 ~/xgen-connector, 명시값 존중', () => {
  assert.equal(resolveDataRoot({}, HOME), join(HOME, 'xgen-connector'));
  assert.equal(resolveDataRoot({ dataRoot: '/custom/place' }, HOME), '/custom/place');
});

test('settleDataRoot: 트리 생성 + 미설정 기본 채움, 명시 설정은 안 덮음', () => {
  const home = mkdtempSync(join(tmpdir(), 'dr-'));
  try {
    const cfg = { serverUrl: '' } as unknown as ConnectorConfig;
    const { root, patch } = settleDataRoot(cfg, home);
    assert.equal(root, join(home, 'xgen-connector'));
    // 트리가 실제로 만들어졌다.
    for (const d of [root, workspaceDirOf(root), cloudDirOf(root), runtimeDirOf(root)])
      assert.ok(existsSync(d), d);
    // 미설정 → dataRoot 파생 기본이 패치로.
    assert.equal(patch.dataRoot, root);
    assert.equal(patch.localShell?.cwd, workspaceDirOf(root));
    assert.equal(patch.workspace?.root, cloudDirOf(root));

    // 명시 설정은 절대 덮지 않는다.
    const explicit = {
      dataRoot: join(home, 'else'),
      localShell: { cwd: '/my/ws' },
      workspace: { root: '/my/cloud', agents: [] },
    } as unknown as ConnectorConfig;
    const r2 = settleDataRoot(explicit, home);
    assert.equal(r2.root, join(home, 'else'));
    assert.equal(r2.patch.localShell, undefined);
    assert.equal(r2.patch.workspace, undefined);
    assert.equal(r2.patch.dataRoot, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('consumeInstallOptions: 1회 소비(파일 삭제) + 패치 매핑, 없으면 null', () => {
  const ud = mkdtempSync(join(tmpdir(), 'ud-'));
  try {
    assert.equal(consumeInstallOptions(ud), null);
    writeFileSync(
      join(ud, INSTALL_OPTIONS_FILE),
      JSON.stringify({ dataRoot: 'D:\\xgen-connector', autoRuntime: true, autoCodex: false, autoClaude: true }),
    );
    const patch = consumeInstallOptions(ud);
    assert.deepEqual(patch, {
      dataRoot: 'D:\\xgen-connector',
      localExec: { autoRuntime: true, autoCodex: false, autoClaude: true },
    });
    // 소비됐다 — 파일 삭제 + 재호출 null.
    assert.equal(existsSync(join(ud, INSTALL_OPTIONS_FILE)), false);
    assert.equal(consumeInstallOptions(ud), null);
    // 손상 JSON → null(그리고 삭제).
    writeFileSync(join(ud, INSTALL_OPTIONS_FILE), '{broken');
    assert.equal(consumeInstallOptions(ud), null);
    assert.equal(existsSync(join(ud, INSTALL_OPTIONS_FILE)), false);
  } finally {
    rmSync(ud, { recursive: true, force: true });
  }
});
