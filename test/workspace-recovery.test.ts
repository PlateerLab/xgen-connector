/**
 * 드라이브가 **되돌릴 수 없는 상태**에 빠지지 않아야 한다.
 *
 * 실기에서 나온 세 가지 사고를 여기서 못 박는다:
 *
 *   1. 드라이브를 **끌 수 없었다** — 이상해져도 사용자가 할 수 있는 일이 없다
 *   2. 마운트된 폴더의 **하위**를 새 루트로 고르자 마운트 안에 마운트가 생겨,
 *      상위 폴더가 EBUSY 로 잠기고 되돌아갈 수도 지울 수도 없었다
 *   3. 마운트 지점에 파일 하나가 남으면 FUSE 가 **영영** 안 붙는다.
 *      그 파일은 사용자 것이라 지우라고 할 수도 없다.
 */
import assert from 'assert'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { isEnabled, moveRoot, validateNewRoot } from '../src/main/workspace'
import { rescueStrays } from '../src/main/fuse-mount'

const HOME = '/home/tester'

test('드라이브는 기본으로 켜져 있고, 명시적으로만 꺼진다', async () => {
  assert.equal(isEnabled(undefined), true, '설정이 없으면 켜짐이어야 한다')
  assert.equal(isEnabled({ agents: [] }), true, '기존 사용자가 갑자기 꺼지면 안 된다')
  assert.equal(isEnabled({ agents: [], enabled: false }), false)
  assert.equal(isEnabled({ agents: [], enabled: true }), true)
})

test('현재 루트의 하위는 새 루트로 고를 수 없다 (마운트 안 마운트)', async () => {
  const cfg = { root: `${HOME}/XGEN-Workspace`, agents: [] }
  const why = validateNewRoot(cfg, `${HOME}/XGEN-Workspace/XGEN-Workspace`, HOME)
  assert.ok(why, '하위 폴더를 그대로 허용했다')
  assert.match(why!, /하위/)
})

test('현재 루트를 포함하는 상위도 고를 수 없다', async () => {
  const cfg = { root: `${HOME}/docs/XGEN-Workspace`, agents: [] }
  const why = validateNewRoot(cfg, `${HOME}/docs`, HOME)
  assert.ok(why, '상위 폴더를 그대로 허용했다')
  assert.match(why!, /상위/)
})

test('홈 전체는 워크스페이스가 될 수 없다', async () => {
  assert.ok(validateNewRoot({ root: `${HOME}/XGEN-Workspace`, agents: [] }, HOME, HOME))
})

test('무관한 폴더는 정상적으로 허용된다', async () => {
  const cfg = { root: `${HOME}/XGEN-Workspace`, agents: [] }
  assert.equal(validateNewRoot(cfg, `${HOME}/다른곳/XGEN-Workspace`, HOME), null)
})

test('같은 곳으로 옮기는 것은 변경 없음으로 통과', async () => {
  const cfg = { root: `${HOME}/XGEN-Workspace`, agents: [] }
  assert.equal(validateNewRoot(cfg, `${HOME}/XGEN-Workspace`, HOME), null)
})

test('moveRoot 는 되돌릴 수 없는 선택을 거부한다 (조용히 하지 않는다)', async () => {
  const cfg = { root: `${HOME}/XGEN-Workspace`, agents: [] }
  assert.throws(() => moveRoot(cfg, `${HOME}/XGEN-Workspace/sub`, HOME), /하위/)
})

test('루트를 옮겨도 on/off 설정이 초기화되지 않는다', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'xgen-move-'))
  try {
    const cfg = { root: `${HOME}/XGEN-Workspace`, enabled: false, agents: [] }
    const r = moveRoot(cfg, join(tmp, 'XGEN-Workspace'), HOME)
    assert.equal(r.config.enabled, false, '드라이브를 꺼뒀는데 옮기니 켜졌다')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('잔여 파일은 지우지 않고 옆으로 옮긴다 (사용자 파일이다)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'xgen-stray-'))
  const mp = join(tmp, 'XGEN-Workspace')
  mkdirSync(mp)
  writeFileSync(join(mp, '보고서.pdf'), 'x')
  mkdirSync(join(mp, '하위'))
  writeFileSync(join(mp, '하위', '메모.txt'), 'y')
  try {
    const backup = await rescueStrays(mp, '20260805-1200')
    assert.ok(backup, '옮기지 않았다')
    // 마운트 지점은 비워져야 붙을 수 있다
    assert.deepEqual(readdirSync(mp), [], '마운트 지점이 아직 비지 않았다')
    // 파일은 하나도 사라지면 안 된다
    assert.ok(existsSync(join(backup!, '보고서.pdf')), '파일이 사라졌다')
    assert.ok(existsSync(join(backup!, '하위', '메모.txt')), '하위 파일이 사라졌다')
    // 보관 폴더는 마운트 지점 **밖**이어야 한다 (안이면 다시 막는다)
    assert.ok(!backup!.startsWith(mp + '/'), `보관 폴더가 마운트 지점 안이다: ${backup}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('비어 있으면 보관 폴더를 만들지 않는다', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'xgen-stray-'))
  const mp = join(tmp, 'XGEN-Workspace')
  mkdirSync(mp)
  try {
    assert.equal(await rescueStrays(mp, '20260805-1200'), null)
    assert.deepEqual(readdirSync(tmp), ['XGEN-Workspace'], '쓸데없는 폴더를 만들었다')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
