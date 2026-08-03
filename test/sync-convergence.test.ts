/**
 * Convergence simulation — EFFECT PROOF for the sync engine.
 *
 * A fake in-memory hub (mirroring the backend's seq/tombstone/base_sha
 * semantics exactly) + two ReplicaFs replicas on real temp dirs. Every
 * scenario asserts the MEASURED end state: identical trees, preserved
 * conflict copies, resurrections.
 *
 * Run: npx tsx tests/sync-convergence.test.ts
 */

import assert from 'assert'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, statSync, utimesSync } from 'fs'
import { readFile, writeFile, mkdir as mkdirP, rename } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { createHash } from 'crypto'
import {
  ChangesResponse, MassDeletePending, SyncConflictError, SyncIndex, syncOnce, Transport,
} from '../src/main/sync-core'
import { ReplicaFs } from '../src/main/sync-fs'

// ── fake hub (mirrors backend workspace_sync + PUT semantics) ─────────

interface HubEntry {
  is_dir: boolean
  data: Buffer
  sha: string
  seq: number
  deleted: boolean
}

class FakeHub {
  entries = new Map<string, HubEntry>()
  seq = 0

  private bump(): number {
    return ++this.seq
  }

  sha(b: Buffer): string {
    return createHash('sha256').update(b).digest('hex')
  }

  /** direct server-side write (simulates the AGENT writing a file) */
  agentWrite(path: string, content: string): void {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      const e = this.entries.get(dir)
      if (!e || e.deleted) {
        this.entries.set(dir, { is_dir: true, data: Buffer.alloc(0), sha: '', seq: this.bump(), deleted: false })
      }
    }
    const buf = Buffer.from(content)
    this.entries.set(path, { is_dir: false, data: buf, sha: this.sha(buf), seq: this.bump(), deleted: false })
  }

  agentDelete(path: string): void {
    for (const [p, e] of this.entries) {
      if (!e.deleted && (p === path || p.startsWith(path + '/'))) {
        this.entries.set(p, { ...e, data: Buffer.alloc(0), sha: '', seq: this.bump(), deleted: true })
      }
    }
  }

  transport(): Transport {
    const hub = this
    return {
      async changes(since: number): Promise<ChangesResponse> {
        const rows = [...hub.entries.entries()]
          .map(([path, e]) => ({
            path, is_dir: e.is_dir, size: e.data.length, mtime_ns: 0,
            sha256: e.sha, seq: e.seq, deleted: e.deleted,
          }))
          .filter((r) => (since <= 0 ? !r.deleted : r.seq > since))
          .sort((a, b) => a.seq - b.seq)
        return { latest_seq: hub.seq, changes: rows, max_file_bytes: 500 * 1024 * 1024 }
      },
      async download(path: string, toAbs: string): Promise<void> {
        const e = hub.entries.get(path)
        if (!e || e.deleted) throw Object.assign(new Error('404'), { status: 404 })
        await mkdirP(dirname(toAbs), { recursive: true })
        const tmp = toAbs + '.part'
        await writeFile(tmp, e.data)
        await rename(tmp, toAbs)
      },
      async put(path: string, fromAbs: string, baseSha: string): Promise<{ sha256: string }> {
        const cur = hub.entries.get(path)
        if (cur && !cur.deleted) {
          if (cur.sha !== baseSha) throw new SyncConflictError(cur.sha)
        }
        // edit-wins resurrect: deleted or missing + any base accepted
        const data = await readFile(fromAbs)
        const sha = hub.sha(data)
        // implicit parent dirs (server PUT does mkdir(parents))
        const parts = path.split('/')
        for (let i = 1; i < parts.length; i++) {
          const dir = parts.slice(0, i).join('/')
          const d = hub.entries.get(dir)
          if (!d || d.deleted) {
            hub.entries.set(dir, { is_dir: true, data: Buffer.alloc(0), sha: '', seq: hub.bump(), deleted: false })
          }
        }
        hub.entries.set(path, { is_dir: false, data, sha, seq: hub.bump(), deleted: false })
        return { sha256: sha }
      },
      async del(path: string, baseSha?: string): Promise<void> {
        const cur = hub.entries.get(path)
        if (!cur || cur.deleted) throw Object.assign(new Error('404'), { status: 404 })
        if (baseSha && !cur.is_dir && cur.sha !== baseSha) throw new SyncConflictError(cur.sha)
        hub.agentDelete(path)
      },
      async mkdir(path: string): Promise<void> {
        const cur = hub.entries.get(path)
        if (cur && !cur.deleted) return
        hub.entries.set(path, { is_dir: true, data: Buffer.alloc(0), sha: '', seq: hub.bump(), deleted: false })
      },
    }
  }
}

