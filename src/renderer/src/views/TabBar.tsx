/**
 * TabBar — 메인 영역 상단의 VS Code 식 탭 줄.
 *
 * 채팅 탭은 세션 스토어의 열린 세션과 1:1 이다 (삽입 순서 — tab-model 참고).
 * 스트리밍 중인 탭은 닫기 버튼 자리에 라이브 점이 앉고, 마우스를 올리면
 * 닫기로 바뀐다 (VS Code 의 dirty-dot 관용구). 아바타 설정은 세션이 아닌
 * 특수 탭 하나로 같은 줄에 선다.
 */
import React from 'react';
import type { SessionState } from '../session-store';
import { chatTabs, tabTitle } from './tab-model';
import { AvatarIcon, ChatIcon, CloseIcon, PlusIcon } from '../brand/icons';

export const TabBar: React.FC<{
  sessions: SessionState[];
  activeKey: string | null;
  /** 지금 메인 영역이 채팅인가 아바타 설정인가. */
  mainView: 'chat' | 'avatar';
  avatarOpen: boolean;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  onSelectAvatar: () => void;
  onCloseAvatar: () => void;
  onNewTab: () => void;
}> = ({
  sessions,
  activeKey,
  mainView,
  avatarOpen,
  onSelect,
  onClose,
  onSelectAvatar,
  onCloseAvatar,
  onNewTab,
}) => {
  const tabs = chatTabs(sessions, activeKey);
  if (tabs.length === 0 && !avatarOpen) return null;

  return (
    <div className="tab-strip">
      <div className="tab-strip-scroll">
        {tabs.map((s) => {
          const active = mainView === 'chat' && s.key === activeKey;
          return (
            <div
              key={s.key}
              className={`tab-item ${active ? 'active' : ''}`}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              onClick={() => onSelect(s.key)}
              onKeyDown={(e) => e.key === 'Enter' && onSelect(s.key)}
              onAuxClick={(e) => {
                // 휠 클릭으로 닫기 — 탭 UI 의 보편 규칙.
                if (e.button === 1) onClose(s.key);
              }}
              title={tabTitle(s)}
            >
              <span className="tab-icon">
                <ChatIcon size={13} />
              </span>
              <span className="tab-label">{tabTitle(s)}</span>
              <button
                className={`tab-close ${s.streaming ? 'live' : ''}`}
                title="채팅 종료"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(s.key);
                }}
              >
                <span className="tab-close-x">
                  <CloseIcon size={12} />
                </span>
                {s.streaming && <span className="tab-live-dot" />}
              </button>
            </div>
          );
        })}

        {avatarOpen && (
          <div
            className={`tab-item ${mainView === 'avatar' ? 'active' : ''}`}
            role="tab"
            aria-selected={mainView === 'avatar'}
            tabIndex={0}
            onClick={onSelectAvatar}
            onKeyDown={(e) => e.key === 'Enter' && onSelectAvatar()}
            title="아바타 설정"
          >
            <span className="tab-icon">
              <AvatarIcon size={13} />
            </span>
            <span className="tab-label">아바타 설정</span>
            <button
              className="tab-close"
              title="닫기"
              onClick={(e) => {
                e.stopPropagation();
                onCloseAvatar();
              }}
            >
              <span className="tab-close-x">
                <CloseIcon size={12} />
              </span>
            </button>
          </div>
        )}
      </div>
      <button className="tab-new" title="새 대화" onClick={onNewTab}>
        <PlusIcon size={15} />
      </button>
    </div>
  );
};
