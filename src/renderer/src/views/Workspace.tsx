/**
 * Workspace — the main screen: a unified agent sidebar + the chat pane.
 *
 * The sidebar is ONE list of agents (no more separate 에이전트 / 대화 기록 tabs).
 *   · Click an agent with no history and no open session → a fresh chat opens.
 *   · Click an agent that has past conversations or a live session → drill into
 *     that agent's session chooser (새 대화 시작 · 진행 중인 대화 · 이전 대화 이어보기).
 * Open sessions are held in the SessionStore and listed in a "진행 중인 대화" strip
 * at the top, so switching agents never drops a conversation whose answer is
 * still streaming — its connector stays alive in the background.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { xgen } from '../bridge';
import { sessionStore, useSessions } from '../session';
import { agentSessions, isKeepable, openSessions, type SessionState } from '../session-store';
import type { Agent, Conversation, CurrentUser } from '../../../core/index';
import type { ConnectorConfig } from '../../../main/config';
import { Chat } from './Chat';
import { Settings } from './Settings';
import { AvatarSettings } from './AvatarSettings';
import { XgenWordmark, XgenMark } from '../brand/Logo';
import { SettingsIcon, RefreshIcon, LogoutIcon, PanelLeftIcon, ChatIcon, BotIcon, AvatarIcon, BackIcon, HistoryIcon, CloseIcon, PlusIcon } from '../brand/icons';

function relativeTime(iso: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
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

/** A short preview of a session's latest content for the open-sessions strip.
 *  Defensive: message text should always be a string (history is coerced at the
 *  transport), but a non-string here must degrade to a preview, never throw. */
function sessionPreview(s: SessionState): string {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const raw = s.messages[i].text;
    const t = (typeof raw === 'string' ? raw : raw == null ? '' : String(raw)).trim();
    if (t) return t.length > 42 ? `${t.slice(0, 42)}…` : t;
  }
  return '새 대화';
}

/** Reuse a loaded agent for richer header meta; otherwise synthesize from the conversation. */
function synthAgent(c: Conversation, agents: Agent[]): Agent {
  return (
    agents.find((a) => a.workflowId === c.workflowId) ?? {
      id: c.id,
      workflowId: c.workflowId,
      workflowName: c.workflowName,
      nodeCount: 0,
      isShared: false,
      isDeployed: false,
      isCompleted: true,
      workflowType: 'canvas',
      description: '',
      username: '',
      fullName: '',
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }
  );
}

