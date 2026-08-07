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
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
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

// ── 업로드 바디는 반드시 버퍼여야 한다 ────────────────────────────────
//
// 이 전송 계층은 설정된 XGEN 서버의 인증서 정책을 공유하려고 Electron
// `net.fetch`(Chromium 네트워크 스택)를 주입받는다. Chromium 은
// **ReadableStream 업로드를 지원하지 않는다.** `Readable.toWeb(...)` +
// `duplex:'half'` 는 Node(undici) 전용이라, 주입이 들어간 순간부터 단일 PUT 이
// 전부 실패했다 — 드라이브에 파일을 복사하면 close() 에서 EIO.
// 8MiB 씩 Buffer 로 보내는 청크 경로만 멀쩡했다.

test('업로드가 스트림 바디를 쓰지 않는다 (Electron net.fetch 는 못 받는다)', () => {
  const src = readFileSync(new URL('../src/main/sync-transport.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  assert.ok(!/duplex\s*:/.test(src), "duplex 옵션이 있다 — Node 전용 스트림 업로드다")
  assert.ok(
    !/body\s*:\s*Readable\.toWeb/.test(src),
    'body 로 ReadableStream 을 보낸다 — net.fetch 가 거부한다',
  )
})

test('업로드 실패는 서버가 준 이유를 메시지에 남긴다', () => {
  const src = readFileSync(new URL('../src/main/sync-transport.ts', import.meta.url), 'utf8')
  assert.match(
    src,
    /put HTTP \$\{res\.status\}\$\{detail/,
    '상태코드만 남기면 EIO 뒤에 원인을 찾을 수 없다',
  )
})

test('업로드가 Chromium 금지 헤더를 붙이지 않는다 (net.fetch 가 요청을 거부한다)', () => {
  // Electron net.fetch(Chromium 네트워크 스택)는 Content-Length 같은 *금지
  // 헤더*가 붙으면 요청을 **보내기도 전에** 거부한다:
  //     net::ERR_INVALID_ARGUMENT
  // 실기에서 단일 PUT 이 전부 이렇게 죽었고, 헤더를 안 붙이는 청크 업로드
  // 경로만 멀쩡했다. 드라이브 복사가 close() 에서 EIO 로 끝난 원인이다.
  const src = readFileSync(new URL('../src/main/sync-transport.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  const FORBIDDEN = ['Content-Length', 'Host', 'Connection', 'Transfer-Encoding']
  for (const h of FORBIDDEN) {
    assert.ok(
      !new RegExp(`['"\`]${h}['"\`]\\s*:`, 'i').test(src),
      `${h} 헤더를 직접 설정한다 — net.fetch 가 요청을 거부한다`,
    )
  }
})
