/**
 * McpSettings — manage local MCP servers the connector hosts and bridges to your
 * XGEN agents. Enable the bridge, add stdio/http MCP servers, test them, and the
 * backend auto-injects their tools into your agents' next turns.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { xgen } from '../bridge';
import type { McpServerConfig } from '../../../main/config';
import type { McpBridgeStatusLike } from '../../../preload/index';

type Transport = 'stdio' | 'http';
type Draft = {
  name: string;
  transport: Transport;
  command: string;
  url: string;
  envText: string;
  headersText: string;
  enabled: boolean;
};

const EMPTY_DRAFT: Draft = {
  name: '',
  transport: 'stdio',
  command: '',
  url: '',
  envText: '',
  headersText: '',
  enabled: true,
};

function kvToText(obj?: Record<string, string>, sep = '='): string {
  if (!obj) return '';
  return Object.entries(obj)
    .map(([k, v]) => `${k}${sep}${v}`)
    .join('\n');
}
function textToKv(text: string, sep = '='): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf(sep);
    if (i <= 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

function draftFromConfig(c: McpServerConfig): Draft {
  return {
    name: c.name,
    transport: c.transport,
    command: c.command ?? '',
    url: c.url ?? '',
    envText: kvToText(c.env, '='),
    headersText: kvToText(c.headers, ': '),
    enabled: c.enabled !== false,
  };
}
function configFromDraft(d: Draft): McpServerConfig {
  const c: McpServerConfig = { name: d.name.trim(), transport: d.transport, enabled: d.enabled };
  if (d.transport === 'stdio') {
    c.command = d.command.trim();
    const env = textToKv(d.envText, '=');
    if (env) c.env = env;
  } else {
    c.url = d.url.trim();
    const headers = textToKv(d.headersText, ': ');
    if (headers) c.headers = headers;
  }
  return c;
}

export const McpSettings: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [enabled, setEnabled] = useState(false);
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [status, setStatus] = useState<McpBridgeStatusLike | null>(null);
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [test, setTest] = useState<{ busy?: boolean; ok?: boolean; msg?: string } | null>(null);

  useEffect(() => {
    xgen.mcp.getEnabled().then(setEnabled).catch(() => undefined);
    xgen.mcp.listServers().then(setServers).catch(() => undefined);
    xgen.mcp.status().then(setStatus).catch(() => undefined);
    return xgen.mcp.onStatus(setStatus);
  }, []);

  const toolCount = useMemo(
    () => (status?.servers ?? []).reduce((n, s) => n + (s.connected ? s.tools.length : 0), 0),
    [status],
  );

  const persist = async (next: McpServerConfig[]) => {
    setServers(next);
    await xgen.mcp.saveServers(next);
  };

  const startEdit = (i: number | 'new') => {
    setTest(null);
    if (i === 'new') setDraft(EMPTY_DRAFT);
    else setDraft(draftFromConfig(servers[i]));
    setEditing(i);
  };

  const saveDraft = async () => {
    const c = configFromDraft(draft);
    if (!c.name) return;
    const next = [...servers];
    if (editing === 'new') next.push(c);
    else if (typeof editing === 'number') next[editing] = c;
    await persist(next);
    setEditing(null);
  };

  const remove = async (i: number) => {
    const next = servers.filter((_, j) => j !== i);
    await persist(next);
  };

  const toggleServer = async (i: number) => {
    const next = servers.map((s, j) => (j === i ? { ...s, enabled: s.enabled === false } : s));
    await persist(next);
  };

  const runTest = async () => {
    setTest({ busy: true });
    const r = await xgen.mcp.testServer(configFromDraft(draft));
    if (r.ok) setTest({ ok: true, msg: `연결됨 · 도구 ${r.tools?.length ?? 0}개` + (r.tools?.length ? `: ${r.tools.map((t) => t.name).slice(0, 8).join(', ')}` : '') });
    else setTest({ ok: false, msg: r.error || '연결 실패' });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal mcp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>로컬 MCP</h2>
          <button className="link" onClick={onClose}>
            닫기
          </button>
        </div>

        <p className="small muted" style={{ margin: '0 0 8px' }}>
          내 PC에서 MCP 서버를 실행해, 선택된 세션의 에이전트가 그 도구를 사용하게 합니다.
          로그인 상태에서만 연결됩니다.
        </p>

        <div className="field-row">
          <span>
            로컬 MCP 사용
            {enabled && (
              <span className="small muted" style={{ marginLeft: 8 }}>
                {status?.connected ? `연결됨 · 도구 ${toolCount}개` : '연결 대기 중…'}
                {status?.error ? ` · ${status.error}` : ''}
              </span>
            )}
          </span>
          <label className="switch">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => {
                setEnabled(e.target.checked);
                void xgen.mcp.setEnabled(e.target.checked);
              }}
            />
            <span className="track" />
          </label>
        </div>

        <div className="mcp-list">
          {servers.length === 0 && <div className="muted small pad">등록된 MCP 서버가 없습니다.</div>}
          {servers.map((s, i) => {
            const st = status?.servers?.find((x) => x.name === s.name);
            return (
              <div key={s.name + i} className="mcp-item">
                <label className="switch small-switch" title={s.enabled === false ? '사용 안 함' : '사용'}>
                  <input type="checkbox" checked={s.enabled !== false} onChange={() => void toggleServer(i)} />
                  <span className="track" />
                </label>
                <div className="mcp-item-body">
                  <div className="mcp-item-name">
                    {s.name}
                    <span className="mcp-badge">{s.transport}</span>
                    {st && (
                      <span className={`mcp-dot ${st.connected ? 'ok' : 'off'}`} title={st.error || (st.connected ? '연결됨' : '연결 안 됨')} />
                    )}
                    {st?.connected && <span className="small muted">도구 {st.tools.length}</span>}
                  </div>
                  <div className="mcp-item-cmd">{s.transport === 'stdio' ? s.command : s.url}</div>
                </div>
                <div className="mcp-item-actions">
                  <button className="link" onClick={() => startEdit(i)}>
                    편집
                  </button>
                  <button className="link" onClick={() => void remove(i)}>
                    삭제
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {editing === null ? (
          <button className="secondary" style={{ marginTop: 8 }} onClick={() => startEdit('new')}>
            + MCP 서버 추가
          </button>
        ) : (
          <div className="mcp-form">
            <label className="field">
              <span>이름 (고유)</span>
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="filesystem" />
            </label>
            <div className="field-row">
              <span>전송 방식</span>
              <div className="seg">
                {(['stdio', 'http'] as const).map((t) => (
                  <button key={t} className={draft.transport === t ? 'active' : ''} onClick={() => setDraft({ ...draft, transport: t })}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
            {draft.transport === 'stdio' ? (
              <>
                <label className="field">
                  <span>실행 명령</span>
                  <input
                    value={draft.command}
                    onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                    placeholder="npx -y @modelcontextprotocol/server-filesystem /path"
                  />
                </label>
                <label className="field">
                  <span>환경변수 (KEY=VALUE, 한 줄에 하나)</span>
                  <textarea
                    className="mcp-textarea"
                    value={draft.envText}
                    onChange={(e) => setDraft({ ...draft, envText: e.target.value })}
                    placeholder={'API_TOKEN=xxxx'}
                    rows={2}
                  />
                </label>
              </>
            ) : (
              <>
                <label className="field">
                  <span>엔드포인트 URL (Streamable HTTP)</span>
                  <input value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="https://mcp.example.com/mcp" />
                </label>
                <label className="field">
                  <span>헤더 (Key: Value, 한 줄에 하나)</span>
                  <textarea
                    className="mcp-textarea"
                    value={draft.headersText}
                    onChange={(e) => setDraft({ ...draft, headersText: e.target.value })}
                    placeholder={'Authorization: Bearer xxxx'}
                    rows={2}
                  />
                </label>
              </>
            )}

            {test && (
              <div className={`small ${test.ok ? '' : test.busy ? 'muted' : 'error'}`} style={{ margin: '2px 0' }}>
                {test.busy ? '테스트 중…' : test.msg}
              </div>
            )}

            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 6 }}>
              <button className="link" onClick={() => setEditing(null)}>
                취소
              </button>
              <button className="secondary" onClick={() => void runTest()} disabled={test?.busy}>
                테스트
              </button>
              <button className="primary" onClick={() => void saveDraft()} disabled={!draft.name.trim()}>
                저장
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
