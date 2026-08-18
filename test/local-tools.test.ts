/** 로컬 셸 도구 — 카탈로그 광고·게이트·셸 선택·결과 정형·실행. */
import assert from 'assert'
import { test } from 'node:test'
import { platform } from 'os'
import {
  LOCAL_SERVER,
  SHELL_TOOL,
  LocalToolProvider,
  coerceShellArgs,
  firstToken,
  isBlocked,
  shapeResult,
  shellConfig,
  shellEnabled,
  shellInvocation,
  shellToolSchema,
} from '../src/main/local-tools'

const isWin = platform() === 'win32'

test('기본은 켜짐(opt-out) — enabled 미지정이면 셸 접근 ON', () => {
  assert.equal(shellEnabled(undefined), true)
  assert.equal(shellEnabled({}), true)
  assert.equal(shellEnabled({ enabled: false }), false)
  assert.equal(shellEnabled({ enabled: true }), true)
})

test('shellConfig 는 timeout 을 [1s, 1h] 로 clamp 한다', () => {
  assert.equal(shellConfig({ timeoutMs: 10 }).timeoutMs, 1_000)
  assert.equal(shellConfig({ timeoutMs: 99_999_999 }).timeoutMs, 3_600_000)
  assert.equal(shellConfig({}).timeoutMs, 120_000)
})

test('꺼져 있으면 카탈로그가 비고, 켜져 있으면 Shell 하나', () => {
  const p = new LocalToolProvider()
  p.configure({ enabled: false })
  assert.deepEqual(p.advertise(), [])
  p.configure({ enabled: true })
  const tools = p.advertise()
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, SHELL_TOOL)
})

test('owns 는 예약 네임스페이스(local)만 소유한다', () => {
  const p = new LocalToolProvider()
  assert.equal(p.owns(LOCAL_SERVER), true)
  assert.equal(p.owns('my-mcp-server'), false)
})

test('Shell 스키마는 command 필수 + shell enum', () => {
  const s = shellToolSchema()
  const schema = s.inputSchema as any
  assert.deepEqual(schema.required, ['command'])
  assert.ok(schema.properties.command)
  assert.deepEqual(schema.properties.shell.enum, ['default', 'powershell', 'cmd', 'bash', 'sh'])
})

test('shellInvocation: default 는 OS 네이티브, 명시 셸은 강제', () => {
  if (isWin) {
    assert.equal(shellInvocation('notepad', null).file, 'powershell.exe')
  } else {
    // POSIX default 는 $SHELL 바이너리 우선(경로 형태일 때), 없으면 bash
    assert.equal(shellInvocation('ls', '/bin/zsh').file, '/bin/zsh')
    assert.deepEqual(shellInvocation('ls', '/bin/zsh').args, ['-lc', 'ls'])
    assert.equal(shellInvocation('ls', null).file, 'bash')
    assert.equal(shellInvocation('ls', 'not-a-path').file, 'bash', '경로가 아니면 bash 로 폴백')
  }
  // 명시 셸은 플랫폼과 무관하게 강제
  assert.equal(shellInvocation('x', null, 'powershell').file, 'powershell.exe')
  assert.equal(shellInvocation('x', null, 'cmd').file, 'cmd.exe')
  assert.equal(shellInvocation('x', '/bin/zsh', 'bash').file, 'bash')
  assert.equal(shellInvocation('x', null, 'sh').file, 'sh')
})

test('firstToken 은 경로·확장자·따옴표를 벗겨 프로그램 이름만 남긴다', () => {
  assert.equal(firstToken('rm -rf /'), 'rm')
  assert.equal(firstToken('"C:\\\\Windows\\\\System32\\\\rm.exe" x'), 'rm')
  assert.equal(firstToken('/usr/bin/git status'), 'git')
  assert.equal(firstToken("'my prog' arg"), 'my prog')
})

test('blocklist 는 첫 토큰 기준으로 차단한다 (경로 우회 불가)', () => {
  assert.equal(isBlocked('rm -rf /', ['rm']), true)
  assert.equal(isBlocked('/usr/bin/rm x', ['rm']), true)
  assert.equal(isBlocked('ls', ['rm']), false)
  assert.equal(isBlocked('anything', []), false)
})

test('coerceShellArgs 는 느슨한 입력을 정규화한다', () => {
  assert.deepEqual(coerceShellArgs({ command: 'ls', cwd: '/tmp', shell: 'bash', timeout_ms: 5000 }), {
    command: 'ls',
    cwd: '/tmp',
    shell: 'bash',
    timeoutMs: 5000,
  })
  // 빈 cwd/timeout 은 undefined 로
  assert.equal(coerceShellArgs({ command: 'ls', cwd: '  ' }).cwd, undefined)
  assert.equal(coerceShellArgs({ command: 'ls' }).timeoutMs, undefined)
})

test('shapeResult 는 stdout/stderr 합치고 실패를 표시한다', () => {
  const ok = shapeResult('hello\n', '', 0, null)
  assert.equal(ok.isError, false)
  assert.match(ok.content[0].text, /hello/)

  const fail = shapeResult('', 'boom', 1, null)
  assert.equal(fail.isError, true)
  assert.match(fail.content[0].text, /STDERR:/)
  assert.match(fail.content[0].text, /exit code 1/)

  const killed = shapeResult('', '', null, 'SIGKILL')
  assert.equal(killed.isError, true)
  assert.match(killed.content[0].text, /SIGKILL/)

  assert.match(shapeResult('', '', 0, null).content[0].text, /no output/)
})

test('꺼진 상태에서 callTool 은 명확한 오류를 던진다', async () => {
  const p = new LocalToolProvider()
  p.configure({ enabled: false })
  await assert.rejects(() => p.callTool(SHELL_TOOL, { command: 'ls' }), /꺼져 있습니다/)
})

test('빈 command / 알 수 없는 도구는 거절한다', async () => {
  const p = new LocalToolProvider()
  p.configure({ enabled: true })
  await assert.rejects(() => p.callTool(SHELL_TOOL, { command: '   ' }), /empty/)
  await assert.rejects(() => p.callTool('Nope', {}), /unknown local tool/)
})

test('차단된 명령은 실행 전에 거절한다', async () => {
  const p = new LocalToolProvider()
  p.configure({ enabled: true, blocked: ['rm'] })
  await assert.rejects(() => p.callTool(SHELL_TOOL, { command: 'rm -rf /' }), /차단 목록/)
})

test('E2E: 실제 셸로 echo 를 실행해 stdout 을 받는다', async () => {
  const p = new LocalToolProvider()
  p.configure({ enabled: true })
  const cmd = isWin ? 'Write-Output hello-xgen' : 'echo hello-xgen'
  const res = await p.callTool(SHELL_TOOL, { command: cmd })
  assert.equal(res.isError, false, JSON.stringify(res))
  assert.match(res.content[0].text, /hello-xgen/)
})

test('E2E: 0 아닌 종료 코드는 isError 로 표시된다', async () => {
  const p = new LocalToolProvider()
  p.configure({ enabled: true })
  const cmd = isWin ? 'exit 3' : 'exit 3'
  const res = await p.callTool(SHELL_TOOL, { command: cmd })
  assert.equal(res.isError, true)
})
