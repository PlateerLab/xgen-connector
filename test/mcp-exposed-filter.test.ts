/** 내부 도구(_ 접두)는 "에이전트에 노출된 도구" 목록에서 제외된다 — 서버가 LLM 노출에서
 *  거르는 실행 브리지 라우트(_Exec/_WorkspaceInfo 등)라 모델이 부를 수 없고, 사용자에게
 *  불필요·혼란만 준다(자동 관리되는 로컬/서버 실행 환경의 내부 배관). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, '..', 'src', 'renderer', 'src', 'views', 'McpSettings.tsx'), 'utf-8').replace(
  /\r\n/g,
  '\n',
);

test('노출 도구 패널이 _ 접두 내부 도구를 거른다', () => {
  // isExposed 로 _-접두를 제외하고, 그 결과로 total/목록을 만든다.
  assert.match(SRC, /const isExposed = \(name: string\): boolean => !String\(name \|\| ''\)\.startsWith\('_'\)/);
  assert.match(SRC, /\.filter\(\(t\) => isExposed\(t\.name\)\)/);
  // total 은 필터된 servers 에서 계산한다(내부 도구가 개수에 안 잡힘).
  assert.match(SRC, /const total = servers\.reduce/);
});

test('복사는 main clipboard(copyText)를 쓴다 — navigator.clipboard 직접 사용 없음', () => {
  assert.match(SRC, /copyText\(/);
  assert.doesNotMatch(SRC, /navigator\.clipboard\.writeText/);
});
