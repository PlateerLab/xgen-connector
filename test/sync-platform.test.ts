/**
 * sync-platform.test — 3-플랫폼 감사에서 나온 엔진 결함 수정의 효과 입증.
 *
 * 1) 플랫폼-불법 리모트 이름(win32 예약문자 등): 정책 스킵 + 커서 전진
 *    (기존: 매 라운드 다운로드 실패 + holdBack = 영구 웨지)
 * 2) 케이스-상이 로컬 철자 충돌: 정책 스킵 + 커서 전진 (기존: 영구 웨지)
 * 3) removeDirIfEmpty: Finder/탐색기 정크(.DS_Store 등)만 남은 디렉터리는
 *    비운 뒤 삭제 (기존: 서버 폴더 삭제가 mac/win 에 영구 미전파)
 * 4) NFD 실명 파일: rawByNfc 매핑으로 NFC 키 접근이 실파일에 닿는다
 *    (기존: hash ENOENT → 매 라운드 deferred, 영구 미동기)
 */
import assert from 'assert'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ChangesResponse, LocalStat, SyncIndex, syncOnce, Transport,
} from '../src/main/sync-core'
import { ReplicaFs } from '../src/main/sync-fs'

function fakeTransport(changes: ChangesResponse): Transport & { deleted: string[]; put: Transport['put'] } {
  return {
    deleted: [] as string[],
    async changes() { return changes },
    async download() { throw new Error('download should not be called in these tests') },
    async put() { return { sha256: 'x'.repeat(64) } },
    async del(p: string) { this.deleted.push(p) },
    async mkdir() {},
  }
}

function replica(): { root: string; fs: ReplicaFs; index: SyncIndex } {
  const root = mkdtempSync(join(tmpdir(), 'sync-platform-'))
  return { root, fs: new ReplicaFs(root), index: { cursor: 0, entries: {} } }
}

const OPTS = { deviceName: 'test-pc', maxFileBytes: 500 * 1024 * 1024, stabilityMs: 0 }

test('illegal remote name → policy skip, cursor advances (no wedge)', async () => {
  const r = replica()
  // 플랫폼 무관 검증을 위해 win32 규칙을 강제 주입.
  ;(r.fs as unknown as { isNameLegal: (p: string) => boolean }).isNameLegal = (p: string) =>
    !/[<>:"|?*]/.test(p)
  const t = fakeTransport({
    latest_seq: 7,
    changes: [
      { path: 'results:final.txt', is_dir: false, size: 3, mtime_ns: 1, sha256: 'a'.repeat(64), seq: 5, deleted: false },
      { path: 'ok.txt', is_dir: false, size: 0, mtime_ns: 1, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', seq: 7, deleted: false },
    ],
  })
  // ok.txt(빈 파일)는 다운로드 대신 empty 생성이 아닌 download 경로를 타므로
  // download 를 실제로 구현해 준다.
  t.download = async (_p: string, toAbs: string) => writeFileSync(toAbs, '')
  const { stats } = await syncOnce(t, r.fs, r.index, OPTS)
  assert.ok(stats.errors.some((e) => e.includes('illegal-name skipped')), stats.errors.join(';'))
  assert.equal(r.index.cursor, 7, 'cursor must advance past the illegal entry')
  assert.ok(existsSync(join(r.root, 'ok.txt')), 'legal sibling still syncs')
})

test('case-differing local spelling → policy skip, cursor advances', async () => {
  const r = replica()
  ;(r.fs as unknown as { isCaseInsensitive: () => Promise<boolean> }).isCaseInsensitive =
    async () => true
  writeFileSync(join(r.root, 'Readme.md'), 'local spelling')
  const t = fakeTransport({
    latest_seq: 3,
    changes: [
      { path: 'README.md', is_dir: false, size: 5, mtime_ns: 1, sha256: 'b'.repeat(64), seq: 3, deleted: false },
    ],
  })
  const { stats } = await syncOnce(t, r.fs, r.index, OPTS)
  assert.ok(
    stats.errors.some((e) => e.includes('case-collision with local')),
    stats.errors.join(';'),
  )
  assert.equal(r.index.cursor, 3, 'cursor must advance (no permanent wedge)')
})

test('removeDirIfEmpty sweeps finder junk (.DS_Store)', async () => {
  const r = replica()
  mkdirSync(join(r.root, 'photos'))
  writeFileSync(join(r.root, 'photos', '.DS_Store'), 'junk')
  assert.equal(await r.fs.removeDirIfEmpty('photos'), true)
  assert.ok(!existsSync(join(r.root, 'photos')))
  // 실파일이 남아 있으면 여전히 거부해야 한다.
  mkdirSync(join(r.root, 'docs'))
  writeFileSync(join(r.root, 'docs', '.DS_Store'), 'junk')
  writeFileSync(join(r.root, 'docs', 'real.txt'), 'keep me')
  assert.equal(await r.fs.removeDirIfEmpty('docs'), false)
  assert.ok(existsSync(join(r.root, 'docs', 'real.txt')))
})

test('NFD on-disk name reachable through NFC key (rawByNfc map)', async () => {
  const r = replica()
  const nfd = '한글노트.txt'.normalize('NFD')
  const nfc = '한글노트.txt'.normalize('NFC')
  writeFileSync(join(r.root, nfd), 'nfd bytes')
  const scan = await r.fs.scan()
  assert.ok(scan.has(nfc), 'scan keys must be NFC')
  // ext4/NTFS 는 바이트 단위 조회 — 매핑 없으면 여기서 ENOENT 가 났다.
  const sha = await r.fs.hash(nfc)
  assert.equal(typeof sha, 'string')
  assert.equal(sha.length, 64)
  const st: LocalStat | null = await r.fs.stat(nfc)
  assert.ok(st && !st.isDir && st.size === 9)
})
