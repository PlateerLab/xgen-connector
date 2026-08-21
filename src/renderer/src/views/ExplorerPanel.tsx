/**
 * ExplorerPanel — 사이드바 [탐색기] 뷰. 가상 드라이브를 앱 안에서 바로 본다.
 *
 *     [XgenCloud]            ← 내 클라우드 스토리지 (/클라우드)
 *       파일 트리…
 *     [<에이전트 이름>]        ← 연결된 에이전트 workspace (/에이전트/<폴더>)
 *       파일 트리…
 *
 * 목록은 OS 마운트가 아니라 **백엔드 IPC**(workspace.list)로 읽는다 — 마운트가
 * 죽어 있어도 탐색기는 동작하고, 메인 프로세스가 자기 FUSE 마운트를 만질 일도
 * 없다. 디렉터리는 펼칠 때 지연 로드하고, 다시 읽는 동안 **이전 목록을 그대로
 * 보여준다** (비웠다가 채우면 "파일이 사라졌다"로 보인다 — orca 의 교훈).
 */
import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { xgen } from '../bridge';
import type { WorkspaceStatusLike } from '../../../preload/index';
import {
  childPath,
  formatSize,
  sectionsFor,
  sortEntries,
  type ExplorerEntry,
  type ExplorerSection,
} from './explorer-model';
import {
  BotIcon,
  ChevronRightIcon,
  CloudIcon,
  DocIcon,
  FolderIcon,
  FolderOpenIcon,
  RefreshIcon,
  UploadIcon,
} from '../brand/icons';

interface DirState {
  /** null = 아직 한 번도 못 읽음. 로드 중에도 이전 목록을 유지한다. */
  entries: ExplorerEntry[] | null;
  loading: boolean;
}

