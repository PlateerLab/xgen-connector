/**
 * ShareToTeams — [Agent] 탭의 산출물을 [Teams] 방으로 내보내는 문.
 *
 *   ┌ Teams로 공유 ───────────────────────┐
 *   │ 대화 검색…                           │
 *   │ ● 3팀 개발방            2시간 전     │
 *   │ ● 홍길동 (1:1)                       │
 *   ├─ 미리보기 ───────────────────────────┤
 *   │ 🤖 사내문서QA · XGEN 에이전트 답변… │
 *   │ 원인은 커넥션 풀 고갈로…             │
 *   └──────────────── [취소] [공유]────────┘
 *
 * 보내기 전에 **방에 실제로 남을 모양**을 그대로 보여 준다. 공유는 되돌릴 수
 * 없는 행동이고(서버에 메시지 삭제 API 가 없다), 잘못 고른 방에 사내 문서가
 * 올라가는 것이 이 기능의 가장 큰 사고다.
 *
 * 방에 남는 첫 줄은 출처 표식이다 (`core/teams-bridge`). 커넥터는 그 줄을 숨기고
 * [원본 대화 보기] 카드로 그리지만, 웹 Teams 처럼 표식을 모르는 클라이언트에서도
 * "누가 어느 에이전트의 답변을 공유했는지" 가 문장으로 읽힌다.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  buildSharedMessage,
  type TeamsAttachment,
  type TeamsRoom,
  type TeamsShareRef,
} from '../../../core/index';
import { xgen } from '../bridge';
import { teamsStore, useTeams } from '../teams';
import { ChatIcon, TeamsIcon } from '../brand/icons';
import { filterRooms, formatBytes, roomTime } from './teams-store';

/** 워크스페이스(가상 드라이브) 파일을 함께 올릴 때. */
export interface ShareFile {
  /** 드라이브 상대 경로 (`/에이전트/…`). 실제 경로는 메인 프로세스만 안다. */
  drivePath: string;
  name: string;
  size: number;
}

export const ShareToTeamsModal: React.FC<{
  /** 방에 남길 본문. 이미 마크다운이면 그대로 간다 (Teams 도 에이전트 글은 마크다운으로 그린다). */
  body: string;
  /** 출처 — 이 표식이 있어야 나중에 원본 대화로 돌아갈 수 있다. */
  shareRef: TeamsShareRef;
  /** 보낸 사람 표시 이름 (낙관적 렌더용). */
  myName: string;
  /** 함께 올릴 파일. 있으면 방을 고른 **뒤에** 그 방으로 업로드한다. */
  file?: ShareFile;
  title?: string;
  onClose: () => void;
  /** 공유 성공 — 호출자가 그 방을 탭으로 열어 주면 흐름이 끊기지 않는다. */
  onShared?: (room: TeamsRoom) => void;
}> = ({ body, shareRef, myName, file, title = 'Teams로 공유', onClose, onShared }) => {
  const { rooms, loadingRooms } = useTeams();
  const [query, setQuery] = useState('');
  const [targetId, setTargetId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // 목록이 비어 있을 수 있다 — 공유 모달이 Teams 탭보다 먼저 열릴 수 있으므로
  // 여기서도 한 번 채운다 (이미 있으면 갱신만 된다).
  useEffect(() => {
    if (rooms.length === 0) void teamsStore.loadRooms();
  }, []);

  const visible = useMemo(() => filterRooms(rooms, query), [rooms, query]);
  const target = useMemo(() => rooms.find((r) => r.id === targetId) ?? null, [rooms, targetId]);
  const preview = useMemo(() => buildSharedMessage(shareRef, body), [shareRef, body]);

  const share = useCallback(async () => {
    if (!target || busy) return;
    setBusy(true);
    setError('');
    // 첨부는 **방마다 따로 저장된다** (서버 경로가 `rooms/{id}/attachments`).
    // 그래서 방을 고르기 전에는 올릴 수 없고, 고른 뒤 그 방으로 올린다.
    let attachments: TeamsAttachment[] | undefined;
    if (file) {
      try {
        attachments = [await xgen.teams.shareWorkspaceFile(target.id, file.drivePath)];
      } catch (e) {
        setBusy(false);
        setError(e instanceof Error ? e.message : '파일을 올리지 못했습니다.');
        return;
      }
    }
    const ok = await teamsStore.send(target.id, preview, myName, { attachments });
    setBusy(false);
    if (!ok) {
      setError('공유하지 못했습니다. 잠시 후 다시 시도해 주세요.');
      return;
    }
    onShared?.(target);
    onClose();
  }, [target, busy, preview, myName, file, onShared, onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal teams-share" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>

        <input
          className="input"
          autoFocus
          value={query}
          placeholder="대화 검색"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && onClose()}
        />

        <div className="teams-user-results tall">
          {loadingRooms && rooms.length === 0 && <div className="teams-empty sm">불러오는 중…</div>}
          {!loadingRooms && visible.length === 0 && (
            <div className="teams-empty sm">
              {rooms.length === 0
                ? '참여 중인 대화가 없습니다. Teams 에서 대화를 먼저 만들어 주세요.'
                : '일치하는 대화가 없습니다.'}
            </div>
          )}
          {visible.map((room) => (
            <button
              key={room.id}
              className={`agent-item ${targetId === room.id ? 'active' : ''}`}
              onClick={() => setTargetId(room.id)}
              title={room.description || room.name}
            >
              <span className="agent-mark">
                {room.isDirect ? <ChatIcon size={16} /> : <TeamsIcon size={16} />}
              </span>
              <span className="agent-body">
                <span className="agent-name">{room.name}</span>
                <span className="agent-meta">
                  {room.isDirect ? '1:1 대화' : '그룹 대화'}
                  {room.lastMessageAt ? ` · ${roomTime(room.lastMessageAt)}` : ''}
                </span>
              </span>
            </button>
          ))}
        </div>

        <div className="teams-share-preview">
          <span className="label">이 내용이 방에 올라갑니다</span>
          <pre>{preview}</pre>
          {file && (
            <span className="teams-share-file">
              📎 {file.name} · {formatBytes(file.size)}
            </span>
          )}
        </div>

        {error && <div className="teams-error inline">{error}</div>}

        <div className="modal-actions">
          <button className="secondary" onClick={onClose} disabled={busy}>
            취소
          </button>
          <button onClick={() => void share()} disabled={!target || busy}>
            {busy ? '공유 중…' : '공유'}
          </button>
        </div>
      </div>
    </div>
  );
};
