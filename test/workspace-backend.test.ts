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

function setup(): { be: WorkspaceDavBackend; api: FakeApi } {
  const api = new FakeApi()
  api.files.set('보고서.md', '# 보고서\n')
  api.files.set('자료/표.csv', 'a,b\n')
  api.dirs.add('자료')
  const be = new WorkspaceDavBackend()
  be.setAgents([{ folder: '마케팅 리서치', api }])
  return { be, api }
}

test('루트는 붙어 있는 에이전트 목록이다', async () => {
  const { be } = setup()
  const root = await be.stat('/')
  assert.ok(root?.isDir)
  const kids = await be.readdir('/')
  assert.deepEqual(kids.map((k) => k.name), ['마케팅 리서치'])
  assert.ok(kids[0].isDir)
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

test('에이전트 폴더 자체는 드라이브에서 만들거나 지울 수 없다', async () => {
  const { be } = setup()
  await assert.rejects(() => be.mkdir('/새 에이전트'), /앱에서 추가/)
  await assert.rejects(() => be.remove('/마케팅 리서치'), /앱에서 추가/)
  await assert.rejects(() => be.write('/루트파일.txt', Buffer.from('x')), /밖에는 쓸 수 없습니다/)
})

test('에이전트를 떼면 목록에서 사라지고 캐시도 정리된다', async () => {
  const { be } = setup()
  await be.readdir('/마케팅 리서치')
  be.setAgents([])
  assert.deepEqual(await be.readdir('/'), [])
  assert.equal(await be.stat('/마케팅 리서치'), null)
})
