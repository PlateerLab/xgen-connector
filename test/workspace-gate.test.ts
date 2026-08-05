/**
 * 클라우드 스토리지 on/off — 커넥터가 서버의 판정을 따르는지.
 *
 * on/off 는 **두 곳**에 있다: 관리자 전역 설정(IS_AVAILABLE_CLOUD_STORAGE)과
 * 사용자 개인 설정(preferences.cloud_storage). 커넥터는 어느 쪽이 껐는지 알
 * 필요가 없다 — 서버가 403 으로 거절하면 그게 꺼진 것이다. 게이트 판정을
 * 커넥터가 흉내내면 서버와 어긋나는 순간 "웹에선 꺼졌는데 드라이브엔 남아
 * 있다"가 된다.
 *
 * 여기서 고정하는 것:
 *   1. 403 → 루트를 붙이지 않고 **사유를 사용자에게 보여준다** (조용히 빈
 *      폴더가 되면 사용자는 파일이 사라진 줄 안다)
 *   2. 네트워크 실패는 **꺼짐이 아니다** — 잠깐 끊겼다고 루트를 떼면 안 된다
 *   3. 꺼져 있어도 **에이전트 workspace 는 그대로** 동작한다
 */
import assert from 'assert'
import { test } from 'node:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { WorkspaceManager, type WorkspaceManagerDeps } from '../src/main/workspace-manager'
import type { WorkspaceApi } from '../src/main/workspace-backend'

/** changes() 가 지정한 방식으로 실패하는(또는 성공하는) 최소 API. */
function api(fail?: { status?: number; message: string }): WorkspaceApi {
  return {
    async changes() {
      if (fail) {
        throw Object.assign(new Error(fail.message), fail.status ? { status: fail.status } : {})
      }
      return { changes: [] }
    },
    async download() {},
    async put() {
      return { sha256: '' }
    },
    async del() {},
    async mkdir() {},
  }
}

function manager(userApi: WorkspaceApi | null, agents: string[] = []): WorkspaceManager {
  const deps: WorkspaceManagerDeps = {
    config: () => ({
      root: '/tmp/xgen-gate-test',
      agents: agents.map((id) => ({ workflowId: id, label: id, folder: id })),
    }) as never,
    apiFor: () => api(),
    loggedIn: () => true,
    userApi: () => userApi,
  }
  return new WorkspaceManager(deps)
}

// probeUserStorage 는 내부 계약이지만 **이 동작이 사용자에게 보이는 전부**다.
type Probe = (a: WorkspaceApi | null) => Promise<WorkspaceApi | null>
const probeOf = (m: WorkspaceManager): Probe =>
  (m as unknown as { probeUserStorage: Probe }).probeUserStorage.bind(m)

test('403 이면 루트를 붙이지 않고 서버가 준 사유를 보여준다', async () => {
  const m = manager(null)
  const denied = api({ status: 403, message: '내 클라우드 스토리지가 켜져 있지 않습니다' })
  assert.equal(await probeOf(m)(denied), null, '꺼졌는데 루트를 붙였다')
  assert.match(m.status().storageOff ?? '', /켜져 있지 않습니다/)
  // 오류가 아니다 — "실패"로 보이면 사용자가 고치려 든다.
  assert.equal(m.status().error, undefined)
})

test('관리자가 끈 경우도 같은 경로로 처리된다 (누가 껐는지 몰라도 된다)', async () => {
  const m = manager(null)
  const denied = api({ status: 403, message: '클라우드 스토리지 기능이 비활성화되어 있습니다' })
  assert.equal(await probeOf(m)(denied), null)
  assert.match(m.status().storageOff ?? '', /비활성화/)
})

test('네트워크 실패는 꺼짐이 아니다 (파일이 사라진 것처럼 보이면 안 된다)', async () => {
  const m = manager(null)
  const flaky = api({ message: 'fetch failed' })
  assert.notEqual(await probeOf(m)(flaky), null, '잠깐 끊겼다고 루트를 뗐다')
  assert.equal(m.status().storageOff, undefined)
})

test('500 도 꺼짐이 아니다 — 서버 장애와 정책은 다르다', async () => {
  const m = manager(null)
  const broken = api({ status: 500, message: 'changes HTTP 500' })
  assert.notEqual(await probeOf(m)(broken), null)
  assert.equal(m.status().storageOff, undefined)
})

test('다시 켜면 사유가 사라진다 (한 번 꺼지면 영영 꺼진 것처럼 남으면 안 된다)', async () => {
  const m = manager(null)
  await probeOf(m)(api({ status: 403, message: '꺼져 있습니다' }))
  assert.ok(m.status().storageOff)
  assert.notEqual(await probeOf(m)(api()), null)
  assert.equal(m.status().storageOff, undefined, '다시 켰는데 꺼짐 표시가 남아 있다')
})

test('스토리지를 안 쓰는 사용자는 사유도 없다', async () => {
  const m = manager(null)
  assert.equal(await probeOf(m)(null), null)
  assert.equal(m.status().storageOff, undefined)
})

test('꺼져 있고 에이전트도 없으면 마운트하지 않는다', async () => {
  const m = manager(api({ status: 403, message: '꺼져 있습니다' }))
  await m.reconcile()
  const s = m.status()
  assert.equal(s.mounted, false)
  assert.match(s.storageOff ?? '', /꺼져 있습니다/)
})

/**
 * preload 의 WorkspaceStatusLike 는 main 의 WorkspaceStatus 를 **손으로 베낀
 * 미러**다. 미러가 어긋나면 main 이 보낸 필드가 렌더러에서 조용히 사라진다
 * (타입만 없을 뿐 런타임 값은 오므로 컴파일러도 안 잡아준다).
 *
 * 실제로 이 종류의 조용한 실패를 여러 번 겪었다 — 주석 대신 테스트로 못 박는다.
 */
test('preload 상태 미러가 main 의 필드를 하나도 빠뜨리지 않는다', () => {
  const fields = (file: string, iface: string): Set<string> => {
    const src = readFileSync(join(__dirname, '..', file), 'utf8')
    const m = new RegExp(`interface ${iface}\\s*{([\\s\\S]*?)\\n}`).exec(src)
    assert.ok(m, `${iface} 를 ${file} 에서 못 찾았다`)
    return new Set(
      [...m![1].matchAll(/^\s{2}(\w+)\??:/gm)].map((x) => x[1]),
    )
  }
  const main = fields('src/main/workspace-manager.ts', 'WorkspaceStatus')
  const mirror = fields('src/preload/index.ts', 'WorkspaceStatusLike')
  assert.ok(main.size > 5, `main 필드 파싱 실패 (${[...main]})`)
  const missing = [...main].filter((f) => !mirror.has(f))
  assert.deepEqual(missing, [], `preload 미러에 빠진 필드: ${missing.join(', ')}`)
})
