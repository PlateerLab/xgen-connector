/**
 * Workspace — the main screen: sidebar (agents / conversation history) + chat.
 *
 * The sidebar has two tabs:
 *   - 에이전트: the user's agents (paged, searchable), like the XGEN "Agent 목록".
 *   - 대화 기록: past conversations (interaction list) — click to reopen and
 *     continue that conversation.
 * The sidebar can be collapsed. Includes a settings modal and logout.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { xgen } from '../bridge';
import type { Agent, Conversation, CurrentUser } from '../../../core/index';
import type { ConnectorConfig } from '../../../main/config';
import { Chat, type ChatSession } from './Chat';
import { Settings } from './Settings';
import { XgenWordmark, XgenMark } from '../brand/Logo';
import { SettingsIcon, RefreshIcon, LogoutIcon, PanelLeftIcon, ChatIcon, BotIcon } from '../brand/icons';

type Tab = 'agents' | 'history';

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

export const Workspace: React.FC<{
  user: CurrentUser;
  config: ConnectorConfig;
  onLogout: () => void;
  onConfigChange: () => Promise<ConnectorConfig>;
}> = ({ user, config, onLogout, onConfigChange }) => {
  const [tab, setTab] = useState<Tab>('agents');
  const [collapsed, setCollapsed] = useState(false);

  // agents tab
  const [agents, setAgents] = useState<Agent[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');
  const [owner, setOwner] = useState<'all' | 'personal' | 'shared'>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // history tab
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [convLoading, setConvLoading] = useState(false);
  const [convError, setConvError] = useState<string | null>(null);

  // the open chat session
  const [session, setSession] = useState<ChatSession | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [overlayOn, setOverlayOn] = useState(config.avatarOverlay ?? false);

  const toggleOverlay = useCallback(async () => {
    const next = !overlayOn;
    setOverlayOn(next);
    await xgen.overlay.setEnabled(next);
    void onConfigChange();
  }, [overlayOn, onConfigChange]);

  // Keep the toggle in sync if the overlay is closed from its own ✕ button.
  useEffect(() => xgen.config.onChange((c) => setOverlayOn(!!c.avatarOverlay)), []);

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
        if (!session && res.items.length) {
          const last = res.items.find((a) => a.workflowId === config.lastWorkflowId);
          const a = last ?? res.items[0];
          setSession({ agent: a });
        }
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
    setConvError(null);
    try {
      setConversations(await xgen.history.conversations());
    } catch (e) {
      setConvError(e instanceof Error ? e.message : String(e));
    } finally {
      setConvLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'history') void loadConversations();
  }, [tab, loadConversations]);

  const pickAgent = useCallback((a: Agent) => {
    setSession({ agent: a });
    void xgen.config.set({ lastWorkflowId: a.workflowId });
  }, []);

  const openConversation = useCallback(
    (c: Conversation) => {
      // Reuse a matching loaded agent for richer header meta; otherwise synthesize.
      const match = agents.find((a) => a.workflowId === c.workflowId);
      const agent: Agent =
        match ?? {
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
        };
      setSession({ agent, interactionId: c.interactionId, resume: true });
    },
    [agents],
  );

  const displayName = user.username || '사용자';
  const initial = displayName.trim().charAt(0) || 'U';
  const activeConvId = session?.resume ? session.interactionId : undefined;

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
              <button className="icon-btn" title="설정" onClick={() => setShowSettings(true)}>
                <SettingsIcon size={18} />
              </button>
              <button className="icon-btn" title="사이드바 접기" onClick={() => setCollapsed(true)}>
                <PanelLeftIcon size={18} />
              </button>
            </div>
          </div>

          <div className="side-tabs">
            <button
              className={`side-tab ${tab === 'agents' ? 'active' : ''}`}
              onClick={() => setTab('agents')}
            >
              에이전트
            </button>
            <button
              className={`side-tab ${tab === 'history' ? 'active' : ''}`}
              onClick={() => setTab('history')}
            >
              대화 기록
            </button>
          </div>

          {tab === 'agents' ? (
            <>
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
                <button className="chip ghost" onClick={() => void load(page)} title="새로고침">
                  <RefreshIcon size={13} />
                </button>
              </div>

              <div className="agent-list">
                {loading && <div className="muted small pad">불러오는 중…</div>}
                {error && <div className="error small pad">{error}</div>}
                {!loading &&
                  agents.map((a) => (
                    <button
                      key={a.workflowId}
                      className={`agent-item ${
                        session && !session.resume && session.agent.workflowId === a.workflowId
                          ? 'active'
                          : ''
                      }`}
                      onClick={() => pickAgent(a)}
                    >
                      <span className="agent-mark">
                        <XgenMark height={17} variant="color" />
                      </span>
                      <span className="agent-body">
                        <div className="agent-name">{a.workflowName}</div>
                        <div className="agent-meta">
                          {a.isDeployed && <span className="dot" />}
                          {a.isShared ? '공유' : '개인'} · 노드 {a.nodeCount}개
                          {a.isDeployed ? ' · 배포됨' : ''}
                        </div>
                      </span>
                    </button>
                  ))}
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
          ) : (
            <div className="agent-list">
              {convLoading && <div className="muted small pad">불러오는 중…</div>}
              {convError && <div className="error small pad">{convError}</div>}
              {!convLoading &&
                conversations.map((c) => (
                  <button
                    key={c.interactionId}
                    className={`conv-item ${activeConvId === c.interactionId ? 'active' : ''}`}
                    onClick={() => openConversation(c)}
                  >
                    <span className="conv-icon">
                      <ChatIcon size={15} />
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
              {!convLoading && !convError && conversations.length === 0 && (
                <div className="muted small pad">저장된 대화가 없습니다.</div>
              )}
            </div>
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
        {session ? (
          <Chat
            session={session}
            collapsed={collapsed}
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