// ── device harness ────────────────────────────────────────────────────

class Device {
  root: string
  fs: ReplicaFs
  index: SyncIndex = { cursor: 0, entries: {} }

  constructor(public name: string, private hub: FakeHub) {
    this.root = mkdtempSync(join(tmpdir(), `geny-sync-${name}-`))
    this.fs = new ReplicaFs(this.root)
  }

  write(rel: string, content: string, ageMs = 5_000): void {
    const abs = join(this.root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
    // age the mtime so the stability window doesn't defer it
    const t = new Date(Date.now() - ageMs)
    utimesSync(abs, t, t)
  }

  delete(rel: string): void {
    rmSync(join(this.root, rel), { recursive: true, force: true })
  }

  read(rel: string): string {
    return readFileSync(join(this.root, rel), 'utf-8')
  }

  has(rel: string): boolean {
    return existsSync(join(this.root, rel))
  }

  tree(dir = ''): string[] {
    const abs = join(this.root, dir)
    if (!existsSync(abs)) return []
    const out: string[] = []
    for (const name of readdirSync(abs)) {
      // ignored trees stay device-local by design — exclude from equality
      if (name.startsWith('.geny-sync') || name === 'node_modules' || name === '__pycache__') continue
      const rel = dir ? `${dir}/${name}` : name
      out.push(rel)
      if (statSync(join(this.root, rel)).isDirectory()) out.push(...this.tree(rel))
    }
    return out.sort()
  }

  async sync(opts: Partial<Parameters<typeof syncOnce>[3]> = {}) {
    const res = await syncOnce(this.hub.transport(), this.fs, this.index, {
      deviceName: this.name,
      maxFileBytes: 500 * 1024 * 1024,
      stabilityMs: 500,
      ...opts,
    })
    this.index = res.index
    return res.stats
  }
}

// ── scenarios ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const hub = new FakeHub()
  const A = new Device('PC-A', hub)
  const B = new Device('PC-B', hub)

  // 1) bootstrap: agent already produced files server-side
  hub.agentWrite('outputs/report.md', '# 보고서 v1')
  hub.agentWrite('uploads/data.csv', 'a,b,c')
  await hub.transport().mkdir('빈폴더')
  let s = await A.sync()
  assert.strictEqual(s.downloaded, 2, 'bootstrap downloads')
  assert.strictEqual(A.read('outputs/report.md'), '# 보고서 v1')
  assert.ok(A.has('빈폴더'), 'empty dir materialised')
  console.log('1) bootstrap OK')

  // 2) A creates → B receives
  A.write('메모.txt', '로컬에서 작성')
  A.write('proj/코드.py', 'print(1)')
  s = await A.sync()
  assert.strictEqual(s.uploaded, 2)
  s = await B.sync()
  assert.strictEqual(B.read('메모.txt'), '로컬에서 작성')
  assert.strictEqual(B.read('proj/코드.py'), 'print(1)')
  console.log('2) A→hub→B propagation OK')

  // 3) modify on B → A
  B.write('메모.txt', 'B가 수정함')
  await B.sync()
  await A.sync()
  assert.strictEqual(A.read('메모.txt'), 'B가 수정함')
  console.log('3) modify propagation OK')

  // 4) delete on A → B
  A.delete('uploads/data.csv')
  s = await A.sync()
  assert.strictEqual(s.deletedRemote, 1)
  s = await B.sync()
  assert.strictEqual(s.deletedLocal, 1)
  assert.ok(!B.has('uploads/data.csv'))
  console.log('4) delete propagation OK')

