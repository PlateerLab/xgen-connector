/**
 * 탐색기(사이드바) 순수 모델 — React 없이 단위 테스트되는 부분.
 *
 * 탐색기는 가상 드라이브를 **섹션 단위**로 보여준다:
 *
 *     [XgenCloud]            ← /클라우드 (내 클라우드 스토리지)
 *       파일 트리…
 *     [<에이전트 이름>]        ← /에이전트/<폴더> (연결된 에이전트 workspace)
 *       파일 트리…
 *
 * 섹션 경로는 백엔드(workspace-backend)의 예약 루트 두 개와 1:1 이다. 나중에
 * "폴더 연결"이 생기면 XgenCloud 아래에 경로 헤더 섹션이 추가된다 — 그때도
 * 이 모델(섹션 배열)에 항목이 늘어날 뿐 화면 구조는 그대로다.
 */

/** 드라이브 상태에서 탐색기가 쓰는 부분만 (preload 미러의 부분집합). */
export interface ExplorerStatusLike {
  agents: Array<{ workflowId: string; label: string; folder: string }>;
}

export interface ExplorerSection {
  /** 접힘 상태의 키 — 안정적이어야 한다. */
  id: string;
  /** 섹션 헤더에 보이는 이름. */
  title: string;
  /** 백엔드 경로 (`/` 시작, POSIX). */
  path: string;
  kind: 'cloud' | 'agent';
}

/** 백엔드의 예약 루트 이름 (workspace-backend 의 CLOUD_DIR/AGENTS_DIR 미러). */
export const CLOUD_ROOT = '/클라우드';
export const AGENTS_ROOT = '/에이전트';

/** 드라이브 상태 → 탐색기 섹션 목록. XgenCloud 가 항상 먼저다. */
export function sectionsFor(status: ExplorerStatusLike | null): ExplorerSection[] {
  const out: ExplorerSection[] = [
    { id: 'cloud', title: 'XgenCloud', path: CLOUD_ROOT, kind: 'cloud' },
  ];
  for (const a of status?.agents ?? []) {
    out.push({
      id: `agent:${a.workflowId}`,
      title: a.label || a.folder,
      path: `${AGENTS_ROOT}/${a.folder}`,
      kind: 'agent',
    });
  }
  return out;
}

/** 부모 경로 + 자식 이름 → 자식 경로. 루트('/')도 안전하다. */
export function childPath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`;
}

export interface ExplorerEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

/** 탐색기 정렬 — 폴더 먼저, 그 다음 이름(한국어 로케일). */
export function sortEntries(entries: ExplorerEntry[]): ExplorerEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, 'ko');
  });
}

/** 파일 크기 표시 — 목록 행 우측 미터. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes}B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10}${units[i]}`;
}
