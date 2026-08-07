/**
 * WebDAV 백엔드 — 마운트된 드라이브가 실제 에이전트 워크스페이스를 보여준다.
 *
 * 여기서 고정하는 것: 루트=에이전트 목록, 직계 자식만 나열, 트리 캐시,
 * **조회 실패 시 이전 캐시 유지**(빈 목록을 주면 Finder 에 "전부 사라졌다"로
 * 보인다), base_sha 전달, MOVE=복사+삭제(편집기 저장 패턴).
 */
import assert from 'assert'
import { test } from 'node:test'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { WorkspaceDavBackend, type WorkspaceApi } from '../src/main/workspace-backend'
import { SyncConflictError } from '../src/main/sync-protocol'

interface Rec {
  path: string
  is_dir: boolean
  size: number
  mtime_ns: number
  sha256: string
  deleted: boolean
}

class FakeApi implements WorkspaceApi {
  files = new Map<string, string>()
  dirs = new Set<string>()
  calls: string[] = []
  failChanges = false
  changeCount = 0

  private rec(path: string, isDir: boolean, body = ''): Rec {
    return {
      path,
      is_dir: isDir,
      size: body.length,
      mtime_ns: 1_700_000_000_000_000_000,
      sha256: isDir ? '' : `sha-${body.length}`,
      deleted: false,
    }
  }

  async changes(): Promise<{ changes: Rec[] }> {
    this.changeCount++
    if (this.failChanges) throw new Error('네트워크 끊김')
    return {
      changes: [
        ...[...this.dirs].map((d) => this.rec(d, true)),
        ...[...this.files].map(([p, b]) => this.rec(p, false, b)),
      ],
    }
  }
  async download(path: string, toAbs: string): Promise<void> {
    this.calls.push(`download:${path}`)
    writeFileSync(toAbs, this.files.get(path) ?? '')
  }
  async put(path: string, fromAbs: string, baseSha: string): Promise<{ sha256: string }> {
    this.calls.push(`put:${path}:base=${baseSha}`)
    const body = readFileSync(fromAbs, 'utf8')
    this.files.set(path, body)
    return { sha256: `sha-${body.length}` }
  }
  /** 서버의 fail-closed 계약을 그대로 흉내낸다 — force 없는 삭제는 거부. */
  strictServer = false
  async del(path: string, baseSha?: string, opts?: { force?: boolean }): Promise<void> {
    this.calls.push(`del:${path}:base=${baseSha ?? ''}:force=${opts?.force ? '1' : '0'}`)
    if (this.strictServer && !opts?.force) {
      const isDir = this.dirs.has(path)
      const hasKids = [...this.files.keys()].some((f) => f.startsWith(`${path}/`))
      if (isDir && hasKids) throw Object.assign(new Error('dir_not_empty'), { status: 409 })
      if (!isDir && !baseSha) throw Object.assign(new Error('base_sha_required'), { status: 409 })
    }
    this.files.delete(path)
    this.dirs.delete(path)
    for (const f of [...this.files.keys()]) {
      if (f.startsWith(`${path}/`)) this.files.delete(f)
    }
  }
  async mkdir(path: string): Promise<void> {
    this.calls.push(`mkdir:${path}`)
    this.dirs.add(path)
  }
}

function setup(): { be: WorkspaceDavBackend; api: FakeApi; user: FakeApi } {
  const api = new FakeApi()
  api.files.set('보고서.md', '# 보고서\n')
  api.files.set('자료/표.csv', 'a,b\n')
  api.dirs.add('자료')
  // 루트 = 사용자 클라우드 스토리지, 그 안에 에이전트가 폴더로 온다.
  const user = new FakeApi()
  user.files.set('내 메모.md', '개인 파일\n')
  const be = new WorkspaceDavBackend()
  be.setUserStorage(user)
  be.setAgents([{ folder: '마케팅 리서치', api }])
  return { be, api, user }
}