  // 5) TRUE CONFLICT: both edit the same file before either syncs
  A.write('proj/코드.py', 'print("A의 버전")')
  B.write('proj/코드.py', 'print("B의 버전")')
  await A.sync() // A wins the race — server now has A's version
  s = await B.sync()
  assert.strictEqual(s.conflicts, 1, 'B detects the conflict')
  assert.strictEqual(B.read('proj/코드.py'), 'print("A의 버전")', 'server version keeps the path')
  const conflictFile = B.tree('proj').find((p) => p.includes('충돌-PC-B'))
  assert.ok(conflictFile, 'local version preserved as conflict copy')
  assert.strictEqual(B.read(conflictFile!), 'print("B의 버전")', 'no data lost')
  await A.sync() // A pulls the conflict copy
  assert.deepStrictEqual(A.tree(), B.tree(), 'trees identical after conflict')
  console.log('5) concurrent-edit conflict OK (server keeps path, local preserved, trees converge)')

  // 6) edit-vs-delete: A deletes, B edits (A syncs first) → edit wins
  A.delete('메모.txt')
  B.write('메모.txt', '삭제됐지만 B가 살림')
  await A.sync()
  await B.sync() // B uploads (resurrect)
  await A.sync() // A gets it back
  assert.strictEqual(A.read('메모.txt'), '삭제됐지만 B가 살림', 'edit wins over delete')
  console.log('6) edit-vs-delete resurrection OK')

  // 7) offline catch-up: B "offline" while agent + A churn
  hub.agentWrite('outputs/agent-산출물.md', '에이전트가 만든 파일')
  A.write('신규/깊은/경로/파일.txt', '깊은 파일')
  await A.sync()
  hub.agentDelete('outputs/report.md')
  s = await B.sync() // single catch-up round
  assert.strictEqual(B.read('outputs/agent-산출물.md'), '에이전트가 만든 파일')
  assert.strictEqual(B.read('신규/깊은/경로/파일.txt'), '깊은 파일')
  assert.ok(!B.has('outputs/report.md'), 'offline delete converged')
  await A.sync()
  assert.deepStrictEqual(A.tree(), B.tree(), 'trees identical after catch-up')
  console.log('7) offline catch-up OK')

  // 8) ignore rules: junk never uploaded
  A.write('node_modules/lodash/index.js', 'lib')
  A.write('작업물/__pycache__/x.pyc', 'bin')
  A.write('작업물/유효.txt', '유효')
  s = await A.sync()
  assert.strictEqual(s.uploaded, 1, 'only the real file uploads')
  await B.sync()
  assert.ok(!B.has('node_modules'), 'library storm blocked')
  assert.ok(B.has('작업물/유효.txt'))
  console.log('8) ignore rules OK')

  // 9) stability window: a file modified "just now" is deferred
  A.write('방금씀.txt', '아직 쓰는 중', 0 /* fresh mtime */)
  s = await A.sync()
  assert.strictEqual(s.uploaded, 0, 'unstable file deferred')
  A.write('방금씀.txt', '이제 안정됨') // default ages 5s
  s = await A.sync()
  assert.strictEqual(s.uploaded, 1)
  console.log('9) stability window OK')

  // 10) large file skip
  A.write('큰파일.bin', 'x'.repeat(1000))
  s = await A.sync({ maxFileBytes: 100 })
  assert.strictEqual(s.skippedLarge, 1)
  assert.strictEqual(s.uploaded, 0)
  console.log('10) large-file skip OK')
  await A.sync() // sync it for real so trees match later

  // 11) mass-delete valve
  for (let i = 0; i < 60; i++) A.write(`bulk/f${i}.txt`, String(i))
  await A.sync()
  await B.sync()
  for (const [p, e] of hub.entries) {
    if (!e.deleted && p.startsWith('bulk/') && !e.is_dir) hub.agentDelete(p)
  }
  let valveTripped = false
  try {
    await B.sync()
  } catch (e) {
    valveTripped = e instanceof MassDeletePending
  }
  assert.ok(valveTripped, 'mass delete pauses for confirmation')
  assert.ok(B.has('bulk/f0.txt'), 'nothing deleted before confirmation')
  s = await B.sync({ confirmMassDelete: async () => true })
  assert.ok(s.deletedLocal >= 60, 'confirmed mass delete applies')
  console.log('11) mass-delete safety valve OK')

