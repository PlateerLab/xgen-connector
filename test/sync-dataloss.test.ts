/**
 * sync-dataloss.test — 실증된 데이터 유실 3종의 회귀 방어.
 *
 * 1) 서버 ignore 목록에만 있는 파일이 부트스트랩에서 로컬 삭제되던 문제
 *    (실사고: 사용자의 debug.log 가 사라짐) → sync_ignores 소비로 차단
 * 2) 소형 워크스페이스(≤20 추적)에서 대량삭제 밸브가 아예 돌지 않던 문제
 * 3) 부분 스캔 실패(EACCES 등)가 조용히 '로컬 삭제'로 해석되던 문제
 */
import assert from 'assert'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import {
  ChangesResponse, MassDeletePending, SyncIndex, syncOnce, Transport,
} from '../src/main/sync-core'
import { ReplicaFs } from '../src/main/sync-fs'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const OPTS = { deviceName: 'pc', maxFileBytes: 500 * 1024 * 1024, stabilityMs: 0 }

function transport(changes: ChangesResponse) {
  const calls: string[] = []
  const t: Transport & { calls: string[] } = {
    calls,
    async changes() { return changes },
    async download() { throw new Error('unexpected download') },
    async put() { return { sha256: sha('x') } },
    async del(p: string) { calls.push(`del:${p}`) },
    async mkdir() {},
  }
  return t
}

test('server-ignored file is NOT deleted locally on a bootstrap round', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dl1-'))
  const fs = new ReplicaFs(root)
  writeFileSync(join(root, 'debug.log'), 'user log')
  writeFileSync(join(root, 'keep.txt'), 'keep')
  // 이전 라운드에서 업로드되어 추적 중인 상태
  const index: SyncIndex = {
    cursor: 0,
    entries: {
      'debug.log': { lastSyncedSha: sha('user log'), sha: sha('user log'), size: 8, mtimeMs: 0, isDir: false },
      'keep.txt': { lastSyncedSha: sha('keep'), sha: sha('keep'), size: 4, mtimeMs: 0, isDir: false },
    },
  }
  // 서버 스냅샷: keep.txt 만 (debug.log 는 서버가 ignore) + ignore 규칙 동승
  const t = transport({
    latest_seq: 5,
    changes: [
      { path: 'keep.txt', is_dir: false, size: 4, mtime_ns: 1, sha256: sha('keep'), seq: 5, deleted: false },
    ],
    sync_ignores: ['*.log', 'node_modules/'],
  })
  await syncOnce(t, fs, index, OPTS)
  assert.ok(existsSync(join(root, 'debug.log')), '서버가 ignore 하는 파일이 로컬에서 삭제됐다')
  assert.ok(existsSync(join(root, 'keep.txt')))
})

test('구서버(sync_ignores 없음)에서도 대량삭제 밸브가 2차 방어한다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dl1b-'))
  const fs = new ReplicaFs(root)
  const names = ['a.log', 'b.log', 'c.log', 'keep.txt']
  const entries: SyncIndex['entries'] = {}
  for (const n of names) {
    writeFileSync(join(root, n), n)
    entries[n] = { lastSyncedSha: sha(n), sha: sha(n), size: n.length, mtimeMs: 0, isDir: false }
  }
  const index: SyncIndex = { cursor: 0, entries }
  const t = transport({ latest_seq: 5, changes: [] })
  // 구서버(필드 없음)라 serverIgnored 는 못 쓰지만, 추적 전량이 사라지는
  // 계획이므로 대량삭제 밸브가 확인을 요구하며 막는다 (무경고 유실 없음).
  await assert.rejects(() => syncOnce(t, fs, index, OPTS), (e: unknown) => e instanceof MassDeletePending)
  for (const n of names) {
    assert.ok(existsSync(join(root, n)), `확인 전에 ${n} 이 삭제됐다`)
  }
})

test('mass-delete valve fires for small workspaces (≤20 tracked)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dl2-'))
  const fs = new ReplicaFs(root)
  // 로컬엔 파일 1개만 남기고(스캔 비지 않게), 추적 항목 4개는 사라진 상태
  writeFileSync(join(root, 'alive.txt'), 'a')
  const index: SyncIndex = {
    cursor: 9,
    entries: {
      'alive.txt': { lastSyncedSha: sha('a'), sha: sha('a'), size: 1, mtimeMs: 0, isDir: false },
      'gone1.txt': { lastSyncedSha: sha('1'), sha: sha('1'), size: 1, mtimeMs: 0, isDir: false },
      'gone2.txt': { lastSyncedSha: sha('2'), sha: sha('2'), size: 1, mtimeMs: 0, isDir: false },
      'gone3.txt': { lastSyncedSha: sha('3'), sha: sha('3'), size: 1, mtimeMs: 0, isDir: false },
      'gone4.txt': { lastSyncedSha: sha('4'), sha: sha('4'), size: 1, mtimeMs: 0, isDir: false },
    },
  }
  const t = transport({ latest_seq: 9, changes: [] })
  await assert.rejects(
    () => syncOnce(t, fs, index, OPTS),
    (e: unknown) => e instanceof MassDeletePending,
    '소형 워크스페이스 전량 삭제가 확인 없이 통과했다',
  )
  assert.deepEqual(t.calls, [], '확인 전에 원격 삭제가 실행됐다')
})

