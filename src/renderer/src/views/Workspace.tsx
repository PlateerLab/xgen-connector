/**
 * Workspace — 메인 화면의 셸. VS Code 식 3열 구조다:
 *
 *     [액티비티 바 48px] [사이드바(전환·리사이즈)] [탭 줄 + 콘텐츠]
 *
 * 액티비티 바가 사이드바 **뷰**(Agent / 탐색기)를 고르고, 활성 아이콘을 다시
 * 누르면 사이드바가 접힌다. 두 패널은 뷰 전환에도 **언마운트되지 않는다**
 * (display 로만 숨긴다) — 목록·트리·스크롤이 전환 사이에 살아 있고, 패널
 * 리마운트가 만드는 IPC 폭주도 없다.
 *
 * 메인 영역은 탭 방식이다. 채팅 탭은 세션 스토어의 열린 세션과 1:1 이고
 * (스토어가 곧 탭 모델 — session-store 참고), 아바타 설정은 특수 탭 하나다.
 * 크롬 상태(뷰·접힘·너비)는 config.ui 로 영속된다.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { xgen } from '../bridge';
import { sessionStore, useSessions } from '../session';
import type { CurrentUser } from '../../../core/index';
import type { ConnectorConfig } from '../../../main/config';
import { Chat } from './Chat';
import { Settings } from './Settings';
import { AvatarSettings } from './AvatarSettings';
import { ActivityBar, type SideView } from './ActivityBar';
import { AgentPanel } from './AgentPanel';
import { ExplorerPanel } from './ExplorerPanel';
import { TabBar } from './TabBar';
import { XgenMark } from '../brand/Logo';

const MIN_SIDEBAR = 200;
const MAX_SIDEBAR = 480;

const clampWidth = (w: number): number => Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, w));

export const Workspace: React.FC<{
  user: CurrentUser;
  config: ConnectorConfig;
  onLogout: () => void;
  onConfigChange: () => Promise<ConnectorConfig>;
}> = ({ user, config, onLogout, onConfigChange }) => {
  // ── 크롬 상태 (config.ui 로 영속) ──
  const [sideView, setSideView] = useState<SideView>(config.ui?.sideView ?? 'agent');
  const [collapsed, setCollapsed] = useState(config.ui?.sidebarCollapsed ?? false);
  const [sidebarWidth, setSidebarWidth] = useState(clampWidth(config.ui?.sidebarWidth ?? 300));

  const persistUi = useCallback((ui: NonNullable<ConnectorConfig['ui']>) => {
    void xgen.config.set({ ui });
  }, []);

  const pressView = useCallback(
    (v: SideView) => {
      // VS Code 규칙: 활성 뷰의 아이콘을 다시 누르면 접기, 그 외에는 그 뷰로 펼치기.
      const nextCollapsed = v === sideView && !collapsed;
      const nextView = v;
      setSideView(nextView);
      setCollapsed(nextCollapsed);
      persistUi({ sideView: nextView, sidebarCollapsed: nextCollapsed, sidebarWidth });
    },
    [sideView, collapsed, sidebarWidth, persistUi],
  );

  // ── 사이드바 리사이즈 — 드래그 중에는 DOM 에만 쓰고, 놓을 때 상태·설정에 적는다 ──
  const asideRef = useRef<HTMLElement | null>(null);
  const startResize = useCallback(
    (down: React.MouseEvent) => {
      down.preventDefault();
      const startX = down.clientX;
      const startW = sidebarWidth;
      let liveW = startW;
      const onMove = (e: MouseEvent) => {
        liveW = clampWidth(startW + (e.clientX - startX));
        if (asideRef.current) asideRef.current.style.width = `${liveW}px`;
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        setSidebarWidth(liveW);
        persistUi({ sideView, sidebarCollapsed: collapsed, sidebarWidth: liveW });
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [sidebarWidth, sideView, collapsed, persistUi],
  );

  // ── 세션(=채팅 탭) 런타임 ──
  const { sessions, activeKey } = useSessions();
  const activeSession = activeKey ? (sessions.find((s) => s.key === activeKey) ?? null) : null;

  // ── 메인 영역: 채팅 ↔ 아바타 설정 탭 ──
  const [mainView, setMainView] = useState<'chat' | 'avatar'>('chat');
  const [avatarOpen, setAvatarOpen] = useState(false);

  const [showSettings, setShowSettings] = useState(false);
  const [overlayOn, setOverlayOn] = useState(config.avatarOverlay ?? false);

  const toggleOverlay = useCallback(async () => {
    const next = !overlayOn;
    setOverlayOn(next);
    await xgen.overlay.setEnabled(next);
    void onConfigChange();
  }, [overlayOn, onConfigChange]);

  // 오버레이 창 자체의 ✕ 로 닫혀도 토글이 따라간다.
  useEffect(() => xgen.config.onChange((c) => setOverlayOn(!!c.avatarOverlay)), []);

  // 트레이/오버레이가 설정 모달을 열 수 있다.
  useEffect(() => xgen.appctl.onOpenSettings(() => setShowSettings(true)), []);

  const pressAvatar = useCallback(() => {
    if (mainView === 'avatar') {
      setAvatarOpen(false);
      setMainView('chat');
    } else {
      setAvatarOpen(true);
      setMainView('avatar');
    }
  }, [mainView]);

  const selectTab = useCallback((key: string) => {
    sessionStore.setActive(key);
    setMainView('chat');
  }, []);

  const closeTab = useCallback((key: string) => {
    sessionStore.endChat(key);
  }, []);

  const closeAvatarTab = useCallback(() => {
    setAvatarOpen(false);
    setMainView('chat');
  }, []);

  /** 새 탭(+) — 지금 보고 있는(없으면 마지막) 세션의 에이전트로 새 대화. */
  const newTab = useCallback(() => {
    const src = activeSession ?? sessions[sessions.length - 1] ?? null;
    if (src) {
      sessionStore.openNew(src.agent);
      setMainView('chat');
    } else {
      // 아직 아무 세션도 없다 — 에이전트 목록으로 안내한다.
      setSideView('agent');
      setCollapsed(false);
      persistUi({ sideView: 'agent', sidebarCollapsed: false, sidebarWidth });
    }
  }, [activeSession, sessions, sidebarWidth, persistUi]);

  const displayName = user.username || '사용자';
  const showAvatarPane = mainView === 'avatar' && avatarOpen;

  return (
    <div className="workspace">
      <ActivityBar
        view={sideView}
        collapsed={collapsed}
        onPressView={pressView}
        overlayOn={overlayOn}
        onToggleOverlay={() => void toggleOverlay()}
        avatarActive={showAvatarPane}
        onOpenAvatar={pressAvatar}
        onOpenSettings={() => setShowSettings(true)}
        userName={displayName}
        onLogout={onLogout}
      />

      <aside
        ref={asideRef}
        className={`sidebar ${collapsed ? 'hidden' : ''}`}
        style={{ width: sidebarWidth }}
      >
        <div className="panel-host" style={{ display: sideView === 'agent' ? undefined : 'none' }}>
          <AgentPanel config={config} />
        </div>
        <div
          className="panel-host"
          style={{ display: sideView === 'explorer' ? undefined : 'none' }}
        >
          <ExplorerPanel onOpenSettings={() => setShowSettings(true)} />
        </div>
        <div className="sidebar-resize" onMouseDown={startResize} />
      </aside>

      <main className="main-pane">
        <TabBar
          sessions={sessions}
          activeKey={activeKey}
          mainView={showAvatarPane ? 'avatar' : 'chat'}
          avatarOpen={avatarOpen}
          onSelect={selectTab}
          onClose={closeTab}
          onSelectAvatar={() => setMainView('avatar')}
          onCloseAvatar={closeAvatarTab}
          onNewTab={newTab}
        />

        {/* 아바타 설정 탭은 숨김 전환 — 언마운트하면 스토어·업로드 진행이 초기화된다. */}
        {avatarOpen && (
          <div className="pane-fill" style={{ display: showAvatarPane ? undefined : 'none' }}>
            <AvatarSettings user={user} serverUrl={config.serverUrl} onBack={closeAvatarTab} />
          </div>
        )}
        {!showAvatarPane &&
          (activeSession ? (
            <Chat
              key={activeSession.key}
              session={activeSession}
              mcpDebug={config.mcpDebug === true}
            />
          ) : (
            <div className="welcome">
              <XgenMark height={48} variant="color" />
              <h1>
                반갑습니다, {displayName}님!
                <br />
                <span className="xgen-gradient-text">어떤 Agent와 대화를 시작할까요?</span>
              </h1>
              <p>왼쪽 Agent 목록에서 에이전트를 선택하면 바로 대화를 시작할 수 있습니다.</p>
            </div>
          ))}
      </main>

      {showSettings && (
        <Settings
          config={config}
          onClose={() => setShowSettings(false)}
          onChanged={onConfigChange}
        />
      )}
    </div>
  );
};
