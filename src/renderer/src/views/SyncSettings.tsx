/**
 * SyncSettings — 로컬 폴더 ↔ 에이전트 workspace 동기화(Drive형) 관리.
 *
 * geny-connector ControlApp 의 Workspace 탭 이식: 페어링 생성(에이전트 선택 +
 * 폴더 선택), 상태(연결/동기화 중/오프라인/일시정지/에이전트 삭제됨), 카운터,
 * lastError 표면화, 대량 삭제 확인 배너, 행 액션(폴더 열기/지금 동기화/
 * 일시정지·재개/해제).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { xgen } from '../bridge';
import type { SyncPairPersistConfig } from '../../../main/config';
import type { SyncPairStatusLike } from '../../../preload/index';

const STATE_LABEL: Record<SyncPairStatusLike['state'], string> = {
  idle: '연결됨',
  syncing: '동기화 중',
  paused: '일시정지',
  offline: '오프라인',
  error: '오류',
  session_gone: '에이전트 없음',
  awaiting_confirmation: '확인 대기',
};

const STATE_COLOR: Record<SyncPairStatusLike['state'], string> = {
  idle: '#2eae60',
  syncing: '#3b82f6',
  paused: '#9aa1ab',
  offline: '#d97706',
  error: '#dc2626',
  session_gone: '#dc2626',
  awaiting_confirmation: '#d97706',
};

type AgentOption = { id: string; name: string };

export const SyncSettings: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [pairs, setPairs] = useState<SyncPairPersistConfig[]>([]);
  const [statuses, setStatuses] = useState<SyncPairStatusLike[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  // 가상 드라이브 검증 — 이 컴퓨터에서 WebDAV 마운트가 실제로 되는지.
  const [probe, setProbe] = useState<{
    busy?: boolean;
    ok?: boolean;
    path?: string;
    error?: string;
    hint?: string;
    log?: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  // 실제 워크스페이스(가상 드라이브) — 부착된 에이전트 + 마운트 상태.
  const [ws, setWs] = useState<import('../../../preload/index').WorkspaceStatusLike | null>(null);
  const [wsAgent, setWsAgent] = useState('');
  const [wsBusy, setWsBusy] = useState(false);
  const [selAgent, setSelAgent] = useState('');
  const [selFolder, setSelFolder] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    const r = await xgen.sync.list();
    setPairs(r.pairs);
    setStatuses(r.statuses);
  };

  useEffect(() => {
    void reload();
    const off = xgen.sync.onStatus((s) => setStatuses(s));
    // 페어링 대상 에이전트 후보 — 내 에이전트 목록.
    xgen.agents
      .list({ page: 1, pageSize: 100 })
      .then((res) =>
        setAgents(
          (res.items ?? []).map((a) => ({
            id: a.workflowId,
            name: a.workflowName || a.workflowId,
          })),
        ),
      )
      .catch(() => setAgents([]));
    return off;
  }, []);

  const statusOf = useMemo(() => {
    const m = new Map(statuses.map((s) => [s.id, s]));
    return (id: string) => m.get(id);
  }, [statuses]);

  const pickFolder = async () => {
    const p = await xgen.sync.pickFolder();
    if (p) setSelFolder(p);
  };

  const addPair = async () => {
    if (!selAgent || !selFolder) return;
    setBusy(true);
    setAddError(null);
    try {
      const label = agents.find((a) => a.id === selAgent)?.name ?? '';
      const r = await xgen.sync.addPair(selAgent, label, selFolder);
      if (!r.ok) {
        setAddError(r.error ?? '페어링 생성에 실패했습니다.');
        return;
      }
      setSelFolder('');
      await reload();
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    xgen.workspace.status().then(setWs).catch(() => undefined);
    return xgen.workspace.onStatus(setWs);
  }, []);

  const attachWs = async () => {
    const agent = agents.find((a) => a.id === wsAgent);
    if (!agent) return;
    setWsBusy(true);
    try {
      setWs(await xgen.workspace.attach({ workflowId: agent.id, label: agent.name }));
      setWsAgent('');
    } finally {
      setWsBusy(false);
    }
  };

  const detachWs = async (workflowId: string) => {
    setWsBusy(true);
    try {
      setWs(await xgen.workspace.detach(workflowId));
    } finally {
      setWsBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <div className="modal-head">
          <h2>워크스페이스 동기화</h2>
          <button className="link" onClick={onClose}>
            닫기
          </button>
        </div>

        <p className="small muted">
          로컬 폴더와 에이전트 워크스페이스를 Google Drive 처럼 양방향으로 동기화합니다.
          충돌 시 서버 버전이 유지되고 로컬 사본은 «(충돌-기기 시각)» 이름으로 보존됩니다.
          node_modules / .venv / build 등 대형 라이브러리 폴더와 500MiB 초과 파일은 제외됩니다.
        </p>

        {/* ── 가상 드라이브 검증 ──────────────────────────────────
            전체 기능(에이전트 부착·파일 서빙)은 "OS 내장 WebDAV 클라이언트가
            인증 없이 실제로 붙는가"라는 검증되지 않은 가정 위에 있다. 그
            가정만 먼저 찍는다 — 실패하면 진단 로그를 그대로 보낼 수 있다. */}
        <div className="mcp-form" style={{ marginBottom: 12 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span style={{ fontWeight: 600 }}>
              XGEN 워크스페이스
              {ws?.mounted && <span className="small notice-ok" style={{ marginLeft: 8 }}>마운트됨</span>}
            </span>
            {ws?.mounted && (
              <button className="link" onClick={() => void xgen.workspace.open()}>
                폴더 열기
              </button>
            )}
          </div>
          {ws && !ws.supported ? (
            <div className="small error" style={{ marginTop: 4 }}>
              {ws.reason}
              {ws.hint && <div style={{ marginTop: 2 }}>{ws.hint}</div>}
            </div>
          ) : (
            <>
              <div className="small muted" style={{ marginTop: 4 }}>
                홈 폴더의 <code>XGEN-Workspace</code> 안에 에이전트가 폴더로 나타납니다.
                앱이 켜져 있을 때만 존재합니다.
              </div>
              {ws?.error && <div className="small error" style={{ marginTop: 4 }}>{ws.error}</div>}
              {(ws?.agents.length ?? 0) > 0 && (
                <div className="mcp-list" style={{ maxHeight: 160 }}>
                  {ws!.agents.map((a) => (
                    <div key={a.workflowId} className="mcp-item">
                      <div className="mcp-item-body">
                        <div className="mcp-item-name">{a.label}</div>
                        <div className="mcp-item-cmd">XGEN-Workspace/{a.folder}</div>
                      </div>
                      <div className="mcp-item-actions">
                        <button className="link" disabled={wsBusy} onClick={() => void detachWs(a.workflowId)}>
                          제거
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="row" style={{ marginTop: 6, gap: 6 }}>
                <select
                  className="grow"
                  value={wsAgent}
                  onChange={(e) => setWsAgent(e.target.value)}
                >
                  <option value="">워크스페이스에 추가할 에이전트…</option>
                  {agents
                    .filter((a) => !ws?.agents.some((x) => x.workflowId === a.id))
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </select>
                <button className="primary" disabled={!wsAgent || wsBusy} onClick={() => void attachWs()}>
                  추가
                </button>
              </div>
            </>
          )}
        </div>

        <div className="mcp-form" style={{ marginBottom: 12 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span style={{ fontWeight: 600 }}>마운트 진단 (시험)</span>
            <div className="row" style={{ gap: 6 }}>
              <button
                className="secondary"
                disabled={probe?.busy}
                onClick={() => {
                  setProbe({ busy: true });
                  void xgen.workspace
                    .probeRun()
                    .then((r) => setProbe({ ...r }))
                    .catch((e: unknown) =>
                      setProbe({ ok: false, error: String((e as Error)?.message ?? e) }),
                    );
                }}
              >
                {probe?.busy ? '마운트 중…' : '마운트 시험'}
              </button>
              {probe?.ok && (
                <button
                  className="link"
                  onClick={() => {
                    void xgen.workspace.probeStop().then(() => setProbe(null));
                  }}
                >
                  해제
                </button>
              )}
            </div>
          </div>
          <div className="small muted" style={{ marginTop: 4 }}>
            홈 폴더에 <code>XGEN-Workspace</code> 를 마운트해 봅니다. 샘플 파일이 보이면
            성공입니다 — 앱을 끄거나 [해제]하면 사라집니다.
          </div>
          {probe && !probe.busy && (
            <div className={`small mcp-test-result ${probe.ok ? 'notice-ok' : 'error'}`}>
              <div>
                {probe.ok
                  ? `마운트됨 → ${probe.path}`
                  : `마운트 실패: ${probe.error ?? '알 수 없는 오류'}`}
              </div>
              {probe.hint && <div style={{ marginTop: 2 }}>{probe.hint}</div>}
            </div>
          )}
          {probe?.log && (
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 6 }}>
              <button
                className="link"
                onClick={() => {
                  void xgen.workspace
                    .diagText()
                    .then((t) => navigator.clipboard.writeText(t))
                    .then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    })
                    .catch(() => undefined);
                }}
              >
                {copied ? '복사됨' : '진단 로그 복사'}
              </button>
            </div>
          )}
        </div>

        {/* 페어링 생성 */}
        <div className="field">
          <span>새 연결</span>
          <div className="row">
            <select
              className="grow"
              value={selAgent}
              onChange={(e) => setSelAgent(e.target.value)}
            >
              <option value="">에이전트 선택…</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <button className="secondary" onClick={() => void pickFolder()}>
              {selFolder ? '폴더 변경' : '폴더 선택'}
            </button>
            <button className="primary" disabled={!selAgent || !selFolder || busy} onClick={() => void addPair()}>
              연결
            </button>
          </div>
          {selFolder && <span className="small muted">{selFolder}</span>}
          {addError && <span className="small notice-warn">{addError}</span>}
        </div>

        {/* 페어링 목록 */}
        {pairs.length === 0 && <p className="small muted">아직 연결된 폴더가 없습니다.</p>}
        {pairs.map((p) => {
          const st = statusOf(p.id);
          const state: SyncPairStatusLike['state'] = st?.state ?? (p.paused ? 'paused' : 'offline');
          // 버튼은 **라이브 상태** 기준 — 자동 일시정지(쿼터/에이전트 삭제)
          // 직후에도 첫 클릭이 곧바로 재개가 되게 (stale p.paused 는 두 번
          // 클릭을 요구했다).
          const isPaused = state === 'paused' || state === 'session_gone' || p.paused === true;
          return (
            <div key={p.id} className="sync-pair">
              <div className="sync-pair-head">
                <span className="sync-pair-dot" style={{ background: STATE_COLOR[state] }} />
                <span className="sync-pair-name" title={p.workflowLabel || p.workflowId}>
                  {p.workflowLabel || p.workflowId}
                </span>
                <span className="sync-pair-state" style={{ color: STATE_COLOR[state] }}>
                  {STATE_LABEL[state]}
                </span>
              </div>
              <div className="sync-pair-path small muted" title={p.localPath}>
                {p.localPath}
              </div>
              {st && (
                <div className="sync-pair-meta small muted">
                  ↓ {st.counts.downloaded} · ↑ {st.counts.uploaded}
                  {st.counts.conflicts > 0 && ` · 충돌 사본 ${st.counts.conflicts}`}
                  {st.counts.skippedLarge > 0 && ` · 대형 파일 제외 ${st.counts.skippedLarge}`}
                  {st.lastSyncAt &&
                    ` · 마지막 동기화 ${new Date(st.lastSyncAt).toLocaleTimeString()}`}
                </div>
              )}
              {st?.lastError && (
                <div className="sync-pair-error small" title={st.lastError}>
                  {st.lastError}
                </div>
              )}
              <div className="sync-pair-foot">
                <button className="secondary" onClick={() => void xgen.sync.openFolder(p.id)}>
                  폴더 열기
                </button>
                <button className="secondary" onClick={() => void xgen.sync.syncNow(p.id)}>
                  지금 동기화
                </button>
                <button
                  className="secondary"
                  onClick={() => void xgen.sync.setPaused(p.id, !isPaused).then(() => reload())}
                >
                  {isPaused ? '재개' : '일시정지'}
                </button>
                <button
                  className="danger"
                  onClick={() => void xgen.sync.removePair(p.id).then(() => reload())}
                >
                  해제
                </button>
              </div>

              {/* 대량 삭제 안전밸브 확인 배너 */}
              {st?.pendingMassDelete && (
                <div className="notice-warn" style={{ marginTop: 8, padding: 8, borderRadius: 8 }}>
                  <div className="small">
                    한 번에 {st.pendingMassDelete.count}개 파일(전체 {st.pendingMassDelete.total}개 중)이
                    삭제되려 합니다. 실수(폴더 마운트 해제 등)일 수 있어 동기화를 멈췄습니다.
                  </div>
                  <div className="row" style={{ gap: 6, marginTop: 6 }}>
                    <button
                      className="danger"
                      onClick={() => void xgen.sync.confirmMassDelete(p.id, true)}
                    >
                      삭제 적용
                    </button>
                    <button
                      className="secondary"
                      onClick={() => void xgen.sync.confirmMassDelete(p.id, false).then(() => reload())}
                    >
                      동기화 일시정지
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
