/**
 * FUSE 는 **자식 프로세스**가 건다.
 *
 * 왜: 네이티브 바인딩이 Electron 메인에서 SIGSEGV 를 내면 커넥터가 통째로
 * 사라진다 (실기: 클라우드 폴더에 파일을 넣는 순간 앱이 죽었다). 그리고 FUSE
 * 콜백이 메인 루프에 올라오면 자기 마운트를 만지는 동기 호출 하나가 데드락을
 * 만든다 — 그 문제를 세 번 겪었다. 루프가 아예 다르면 규칙 없이도 성립한다.
 *
 * 여기서 고정하는 것은 **경계가 유지되는지**다. 코드가 다시 메인에서 FUSE 를
 * 직접 잡으면 잡아낸다.
 */
import assert from 'assert'
import { test } from 'node:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const SRC = join(__dirname, '..', 'src', 'main')
const src = (n: string): string => readFileSync(join(SRC, n), 'utf-8')

test('워크스페이스 매니저는 FUSE 를 직접 마운트하지 않는다', () => {
  const s = src('workspace-manager.ts')
  assert.ok(!s.includes('mountFuse('), '메인에서 mountFuse 를 직접 부른다 — 자식 프로세스 경계가 무너졌다')
  assert.match(s, /spawnFuseHost/, '자식 호스트를 띄우지 않는다')
})

test('자식은 Electron 을 Node 모드로 실행한다 (앱에 별도 Node 가 없다)', () => {
  const s = src('workspace-manager.ts')
  const fn = s.slice(s.indexOf('private async spawnFuseHost'), s.indexOf('private async stopFuseHost'))
  assert.match(fn, /process\.execPath/, '실행 파일을 지정하지 않는다')
  assert.match(fn, /ELECTRON_RUN_AS_NODE/, 'Node 모드 지정이 없다 — Electron 앱으로 떠 버린다')
  assert.match(fn, /fuse-host\.js/, '자식 진입점을 가리키지 않는다')
})

test('자식이 죽어도 앱은 살고, 무한 재기동은 하지 않는다', () => {
  const s = src('workspace-manager.ts')
  const fn = s.slice(s.indexOf('private async spawnFuseHost'), s.indexOf('private async stopFuseHost'))
  assert.match(fn, /child\.on\('exit'/, '자식 종료를 감지하지 않는다')
  assert.match(fn, /hostRestarts/, '재기동 횟수를 세지 않는다 — 죽는 자식을 무한히 다시 띄운다')
})

test('자식이 응답하지 않으면 매달리지 않는다', () => {
  const s = src('workspace-manager.ts')
  const fn = s.slice(s.indexOf('private async spawnFuseHost'), s.indexOf('private async stopFuseHost'))
  assert.match(fn, /setTimeout\(/, '타임아웃이 없다 — 자식이 조용하면 리컨사일이 영영 안 끝난다')
})

test('자식은 부모가 사라지면 스스로 언마운트한다', () => {
  // 부모가 죽었는데 마운트가 남으면 그 폴더는 이후 모든 접근을 거부한다.
  const s = src('fuse-host.ts')
  assert.match(s, /process\.stdin\.on\('end'/, 'stdin 종료(=부모 소멸)를 감지하지 않는다')
  assert.match(s, /SIGTERM/, '종료 신호를 처리하지 않는다')
})

test('자식은 예외로 죽지 않고 부모에게 알린다', () => {
  const s = src('fuse-host.ts')
  assert.match(s, /uncaughtException/, '자식이 예외 하나로 사라진다')
  assert.match(s, /unhandledRejection/, '거부 하나로 사라진다')
})

test('빌드가 자식 진입점을 실제로 낸다', () => {
  const cfg = readFileSync(join(__dirname, '..', 'electron.vite.config.ts'), 'utf-8')
  assert.match(cfg, /'fuse-host':/, '빌드 설정에 자식 진입점이 없다 — 배포본에 파일이 없다')
})
