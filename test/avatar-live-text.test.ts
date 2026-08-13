/**
 * 아바타가 말하는 것의 계약 — **이 세션에서 라이브로 흐른 텍스트만.**
 *
 * 버그: 대화 기록을 열기만 해도 그 대화의 마지막 답변이 아바타 말풍선/자막에
 * 떠서, 아바타가 방금 말한 것처럼 보였다.
 *
 * 원인은 원천이었다 — 아바타 상태가 "마지막 assistant 메시지"에서 파생됐고,
 * 기록 로드도 messages 를 바꾸므로 구분 없이 흘러갔다. 기록을 읽는 것과
 * 말하는 것은 다른 일이다.
 *
 * 이 파일은 원천 분리가 유지되는지 검사한다 — 되돌아가면 같은 버그가 재발한다.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// Windows 러너는 CRLF 로 체크아웃한다 — \n 고정 검색이 빈 슬라이스를 만들어
// 이 파일의 검사가 윈도우에서만 실패했다 (CI 실증). 줄바꿈을 정규화한다.
const CHAT = readFileSync(join(__dirname, '..', 'src/renderer/src/views/Chat.tsx'), 'utf8')
  .replace(/\r\n/g, '\n');

test('아바타 상태는 messages 가 아니라 liveText 에서 나온다', () => {
  assert.match(CHAT, /streamingText:\s*liveText/, '아바타가 liveText 를 쓰지 않는다');
  // 예전 방식 — 마지막 메시지 파생 — 이 되살아나면 안 된다.
  assert.ok(
    !/streamingText:\s*last\?\.role/.test(CHAT),
    '아바타가 다시 "마지막 메시지"에서 파생된다 — 기록 로드가 말이 된다',
  );
});

test('세션 전환(기록 로드 포함)이 라이브 텍스트를 비운다', () => {
  // 세션 이펙트 초입: 이전 세션/기록의 말이 새 화면에 남으면 안 된다.
  const effect = CHAT.slice(
    CHAT.indexOf('cancelRef.current = null;'),
    CHAT.indexOf('session.resume && session.interactionId'),
  );
  assert.match(effect, /setLiveText\(''\)/, '세션 전환이 이전 말을 지우지 않는다');
});

test('새 질문을 보내면 이전 답의 잔상이 지워진다', () => {
  const sendBlock = CHAT.slice(
    CHAT.indexOf("streaming: true },\n    ]);"),
    CHAT.indexOf('const tools: ToolEvent[] = [];'),
  );
  assert.match(sendBlock, /setLiveText\(''\)/);
});

test('라이브 스트림만 텍스트를 채운다', () => {
  // 스트리밍 이벤트 핸들러 안에서만 setLiveText(내용) 이 불린다.
  const matches = CHAT.match(/setLiveText\(assistantText\)/g) ?? [];
  assert.ok(matches.length >= 1, '스트림이 아바타 텍스트를 채우지 않는다');
  // 기록 로드 경로(turns → setMessages)에는 setLiveText(내용) 이 없어야 한다.
  const historyBlock = CHAT.slice(
    CHAT.indexOf('xgen.history'),
    CHAT.indexOf('setLoadingHistory(false)'),
  );
  assert.ok(
    !/setLiveText\((?!''\))/.test(historyBlock),
    '기록 로드가 아바타 텍스트를 채운다',
  );
});

test('TTS 는 라이브 경로에서만 큐잉된다', () => {
  // 자막과 달리 소리는 한 번 나면 주워 담을 수 없다 — 기록 로드 블록에
  // enqueueTts 가 없어야 한다.
  const historyBlock = CHAT.slice(
    CHAT.indexOf('xgen.history'),
    CHAT.indexOf('setLoadingHistory(false)'),
  );
  assert.ok(!/enqueueTts/.test(historyBlock), '기록 로드가 TTS 를 울린다');
});