test('루트는 사용자 클라우드 스토리지이고 에이전트가 그 안에 있다', async () => {
  const { be } = setup()
  const root = await be.stat('/')
  assert.ok(root?.isDir)
  const names = (await be.readdir('/')).map((k) => k.name)
  assert.ok(names.includes('마케팅 리서치'), `에이전트가 없다: ${names}`)
  assert.ok(names.includes('내 메모.md'), `사용자 파일이 없다: ${names}`)
})

test('에이전트 폴더 안에 실제 파일이 보인다 (직계 자식만)', async () => {
  const { be } = setup()
  const kids = await be.readdir('/마케팅 리서치')
  assert.deepEqual(kids.map((k) => k.name).sort(), ['보고서.md', '자료'])
  // 하위 폴더의 파일이 상위에 새어 나오면 안 된다
  assert.ok(!kids.some((k) => k.name.includes('/')))
  const sub = await be.readdir('/마케팅 리서치/자료')
  assert.deepEqual(sub.map((k) => k.name), ['표.csv'])
})

test('파일 stat 이 크기와 ETag 를 준다', async () => {
  const { be } = setup()
  const n = await be.stat('/마케팅 리서치/보고서.md')
  assert.ok(n && !n.isDir)
  assert.equal(n!.name, '보고서.md')
  assert.equal(n!.size, '# 보고서\n'.length)
  assert.ok(n!.etag)
})

test('모르는 에이전트 폴더는 404 (null)', async () => {
  const { be } = setup()
  assert.equal(await be.stat('/없는 에이전트'), null)
  assert.deepEqual(await be.readdir('/없는 에이전트'), [])
})

test('읽기가 서버에서 내용을 가져온다', async () => {
  const { be, api } = setup()
  const buf = await be.read('/마케팅 리서치/보고서.md')
  assert.equal(buf.toString(), '# 보고서\n')
  assert.ok(api.calls.includes('download:보고서.md'))
})

test('쓰기가 base_sha 를 실어 보낸다 (서버 낙관적 동시성)', async () => {
  const { be, api } = setup()
  await be.write('/마케팅 리서치/보고서.md', Buffer.from('# 수정됨\n'))
  const put = api.calls.find((c) => c.startsWith('put:보고서.md'))
  assert.ok(put, api.calls.join(','))
  assert.match(put!, /base=sha-/, 'base_sha 없이 덮어썼다')
  assert.equal(api.files.get('보고서.md'), '# 수정됨\n')
})

test('쓰기 뒤 목록이 최신을 반영한다 (캐시 무효화)', async () => {
  const { be } = setup()
  await be.readdir('/마케팅 리서치')
  await be.write('/마케팅 리서치/새 파일.txt', Buffer.from('x'))
  const kids = await be.readdir('/마케팅 리서치')
  assert.ok(kids.some((k) => k.name === '새 파일.txt'), kids.map((k) => k.name).join(','))
})

test('트리를 캐시해 폴더 열기가 매번 왕복하지 않는다', async () => {
  // Finder 는 폴더 하나를 열 때 항목마다 PROPFIND 를 따로 쏜다.
  const { be, api } = setup()
  await be.readdir('/마케팅 리서치')
  const after = api.changeCount
  await be.stat('/마케팅 리서치/보고서.md')
  await be.stat('/마케팅 리서치/자료')
  await be.readdir('/마케팅 리서치/자료')
  assert.equal(api.changeCount, after, `캐시가 안 먹었다 (${api.changeCount - after}회 추가 왕복)`)
})

test('조회 실패 시 이전 캐시를 유지한다 (전부 사라진 것처럼 보이면 안 된다)', async () => {
  const { be, api } = setup()
  const before = await be.readdir('/마케팅 리서치')
  assert.equal(before.length, 2)

  api.failChanges = true
  await new Promise((r) => setTimeout(r, 4100)) // TTL 만료
  const after = await be.readdir('/마케팅 리서치')
  assert.equal(after.length, 2, '네트워크가 끊기자 파일이 전부 사라졌다')
})