export const Workspace: React.FC<{
  user: CurrentUser;
  config: ConnectorConfig;
  onLogout: () => void;
  onConfigChange: () => Promise<ConnectorConfig>;
}> = ({ user, config, onLogout, onConfigChange }) => {
  const [collapsed, setCollapsed] = useState(false);

  // agents list
  const [agents, setAgents] = useState<Agent[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');
  const [owner, setOwner] = useState<'all' | 'personal' | 'shared'>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // past conversations (for the per-agent chooser) — loaded once, refreshable
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [convLoading, setConvLoading] = useState(false);

  // sidebar drill-down: null = agent list (level 1), agent = its session chooser (level 2)
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);

  // durable session runtime (lives outside React)
  const { sessions, activeKey } = useSessions();
  const activeSession = activeKey ? sessions.find((s) => s.key === activeKey) ?? null : null;
  const open = useMemo(() => openSessions(sessions), [sessions]);

  const [showSettings, setShowSettings] = useState(false);
  // 메인 페인 전환: 채팅 ↔ 아바타 설정 (채팅 세션은 뒤에 유지)
  const [showAvatarSettings, setShowAvatarSettings] = useState(false);
  const [overlayOn, setOverlayOn] = useState(config.avatarOverlay ?? false);

  const toggleOverlay = useCallback(async () => {
    const next = !overlayOn;
    setOverlayOn(next);
    await xgen.overlay.setEnabled(next);
    void onConfigChange();
  }, [overlayOn, onConfigChange]);

  // Keep the toggle in sync if the overlay is closed from its own ✕ button.
  useEffect(() => xgen.config.onChange((c) => setOverlayOn(!!c.avatarOverlay)), []);

  // The tray / avatar overlay can ask to open the settings modal.
  useEffect(() => xgen.appctl.onOpenSettings(() => setShowSettings(true)), []);

  const load = useCallback(
    async (p: number) => {
      setLoading(true);
      setError(null);
      try {
        const res = await xgen.agents.list({
          page: p,
          pageSize: 24,
          search: search || undefined,
          owner: owner === 'all' ? undefined : owner,
        });
        setAgents(res.items);
        setTotalPages(res.pagination.totalPages);
        setPage(res.pagination.page);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [search, owner],
  );

  useEffect(() => {
    void load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, owner]);

  const loadConversations = useCallback(async () => {
    setConvLoading(true);
    try {
      setConversations(await xgen.history.conversations());
    } catch {
      /* 조용히 실패 — 이어보기 목록이 없을 뿐 새 대화는 가능하다 */
    } finally {
      setConvLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  // Landing: on first load, drop the user straight into a ready chat with the
  // last-used (or first) agent — but only if nothing is already open. Runs once.
  const landedRef = useRef(false);
  useEffect(() => {
    if (landedRef.current || loading || agents.length === 0) return;
    landedRef.current = true;
    if (activeKey || sessions.some(isKeepable)) return;
    const last = agents.find((a) => a.workflowId === config.lastWorkflowId);
    sessionStore.openNew(last ?? agents[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, loading]);

  const rememberAgent = useCallback((a: Agent) => {
    void xgen.config.set({ lastWorkflowId: a.workflowId });
  }, []);

  const clickAgent = useCallback(
    (a: Agent) => {
      rememberAgent(a);
      const live = agentSessions(sessions, a.workflowId);
      const past = conversations.filter((c) => c.workflowId === a.workflowId);
      if (live.length > 0 || past.length > 0) {
        setSelectedAgent(a); // drill into the chooser
      } else {
        sessionStore.openNew(a); // no history → straight to a new chat
      }
    },
    [sessions, conversations, rememberAgent],
  );

  const startNew = useCallback(
    (a: Agent) => {
      rememberAgent(a);
      sessionStore.openNew(a);
      setSelectedAgent(null);
    },
    [rememberAgent],
  );

  const resumeConversation = useCallback(
    (c: Conversation) => {
      const agent = synthAgent(c, agents);
      rememberAgent(agent);
      sessionStore.openResume(agent, c.interactionId, c.workflowName);
      setSelectedAgent(null);
    },
    [agents, rememberAgent],
  );

  const focusSession = useCallback((key: string) => {
    sessionStore.setActive(key);
    setSelectedAgent(null);
  }, []);

  const displayName = user.username || '사용자';
  const initial = displayName.trim().charAt(0) || 'U';

  // Level-2 chooser data for the selected agent.
  const selectedLive = selectedAgent ? agentSessions(sessions, selectedAgent.workflowId) : [];
  const selectedLiveIds = new Set(selectedLive.map((s) => s.interactionId));
  const selectedPast = selectedAgent
    ? conversations.filter(
        (c) => c.workflowId === selectedAgent.workflowId && !selectedLiveIds.has(c.interactionId),
      )
    : [];

  return (
    <div className={`workspace ${collapsed ? 'collapsed' : ''}`}>
      {!collapsed && (
        <aside className="sidebar">
          <div className="sidebar-head">
            <div className="brand-row">
              <XgenWordmark height={22} variant="color" title="XGEN" />
              <span className="brand-tag">Connector</span>
            </div>
            <div className="sidebar-head-actions">
              <button
                className={`icon-btn ${overlayOn ? 'active' : ''}`}
                title={overlayOn ? '아바타 오버레이 끄기' : '아바타 오버레이 켜기'}
                onClick={() => void toggleOverlay()}
              >
                <BotIcon size={18} />
              </button>
              <button
                className={`icon-btn ${showAvatarSettings ? 'active' : ''}`}
                title="아바타 설정"
                onClick={() => setShowAvatarSettings((v) => !v)}
              >
                <AvatarIcon size={18} />
              </button>
              <button className="icon-btn" title="설정" onClick={() => setShowSettings(true)}>
                <SettingsIcon size={18} />
              </button>
              <button className="icon-btn" title="사이드바 접기" onClick={() => setCollapsed(true)}>
                <PanelLeftIcon size={18} />
              </button>
            </div>
          </div>

          {selectedAgent ? (
            // ── Level 2: one agent's session chooser ──
            <>
              <div className="drill-head">
                <button className="icon-btn" title="목록으로" onClick={() => setSelectedAgent(null)}>
                  <BackIcon size={18} />
                </button>
                <div className="drill-title" title={selectedAgent.workflowName}>
                  {selectedAgent.workflowName}
                </div>
              </div>

              <div className="agent-list">
                <button className="new-chat-btn" onClick={() => startNew(selectedAgent)}>
                  <PlusIcon size={16} /> 새 대화 시작
                </button>

                {selectedLive.length > 0 && (
                  <>
                    <div className="list-label">진행 중인 대화</div>
                    {selectedLive.map((s) => (
                      <div
                        key={s.key}
                        className={`conv-item ${activeKey === s.key ? 'active' : ''}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => focusSession(s.key)}
                        onKeyDown={(e) => e.key === 'Enter' && focusSession(s.key)}
                      >
                        <span className="conv-icon">
                          <ChatIcon size={15} />
                        </span>
                        <span className="conv-body">
                          <div className="conv-name">
                            {s.streaming && <span className="live-dot" />}
                            {sessionPreview(s)}
                          </div>
                          <div className="conv-meta">{s.streaming ? '응답 중…' : '열려 있음'}</div>
                        </span>
                        <button
                          className="conv-end"
                          title="채팅 종료"
                          onClick={(e) => {
                            e.stopPropagation();
                            sessionStore.endChat(s.key);
                          }}
                        >
                          <CloseIcon size={13} />
                        </button>
                      </div>
                    ))}
                  </>
                )}

                {selectedPast.length > 0 && (
                  <>
                    <div className="list-label">이전 대화</div>
                    {selectedPast.map((c) => (
                      <button
                        key={c.interactionId}
                        className="conv-item"
                        onClick={() => resumeConversation(c)}
                      >
                        <span className="conv-icon">
                          <HistoryIcon size={15} />
                        </span>
                        <span className="conv-body">
                          <div className="conv-name">{c.workflowName || '대화'}</div>
                          <div className="conv-meta">
                            {relativeTime(c.updatedAt || c.createdAt)}
                            {c.interactionCount ? ` · ${c.interactionCount}개 대화` : ''}
                          </div>
                        </span>
                      </button>
                    ))}
                  </>
                )}

                {convLoading && selectedPast.length === 0 && selectedLive.length === 0 && (
                  <div className="muted small pad">불러오는 중…</div>
                )}
              </div>
            </>
          ) : (
            // ── Level 1: agent list (+ open-sessions strip) ──
            <>
              {open.length > 0 && (
                <div className="open-sessions">
                  <div className="list-label">진행 중인 대화</div>
                  {open.map((s) => (
                    <div
                      key={s.key}
                      className={`open-item ${activeKey === s.key ? 'active' : ''}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => focusSession(s.key)}
                      onKeyDown={(e) => e.key === 'Enter' && focusSession(s.key)}
                      title={sessionPreview(s)}
                    >
                      <span className={`open-dot ${s.streaming ? 'live' : ''}`} />
                      <span className="open-body">
                        <div className="open-name">{s.agent.workflowName}</div>
                        <div className="open-meta">{s.streaming ? '응답 중…' : sessionPreview(s)}</div>
                      </span>
                      <button
                        className="conv-end"
                        title="채팅 종료"
                        onClick={(e) => {
                          e.stopPropagation();
                          sessionStore.endChat(s.key);
                        }}
                      >
                        <CloseIcon size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="sidebar-search">
                <input
                  className="search"
                  placeholder="에이전트 검색…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="filter-row">
                {(['all', 'personal', 'shared'] as const).map((o) => (
                  <button
                    key={o}
                    className={`chip ${owner === o ? 'active' : ''}`}
                    onClick={() => setOwner(o)}
                  >
                    {o === 'all' ? '전체' : o === 'personal' ? '개인' : '공유'}
                  </button>
                ))}
                <button
                  className="chip ghost"
                  onClick={() => {
                    void load(page);
                    void loadConversations();
                  }}
                  title="새로고침"
                >
                  <RefreshIcon size={13} />
                </button>
              </div>

              <div className="agent-list">
                {loading && <div className="muted small pad">불러오는 중…</div>}
                {error && <div className="error small pad">{error}</div>}
                {!loading &&
                  agents.map((a) => {
                    const live = agentSessions(sessions, a.workflowId);
                    const isActive = activeSession?.agent.workflowId === a.workflowId;
                    return (
                      <button
                        key={a.workflowId}
                        className={`agent-item ${isActive ? 'active' : ''}`}
                        onClick={() => clickAgent(a)}
                      >
                        <span className="agent-body">
                          <div className="agent-name">{a.workflowName}</div>
                          <div className="agent-meta">
                            {a.isDeployed && <span className="dot" />}
                            {a.isShared ? '공유' : '개인'} · 노드 {a.nodeCount}개
                            {a.isDeployed ? ' · 배포됨' : ''}
                          </div>
                        </span>
                        {live.length > 0 && (
                          <span
                            className={`agent-live ${live.some((s) => s.streaming) ? 'streaming' : ''}`}
                            title={live.some((s) => s.streaming) ? '응답 중' : '열린 대화 있음'}
                          />
                        )}
                      </button>
                    );
                  })}
                {!loading && !error && agents.length === 0 && (
                  <div className="muted small pad">에이전트가 없습니다.</div>
                )}
              </div>

              {totalPages > 1 && (
                <div className="pager">
                  <button disabled={page <= 1} onClick={() => void load(page - 1)}>
                    ‹
                  </button>
                  <span className="small muted">
                    {page} / {totalPages}
                  </span>
                  <button disabled={page >= totalPages} onClick={() => void load(page + 1)}>
                    ›
                  </button>
                </div>
              )}
            </>
          )}

          <div className="sidebar-foot">
            <div className="account">
              <span className="avatar-badge">{initial}</span>
              <span className="small" style={{ fontWeight: 600 }}>
                {displayName}
              </span>
            </div>
            <button className="icon-btn" title="로그아웃" onClick={onLogout}>
              <LogoutIcon size={16} />
            </button>
          </div>
        </aside>
      )}

      <main className="main-pane">
        {showAvatarSettings ? (
          <AvatarSettings user={user} serverUrl={config.serverUrl} onBack={() => setShowAvatarSettings(false)} />
        ) : activeSession ? (
          <Chat
            key={activeSession.key}
            session={activeSession}
            collapsed={collapsed}
            mcpDebug={config.mcpDebug === true}
            onExpandSidebar={() => setCollapsed(false)}
          />
        ) : (
          <div className="welcome">
            <XgenMark height={48} variant="color" />
            <h1>
              반갑습니다, {displayName}님!
              <br />
              <span className="xgen-gradient-text">어떤 Agent와 대화를 시작할까요?</span>
            </h1>
            <p>왼쪽 목록에서 에이전트를 선택하면 바로 대화를 시작할 수 있습니다.</p>
          </div>
        )}
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