  // 12) crash recovery: A loses its ENTIRE index (crash before save) —
  //     resync must settle silently, zero junk conflict copies.
  await A.sync({ confirmMassDelete: async () => true }) // converge A first
  const before = A.tree()
  A.index = { cursor: 0, entries: {} }
  s = await A.sync()
  assert.strictEqual(s.conflicts, 0, `no junk conflicts after index loss (${JSON.stringify(s)})`)
  assert.strictEqual(s.uploaded, 0, 'nothing re-uploaded — content identical')
  assert.deepStrictEqual(A.tree(), before, 'tree untouched by recovery')
  console.log('12) index-loss crash recovery OK (settled, no junk copies)')

  // 13) server journal reset: B's cursor is far ahead of a rebuilt hub —
  //     the engine must detect it and re-bootstrap, not go blind.
  hub.agentWrite('재빌드후파일.txt', '커서 리셋 후 생긴 파일')
  B.index.cursor = hub.seq + 1_000_000
  s = await B.sync()
  assert.strictEqual(B.read('재빌드후파일.txt'), '커서 리셋 후 생긴 파일', 'cursor reset re-bootstrap')
  assert.ok(B.index.cursor <= hub.seq, 'cursor healed')
  console.log('13) cursor-ahead-of-server re-bootstrap OK')
  await A.sync()

  // 14) mid-round edit protection: the user edits a file WHILE the
  //     engine is downloading the server version → the fresh edit must
  //     NOT be clobbered; it resolves as a conflict next round.
  A.write('보호대상.txt', '공통 v1')
  await A.sync(); await B.sync()
  hub.agentWrite('보호대상.txt', '서버 v2')
  const origDownload = hub.transport().download
  const racingTransport = { ...hub.transport() }
  racingTransport.download = async (p: string, toAbs: string) => {
    if (p === '보호대상.txt') B.write('보호대상.txt', '다운로드 중 사용자가 씀!')
    return origDownload(p, toAbs)
  }
  const r14 = await syncOnce(racingTransport as any, B.fs, B.index, {
    deviceName: 'PC-B', maxFileBytes: 500 * 1024 * 1024, stabilityMs: 500,
  })
  B.index = r14.index
  assert.strictEqual(B.read('보호대상.txt'), '다운로드 중 사용자가 씀!', 'fresh edit NOT clobbered')
  assert.ok(r14.stats.deferred >= 1, `deferred (${JSON.stringify(r14.stats)})`)
  s = await B.sync() // next round: both-changed → conflict, nothing lost
  assert.strictEqual(B.read('보호대상.txt'), '서버 v2')
  const guarded = B.tree().find((p) => p.includes('충돌-PC-B') && p.startsWith('보호대상'))
  assert.ok(guarded && B.read(guarded).includes('사용자가 씀'), 'edit preserved as conflict copy')
  await A.sync()
  console.log('14) mid-round edit protection OK (deferred → conflict copy, no loss)')

  // 15) deleted-dir resurrection guard: server deletes a dir; the local
  //     copy still holds IGNORED junk so rmdir fails — the dir must NOT
  //     be pushed back to the server (ping-pong guard).
  A.write('legacy/문서.txt', 'doc')
  await A.sync(); await B.sync()
  B.write('legacy/node_modules/junk.js', 'x') // ignored junk inside
  A.delete('legacy')
  await A.sync()
  await B.sync() // deletes 문서.txt; rmdir legacy fails (junk)
  await B.sync() // second round must NOT resurrect it
  const legacyOnHub = [...hub.entries.entries()].some(([p, e]) => !e.deleted && p.startsWith('legacy'))
  assert.ok(!legacyOnHub, 'deleted dir NOT resurrected on server')
  assert.ok(!B.has('legacy/문서.txt'), 'tracked file inside removed')
  // user clears the junk by hand → the leftover unwinds cleanly (404 path)
  B.delete('legacy')
  await B.sync()
  console.log('15) deleted-dir resurrection guard OK')

  // 16) case-insensitive fs: two server paths differing only by case →
  //     one is skipped loudly, no flip-flop uploads.
  hub.agentWrite('Case.txt', 'UPPER')
  hub.agentWrite('case.txt', 'lower')
  const ciFs = B.fs as any
  const origCi = ciFs.isCaseInsensitive?.bind(ciFs)
  ciFs.isCaseInsensitive = async () => true
  const r16 = await B.sync()
  assert.ok(r16.errors.some((e) => e.includes('case-collision')), 'collision reported')
  const r16b = await B.sync()
  assert.strictEqual(r16b.uploaded, 0, 'no flip-flop upload on second round')
  ciFs.isCaseInsensitive = origCi
  hub.agentDelete('Case.txt'); hub.agentDelete('case.txt')
  await A.sync(); await B.sync()