test('삭제는 파일에 base_sha 를 주고 디렉터리에는 주지 않는다', async () => {
  const { be, api } = setup()
  await be.remove('/마케팅 리서치/보고서.md')
  assert.ok(api.calls.some((c) => /^del:보고서\.md:base=sha-/.test(c)), api.calls.join(','))

  await be.remove('/마케팅 리서치/자료')
  assert.ok(api.calls.some((c) => c.startsWith('del:자료:base=:')), api.calls.join(','))
})

test('MOVE 는 복사+삭제로 처리한다 (편집기의 임시파일→rename 저장)', async () => {
  const { be, api } = setup()
  await be.move('/마케팅 리서치/보고서.md', '/마케팅 리서치/보고서-최종.md')
  assert.equal(api.files.get('보고서-최종.md'), '# 보고서\n')
  assert.ok(!api.files.has('보고서.md'))
})

test('에이전트 폴더만 보호된다 (사용자 영역은 자유롭게 쓴다)', async () => {
  const { be, user } = setup()
  // 에이전트 폴더는 앱에서 연결/해제한다 — 드라이브에서 만들면 실제와 어긋난다.
  await assert.rejects(() => be.mkdir('/마케팅 리서치'), /앱에서 연결\/해제/)
  await assert.rejects(() => be.remove('/마케팅 리서치'), /앱에서 연결\/해제/)
  // 반면 사용자 클라우드에는 루트에서도 자유롭게 쓴다 — 내 스토리지다.
  await be.write('/새 메모.txt', Buffer.from('hello'))
  assert.equal(user.files.get('새 메모.txt'), 'hello')
  await be.mkdir('/새 폴더')
  assert.ok(user.dirs.has('새 폴더'))
})

test('이름이 겹치면 에이전트가 사용자 폴더를 가린다', async () => {
  // 연결한 에이전트가 안 보이는 편이 더 혼란스럽다.
  const { be, user } = setup()
  user.dirs.add('마케팅 리서치')
  const names = (await be.readdir('/')).map((k) => k.name)
  assert.equal(names.filter((n) => n === '마케팅 리서치').length, 1, '중복으로 나온다')
  // 그리고 그 경로는 에이전트로 간다
  const kids = (await be.readdir('/마케팅 리서치')).map((k) => k.name)
  assert.ok(kids.includes('보고서.md'), kids.join(','))
})

test('사용자 스토리지가 없으면 에이전트만 보인다', async () => {
  const { be } = setup()
  be.setUserStorage(null)
  assert.deepEqual((await be.readdir('/')).map((k) => k.name), ['마케팅 리서치'])
  await assert.rejects(() => be.write('/x.txt', Buffer.from('x')), /연결되어 있지 않습니다/)
})

test('사용자 영역과 에이전트 영역 사이로 파일을 옮길 수 있다', async () => {
  const { be, api, user } = setup()
  await be.move('/내 메모.md', '/마케팅 리서치/옮긴 메모.md')
  assert.equal(api.files.get('옮긴 메모.md'), '개인 파일\n')
  assert.ok(!user.files.has('내 메모.md'))
})

test('에이전트를 떼면 목록에서 사라진다 (사용자 파일은 남는다)', async () => {
  const { be } = setup()
  await be.readdir('/마케팅 리서치')
  be.setAgents([])
  const names = (await be.readdir('/')).map((k) => k.name)
  assert.ok(!names.includes('마케팅 리서치'), '뗐는데 남아 있다')
  assert.ok(names.includes('내 메모.md'), '사용자 파일까지 사라졌다')
  assert.equal(await be.stat('/마케팅 리서치'), null)
})

