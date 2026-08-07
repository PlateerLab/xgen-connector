/**
 * XGEN 워크스페이스 — 커넥터가 소유하는 가상 드라이브 하나.
 *
 * 예전에는 "에이전트 ↔ 사용자가 고른 임의 폴더"를 하나씩 페어링했다. 폴더가
 * 흩어지니 진실도 흩어졌고, 무엇이 원본인지가 페어마다 달랐다. 지금은 구글
 * 드라이브와 같은 모양이다: **루트 하나**에 **에이전트를 추가**한다.
 *
 * 앱이 켜져 있을 때만 존재하는 폴더이므로, 여기서 하는 일은 (1) 루트 위치를
 * 정하고 (2) 어떤 에이전트를 넣을지 고르는 것뿐이다.
 */
import React, { useEffect, useState } from 'react';
import { xgen } from '../bridge';
import type { WorkspaceStatusLike } from '../../../preload/index';

type AgentOption = { id: string; name: string };

export const SyncSettings: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [ws, setWs] = useState<WorkspaceStatusLike | null>(null);
  const [root, setRoot] = useState('');
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [sel, setSel] = useState('');
  const [busy, setBusy] = useState('');
  // 실패를 절대 삼키지 않는다 — v1.7.0 에서 추가 버튼이 조용히 아무 일도
  // 하지 않던 원인이 예외를 잡지 않은 것이었다.
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const refreshRoot = () => xgen.workspace.root().then(setRoot).catch(() => undefined);

  useEffect(() => {
    xgen.workspace.status().then(setWs).catch((e) => setError(String(e?.message ?? e)));
    void refreshRoot();
    xgen.agents
      .list({ page: 1, pageSize: 200 })
      .then((r) => setAgents((r.items ?? []).map((a) => ({ id: a.workflowId, name: a.workflowName }))))
      .catch(() => undefined);
    return xgen.workspace.onStatus(setWs);
  }, []);

  /** 모든 워크스페이스 조작의 단일 통로 — 실패는 반드시 화면에 뜬다. */
  const act = async (label: string, fn: () => Promise<WorkspaceStatusLike | undefined>) => {
    setBusy(label);
    setError('');
    try {
      const next = await fn();
      if (next) setWs(next);
      await refreshRoot();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const attached = ws?.agents ?? [];
  const addable = agents.filter((a) => !attached.some((x) => x.workflowId === a.id));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <div className="modal-head">
          <h2>XGEN 워크스페이스</h2>
          <button className="link" onClick={onClose}>
            닫기
          </button>
        </div>

        <p className="small muted">
          에이전트의 파일을 내 컴퓨터의 폴더처럼 씁니다. 앱이 켜져 있는 동안에만 나타나고,
          끄면 사라집니다 — 파일의 원본은 항상 서버에 있습니다.
        </p>

        {ws && !ws.supported ? (
          <div className="mcp-form">
            <div className="small error">{ws.reason}</div>
            {ws.hint && <div className="small muted" style={{ marginTop: 4 }}>{ws.hint}</div>}
          </div>
        ) : (
          <>
            {/* 드라이브 on/off — 끌 수 없는 기능은 고장 났을 때 손 쓸 방법이 없다 */}
            <div className="mcp-form" style={{ marginBottom: 12 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontWeight: 600 }}>가상 드라이브 사용</div>
                  <div className="small muted" style={{ marginTop: 2 }}>
                    끄면 폴더가 사라집니다. 파일의 원본은 서버에 그대로 있습니다.
                  </div>
                </div>
                {/* 앱의 다른 on/off 와 같은 토글 (VoiceSettings·McpSettings 동일 컴포넌트) */}
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={ws?.enabled !== false}
                    disabled={!!busy}
                    onChange={(e) =>
                      void act('enabled', () => xgen.workspace.setEnabled(e.target.checked))
                    }
                  />
                  <span className="track" />
                </label>
              </div>
            </div>

            {/* 위치 */}
            <div className="mcp-form" style={{ marginBottom: 12 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span style={{ fontWeight: 600 }}>
                  위치
                  {ws?.mounted && (
                    <span className="small notice-ok" style={{ marginLeft: 8 }}>연결됨</span>
                  )}
                </span>
                <div className="row" style={{ gap: 8 }}>
                  {ws?.mounted && (
                    <button className="link" onClick={() => void xgen.workspace.open()}>
                      폴더 열기
                    </button>
                  )}
                  {/*
                    붙어 있으면 [동기화](서버 상태 다시 읽기), 안 붙어 있으면
                    [다시 연결](걷고 재마운트). 실패했을 때 사용자가 스스로
                    되살릴 수단이 없으면 앱을 껐다 켜는 수밖에 없다.
                  */}
                  {ws?.enabled !== false &&
                    (ws?.mounted ? (
                      <button
                        className="link"
                        disabled={!!busy}
                        onClick={() => void act('refresh', () => xgen.workspace.refresh())}
                      >
                        {busy === 'refresh' ? '동기화 중…' : '동기화'}
                      </button>
                    ) : (
                      <button
                        className="link"
                        disabled={!!busy}
                        onClick={() => void act('remount', () => xgen.workspace.remount())}
                      >
                        {busy === 'remount' ? '연결 중…' : '다시 연결'}
                      </button>
                    ))}
                  <button
                    className="link"
                    disabled={!!busy}
                    onClick={() => void act('root', () => xgen.workspace.setRoot())}
                  >
                    {busy === 'root' ? '옮기는 중…' : '위치 변경'}
                  </button>
                </div>
              </div>
              <div className="mcp-item-cmd" style={{ marginTop: 4 }}>{root || '—'}</div>
              {/*
                꺼져 있는 것은 오류가 아니다 — 오류처럼 보이면 사용자가 고치려
                든다. 어디서 켜는지까지 알려준다.
              */}
              {/* 마운트를 막던 로컬 파일 — 지우지 않고 옆으로 옮겨 뒀다 */}
              {ws?.rescued && (
                <div className="small muted" style={{ marginTop: 4 }}>
                  <div>폴더에 있던 파일을 다음 위치로 옮기고 연결했습니다:</div>
                  <div className="mcp-item-cmd" style={{ marginTop: 2 }}>{ws.rescued}</div>
                  <div style={{ marginTop: 2 }}>클라우드로 올라가면 이 폴더는 자동으로 정리됩니다.</div>
                </div>
              )}
              {/* on/off 는 두 곳에 있다 — 관리자의 조직 전체 설정과 본인 설정.
                  어느 쪽이 껐는지는 **서버가 준 사유**가 말해 준다(커넥터가
                  게이트 판정을 흉내내면 서버와 어긋난다). 그래서 사유를 그대로
                  보여주고, 안내는 두 경우를 모두 덮는 문구로 둔다 — 예전에는
                  조직 전체가 꺼졌을 때도 "마이페이지에서 켜라"고 해서 사용자가
                  이미 켜져 있는 자기 설정만 들여다보게 만들었다. */}
              {ws?.storageOff && (
                <div className="small muted" style={{ marginTop: 4 }}>
                  <div>내 클라우드 스토리지를 쓸 수 없습니다: {ws.storageOff}</div>
                  <div style={{ marginTop: 2 }}>
                    본인 설정은 XGEN 웹의 [마이페이지 → 클라우드 스토리지] 에서 켤 수 있습니다.
                    조직 전체가 꺼져 있으면 관리자만 켤 수 있습니다.
                  </div>
                  <div style={{ marginTop: 2 }}>
                    에이전트 폴더는 이 설정과 무관하게 그대로 동작합니다.
                  </div>
                </div>
              )}
              {ws?.error && (
                <div className="small error" style={{ marginTop: 4 }}>
                  <div>{ws.error}</div>
                  {ws.errorHint && (
                    <div className="mcp-item-cmd" style={{ marginTop: 2 }}>{ws.errorHint}</div>
                  )}
                </div>
              )}
            </div>

            {/* 에이전트 */}
            <div className="mcp-form">
              <div style={{ fontWeight: 600, marginBottom: 6 }}>
                이 워크스페이스의 에이전트
              </div>

              {attached.length === 0 ? (
                <div className="small muted pad">
                  아직 추가된 에이전트가 없습니다. 아래에서 골라 추가하면 그 이름의 폴더가
                  생깁니다.
                </div>
              ) : (
                <div className="mcp-list" style={{ maxHeight: 220 }}>
                  {attached.map((a) => (
                    <div key={a.workflowId} className="mcp-item">
                      <div className="mcp-item-body">
                        <div className="mcp-item-name">{a.label}</div>
                        <div className="mcp-item-cmd">{a.folder}</div>
                      </div>
                      <div className="mcp-item-actions">
                        <button
                          className="link"
                          disabled={!!busy}
                          onClick={() =>
                            void act(`detach:${a.workflowId}`, () =>
                              xgen.workspace.detach(a.workflowId),
                            )
                          }
                        >
                          {busy === `detach:${a.workflowId}` ? '제거 중…' : '제거'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="row" style={{ marginTop: 8, gap: 6 }}>
                <select
                  className="grow"
                  value={sel}
                  onChange={(e) => setSel(e.target.value)}
                  disabled={addable.length === 0}
                >
                  <option value="">
                    {addable.length === 0 ? '추가할 에이전트가 없습니다' : '에이전트 선택…'}
                  </option>
                  {addable.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <button
                  className="primary"
                  disabled={!sel || !!busy}
                  onClick={() => {
                    const agent = addable.find((a) => a.id === sel);
                    if (!agent) return;
                    void act('attach', async () => {
                      const next = await xgen.workspace.attach({
                        workflowId: agent.id,
                        label: agent.name,
                      });
                      setSel('');
                      return next;
                    });
                  }}
                >
                  {busy === 'attach' ? '추가 중…' : '추가'}
                </button>
              </div>
            </div>
          </>
        )}

        {error && (
          <div className="small error" style={{ marginTop: 8 }}>
            {error}
          </div>
        )}

        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
          <button
            className="link"
            onClick={() => {
              // 실패를 삼키지 않는다 — 복사가 안 되면 사용자가 알아야 한다.
              setError('');
              void xgen.workspace
                .diagCopy()
                .then((r) => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                  if (!r.chars) setError('진단 로그가 비어 있습니다.');
                })
                .catch((e) =>
                  setError(`진단 로그를 복사하지 못했습니다: ${e?.message ?? e}`),
                );
            }}
          >
            {copied ? '복사됨' : '진단 로그 복사'}
          </button>
        </div>
      </div>
    </div>
  );
};
