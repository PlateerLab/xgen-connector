/**
 * sync-e2e — 실제 xgen-workflow geny-workspace API 에 대한 라이브 E2E.
 *
 * 기본 `npm test` 에는 포함되지 않는다 (서버 필요). 실행:
 *
 *   1) 서버: xgen-workflow 의 geny-workspace 라우터를 띄운다 (게이트웨이 인증
 *      헤더 주입만 시뮬레이션). 예: scratchpad/serve_geny_workspace.py
 *   2) XGEN_WS_URL=http://127.0.0.1:8977 npx tsx test/sync-e2e.ts
 *
 * 검증: 부트스트랩 업로드 → 서버발 변경 다운로드 → 동시 편집 충돌 사본 →
 * 삭제 전파 → 청크 업로드(임계값 강제 초과) → WS notify 수신.
 */
import assert from 'assert'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SyncIndex, syncOnce } from '../src/main/sync-core'
import { ReplicaFs } from '../src/main/sync-fs'
import { HttpSyncTransport, WorkspaceWsClient } from '../src/main/sync-transport'

const BASE = process.env.XGEN_WS_URL || 'http://127.0.0.1:8977'
const WF = 'wf-e2e'

function makeReplica(name: string) {
  const root = mkdtempSync(join(tmpdir(), `xgen-sync-e2e-${name}-`))
  const fs = new ReplicaFs(root)
  const index: SyncIndex = { cursor: 0, entries: {} }
  const transport = new HttpSyncTransport(
    { baseUrl: BASE, token: () => 'e2e-token', workflowId: WF, deviceId: `dev-${name}` },
    join(root, '.geny-sync-tmp'),
    { chunkThresholdBytes: 1024 * 1024 }, // 1MiB 초과는 청크 경로 강제
  )
  return { root, fs, index, transport }
}

async function round(r: ReturnType<typeof makeReplica>) {
  return syncOnce(r.transport, r.fs, r.index, {
    deviceName: `pc-${r.root.slice(-4)}`,
    maxFileBytes: 500 * 1024 * 1024,
    stabilityMs: 0,
  })
}

async function main() {
  // 사전 상태 확인
  const probe = await fetch(`${BASE}/api/agentflow/geny-workspace/${WF}/storage/changes?since=0`)
  assert.equal(probe.status, 200, `server not reachable: ${probe.status}`)

  const a = makeReplica('a')
  const b = makeReplica('b')

  // 1) A 부트스트랩 업로드
  mkdirSync(join(a.root, 'docs'), { recursive: true })
  writeFileSync(join(a.root, 'docs', 'note.md'), '# hello from A')
  writeFileSync(join(a.root, 'top.txt'), 'top-v1')
  let res = await round(a)
  assert.equal(res.stats.uploaded, 2, `A upload: ${JSON.stringify(res.stats)}`)
  console.log('# 1) bootstrap upload OK')

  // 2) B 부트스트랩 다운로드 → 수렴
  res = await round(b)
  assert.equal(res.stats.downloaded, 2, `B download: ${JSON.stringify(res.stats)}`)
  assert.equal(readFileSync(join(b.root, 'docs', 'note.md'), 'utf-8'), '# hello from A')
  console.log('# 2) second replica bootstrap OK')

  // 3) 동시 편집 → 충돌 사본 (서버가 이긴 쪽 유지 + 로컬 사본 보존·업로드)
  writeFileSync(join(a.root, 'top.txt'), 'A-edit')
  writeFileSync(join(b.root, 'top.txt'), 'B-edit')
  await round(a)
  res = await round(b)
  assert.equal(res.stats.conflicts, 1, `conflict: ${JSON.stringify(res.stats)}`)
  const bFiles = readdirSync(b.root)
  const conflictCopy = bFiles.find((f) => f.includes('충돌'))
  assert.ok(conflictCopy, `conflict copy missing: ${bFiles.join(',')}`)
  assert.equal(readFileSync(join(b.root, 'top.txt'), 'utf-8'), 'A-edit')
  await round(a)
  assert.ok(readdirSync(a.root).find((f) => f.includes('충돌')), 'conflict copy did not propagate to A')
  console.log(`# 3) concurrent edit conflict OK (${conflictCopy})`)

  // 4) 삭제 전파
  rmSync(join(a.root, 'docs', 'note.md'))
  await round(a)
  res = await round(b)
  assert.ok(res.stats.deletedLocal >= 1, `delete propagate: ${JSON.stringify(res.stats)}`)
  console.log('# 4) delete propagation OK')

  // 5) 청크 업로드 (3MiB > 1MiB 임계값) + 반대편 다운로드 무결성
  const big = Buffer.alloc(3 * 1024 * 1024)
  for (let i = 0; i < big.length; i += 4) big.writeUInt32LE((i * 2654435761) >>> 0, i)
  writeFileSync(join(a.root, 'big.bin'), big)
  res = await round(a)
  assert.equal(res.stats.uploaded, 1, `chunked upload: ${JSON.stringify(res.stats)}`)
  res = await round(b)
  assert.ok(readFileSync(join(b.root, 'big.bin')).equals(big), 'chunked roundtrip bytes differ')
  console.log('# 5) chunked upload roundtrip OK (3MiB)')

  // 6) WS notify: B 가 소켓을 열고, A 의 업로드가 changed 프레임으로 도착
  const notified = new Promise<number>((resolveP, rejectP) => {
    const timer = setTimeout(() => rejectP(new Error('WS notify timeout (10s)')), 10_000)
    const ws = new WorkspaceWsClient(
      { baseUrl: BASE, token: () => 'e2e-token', workflowId: WF, deviceId: 'dev-ws' },
      'pc-ws',
      (seq) => {
        if (seq > b.index.cursor) {
          clearTimeout(timer)
          ws.stop()
          resolveP(seq)
        }
      },
      () => {},
    )
    void ws.start()
  })
  await new Promise((r) => setTimeout(r, 500)) // hello/state 수신 대기
  writeFileSync(join(a.root, 'ping.txt'), 'ws-notify')
  await round(a)
  const seq = await notified
  console.log(`# 6) WS change notify OK (latest_seq=${seq})`)

  console.log('# ALL SYNC E2E SCENARIOS PASS')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