// ── 삭제: 드라이브에서 지운 것은 사용자의 명시적 의사다 ──────────────
//
// 서버는 force 없는 삭제를 "동기화 레플리카의 추론"으로 보고 fail-closed 로
// 막는다 (파일=base_sha 필수, 폴더=비어 있을 때만). 그 가드는 낡은 레플리카가
// 에이전트 산출물을 쓸어 담는 것을 막기 위한 것이지 **사람 손**을 막으려는
// 게 아니다. 드라이브가 force 를 안 실어 보내서 실기에서 폴더 삭제는 늘
// 실패했고, 캐시에 없는 파일도 지워지지 않았다.

test('드라이브에서 지우면 force 를 실어 보낸다', async () => {
  const { be, user } = setup()
  await be.readdir('/')
  await be.remove('/내 메모.md')
  const del = user.calls.find((c) => c.startsWith('del:'))
  assert.ok(del?.endsWith(':force=1'), `force 를 안 보냈다: ${del}`)
})

test('내용이 있는 폴더도 드라이브에서 지워진다', async () => {
  const { be, api } = setup()
  api.strictServer = true // 서버의 fail-closed 계약을 켠다
  await be.readdir('/마케팅 리서치/자료')
  await be.remove('/마케팅 리서치/자료') // 안에 표.csv 가 있다
  assert.ok(!api.dirs.has('자료'), '폴더가 안 지워졌다')
  assert.ok(!api.files.has('자료/표.csv'), '폴더 안 파일이 남았다')
})

test('캐시가 모르는 파일도 지워진다', async () => {
  const { be, api } = setup()
  api.strictServer = true
  await be.readdir('/마케팅 리서치')
  // 다른 기기가 방금 만든 파일 — 우리 트리 캐시엔 없어서 base_sha 가 없다.
  api.files.set('남이만든.txt', 'x')
  await be.remove('/마케팅 리서치/남이만든.txt')
  assert.ok(!api.files.has('남이만든.txt'), '캐시에 없다고 삭제를 포기했다')
})

test('레거시 페어 동기화 엔진이 코드에 존재하지 않는다', () => {
  // 예전에는 "리컨사일 경로는 force 를 쓰지 않는다"를 고정했다. 이제 그
  // 엔진 자체가 없다 — 가상 드라이브가 대체한 뒤에도 설정에 남은 syncPairs 로
  // 계속 되살아나 **같은 폴더를 향해 두 시스템이 동시에** 돌았고, 사용자가
  // 지운 파일을 레거시 엔진이 자기 인덱스를 근거로 다시 올렸다(무한 부활).
  // 멈추는 것으로는 부족했다 — 재가동 경로가 다섯 군데였다. 지웠다.
  for (const gone of ['sync-core.ts', 'sync-fs.ts', 'sync-manager.ts']) {
    assert.ok(
      !existsSync(new URL(`../src/main/${gone}`, import.meta.url)),
      `레거시 엔진이 되살아났다: src/main/${gone}`,
    )
  }
})

// ── 409 충돌 재시도: 실제로 도는가 ────────────────────────────────────
//
// 재시도 코드는 오래전부터 있었지만 **한 번도 실행되지 않았다.** 전송 계층이
// 던지는 SyncConflictError 에 status 가 없어서 `status !== 409` 가 늘 참이었기
// 때문이다. 그래서 드라이브에 파일을 복사하면 close() 에서 EIO 로 끝났고
// (재시도했으면 성공했을 상황), 서버에는 0바이트 파일만 남았다.

test('전송 계층의 충돌 예외를 409 로 알아본다', () => {
  const e = new SyncConflictError('abc123')
  assert.equal((e as unknown as { status: number }).status, 409, 'status 가 없다')
  assert.match(e.message, /abc123/, '서버 sha 를 메시지에 안 남긴다')
})

