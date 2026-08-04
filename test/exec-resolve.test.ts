/** 실행 파일 해석 — GUI 실행에서 uvx/npx 를 못 찾던 ENOENT 의 방어선. */
import assert from 'assert'
import { test } from 'node:test'
import { chmodSync, mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { delimiter, join } from 'path'
import { commonBinDirs, mergePaths, notFoundMessage, resolveExecutable } from '../src/main/exec-resolve'

const isWin = process.platform === 'win32'

function fakeBin(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, isWin ? `${name}.cmd` : name)
  writeFileSync(file, isWin ? '@echo off\n' : '#!/bin/sh\nexit 0\n')
  if (!isWin) chmodSync(file, 0o755)
  return file
}

test('PATH 에 있는 실행 파일을 절대 경로로 해석한다', () => {
  const root = mkdtempSync(join(tmpdir(), 'exec-'))
  const bin = join(root, 'bin')
  const target = fakeBin(bin, 'uvx')
  const resolved = resolveExecutable('uvx', [join(root, 'nope'), bin].join(delimiter))
  // Windows 는 경로 대소문자를 구분하지 않는다 — 비교도 그렇게.
  const norm = (p: string | null) => (p && isWin ? p.toLowerCase() : p)
  assert.equal(norm(resolved), norm(target), 'PATH 순회로 찾지 못했다')
})

test('PATH 에 없으면 null 과 안내 메시지', () => {
  const root = mkdtempSync(join(tmpdir(), 'exec-'))
  const p = join(root, 'empty')
  mkdirSync(p, { recursive: true })
  assert.equal(resolveExecutable('uvx', p), null)
  const msg = notFoundMessage('uvx', p)
  assert.ok(msg.includes('uvx'), '어떤 명령인지 알려야 한다')
  assert.ok(/절대 경로/.test(msg), '해결 방법을 안내해야 한다')
})

test('경로가 포함된 명령은 그대로 검증만 한다', () => {
  const root = mkdtempSync(join(tmpdir(), 'exec-'))
  const target = fakeBin(join(root, 'bin'), 'tool')
  // 절대 경로 → 그대로 반환
  assert.equal(resolveExecutable(target, ''), target)
  // 존재하지 않는 절대 경로 → null (PATH 를 뒤지지 않는다)
  assert.equal(resolveExecutable(join(root, 'bin', 'ghost'), join(root, 'bin')), null)
})

test('디렉터리는 실행 파일로 취급하지 않는다', () => {
  const root = mkdtempSync(join(tmpdir(), 'exec-'))
  const bin = join(root, 'bin')
  mkdirSync(join(bin, 'uvx'), { recursive: true }) // 같은 이름의 디렉터리
  assert.equal(resolveExecutable('uvx', bin), null)
})

test('실행 권한이 없는 파일은 건너뛴다 (posix)', (ctx) => {
  if (isWin) return ctx.skip('windows: 실행 권한 개념이 다름')
  const root = mkdtempSync(join(tmpdir(), 'exec-'))
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const noexec = join(bin, 'uvx')
  writeFileSync(noexec, '#!/bin/sh\n')
  chmodSync(noexec, 0o644)
  assert.equal(resolveExecutable('uvx', bin), null)
  chmodSync(noexec, 0o755)
  assert.equal(resolveExecutable('uvx', bin), noexec)
})

test('mergePaths 는 순서를 지키며 중복/빈 항목을 제거한다', () => {
  const merged = mergePaths('/a', `/b${delimiter}/a`, '', undefined, `/c${delimiter}`)
  assert.deepEqual(merged.split(delimiter), ['/a', '/b', '/c'])
})

test('commonBinDirs 는 사용자 설치 위치를 포함한다', () => {
  const dirs = commonBinDirs(homedir())
  const joined = dirs.join(delimiter)
  // uv/uvx 의 기본 설치 위치 — ENOENT 사고의 주인공
  assert.ok(joined.includes(join(homedir(), '.local', 'bin')), '~/.local/bin 이 빠졌다')
  assert.ok(dirs.length >= 5)
})

test('실제 시스템 명령을 해석할 수 있다 (스모크)', () => {
  const known = isWin ? 'cmd' : 'sh'
  const resolved = resolveExecutable(known, process.env.PATH ?? '')
  assert.ok(resolved, `${known} 를 PATH 에서 찾지 못했다`)
})
