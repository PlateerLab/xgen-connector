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
          return (
            <div key={p.id} className="card" style={{ marginBottom: 10, padding: 12 }}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 8,
                        background: STATE_COLOR[state],
                        display: 'inline-block',
                        flex: '0 0 auto',
                      }}
                    />
                    <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.workflowLabel || p.workflowId}
                    </strong>
                    <span className="small muted">{STATE_LABEL[state]}</span>
                  </div>
                  <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {p.localPath}
                  </div>
                  {st && (
                    <div className="small muted">
                      ↓{st.counts.downloaded} ↑{st.counts.uploaded}
                      {st.counts.conflicts > 0 && ` · 충돌 사본 ${st.counts.conflicts}`}
                      {st.counts.skippedLarge > 0 && ` · 대형 파일 제외 ${st.counts.skippedLarge}`}
                      {st.lastSyncAt && ` · ${new Date(st.lastSyncAt).toLocaleTimeString()}`}
                    </div>
                  )}
                  {st?.lastError && (
                    <div
                      className="small"
                      title={st.lastError}
                      style={{ color: '#dc2626', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {st.lastError}
                    </div>
                  )}
                </div>
                <div className="row" style={{ gap: 6, flex: '0 0 auto' }}>
                  <button className="secondary" onClick={() => void xgen.sync.openFolder(p.id)}>
                    폴더 열기
                  </button>
                  <button className="secondary" onClick={() => void xgen.sync.syncNow(p.id)}>
                    지금 동기화
                  </button>
                  <button
                    className="secondary"
                    onClick={() => void xgen.sync.setPaused(p.id, !p.paused).then(() => reload())}
                  >
                    {p.paused ? '재개' : '일시정지'}
                  </button>
                  <button
                    className="danger"
                    onClick={() => void xgen.sync.removePair(p.id).then(() => reload())}
                  >
                    해제
                  </button>
                </div>
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