test('쓰기가 충돌하면 최신 sha 로 다시 올린다 (EIO 로 끝내지 않는다)', async () => {
  const { be, user } = setup()
  await be.readdir('/')
  let first = true
  const realPut = user.put.bind(user)
  user.put = async (path, fromAbs, baseSha) => {
    if (first) {
      first = false
      throw new SyncConflictError('서버가아는sha') // 캐시가 낡았다
    }
    return realPut(path, fromAbs, baseSha)
  }
  await be.write('/내 메모.md', Buffer.from('새 내용\n'))
  assert.equal(user.files.get('내 메모.md'), '새 내용\n', '재시도가 안 돌아 쓰기가 유실됐다')
})

test('삭제가 충돌해도 최신 sha 로 다시 지운다', async () => {
  const { be, user } = setup()
  await be.readdir('/')
  let first = true
  const realDel = user.del.bind(user)
  user.del = async (path, baseSha, opts) => {
    if (first) {
      first = false
      throw new SyncConflictError('서버가아는sha')
    }
    return realDel(path, baseSha, opts)
  }
  await be.remove('/내 메모.md')
  assert.ok(!user.files.has('내 메모.md'), '재시도가 안 돌아 삭제가 유실됐다')
})

// ── macOS/Windows: 조각 읽기와 다운로드 횟수 ──────────────────────────
//
// 두 OS 의 내장 WebDAV 클라이언트는 큰 파일을 Range 로 조각내 읽는다.
// 조각마다 서버에서 파일 전체를 내려받으면 100MB 파일 한 번 여는 데 수십 GB
// 가 오간다. Linux 는 FUSE 가 열 때 통째로 한 번 읽어서 안 드러났다.

test('같은 파일을 여러 번 읽어도 한 번만 내려받는다', async () => {
  const { be, api } = setup()
  const before = api.calls.filter((c) => c.startsWith('download:')).length
  await be.read('/마케팅 리서치/보고서.md')
  await be.read('/마케팅 리서치/보고서.md')
  await be.read('/마케팅 리서치/보고서.md')
  const n = api.calls.filter((c) => c.startsWith('download:')).length - before
  assert.equal(n, 1, `${n}번 내려받았다 — 캐시가 안 먹는다`)
})

test('부분 읽기가 정확한 조각을 준다', async () => {
  const { be } = setup()
  const whole = await be.read('/마케팅 리서치/보고서.md')
  const part = await be.readRange('/마케팅 리서치/보고서.md', 2, 5)
  assert.deepEqual(part, whole.subarray(2, 6))
})

test('조각을 여러 번 읽어도 내려받기는 한 번뿐이다', async () => {
  const { be, api } = setup()
  const before = api.calls.filter((c) => c.startsWith('download:')).length
  for (let i = 0; i < 5; i++) await be.readRange('/마케팅 리서치/보고서.md', i, i + 1)
  const n = api.calls.filter((c) => c.startsWith('download:')).length - before
  assert.equal(n, 1, `조각 5개에 ${n}번 내려받았다`)
})

test('내용이 바뀌면 캐시가 저절로 무효화된다 (키가 sha)', async () => {
  const { be, api } = setup()
  await be.read('/마케팅 리서치/보고서.md')
  await be.write('/마케팅 리서치/보고서.md', Buffer.from('완전히 다른 내용이다\n'))
  const after = await be.read('/마케팅 리서치/보고서.md')
  assert.equal(after.toString(), '완전히 다른 내용이다\n', '낡은 캐시를 돌려줬다')
  assert.ok(api.calls.filter((c) => c.startsWith('download:')).length >= 2)
})

test('동시에 같은 파일을 읽어도 한 번만 내려받는다', async () => {
  const { be, api } = setup()
  const before = api.calls.filter((c) => c.startsWith('download:')).length
  await Promise.all([
    be.read('/마케팅 리서치/보고서.md'),
    be.read('/마케팅 리서치/보고서.md'),
    be.readRange('/마케팅 리서치/보고서.md', 0, 3),
  ])
  const n = api.calls.filter((c) => c.startsWith('download:')).length - before
  assert.equal(n, 1, `동시 읽기가 ${n}번 내려받았다`)
})
