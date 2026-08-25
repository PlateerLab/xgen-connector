/**
 * teams-store — Teams 화면의 **순수** 상태 모델.
 *
 * 브릿지(window.xgen)도 React 도 모른다 — 그래서 node 에서 단위 테스트가 된다
 * (`session-store.ts` 와 같은 이유·같은 결). 화면은 이 함수들이 만든 결과만
 * 그린다.
 *
 * 여기서 푸는 문제는 셋이다:
 *   1. REST 로 불러온 과거 메시지와 WS 로 도착한 새 메시지를 **한 줄로 합치기**
 *      (중복 제거 + 시간 오름차순).
 *   2. 낙관적 전송 — 보낸 즉시 화면에 띄우고, 서버가 확정한 메시지로 교체.
 *   3. 안 읽은 메시지 — 서버가 세어 주지 않으므로(웹 Teams 도 항상 0 이 내려온다)
 *      방별 "마지막으로 읽은 시각" 을 클라이언트가 들고 계산한다.
 */
// 값 import 는 **순수 모듈에서 직접** 가져온다. core/index 를 거치면 클라이언트
// 전체(HttpClient·아바타·음성…)가 딸려 들어와 node 단위 테스트가 무거워진다.
import { shareBodyOf } from '../../../core/teams-bridge';
import type { TeamsAttachment, TeamsMessage, TeamsReaction, TeamsRoom } from '../../../core/index';

/** 낙관적으로 그려 둔, 아직 서버가 확정하지 않은 메시지의 id 접두사. */
export const PENDING_PREFIX = 'pending:';

export function isPending(message: TeamsMessage): boolean {
  return message.id.startsWith(PENDING_PREFIX);
}

/** 정렬 키 — created_at 이 같은 순간이면 id 로 안정 정렬한다. */
function sortKey(m: TeamsMessage): string {
  return `${m.createdAt} ${m.id}`;
}

/**
 * 두 메시지 목록을 합친다. 같은 id 는 **나중 것이 이긴다** — WS 로 온 최신 상태가
 * 캐시된 과거본을 덮어야 편집/리액션이 반영된다.
 *
 * 정렬에서 낙관적(pending) 메시지는 **항상 맨 뒤**다. 서버의 created_at 은 타임존이
 * 없는 로컬 표기(`2026-08-21T15:04:05`)인데 방금 만든 임시 메시지는 UTC 'Z' 표기라,
 * 문자열로 나란히 정렬하면 방금 보낸 말이 대화 맨 위로 튀어 오른다. 시각 표기를
 * 맞추려 애쓰는 대신 "아직 서버가 모르는 메시지는 마지막" 이라는 사실을 그대로 쓴다.
 */
/**
 * 한 방이 메모리에 들고 있을 메시지 상한.
 *
 * 위로 스크롤하면 계속 불러오고 실시간 메시지는 계속 쌓이므로, 두지 않으면
 * 오래 켜 둔 방이 무한히 커진다. 넘치면 **가장 오래된 것부터** 버린다 —
 * 버려도 위로 스크롤하면 서버에서 다시 불러온다(hasMore/커서 그대로 동작).
 *
 * 화면에 보이는 것보다 넉넉해야 스크롤이 끊기지 않으므로 한 페이지(50)의
 * 여러 배로 잡는다.
 */
export const MAX_ROOM_MESSAGES = 400;

export function mergeMessages(current: TeamsMessage[], incoming: TeamsMessage[]): TeamsMessage[] {
  if (incoming.length === 0) return current;
  const byId = new Map<string, TeamsMessage>();
  for (const m of current) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  const sorted = [...byId.values()].sort((a, b) => {
    const ap = isPending(a);
    const bp = isPending(b);
    if (ap !== bp) return ap ? 1 : -1;
    return sortKey(a) < sortKey(b) ? -1 : 1;
  });
  // 상한을 넘으면 앞(과거)부터 버린다. 최근이 대화이고, 과거는 스크롤로 다시 온다.
  return sorted.length > MAX_ROOM_MESSAGES ? sorted.slice(-MAX_ROOM_MESSAGES) : sorted;
}

/**
 * 낙관적 메시지를 서버 확정본으로 교체한다.
 *
 * 서버 응답과 WS `message_new` 가 경쟁하므로, 확정본이 이미 목록에 있으면
 * 임시본만 걷어낸다 — 그러지 않으면 같은 메시지가 두 줄로 보인다.
 */
export function settlePending(
  current: TeamsMessage[],
  pendingId: string,
  settled: TeamsMessage,
): TeamsMessage[] {
  const without = current.filter((m) => m.id !== pendingId);
  return mergeMessages(without, [settled]);
}

/** 전송 실패한 낙관적 메시지를 목록에서 뺀다. */
export function dropPending(current: TeamsMessage[], pendingId: string): TeamsMessage[] {
  return current.filter((m) => m.id !== pendingId);
}

/** 한 메시지의 리액션 집계만 갈아끼운다 (WS reaction_update). */
export function applyReactions(
  current: TeamsMessage[],
  messageId: string,
  reactions: TeamsReaction[],
): TeamsMessage[] {
  let changed = false;
  const next = current.map((m) => {
    if (m.id !== messageId) return m;
    changed = true;
    return { ...m, reactions: reactions.length > 0 ? reactions : undefined };
  });
  return changed ? next : current;
}