export const ExplorerPanel: React.FC<{ onOpenSettings: () => void }> = ({ onOpenSettings }) => {
  const [status, setStatus] = useState<WorkspaceStatusLike | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 디렉터리 캐시는 ref + 수동 리렌더 — 로드가 겹칠 때 상태 업데이트 함수 안에서
  // IO 를 시작하는 꼴(불순한 updater)을 피하는 가장 단순한 구조다.
  const cacheRef = useRef(new Map<string, DirState>());
  const seqRef = useRef(new Map<string, number>());
  const [, bump] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    void xgen.workspace
      .status()
      .then(setStatus)
      .catch(() => undefined);
    return xgen.workspace.onStatus(setStatus);
  }, []);

  const loadDir = useCallback(async (path: string, force = false) => {
    const cur = cacheRef.current.get(path);
    if (cur?.loading) return;
    if (cur?.entries && !force) return;
    // 추월당한 응답이 최신 목록을 덮지 않게 경로마다 순번을 센다.
    const seq = (seqRef.current.get(path) ?? 0) + 1;
    seqRef.current.set(path, seq);
    cacheRef.current.set(path, { entries: cur?.entries ?? null, loading: true });
    bump();
    let next: ExplorerEntry[] | null = null;
    try {
      next = sortEntries(await xgen.workspace.list(path));
    } catch {
      next = cur?.entries ?? [];
    }
    if (seqRef.current.get(path) !== seq) return;
    cacheRef.current.set(path, { entries: next, loading: false });
    bump();
  }, []);

  const sections = sectionsFor(status);

  // 펼쳐져 있는 섹션 루트는 항상 읽혀 있어야 한다 — 상태 변화(에이전트
  // 부착/해제, 최초 로드)로 섹션이 생기면 여기서 따라 읽는다.
  useEffect(() => {
    for (const s of sections) {
      if (!collapsed.has(s.id)) void loadDir(s.path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, collapsed]);

  const toggleSection = (s: ExplorerSection) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(s.id)) next.delete(s.id);
      else next.add(s.id);
      return next;
    });
  };

  const toggleDir = (path: string) => {
    setSelected(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else {
        next.add(path);
        void loadDir(path);
      }
      return next;
    });
  };

  /** 서버 캐시를 버리고, 열어 둔 모든 폴더를 다시 읽는다. */
  const refreshAll = useCallback(async () => {
    setBusy(true);
    try {
      await xgen.workspace.refresh();
    } catch {
      /* 서버 새로고침 실패해도 로컬 다시 읽기는 진행한다 */
    }
    const targets = [...cacheRef.current.keys()];
    await Promise.all(targets.map((p) => loadDir(p, true)));
    setBusy(false);
  }, [loadDir]);

  const openInOs = (path: string) => void xgen.workspace.openPath(path);

  const renderDir = (path: string, depth: number): React.ReactNode => {
    const st = cacheRef.current.get(path);
    if (!st || (!st.entries && st.loading)) {
      return (
        <div className="tree-row muted" style={{ paddingLeft: depth * 14 + 26 }}>
          불러오는 중…
        </div>
      );
    }
    if (!st.entries) return null;
    if (st.entries.length === 0) {
      return (
        <div className="tree-row muted" style={{ paddingLeft: depth * 14 + 26 }}>
          비어 있음
        </div>
      );
    }
    return st.entries.map((e) => {
      const p = childPath(path, e.name);
      if (e.isDir) {
        const open = expanded.has(p);
        return (
          <React.Fragment key={p}>
            <div
              className={`tree-row ${selected === p ? 'selected' : ''}`}
              style={{ paddingLeft: depth * 14 + 8 }}
              role="button"
              tabIndex={0}
              onClick={() => toggleDir(p)}
              onKeyDown={(ev) => ev.key === 'Enter' && toggleDir(p)}
              onDoubleClick={() => status?.mounted && openInOs(p)}
              title={e.name}
            >
              <span className={`tree-chevron ${open ? 'open' : ''}`}>
                <ChevronRightIcon size={13} />
              </span>
              <span className="tree-icon">
                {open ? <FolderOpenIcon size={15} /> : <FolderIcon size={15} />}
              </span>
              <span className="tree-name">{e.name}</span>
            </div>
            {open && renderDir(p, depth + 1)}
          </React.Fragment>
        );
      }
      return (
        <div
          key={p}
          className={`tree-row ${selected === p ? 'selected' : ''}`}
          style={{ paddingLeft: depth * 14 + 8 }}
          role="button"
          tabIndex={0}
          onClick={() => setSelected(p)}
          onDoubleClick={() => status?.mounted && openInOs(p)}
          title={status?.mounted ? `${e.name} — 두 번 눌러 열기` : e.name}
        >
          <span className="tree-chevron" />
          <span className="tree-icon">
            <DocIcon size={14} />
          </span>
          <span className="tree-name">{e.name}</span>
          {e.size > 0 && <span className="tree-size">{formatSize(e.size)}</span>}
        </div>
      );
    });
  };

  // 드라이브가 아예 서빙되지 않는 상태 — 트리 대신 사유와 조치를 보여준다.
  const blocked =
    status &&
    (!status.enabled ||
      !status.supported ||
      ((!!status.storageOff || !!status.cloudApproval) && status.agents.length === 0));

  // 클라우드 섹션만 잠긴 상태의 안내문 — RAG 통제(승인 대기/거절)가 storageOff 보다
  // 먼저다: 대기는 관리자가 승인하면 저절로 풀리므로 "설정을 확인하라"로 보내지
  // 않는다 (SyncSettings 와 같은 문구 결).
  const cloudLockMessage = !status
    ? null
    : status.cloudApproval === 'pending'
      ? '클라우드 연결이 관리자 승인 대기중입니다. 승인되면 자동으로 열립니다.'
      : status.cloudApproval === 'rejected'
        ? status.cloudApprovalDetail || '클라우드 연결이 관리자에 의해 거절되었습니다.'
        : (status.storageOff ?? null);

  return (
    <div className="side-panel">
      <div className="sidebar-title">
        <span className="sidebar-title-text">탐색기</span>
        <span className="sidebar-title-actions">
          {status?.mounted && (
            <button
              className="icon-btn sm"
              title="OS 파일 관리자로 열기"
              onClick={() => void xgen.workspace.open()}
            >
              <UploadIcon size={14} />
            </button>
          )}
          <button
            className={`icon-btn sm ${busy ? 'spin' : ''}`}
            title="새로고침"
            onClick={() => void refreshAll()}
            disabled={busy}
          >
            <RefreshIcon size={14} />
          </button>
        </span>
      </div>

      <div className="explorer-body">
        {!status && <div className="muted small pad">드라이브 상태 확인 중…</div>}

        {status && blocked && (
          <div className="explorer-notice">
            {!status.supported ? (
              <>
                <p>{status.reason ?? '이 플랫폼에서는 드라이브를 지원하지 않습니다.'}</p>
                {status.hint && <p className="muted small">{status.hint}</p>}
              </>
            ) : !status.enabled ? (
              <>
                <p>XGEN 워크스페이스 드라이브가 꺼져 있습니다.</p>
                <button
                  className="primary-sm"
                  onClick={() => void xgen.workspace.setEnabled(true).then(setStatus)}
                >
                  드라이브 켜기
                </button>
              </>
            ) : (
              <>
                <p>{cloudLockMessage}</p>
                {/* 승인 대기는 사용자가 할 일이 없다 — 버튼은 그 외의 경우만. */}
                {status.cloudApproval !== 'pending' && (
                  <button className="primary-sm" onClick={onOpenSettings}>
                    스토리지 설정 열기
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {status && !blocked && (
          <>
            {status.error && (
              <div className="explorer-notice error-tone">
                <p>{status.error}</p>
                <button
                  className="primary-sm"
                  onClick={() => void xgen.workspace.remount().then(setStatus)}
                >
                  다시 연결
                </button>
              </div>
            )}
            {sections.map((s) => {
              const isCollapsed = collapsed.has(s.id);
              const st = cacheRef.current.get(s.path);
              return (
                <div key={s.id} className="explorer-section">
                  <button className="section-head" onClick={() => toggleSection(s)} title={s.title}>
                    <span className={`tree-chevron ${isCollapsed ? '' : 'open'}`}>
                      <ChevronRightIcon size={13} />
                    </span>
                    <span className="section-icon">
                      {s.kind === 'cloud' ? <CloudIcon size={14} /> : <BotIcon size={14} />}
                    </span>
                    <span className="section-name">{s.title}</span>
                    {st?.loading && <span className="section-loading" />}
                  </button>
                  {!isCollapsed && (
                    <div className="section-body">
                      {s.kind === 'cloud' && cloudLockMessage ? (
                        <div
                          className="tree-row muted"
                          style={{ paddingLeft: 26, whiteSpace: 'normal' }}
                        >
                          {cloudLockMessage}
                        </div>
                      ) : (
                        renderDir(s.path, 1)
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>

      {status && !blocked && (
        <div className="explorer-foot">
          <span className={`mount-dot ${status.mounted ? 'on' : ''}`} />
          {status.mounted && status.path ? (
            <span className="path-ellipsis" title={status.path}>
              {status.path}
            </span>
          ) : (
            <span className="muted">드라이브 연결 중…</span>
          )}
        </div>
      )}
    </div>
  );
};
