import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { xgen } from '../bridge';
import { sessionStore, useSessions } from '../session';
import { useBrowserState } from '../browser-state';
import type { CurrentUser } from '../../../core/index';
import type { ConnectorConfig } from '../../../main/config';
import { Chat } from './Chat';
import { Settings } from './Settings';
import { AvatarSettings } from './AvatarSettings';
import { ActivityBar, type SideView } from './ActivityBar';
import { AgentPanel } from './AgentPanel';
import { ExplorerPanel } from './ExplorerPanel';
import { TabBar } from './TabBar';
import { BrowserPane, type BrowserSurfaceRect } from './BrowserPane';
import { BrowserSurface } from './BrowserSurface';
import { XgenMark } from '../brand/Logo';
import { chatTabs } from './tab-model';
import {
  addWorkspaceTab,
  dropWorkspaceTab,
  findTab,
  newWorkspaceLayout,
  normalizeWorkspaceLayout,
  removeWorkspaceTab,
  selectWorkspaceTab,
  setWorkspaceRatio,
  type DropEdge,
  type WorkspaceGroup,
  type WorkspaceLayout,
  type WorkspaceTab,
} from './workspace-layout';

const MIN_SIDEBAR = 200;
const MAX_SIDEBAR = 480;
const DRAG_THRESHOLD = 5;

const clampWidth = (width: number): number => Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, width));

interface DragPreview {
  tabId: string;
  targetGroupId: string;
  edge: DropEdge;
  index?: number;
  x: number;
  y: number;
  label: string;
}

function chatTab(session: ReturnType<typeof chatTabs>[number]): WorkspaceTab {
  return {
    id: `chat:${session.key}`,
    kind: 'chat',
    sessionKey: session.key,
    workflowId: session.agent.workflowId,
    workflowName: session.agent.workflowName,
  };
}

function layoutWithLiveSessions(
  current: WorkspaceLayout,
  sessions: ReturnType<typeof chatTabs>,
  activeKey: string | null,
): WorkspaceLayout {
  const liveIds = new Set(sessions.map((session) => `chat:${session.key}`));
  let next = current;
  for (const group of current.groups) {
    for (const tab of group.tabs) {
      if (tab.kind === 'chat' && !liveIds.has(tab.id)) next = removeWorkspaceTab(next, tab.id);
    }
  }
  for (const session of sessions) {
    const tab = chatTab(session);
    if (!findTab(next, tab.id)) next = addWorkspaceTab(next, next.focusedGroupId, tab);
  }
  if (activeKey) {
    const found = findTab(next, `chat:${activeKey}`);
    if (found) next = selectWorkspaceTab(next, found.group.id, found.tab.id);
  }
  return next;
}

