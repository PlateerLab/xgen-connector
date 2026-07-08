/**
 * Workspace — the main screen: agent list (sidebar) + chat (main pane).
 *
 * Lists the user's agents (paged, searchable) exactly like the XGEN "Agent 목록"
 * grid, and chats with the selected one. Includes a settings modal (server,
 * theme, auto-update) and logout.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { xgen } from '../bridge';
import type { Agent, CurrentUser } from '../../../core/index';
import type { ConnectorConfig } from '../../../main/config';
import { Chat } from './Chat';
import { Settings } from './Settings';
import { XgenWordmark, XgenMark } from '../brand/Logo';
import { SettingsIcon, RefreshIcon, LogoutIcon } from '../brand/icons';

export const Workspace: React.FC<{
  user: CurrentUser;
  config: ConnectorConfig;
  onLogout: () => void;
  onConfigChange: () => Promise<ConnectorConfig>;
}> = ({ user, config, onLogout, onConfigChange }) => {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selected, setSelected] = useState<Agent | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');
  const [owner, setOwner] = useState<'all' | 'personal' | 'shared'>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

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
        if (!selected && res.items.length) {
          const last = res.items.find((a) => a.workflowId === config.lastWorkflowId);
          setSelected(last ?? res.items[0]);
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

  const pick = useCallback((a: Agent) => {
    setSelected(a);
    void xgen.config.set({ lastWorkflowId: a.workflowId });
  }, []);

  const displayName = user.username || '사용자';
  const initial = displayName.trim().charAt(0) || 'U';

  return (
    <div className="workspace">
      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="brand-row">
            <XgenWordmark height={22} variant="color" title="XGEN" />
            <span className="brand-tag">Connector</span>
          </div>
          <button className="icon-btn" title="설정" onClick={() => setShowSettings(true)}>
            <SettingsIcon size={18} />
          </button>
        </div>

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
                className={`agent-item ${selected?.workflowId === a.workflowId ? 'active' : ''}`}
                onClick={() => pick(a)}
              >
                <span className="agent-mark">
                  <XgenMark height={17} variant={selected?.workflowId === a.workflowId ? 'color' : 'mono'} />
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

      <main className="main-pane">
        {selected ? (
          <Chat agent={selected} />
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
