/**
 * 로컬 실행 수명주기 — index.ts 배선의 **순서/존재 계약**(소스 계약 테스트, account-switch.test 동형).
 *
 *  1. 부팅: 런타임 보장 → **매니페스트 수렴(로그인 상태) → CLI 자동 설치** 순. 예전엔 CLI 를
 *     먼저 깔아 매니페스트를 보기 전에 latest 가 깔렸다(감사 #40).
 *  2. CLI 자동 설치는 수렴기의(디스크 캐시 포함) 매니페스트 목표 버전을 쓴다.
 *  3. 로그아웃/서버 전환: 격리 홈 자격증명 삭제 + 상주 사이드카 종료(감사 #41); 서버 전환은
 *     매니페스트 캐시도 잊는다.
 *  4. 런타임 업그레이드 훅: ensurer 캐시 무효화 + 사이드카 유휴 재기동(감사 #17).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const INDEX = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');
function at(from: number, needle: string): number {
  return INDEX.indexOf(needle, from);
}

test('부팅: ensureLocalRuntimeOnBoot → convergeLocalRuntime(boot) → ensureCliInstalled 순', () => {
  const boot = INDEX.indexOf('void ensureLocalRuntimeOnBoot()');
  assert.ok(boot > 0);
  const converge = at(boot, "await convergeLocalRuntime('boot')");
  const codex = at(boot, "ensureCliInstalled('codex')");
  const claude = at(boot, "ensureCliInstalled('claude')");
  assert.ok(converge > 0, '부팅 블록에 수렴 호출');
  assert.ok(codex > 0 && claude > 0, '부팅 블록에 CLI 자동 설치');
  assert.ok(converge < codex && converge < claude, '수렴이 CLI 자동 설치보다 먼저여야 목표 버전으로 깔린다');
  // 예전 꼬리(설치 뒤 수렴)는 없어야 한다.
  const tailConverge = at(claude, "convergeLocalRuntimeInBackground('boot')");
  assert.equal(tailConverge, -1);
});

test('ensureCliInstalled 는 수렴기(디스크 캐시 복원)의 매니페스트 목표 버전을 쓴다', () => {
  const fn = INDEX.indexOf("function ensureCliInstalled(tool: 'codex' | 'claude')");
  assert.ok(fn > 0);
  const end = at(fn, 'function localExecStatus()');
  const body = INDEX.slice(fn, end);
  assert.match(body, /getLocalConverger\(\)\.status\(\)\.manifest/);
  assert.doesNotMatch(body, /localConverger\?\.status\(\)\.manifest/);
});

test('로그아웃: 자격증명 파일 삭제 + 사이드카 종료', () => {
  const handler = INDEX.indexOf('CHANNELS.authLogout');
  assert.ok(handler > 0);
  const end = at(handler, 'CHANNELS.authStatus');
  const body = INDEX.slice(handler, end);
  assert.match(body, /purgeLocalExecCredentials\('logout'\)/);
  // 헬퍼 자체는 파일 삭제 + 사이드카 shutdown 을 한다.
  const helper = INDEX.indexOf('function purgeLocalExecCredentials(');
  assert.ok(helper > 0);
  const helperEnd = at(helper, 'async function convergeLocalRuntime(');
  const hb = INDEX.slice(helper, helperEnd);
  assert.match(hb, /localCliPurgeCredentials\(\{ runtimeDir: cliRuntimeDir\(\) \}\)/);
  assert.match(hb, /sidecarDaemon\?\.shutdown\(\)/);
});

test('서버 전환(serverChanged): 자격증명 삭제 + 사이드카 종료 + 매니페스트 캐시 잊기', () => {
  const branch = INDEX.indexOf('if (serverChanged) {');
  assert.ok(branch > 0);
  const end = at(branch, 'const next = saveConfig(patch)');
  const body = INDEX.slice(branch, end);
  assert.match(body, /purgeLocalExecCredentials\('server-changed'\)/);
  assert.match(body, /localConverger\?\.clearManifest\(\)/);
});

test('런타임 업그레이드 훅: 수렴기 onRuntimeUpgraded → ensurer.invalidate + restartSidecarWhenIdle', () => {
  assert.match(INDEX, /onRuntimeUpgraded: \(info\) => onLocalRuntimeUpgraded\(info\)/);
  const fn = INDEX.indexOf('function onLocalRuntimeUpgraded(');
  assert.ok(fn > 0);
  const end = at(fn, 'function purgeLocalExecCredentials(');
  const body = INDEX.slice(fn, end);
  assert.match(body, /getLocalEnsurer\(\)/);
  assert.match(body, /\.invalidate\(\)/);
  assert.match(body, /restartSidecarWhenIdle\(sidecarDaemon/);
});