test('directory deletion counts affected files, not one action', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dl3-'))
  const fs = new ReplicaFs(root)
  writeFileSync(join(root, 'alive.txt'), 'a')
  const entries: SyncIndex['entries'] = {
    'alive.txt': { lastSyncedSha: sha('a'), sha: sha('a'), size: 1, mtimeMs: 0, isDir: false },
    docs: { lastSyncedSha: '', sha: '', size: 0, mtimeMs: 0, isDir: true },
  }
  for (let i = 0; i < 60; i++) {
    entries[`docs/f${i}.md`] = { lastSyncedSha: sha(String(i)), sha: sha(String(i)), size: 1, mtimeMs: 0, isDir: false }
  }
  const index: SyncIndex = { cursor: 9, entries }
  const t = transport({ latest_seq: 9, changes: [] })
  await assert.rejects(
    () => syncOnce(t, fs, index, OPTS),
    (e: unknown) => e instanceof MassDeletePending,
    '디렉터리 재귀 삭제(60개 영향)가 액션 1개로 계산돼 밸브를 통과했다',
  )
})

test('partial scan failure aborts the round instead of deleting', async () => {
  // chmod 로 EACCES 를 만드는 방식은 Windows 에서 통하지 않는다 (관리자/ACL
  // 의미가 달라 readdir 이 그대로 성공). 대신 LocalFs 계약 수준에서 검증한다:
  // 스캔이 던지면 엔진은 라운드를 중단해야 하고, 절대 삭제로 해석하면 안 된다.
  const root = mkdtempSync(join(tmpdir(), 'dl4-'))
  const real = new ReplicaFs(root)
  writeFileSync(join(root, 'top.txt'), 't')
  const failing = Object.create(real) as ReplicaFs
  ;(failing as unknown as { scan: () => Promise<never> }).scan = async () => {
    throw new Error('scan failed at locked: EACCES')
  }
  const index: SyncIndex = {
    cursor: 9,
    entries: {
      'top.txt': { lastSyncedSha: sha('t'), sha: sha('t'), size: 1, mtimeMs: 0, isDir: false },
      locked: { lastSyncedSha: '', sha: '', size: 0, mtimeMs: 0, isDir: true },
      'locked/inner.txt': { lastSyncedSha: sha('i'), sha: sha('i'), size: 1, mtimeMs: 0, isDir: false },
    },
  }
  const t = transport({ latest_seq: 9, changes: [] })
  await assert.rejects(
    () => syncOnce(t, failing, index, OPTS),
    /scan failed/,
    '부분 스캔 실패가 조용히 삭제로 이어졌다',
  )
  assert.deepEqual(t.calls, [], '스캔 실패 라운드에서 원격 삭제가 실행됐다')
})

test('ReplicaFs.scan throws on an unreadable subdirectory (posix)', async (ctx) => {
  // 실제 구현 검증 — POSIX 에서만 의미 있는 권한 실험.
  if (process.platform === 'win32') return ctx.skip('windows: chmod semantics differ')
  const root = mkdtempSync(join(tmpdir(), 'dl4b-'))
  const fs = new ReplicaFs(root)
  writeFileSync(join(root, 'top.txt'), 't')
  mkdirSync(join(root, 'locked'))
  writeFileSync(join(root, 'locked', 'inner.txt'), 'i')
  chmodSync(join(root, 'locked'), 0o000)
  try {
    await assert.rejects(() => fs.scan(), /scan failed/)
  } finally {
    chmodSync(join(root, 'locked'), 0o755)
  }
})

test('대량삭제 경고 수치가 추적 항목 수를 넘지 않는다', async () => {
  // "16개 파일(전체 10개 중)" — 중첩 디렉터리의 자식을 부모 액션과 자식 액션
  // 에서 두 번 세던 버그. 밸브 판정은 보수적이라 안전했지만 사용자에게 말이
  // 안 되는 숫자가 나갔다.
  const root = mkdtempSync(join(tmpdir(), 'dl-count-'))
  const fs = new ReplicaFs(root)
  const files = ['a/b/c/f1.txt', 'a/b/c/f2.txt', 'a/b/f3.txt', 'a/f4.txt', 'top.txt']
  const dirs = ['a', 'a/b', 'a/b/c']
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true })
  for (const f of files) writeFileSync(join(root, f), 'x')

  const entries: SyncIndex['entries'] = {}
  for (const d of dirs) entries[d] = { lastSyncedSha: '', sha: '', size: 0, mtimeMs: 0, isDir: true }
  for (const f of files) entries[f] = { lastSyncedSha: sha('x'), sha: sha('x'), size: 1, mtimeMs: 0, isDir: false }
  const index: SyncIndex = { cursor: 1, entries }
  const tracked = Object.keys(entries).length

  // 서버가 전부 지웠다고 알린다 (중첩 디렉터리 툼스톤 포함).
  const t = transport({
    latest_seq: 2,
    changes: [...dirs, ...files].map((path) => ({
      path, is_dir: dirs.includes(path), size: 0, mtime_ns: 0, sha256: '', seq: 2, deleted: true,
    })),
  })

  const seen: Array<{ count: number; total: number }> = []
  await syncOnce(t, fs, index, {
    ...OPTS,
    confirmMassDelete: async (count: number, total: number) => {
      seen.push({ count, total })
      return false
    },
  }).catch(() => undefined)

  assert.equal(seen.length, 1, '전량 삭제인데 밸브가 안 걸렸다')
  const [{ count, total }] = seen
  assert.ok(count <= total, `말이 안 되는 수치: ${count}개(전체 ${total}개 중)`)
  assert.equal(total, tracked)
  assert.equal(count, tracked, '전량 삭제면 영향 수 = 추적 수')
})
