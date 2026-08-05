/**
 * 데드락 방지 계약 — **이 프로세스는 자기 마운트를 동기 IO 로 만지면 안 된다.**
 *
 * FUSE 콜백이 메인 이벤트 루프에 올라오므로, 루프를 막는 동기 호출이 마운트를
 * 향하면 콜백이 응답하지 못하고 서로를 기다린다. 실기에서 두 번 겪었다:
 *   1) 테스트가 마운트를 readFileSync 로 읽어 멈춤
 *   2) shell.openPath 로 "폴더 열기" 를 누르는 순간 앱이 응답 없음
 *
 * 사람이 기억으로 지킬 계약이 아니라서 소스로 고정한다.
 */
import assert from 'assert'
import { test } from 'node:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const SRC = join(__dirname, '..', 'src', 'main')

function src(name: string): string {
  return readFileSync(join(SRC, name), 'utf-8')
}

test('shell.openPath 로 워크스페이스를 열지 않는다 (동기 확인 → 데드락)', () => {
  const s = src('index.ts')
  // 워크스페이스 열기 핸들러가 shell.openPath 를 쓰면 안 된다.
  const handler = s.slice(s.indexOf('CHANNELS.workspaceOpen'), s.indexOf('CHANNELS.workspaceOpen') + 400)
  assert.ok(
    !handler.includes('shell.openPath'),
    'workspaceOpen 이 shell.openPath 를 쓴다 — 마운트를 동기 확인해 데드락이 난다',
  )
  assert.ok(handler.includes('openInFileManager'), '자식 프로세스 경로를 쓰지 않는다')
})

test('폴더 열기는 분리된 자식 프로세스로 실행된다', () => {
  const s = src('index.ts')
  const fn = s.slice(s.indexOf('function openInFileManager'), s.indexOf('function openInFileManager') + 700)
  assert.match(fn, /spawn\(/, '자식 프로세스를 쓰지 않는다')
  assert.match(fn, /detached:\s*true/, 'detached 가 아니면 우리 프로세스에 묶인다')
  assert.match(fn, /xdg-open/, '리눅스 경로가 없다')
})

test('FUSE 모듈은 마운트된 경로에 동기 IO 를 하지 않는다', () => {
  const s = src('fuse-mount.ts')
  // 마운트 이후 경로(언마운트 콜백 안)에서 동기 fs 호출이 있으면 안 된다.
  const unmountBlock = s.slice(s.indexOf('fuse.unmount('), s.indexOf('fuse.unmount(') + 900)
  for (const bad of ['readdirSync', 'rmdirSync', 'existsSync', 'statSync', 'readFileSync']) {
    assert.ok(
      !unmountBlock.includes(bad),
      `언마운트 콜백에서 ${bad} 를 호출한다 — 커널 정리 중이면 루프가 막힌다`,
    )
  }
})

test('워크스페이스 매니저에 데드락 계약이 문서로 남아 있다', () => {
  // 주석이 사라지면 다음 사람이 같은 실수를 한다.
  const s = src('workspace-manager.ts')
  assert.match(s, /동기 IO/, '데드락 계약 설명이 사라졌다')
})
