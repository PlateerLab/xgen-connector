/**
 * XGEN 워크스페이스 모델 — 커넥터가 소유하는 루트 하나 + 그 안의 에이전트.
 *
 * 예전 모델(에이전트 ↔ 임의 폴더 페어링)이 만들던 문제를 구조로 없앤다:
 * 폴더가 흩어지면 진실도 흩어진다. 여기서는 루트가 하나고, 에이전트는
 * 그 안에 **추가**된다.
 */
import assert from 'assert'
import { test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  attachAgent,
  defaultRoot,
  detachAgent,
  folderNameFor,
  materialize,
  mount,
  moveRoot,
  PlainDirMount,
  rootOf,
  setMountProvider,
  strayFolders,
  toPairs,
  type WorkspaceConfig,
} from '../src/main/workspace'

const isWin = process.platform === 'win32'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'ws-home-'))
}

test('기본 루트는 홈 아래 XGEN-Workspace 하나다', () => {
  const h = home()
  assert.equal(defaultRoot(h), join(h, 'XGEN-Workspace'))
  // 설정에 루트가 없으면 기본값, 있으면 그것 (절대 경로로 정규화)
  assert.equal(rootOf(undefined, h), join(h, 'XGEN-Workspace'))
  assert.equal(rootOf({ root: join(h, 'elsewhere'), agents: [] }, h), join(h, 'elsewhere'))
})

test('에이전트를 추가하면 루트 아래 폴더가 생긴다', () => {
  const h = home()
  let cfg: WorkspaceConfig = { agents: [] }
  cfg = attachAgent(cfg, { id: 'p1', workflowId: 'wf-1', label: 'XGeny_copy' }, h)
  assert.equal(cfg.agents.length, 1)
  assert.equal(cfg.agents[0].folder, 'XGeny_copy')
  assert.ok(existsSync(join(defaultRoot(h), 'XGeny_copy')), '폴더가 실체화되지 않았다')
})

test('같은 에이전트를 두 번 추가해도 폴더가 늘지 않는다', () => {
  const h = home()
  let cfg: WorkspaceConfig = { agents: [] }
  cfg = attachAgent(cfg, { id: 'p1', workflowId: 'wf-1', label: '리서치' }, h)
  cfg = attachAgent(cfg, { id: 'p2', workflowId: 'wf-1', label: '리서치' }, h)
  assert.equal(cfg.agents.length, 1)
  assert.equal(cfg.agents[0].id, 'p1', '기존 페어 id 가 바뀌면 인덱스가 버려진다')
})

test('이름이 겹치면 폴더명을 유일하게 만든다', () => {
  const h = home()
  let cfg: WorkspaceConfig = { agents: [] }
  cfg = attachAgent(cfg, { id: 'a', workflowId: 'wf-1', label: '리서치' }, h)
  cfg = attachAgent(cfg, { id: 'b', workflowId: 'wf-2', label: '리서치' }, h)
  cfg = attachAgent(cfg, { id: 'c', workflowId: 'wf-3', label: '리서치' }, h)
  assert.deepEqual(cfg.agents.map((a) => a.folder), ['리서치', '리서치 (2)', '리서치 (3)'])
  for (const f of cfg.agents.map((a) => a.folder)) {
    assert.ok(existsSync(join(defaultRoot(h), f)), `폴더 없음: ${f}`)
  }
})

test('폴더명은 파일시스템이 거부하는 문자를 통과시키지 않는다', () => {
  // 경로 구분자가 남으면 하위 디렉터리가 생겨 루트 구조가 깨진다.
  for (const bad of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b>c', 'a|b']) {
    const f = folderNameFor(bad, 'wf-1', [])
    assert.ok(!/[/\\:*?"<>|]/.test(f), `금지문자가 남았다: ${bad} -> ${f}`)
  }
  // Windows 는 끝 점/공백을 못 쓴다
  assert.ok(!/[. ]$/.test(folderNameFor('보고서...', 'wf-1', [])))
  assert.ok(!/[. ]$/.test(folderNameFor('보고서   ', 'wf-1', [])))
  // 예약 이름은 그대로 쓰면 Windows 에서 만들 수 없다
  assert.notEqual(folderNameFor('CON', 'wf-1', []).toUpperCase(), 'CON')
  assert.notEqual(folderNameFor('com1', 'wf-1', []).toUpperCase(), 'COM1')
})

test('이름이 통째로 날아가도 폴더명을 만들어 낸다', () => {
  const f = folderNameFor('///', 'wf-abcdef12', [])
  assert.ok(f.length > 0)
  assert.ok(f.includes('wf-abcde') || f.startsWith('agent-'), f)
})

test('폴더명 길이에 상한이 있다', () => {
  const f = folderNameFor('가'.repeat(200), 'wf-1', [])
  assert.ok(f.length <= 64, `${f.length}자`)
})

test('제거하면 로컬 폴더가 사라진다 (서버 원본은 무관)', () => {
  const h = home()
  let cfg: WorkspaceConfig = { agents: [] }
  cfg = attachAgent(cfg, { id: 'p1', workflowId: 'wf-1', label: '리서치' }, h)
  const dir = join(defaultRoot(h), '리서치')
  writeFileSync(join(dir, 'note.txt'), 'x')
  cfg = detachAgent(cfg, 'wf-1', h)
  assert.equal(cfg.agents.length, 0)
  assert.ok(!existsSync(dir), '제거했는데 폴더가 남아 있다')
})

test('제거는 루트 밖을 절대 건드리지 않는다', () => {
  const h = home()
  const outside = join(h, 'PRECIOUS')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'data.txt'), 'user data')
  // 조작된 folder 값 (경로 탈출 시도)
  const cfg: WorkspaceConfig = {
    agents: [{ id: 'p1', workflowId: 'wf-1', label: 'x', folder: join('..', 'PRECIOUS') }],
  }
  detachAgent(cfg, 'wf-1', h)
  assert.ok(existsSync(join(outside, 'data.txt')), '루트 밖 사용자 데이터를 지웠다')
})