export const Workspace: React.FC<{
  user: CurrentUser;
  config: ConnectorConfig;
  onLogout: () => void;
  onConfigChange: () => Promise<ConnectorConfig>;
}> = ({ user, config, onLogout, onConfigChange }) => {
  const [sideView, setSideView] = useState<SideView>(config.ui?.sideView ?? 'agent');
  const [collapsed, setCollapsed] = useState(config.ui?.sidebarCollapsed ?? false);
  const [sidebarWidth, setSidebarWidth] = useState(clampWidth(config.ui?.sidebarWidth ?? 300));
  const [layout, setLayout] = useState<WorkspaceLayout>(() =>
    normalizeWorkspaceLayout(config.ui?.workspaceLayout ?? newWorkspaceLayout()),
  );
  const [showSettings, setShowSettings] = useState(false);
  const [overlayOn, setOverlayOn] = useState(config.avatarOverlay ?? false);
  const [notice, setNotice] = useState('');
  const [drag, setDrag] = useState<DragPreview | null>(null);
  const [resizingSplit, setResizingSplit] = useState(false);
  const [surfaceRects, setSurfaceRects] = useState<Record<string, BrowserSurfaceRect>>({});
  const layoutRef = useRef(layout);
  const layoutHostRef = useRef<HTMLDivElement | null>(null);
  const asideRef = useRef<HTMLElement | null>(null);
  const suppressClickRef = useRef(false);

  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  // Persist chrome and layout together because config.set shallow-replaces ui.
  useEffect(() => {
    const timer = setTimeout(() => {
      void xgen.config.set({
        ui: {
          sideView,
          sidebarCollapsed: collapsed,
          sidebarWidth,
          workspaceLayout: layout,
        },
      });
    }, 120);
    return () => clearTimeout(timer);
  }, [sideView, collapsed, sidebarWidth, layout]);

  const pressView = useCallback(
    (view: SideView) => {
      setCollapsed(view === sideView && !collapsed);
      setSideView(view);
    },
    [sideView, collapsed],
  );

  const startSidebarResize = useCallback(
    (down: React.MouseEvent) => {
      down.preventDefault();
      const startX = down.clientX;
      const startWidth = sidebarWidth;
      let liveWidth = startWidth;
      const move = (event: MouseEvent) => {
        liveWidth = clampWidth(startWidth + event.clientX - startX);
        if (asideRef.current) asideRef.current.style.width = `${liveWidth}px`;
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        setSidebarWidth(liveWidth);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    },
    [sidebarWidth],
  );

  const { sessions, activeKey } = useSessions();
  const visibleSessions = useMemo(() => chatTabs(sessions, activeKey), [sessions, activeKey]);
  const sessionMap = useMemo(
    () => new Map(sessions.map((session) => [session.key, session])),
    [sessions],
  );
  const browserState = useBrowserState();

  useEffect(() => {
    setLayout((current) => layoutWithLiveSessions(current, visibleSessions, activeKey));
  }, [visibleSessions, activeKey]);

  // An agent may explicitly create a shared page through BrowserTabs. Surface
  // it in the workspace exactly once, using the currently focused group.
  useEffect(() => {
    if (!browserState.enabled) return;
    const workflows = new Map<string, string>();
    for (const page of browserState.pages) {
      if (page.mode === 'shared') workflows.set(page.workflowId, page.workflowName);
    }
    if (!workflows.size) return;
    setLayout((current) => {
      let next = current;
      for (const [workflowId, workflowName] of workflows) {
        const id = `browser:${workflowId}`;
        if (!findTab(next, id)) {
          next = addWorkspaceTab(next, next.focusedGroupId, {
            id,
            kind: 'browser',
            workflowId,
            workflowName,
          });
        }
      }
      return next;
    });
  }, [browserState.enabled, browserState.pages]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  const toggleOverlay = useCallback(async () => {
    const next = !overlayOn;
    setOverlayOn(next);
    await xgen.overlay.setEnabled(next);
    void onConfigChange();
  }, [overlayOn, onConfigChange]);

  useEffect(() => xgen.config.onChange((next) => setOverlayOn(!!next.avatarOverlay)), []);
  useEffect(() => xgen.appctl.onOpenSettings(() => setShowSettings(true)), []);

  const pressAvatar = useCallback(() => {
    setLayout((current) => {
      const existing = findTab(current, 'avatar');
      if (
        existing &&
        current.focusedGroupId === existing.group.id &&
        existing.group.activeTabId === 'avatar'
      ) {
        return removeWorkspaceTab(current, 'avatar');
      }
      if (existing) return selectWorkspaceTab(current, existing.group.id, 'avatar');
      return addWorkspaceTab(current, current.focusedGroupId, { id: 'avatar', kind: 'avatar' });
    });
  }, []);

  const selectTab = useCallback((groupId: string, tabId: string) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setLayout((current) => selectWorkspaceTab(current, groupId, tabId));
    const selected = findTab(layoutRef.current, tabId)?.tab;
    if (selected?.kind === 'chat' && selected.sessionKey)
      sessionStore.setActive(selected.sessionKey);
  }, []);

  const closeTab = useCallback((tab: WorkspaceTab) => {
    setLayout((current) => removeWorkspaceTab(current, tab.id));
    if (tab.kind === 'chat' && tab.sessionKey) sessionStore.endChat(tab.sessionKey);
    if (tab.kind === 'browser' && tab.workflowId) void xgen.browser.closeWorkflow(tab.workflowId);
  }, []);

  const activeWorkflowFor = useCallback((group: WorkspaceGroup) => {
    const active = group.tabs.find((tab) => tab.id === group.activeTabId);
    if (active?.workflowId)
      return { id: active.workflowId, name: active.workflowName || active.workflowId };
    const recentChat = [...group.tabs]
      .reverse()
      .find((tab) => tab.kind === 'chat' && tab.workflowId);
    if (recentChat?.workflowId) {
      return { id: recentChat.workflowId, name: recentChat.workflowName || recentChat.workflowId };
    }
    return null;
  }, []);

  const openBrowser = useCallback(
    (group: WorkspaceGroup) => {
      const workflow = activeWorkflowFor(group);
      if (!workflow) {
        setSideView('agent');
        setCollapsed(false);
        setNotice('브라우저를 열 Agent를 먼저 선택해 주세요.');
        return;
      }
      if (!browserState.enabled) {
        setNotice('설정 > 로컬 도구에서 브라우저 접근을 먼저 켜 주세요.');
        setShowSettings(true);
        return;
      }
      const tabId = `browser:${workflow.id}`;
      setLayout((current) => {
        const existing = findTab(current, tabId);
        if (existing) return selectWorkspaceTab(current, existing.group.id, tabId);
        return addWorkspaceTab(current, group.id, {
          id: tabId,
          kind: 'browser',
          workflowId: workflow.id,
          workflowName: workflow.name,
        });
      });
      void xgen.browser.ensureShared(workflow.id, workflow.name);
    },
    [activeWorkflowFor, browserState.enabled],
  );

  const onTabPointerDown = useCallback((down: React.PointerEvent, tab: WorkspaceTab) => {
    if (down.button !== 0) return;
    const source = findTab(layoutRef.current, tab.id);
    if (!source) return;
    const startX = down.clientX;
    const startY = down.clientY;
    let started = false;
    let preview: DragPreview | null = null;
    const move = (event: PointerEvent) => {
      if (!started && Math.hypot(event.clientX - startX, event.clientY - startY) < DRAG_THRESHOLD)
        return;
      started = true;
      document.body.classList.add('workspace-tab-dragging');
      const groups = [...document.querySelectorAll<HTMLElement>('[data-workspace-group]')];
      const target = groups.find((element) => {
        const rect = element.getBoundingClientRect();
        return (
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom
        );
      });
      if (!target) {
        preview = null;
        setDrag(null);
        return;
      }
      const targetGroupId = target.dataset.workspaceGroup || source.group.id;
      const rect = target.getBoundingClientRect();
      const x = (event.clientX - rect.left) / Math.max(1, rect.width);
      const y = (event.clientY - rect.top) / Math.max(1, rect.height);
      let edge: DropEdge = 'center';
      if (layoutRef.current.groups.length < 2) {
        if (x < 0.2) edge = 'left';
        else if (x > 0.8) edge = 'right';
        else if (y < 0.2) edge = 'top';
        else if (y > 0.8) edge = 'bottom';
      }
      const under = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>('[data-tab-id]');
      const targetGroup = layoutRef.current.groups.find((group) => group.id === targetGroupId);
      const index =
        edge === 'center' && under && targetGroup
          ? Math.max(
              0,
              targetGroup.tabs.findIndex((item) => item.id === under.dataset.tabId),
            )
          : undefined;
      const names: Record<DropEdge, string> = {
        center: '그룹으로 이동',
        left: '왼쪽에 배치',
        right: '오른쪽에 배치',
        top: '위에 배치',
        bottom: '아래에 배치',
      };
      preview = {
        tabId: tab.id,
        targetGroupId,
        edge,
        index,
        x: event.clientX,
        y: event.clientY,
        label: names[edge],
      };
      setDrag(preview);
    };
    const up = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      document.body.classList.remove('workspace-tab-dragging');
        if (started && preview) {
          suppressClickRef.current = true;
          setTimeout(() => {
            suppressClickRef.current = false;
          }, 0);
        setLayout((current) =>
          dropWorkspaceTab(
            current,
            preview!.tabId,
            preview!.targetGroupId,
            preview!.edge,
            preview!.index,
          ),
        );
      }
      setDrag(null);
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  }, []);

  const startSplitResize = useCallback((down: React.PointerEvent) => {
    down.preventDefault();
    const host = layoutHostRef.current;
    if (!host) return;
    setResizingSplit(true);
    const move = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect();
      const ratio =
        layoutRef.current.direction === 'horizontal'
          ? (event.clientX - rect.left) / Math.max(1, rect.width)
          : (event.clientY - rect.top) / Math.max(1, rect.height);
      setLayout((current) => setWorkspaceRatio(current, ratio));
    };
    const up = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      setResizingSplit(false);
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
  }, []);

  const reportSurface = useCallback((pageId: string, rect: BrowserSurfaceRect | null) => {
    setSurfaceRects((current) => {
      if (!rect) {
        if (!(pageId in current)) return current;
        const next = { ...current };
        delete next[pageId];
        return next;
      }
      const old = current[pageId];
      if (
        old &&
        old.left === rect.left &&
        old.top === rect.top &&
        old.width === rect.width &&
        old.height === rect.height
      ) {
        return current;
      }
      return { ...current, [pageId]: rect };
    });
  }, []);

  const focusBrowserPage = useCallback(
    (pageId: string) => {
      const page = browserState.pages.find((item) => item.pageId === pageId);
      if (!page) return;
      const found = findTab(layoutRef.current, `browser:${page.workflowId}`);
      if (found) setLayout((current) => selectWorkspaceTab(current, found.group.id, found.tab.id));
    },
    [browserState.pages],
  );

  const displayName = user.username || '사용자';
  const avatarActive = layout.groups.some(
    (group) => group.id === layout.focusedGroupId && group.activeTabId === 'avatar',
  );

  const renderGroupContent = (group: WorkspaceGroup) => {
    const active = group.tabs.find((tab) => tab.id === group.activeTabId) ?? null;
    if (active?.kind === 'chat' && active.sessionKey) {
      const chat = sessionMap.get(active.sessionKey);
      if (chat) return <Chat key={chat.key} session={chat} mcpDebug={config.mcpDebug === true} />;
    }
    if (active?.kind === 'browser' && active.workflowId) {
      return (
        <BrowserPane
          workflowId={active.workflowId}
          workflowName={active.workflowName || active.workflowId}
          onSurface={reportSurface}
        />
      );
    }
    if (active?.kind === 'avatar') {
      return (
        <div className="pane-fill">
          <AvatarSettings
            user={user}
            serverUrl={config.serverUrl}
            onBack={() => closeTab(active)}
          />
        </div>
      );
    }
    return (
      <div className="welcome">
        <XgenMark height={48} variant="color" />
        <h1>
          반갑습니다, {displayName}님!
          <br />
          <span className="xgen-gradient-text">어떤 Agent와 대화를 시작할까요?</span>
        </h1>
        <p>왼쪽 Agent 목록에서 에이전트를 선택하면 바로 대화를 시작할 수 있습니다.</p>
      </div>
    );
  };

  return (
    <div className="workspace">
      <ActivityBar
        view={sideView}
        collapsed={collapsed}
        onPressView={pressView}
        overlayOn={overlayOn}
        onToggleOverlay={() => void toggleOverlay()}
        avatarActive={avatarActive}
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
        <div className="sidebar-resize" onMouseDown={startSidebarResize} />
      </aside>

      <main className="main-pane">
        <div
          ref={layoutHostRef}
          className={`workspace-layout split-${layout.direction}`}
          data-group-count={layout.groups.length}
        >
          {layout.groups.map((group, index) => (
            <React.Fragment key={group.id}>
              {index === 1 && (
                <div
                  className={`workspace-divider ${layout.direction}`}
                  role="separator"
                  aria-orientation={layout.direction === 'horizontal' ? 'vertical' : 'horizontal'}
                  onPointerDown={startSplitResize}
                />
              )}
              <section
                className={`workspace-group ${layout.focusedGroupId === group.id ? 'focused' : ''}`}
                data-workspace-group={group.id}
                style={
                  layout.groups.length === 2
                    ? {
                        flexBasis: `${(index === 0 ? layout.ratio : 1 - layout.ratio) * 100}%`,
                        flexGrow: 0,
                      }
                    : undefined
                }
                onPointerDown={() => {
                  if (layoutRef.current.focusedGroupId !== group.id) {
                    setLayout((current) => ({ ...current, focusedGroupId: group.id }));
                  }
                }}
              >
                <TabBar
                  group={group}
                  sessions={sessionMap}
                  onSelect={(tabId) => selectTab(group.id, tabId)}
                  onClose={closeTab}
                  onOpenBrowser={() => openBrowser(group)}
                  onTabPointerDown={onTabPointerDown}
                />
                <div className="workspace-group-content">{renderGroupContent(group)}</div>
                {drag?.targetGroupId === group.id && (
                  <div className={`workspace-drop-preview edge-${drag.edge}`}>
                    <span>{drag.label}</span>
                  </div>
                )}
              </section>
            </React.Fragment>
          ))}
        </div>
      </main>

      {notice && (
        <div className="workspace-notice" role="status">
          {notice}
        </div>
      )}
      {drag && (
        <div className="workspace-drag-ghost" style={{ left: drag.x + 12, top: drag.y + 12 }}>
          {drag.label}
        </div>
      )}
      <BrowserSurface
        pages={browserState.pages}
        rects={surfaceRects}
        dragging={!!drag || resizingSplit}
        onFocusPage={focusBrowserPage}
      />

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
