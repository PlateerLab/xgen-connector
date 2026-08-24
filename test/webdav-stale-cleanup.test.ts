/** Windows WebDAV 스테일 마운트 정리 파서 — 업데이트마다 유령 드라이브가 무한 누적되던 버그 가드.
 *  우리(127.0.0.1) 마운트만 골라내고, 연결 끊긴(드라이브 문자 없는) 것은 원격 경로로 지운다.
 *  다른 앱/서버 마운트(비 127.0.0.1)는 절대 건드리지 않는다. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStaleWebdavTargets } from '../src/main/mount-runner';

test('connected + disconnected 127.0.0.1 마운트만 대상, 다른 마운트는 제외', () => {
  const out = [
    '새 연결이 저장되지 않습니다.',
    '',
    '상태       로컬       원격                                      네트워크',
    '-------------------------------------------------------------------------------',
    '확인         Y:        \\\\127.0.0.1@3337\\xgencloud-NsmQ         Web Client Network',
    '연결 안 됨   X:        \\\\127.0.0.1@4021\\xgencloud-AbcD         Web Client Network',
    '확인         Z:        \\\\nas-server\\share                       Microsoft Windows Network',
    '             \\\\127.0.0.1@5000\\oldtoken                          Web Client Network',
    '확인         W:        \\\\192.168.0.5\\pub                        Microsoft Windows Network',
    '명령을 잘 실행했습니다.',
  ].join('\r\n');
  const targets = parseStaleWebdavTargets(out);
  // 드라이브 문자가 있는 127.0.0.1 두 개 + 드라이브 없는(끊긴) 원격 하나.
  assert.ok(targets.includes('Y:'));
  assert.ok(targets.includes('X:'));
  assert.ok(targets.some((t) => t.includes('127.0.0.1@5000')));
  // 다른 서버는 절대 포함 안 됨.
  assert.ok(!targets.includes('Z:'));
  assert.ok(!targets.includes('W:'));
  assert.ok(!targets.some((t) => t.includes('nas-server') || t.includes('192.168')));
});

test('127.0.0.1 마운트가 없으면 빈 목록', () => {
  const out = ['확인   Z:   \\\\srv\\s   Microsoft Windows Network'].join('\r\n');
  assert.deepEqual(parseStaleWebdavTargets(out), []);
  assert.deepEqual(parseStaleWebdavTargets(''), []);
});