test('루트 자체를 지우는 folder 값도 막는다', () => {
  const h = home()
  const root = defaultRoot(h)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'keep.txt'), 'x')
  const cfg: WorkspaceConfig = {
    agents: [{ id: 'p1', workflowId: 'wf-1', label: 'x', folder: '.' }],
  }
  detachAgent(cfg, 'wf-1', h)
  assert.ok(existsSync(join(root, 'keep.txt')), '루트를 통째로 지웠다')
})

test('기동 시 붙어 있는 폴더를 전부 실체화한다', () => {
  const h = home()
  const cfg: WorkspaceConfig = {
    agents: [
      { id: 'a', workflowId: 'wf-1', label: 'A', folder: 'A' },
      { id: 'b', workflowId: 'wf-2', label: 'B', folder: 'B' },
    ],
  }
  const root = materialize(cfg, h)
  assert.equal(root, defaultRoot(h))
  assert.deepEqual(readdirSync(root).sort(), ['A', 'B'])
})

test('동기화 엔진이 쓰는 페어 목록으로 변환된다', () => {
  const h = home()
  const cfg: WorkspaceConfig = {
    agents: [{ id: 'p1', workflowId: 'wf-1', label: '리서치', folder: '리서치', paused: true }],
  }
  const pairs = toPairs(cfg, h)
  assert.equal(pairs.length, 1)
  assert.equal(pairs[0].localPath, join(defaultRoot(h), '리서치'))
  assert.equal(pairs[0].workflowId, 'wf-1')
  assert.equal(pairs[0].workflowLabel, '리서치')
  assert.equal(pairs[0].paused, true)
})

test('루트를 옮기면 폴더가 따라간다', () => {
  const h = home()
  let cfg: WorkspaceConfig = { agents: [] }
  cfg = attachAgent(cfg, { id: 'p1', workflowId: 'wf-1', label: '리서치' }, h)
  writeFileSync(join(defaultRoot(h), '리서치', 'note.txt'), 'keep me')

  const dest = join(h, 'Elsewhere', 'XGEN')
  const res = moveRoot(cfg, dest, h)
  assert.deepEqual(res.failed, [])
  assert.equal(rootOf(res.config, h), dest)
  assert.equal(
    readdirSync(join(dest, '리서치')).join(''),
    'note.txt',
    '루트를 옮겼는데 파일이 따라오지 않았다',
  )
})

test('루트 이동이 실패해도 빈 폴더를 만들어 동기화가 이어진다', () => {
  const h = home()
  const cfg: WorkspaceConfig = {
    agents: [{ id: 'p1', workflowId: 'wf-1', label: 'A', folder: 'A' }],
  }
  // 원본이 없는 상태에서 이동 — 데이터는 서버에 있으므로 빈 폴더로 시작한다.
  const dest = join(h, 'NewRoot')
  const res = moveRoot(cfg, dest, h)
  assert.ok(existsSync(join(dest, 'A')))
  assert.deepEqual(res.failed, [])
})

test('루트 안의 낯선 폴더를 알려준다 (사용자가 직접 만든 것)', () => {
  const h = home()
  let cfg: WorkspaceConfig = { agents: [] }
  cfg = attachAgent(cfg, { id: 'p1', workflowId: 'wf-1', label: 'A' }, h)
  mkdirSync(join(defaultRoot(h), '내가 만든 폴더'), { recursive: true })
  mkdirSync(join(defaultRoot(h), '.hidden'), { recursive: true })
  assert.deepEqual(strayFolders(cfg, h), ['내가 만든 폴더'])
})

test('마운트 구현은 교체 가능하다 (가상 드라이브가 들어올 자리)', () => {
  const calls: string[] = []
  const fake = {
    streaming: true,
    ensureRoot: (r: string) => {
      calls.push(`root:${r}`)
      return r
    },
    ensureAgentDir: (r: string, f: string) => {
      calls.push(`dir:${f}`)
      return join(r, f)
    },
    removeAgentDir: (_r: string, f: string) => calls.push(`rm:${f}`),
    dispose: () => calls.push('dispose'),
  }
  const original = mount()
  setMountProvider(fake)
  try {
    const h = home()
    let cfg: WorkspaceConfig = { agents: [] }
    cfg = attachAgent(cfg, { id: 'p1', workflowId: 'wf-1', label: 'A' }, h)
    cfg = detachAgent(cfg, 'wf-1', h)
    assert.ok(calls.includes('dir:A'), calls.join(','))
    assert.ok(calls.includes('rm:A'), calls.join(','))
    // 파일시스템이 아니라 제공자를 통해서만 움직였다
    assert.ok(!existsSync(join(defaultRoot(h), 'A')), '제공자를 우회해 디렉터리를 만들었다')
  } finally {
    setMountProvider(original)
  }
})

test('PlainDirMount 는 종료 시 사용자 파일을 지우지 않는다', (ctx) => {
  if (isWin) return ctx.skip('경로 의미만 다를 뿐 동일')
  const h = home()
  const m = new PlainDirMount()
  const root = m.ensureRoot(defaultRoot(h))
  m.ensureAgentDir(root, 'A')
  writeFileSync(join(root, 'A', 'work.txt'), 'in progress')
  m.dispose(root)
  assert.ok(existsSync(join(root, 'A', 'work.txt')), '스트리밍이 아닌데 파일을 지웠다')
})
