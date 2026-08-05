/**
 * WebDAV 백엔드 — 마운트된 드라이브가 실제 에이전트 워크스페이스를 보여준다.
 *
 * 여기서 고정하는 것: 루트=에이전트 목록, 직계 자식만 나열, 트리 캐시,
 * **조회 실패 시 이전 캐시 유지**(빈 목록을 주면 Finder 에 "전부 사라졌다"로
 * 보인다), base_sha 전달, MOVE=복사+삭제(편집기 저장 패턴).
 */
import assert from 'assert'
import { test } from 'node:test'
import { readFileSync, writeFileSync } from 'fs'
import { WorkspaceDavBackend, type WorkspaceApi } from '../src/main/workspace-backend'

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
  async del(path: string, baseSha?: string): Promise<void> {
    this.calls.push(`del:${path}:base=${baseSha ?? ''}`)
    this.files.delete(path)
    this.dirs.delete(path)
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
  assert.ok(api.calls.some((c) => c === 'del:자료:base='), api.calls.join(','))
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