/**
 * 편집 반영 — **본문만** 갈아끼운다.
 *
 * 왜 통째로 교체하지 않는가: 편집의 두 경로 모두 온전한 메시지를 주지 않는다.
 *   · WS `message_updated` 프레임은 `{message_id, content, edited_at}` 뿐이다.
 *   · PATCH 응답은 원본 행이라 답장 스냅샷(reply_to_sender_name/content)이 없다
 *     — 그건 서버가 목록 조회 때만 조립해 준다.
 * 그래서 merge 로 덮으면 **답장 인용과 첨부가 사라진다** (한 번 겪었다: 답장을
 * 편집하면 무엇에 답한 건지가 화면에서 없어졌다).
 */
export function applyEdit(
  current: TeamsMessage[],
  messageId: string,
  content: string,
  editedAt?: string,
): TeamsMessage[] {
  let changed = false;
  const next = current.map((m) => {
    if (m.id !== messageId) return m;
    changed = true;
    return {
      ...m,
      // 빈 본문은 편집 결과가 아니라 프레임 누락이다 — 기존 본문을 지우지 않는다.
      content: content || m.content,
      isEdited: true,
      editedAt: editedAt || m.editedAt,
    };
  });
  return changed ? next : current;
}

/**
 * 방 목록 정렬 — 최근 대화가 위. `lastMessageAt` 이 없는 새 방은 생성 시각을 쓴다.
 */
export function sortRooms(rooms: TeamsRoom[]): TeamsRoom[] {
  return [...rooms].sort((a, b) => {
    const at = a.lastMessageAt || a.createdAt || '';
    const bt = b.lastMessageAt || b.createdAt || '';
    if (at === bt) return a.name.localeCompare(b.name);
    return at < bt ? 1 : -1;
  });
}

/** 검색어로 방 목록 거르기 — 이름과 설명 모두 대상. 대소문자 무시. */
export function filterRooms(rooms: TeamsRoom[], query: string): TeamsRoom[] {
  const q = query.trim().toLowerCase();
  if (!q) return rooms;
  return rooms.filter(
    (room) =>
      room.name.toLowerCase().includes(q) || (room.description ?? '').toLowerCase().includes(q),
  );
}

/**
 * 안 읽은 메시지 수.
 *
 * 서버가 `unread_count` 를 계산하지 않으므로(항상 0) 커넥터가 직접 센다. 기준은
 * "이 방을 마지막으로 본 시각" 이고, **내가 보낸 메시지와 시스템 안내는 세지
 * 않는다** — 내 발화가 배지를 올리면 배지가 무의미해진다.
 */
export function unreadCount(
  messages: TeamsMessage[],
  lastReadAt: string | undefined,
  myUserId: string,
): number {
  let count = 0;
  for (const m of messages) {
    if (m.senderType === 'system') continue;
    if (m.senderType === 'user' && m.senderId === myUserId) continue;
    if (lastReadAt && m.createdAt <= lastReadAt) continue;
    count += 1;
  }
  return count;
}

/** 방 목록 배지에 쓸 값 — 999 를 넘으면 잘라 표시한다. */
export function badgeText(count: number): string {
  if (count <= 0) return '';
  return count > 999 ? '999+' : String(count);
}

/**
 * 같은 사람이 연달아 말하면 아바타와 이름을 한 번만 그린다 (카카오톡/슬랙 규칙).
 * 3분을 넘겨 이어지면 다시 머리를 붙인다 — 시간이 벌어진 발화는 새 덩어리다.
 */
const GROUP_WINDOW_MS = 3 * 60 * 1000;

export function startsGroup(message: TeamsMessage, previous: TeamsMessage | undefined): boolean {
  if (!previous) return true;
  if (previous.senderType !== message.senderType) return true;
  if (previous.senderId !== message.senderId) return true;
  if (message.senderType === 'system') return true;
  const prevAt = Date.parse(previous.createdAt);
  const at = Date.parse(message.createdAt);
  if (!Number.isFinite(prevAt) || !Number.isFinite(at)) return true;
  return at - prevAt > GROUP_WINDOW_MS;
}

/** 채팅 시각 표기 — 오늘이면 시:분, 아니면 월/일 시:분. */
export function messageTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const date = new Date(t);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const time = date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return time;
  return `${date.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })} ${time}`;
}

/** 방 목록 미리보기 — 마지막 메시지 시각을 사람 말로. */
export function roomTime(iso: string | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}일 전`;
  return new Date(t).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

/** 파일 크기를 사람 말로. 0 바이트도 정상적인 파일이므로 숨기지 않는다. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** 첨부가 화면에 미리보기로 뜨는 그림인가 — 그 외에는 파일 카드로 그린다. */
export function isPreviewableImage(attachment: TeamsAttachment): boolean {
  return /^image\//.test(attachment.mime) && !/svg/.test(attachment.mime);
}

/**
 * 방 목록·알림에 쓸 한 줄 미리보기.
 *
 * 공유 메시지는 **출처 표식을 걷어낸 본문**을 보여 준다 — 표식을 그대로 두면
 * 목록이 온통 `🤖 …⟨xgen:…⟩` 으로 덮여 어떤 대화인지 알 수 없다.
 */
export function messagePreview(message: TeamsMessage | undefined): string {
  if (!message) return '';
  const body = shareBodyOf(message.content).trim();
  if (body) return body.split('\n')[0] ?? '';
  const first = message.attachments?.[0];
  if (first) return `📎 ${first.filename}`;
  return '';
}