  // 17) server dir over local file: path becomes a dir server-side while
  //     a LOCALLY-EDITED file occupies it → edit preserved as conflict
  //     copy, dir materialised. (An unedited local copy is dropped —
  //     same semantics as plain delete propagation.)
  B.write('thing', '나는 파일이었다')
  await B.sync()
  hub.agentDelete('thing')
  hub.agentWrite('thing/안의파일.txt', '이제 폴더다')
  B.write('thing', '로컬에서 더 수정함') // fresh edit → must survive
  s = await A.sync() // A: gets dir (no local file) — fine
  const r17 = await B.sync()
  assert.ok(B.has('thing/안의파일.txt'), 'dir materialised over former file')
  const saved = B.tree().find((p) => p.includes('충돌-PC-B') && p.startsWith('thing'))
  assert.ok(saved && B.read(saved) === '로컬에서 더 수정함', `edit preserved (${JSON.stringify(r17)})`)
  await A.sync(); await B.sync(); await A.sync()

  // 18) fail-closed replica: an empty scan over a tracked tree (unmounted
  //     share / renamed root) must ABORT, not wipe the server workspace.
  const realScan = B.fs.scan.bind(B.fs)
  ;(B.fs as any).scan = async () => new Map()
  const hubLiveBefore = [...hub.entries.values()].filter((e) => !e.deleted).length
  let aborted = false
  try {
    await B.sync()
  } catch (e) {
    aborted = String((e as Error).message).includes('unavailable')
  }
  ;(B.fs as any).scan = realScan
  const hubLiveAfter = [...hub.entries.values()].filter((e) => !e.deleted).length
  assert.ok(aborted, 'empty-scan round aborted')
  assert.strictEqual(hubLiveAfter, hubLiveBefore, 'server workspace untouched')
  await B.sync() // healthy round resumes normally
  console.log('18) fail-closed empty-scan guard OK (server not wiped)')

  // 19) cursor holdback: a failed download must be redelivered next
  //     round — never silently skipped past.
  hub.agentWrite('한번은실패.txt', '결국 도착해야 함')
  const okDownload = hub.transport().download
  let failedOnce = false
  const flakyTransport = { ...hub.transport() }
  flakyTransport.download = async (p: string, toAbs: string) => {
    if (p === '한번은실패.txt' && !failedOnce) {
      failedOnce = true
      throw Object.assign(new Error('transient 500'), { status: 500 })
    }
    return okDownload(p, toAbs)
  }
  const r19 = await syncOnce(flakyTransport as any, A.fs, A.index, {
    deviceName: 'PC-A', maxFileBytes: 500 * 1024 * 1024, stabilityMs: 500,
  })
  A.index = r19.index
  assert.ok(r19.stats.errors.length === 1 && !A.has('한번은실패.txt'), 'first round failed')
  s = await A.sync() // cursor was held back → change redelivered
  assert.strictEqual(A.read('한번은실패.txt'), '결국 도착해야 함', 'failed download redelivered')
  await B.sync()
  console.log('19) cursor holdback on failure OK (no permanent miss)')

  // 20) ignore asymmetry: agent-side build junk in the feed is neither
  //     downloaded NOR remote-deleted by replicas that don't scan it.
  hub.agentWrite('.gradle/caches/blob.bin', 'agent build state')
  await B.sync()
  await B.sync() // second round: must not turn "not scanned" into deleteRemote
  const gradleAlive = [...hub.entries.entries()].some(
    ([p, e]) => p.startsWith('.gradle') && !e.deleted && !e.is_dir,
  )
  assert.ok(gradleAlive, 'agent-side ignored file NOT deleted from server')
  assert.ok(!B.has('.gradle/caches/blob.bin'), 'and not downloaded either')
  hub.agentDelete('.gradle')
  console.log('20) ignore-asymmetry protection OK')

  // final: full convergence
  await A.sync({ confirmMassDelete: async () => true })
  await B.sync()
  assert.deepStrictEqual(A.tree(), B.tree(), 'FINAL: A and B trees identical')
  console.log(`FINAL trees identical (${A.tree().length} entries)`) // proof of convergence

  console.log('ALL CONVERGENCE SCENARIOS PASS')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
