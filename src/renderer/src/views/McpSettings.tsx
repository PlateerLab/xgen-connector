/**
 * McpSettings — manage local MCP servers the connector hosts and bridges to your
 * XGEN agents. Enable the bridge, add stdio/http MCP servers, test them, and the
 * backend auto-injects their tools into your agents' next turns.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { xgen } from '../bridge';
import type { McpServerConfig } from '../../../main/config';
import type { McpBridgeStatusLike } from '../../../preload/index';
import {
  McpImportError,
  parseMcpConfig,
  toDisplayCommand,
  toMcpConfigJson,
  type ImportedServer,
} from './mcp-import';

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

const JSON_PLACEHOLDER = `{
  "mcpServers": {
    "mcp-atlassian": {
      "command": "uvx",
      "args": ["mcp-atlassian"],
      "env": { "JIRA_URL": "https://your-company.atlassian.net" }
    }
  }
}`;

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
    // 가져오기로 들어온 args 는 편집 폼에서 한 줄 명령으로 보여준다
    // (저장 시 이 문자열이 진실이 되고 args 는 버려진다 — 왕복 일관).
    command: toDisplayCommand(c.command ?? '', c.args ?? []),
    url: c.url ?? '',
    envText: kvToText(c.env, '='),
    headersText: kvToText(c.headers, ': '),
    enabled: c.enabled !== false,
  };
}
function configFromDraft(d: Draft): McpServerConfig {
  const c: McpServerConfig = { name: d.name.trim(), transport: d.transport, enabled: d.enabled };
  if (d.transport === 'stdio') {
    // 폼에서 명령을 직접 편집하면 그 문자열이 진실이 된다 — 가져오기로 들어온
    // args 배열은 버린다 (둘이 어긋나면 실행 인자가 예상과 달라진다).
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
  // 표준 MCP 설정 JSON 붙여넣기
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importMsg, setImportMsg] = useState<{ ok?: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

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

  /** 붙여넣은 표준 JSON 을 서버 목록에 병합 (같은 이름은 덮어쓰기). */
  const importJson = async () => {
    setImportMsg(null);
    let parsed;
    try {
      parsed = parseMcpConfig(importText);
    } catch (e) {
      setImportMsg({
        ok: false,
        text: e instanceof McpImportError ? e.message : `가져오기 실패: ${String(e)}`,
      });
      return;
    }
    const next = [...servers];
    const added: string[] = [];
    const replaced: string[] = [];
    for (const s of parsed.servers) {
      const cfg: McpServerConfig = {
        name: s.name,
        transport: s.transport,
        enabled: s.enabled !== false,
        ...(s.transport === 'stdio'
          ? { command: s.command, args: s.args, env: s.env }
          : { url: s.url, headers: s.headers }),
      };
      const at = next.findIndex((x) => x.name === s.name);
      if (at >= 0) {
        next[at] = cfg;
        replaced.push(s.name);
      } else {
        next.push(cfg);
        added.push(s.name);
      }
    }
    await persist(next);
    const parts = [
      added.length ? `추가 ${added.length}개 (${added.join(', ')})` : '',
      replaced.length ? `덮어씀 ${replaced.length}개 (${replaced.join(', ')})` : '',
      ...parsed.warnings,
    ].filter(Boolean);
    setImportMsg({ ok: true, text: parts.join(' · ') });
    setImportText('');
  };

  /** 현재 목록을 표준 JSON 으로 복사 (다른 도구에 붙여넣기). */
  const copyJson = async () => {
    const payload: ImportedServer[] = servers.map((s) => ({
      name: s.name,
      transport: s.transport,
      command: s.command,
      args: s.args,
      env: s.env,
      url: s.url,
      headers: s.headers,
      enabled: s.enabled,
    }));
    try {
      await navigator.clipboard.writeText(toMcpConfigJson(payload));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 클립보드 권한 없음 — 조용히 무시 */
    }
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
                  <div className="mcp-item-cmd">
                    {s.transport === 'stdio'
                      ? toDisplayCommand(s.command ?? '', s.args ?? [])
                      : s.url}
                  </div>
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
          <>
            <div className="row" style={{ marginTop: 8, gap: 6 }}>
              <button className="secondary" onClick={() => startEdit('new')}>
                + MCP 서버 추가
              </button>
              <button
                className="secondary"
                onClick={() => {
                  setImportOpen((v) => !v);
                  setImportMsg(null);
                }}
              >
                {importOpen ? 'JSON 붙여넣기 닫기' : 'JSON 붙여넣기'}
              </button>
              {servers.length > 0 && (
                <button className="secondary" onClick={() => void copyJson()} title="현재 설정을 표준 JSON 으로 복사">
                  {copied ? '복사됨' : 'JSON 복사'}
                </button>
              )}
            </div>

            {importOpen && (
              <div className="mcp-form">
                <label className="field">
                  <span>표준 MCP 설정 JSON</span>
                  <textarea
                    rows={10}
                    className="mcp-textarea mcp-json"
                    value={importText}
                    onChange={(e) => setImportText(e.target.value)}
                    spellCheck={false}
                    placeholder={JSON_PLACEHOLDER}
                  />
                </label>
                <div className="small muted" style={{ marginTop: -2 }}>
                  Claude Desktop·Cursor 등에서 쓰는 <code>mcpServers</code> 블록을 그대로 붙여넣으세요.
                  같은 이름은 덮어씁니다.
                </div>
                {importMsg && (
                  <div className={`small ${importMsg.ok ? 'notice-ok' : 'notice-warn'}`}>{importMsg.text}</div>
                )}
                <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
                  <button
                    className="link"
                    onClick={() => {
                      setImportOpen(false);
                      setImportText('');
                      setImportMsg(null);
                    }}
                  >
                    취소
                  </button>
                  <button className="primary" disabled={!importText.trim()} onClick={() => void importJson()}>
                    가져오기
                  </button>
                </div>
              </div>
            )}
          </>
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
