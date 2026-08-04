/** args 배열이 실제 프로세스 spawn 까지 손실 없이 전달되는지 (실기동 검증). */
import assert from 'assert'
import { test } from 'node:test'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { getMcpManager } from '../src/main/mcp-manager'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, 'fixtures', 'fake-mcp-server.mjs')

test('args 의 공백 포함 인자와 env 가 그대로 서버에 도달한다', async () => {
  const mgr = getMcpManager()
  const res = await mgr.test({
    name: 'fake',
    transport: 'stdio',
    command: process.execPath,           // node 실행 파일 (경로에 공백이 있어도 안전)
    args: [FIXTURE, '--path', '/Users/me/My Docs', '--json={"a":1}'],
    env: { FAKE_TOKEN: 'tok-123' },
  })
  assert.ok(res.ok, `연결 실패: ${res.error ?? ''}`)
  const tool = (res.tools ?? []).find((t) => t.name === 'echo_argv')
  assert.ok(tool, `도구 목록에 echo_argv 없음: ${JSON.stringify(res.tools)}`)
  const desc = (tool as { description?: string }).description ?? ''
  assert.ok(desc.includes('"/Users/me/My Docs"'), `공백 인자 손실: ${desc}`)
  assert.ok(desc.includes('--json={\\"a\\":1}') || desc.includes('--json={"a":1}'), `따옴표 인자 손실: ${desc}`)
  assert.ok(desc.includes('tok-123'), `env 전달 실패: ${desc}`)
  await mgr.closeAll()
})

test('args 없이 한 줄 명령이면 따옴표 인식 분해로 동작한다 (기존 경로)', async () => {
  const mgr = getMcpManager()
  const res = await mgr.test({
    name: 'fake2',
    transport: 'stdio',
    command: `"${process.execPath}" "${FIXTURE}" --path "/tmp/a b"`,
  })
  assert.ok(res.ok, `연결 실패: ${res.error ?? ''}`)
  const desc = (res.tools ?? []).find((t) => t.name === 'echo_argv')?.description ?? ''
  assert.ok(desc.includes('/tmp/a b'), `한 줄 명령의 인용 인자 손실: ${desc}`)
  await mgr.closeAll()
})
