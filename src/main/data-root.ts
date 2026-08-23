/**
 * data-root — 커넥터의 **통합 데이터 루트 폴더** (`~/xgen-connector`).
 *
 * 커넥터가 만드는 모든 작업 자산이 한 지붕 아래 모인다:
 *
 *   <dataRoot>/                ← 기본 ~/xgen-connector (인스톨러/설정에서 변경 가능)
 *     workspace/               ← PC 컨트롤 작업 폴더 + 에이전트 로컬 동기화 루트
 *     cloud/                   ← 스토리지(가상 드라이브) 마운트 루트
 *     local-runtime/           ← 에이전트 로컬 실행 런타임(Python) + bin/(codex·claude CLI)
 *
 * 결정 규칙(체크 해제 = 수정 가능):
 *   · 사용자가 명시한 경로(localShell.cwd / workspace.root / dataRoot)는 항상 존중.
 *   · 미설정이면 dataRoot 파생 기본을 **첫 부팅에 config 에 채워** 이후에도
 *     안정적으로 같은 곳을 가리키게 한다(레이아웃이 조용히 이사하지 않게).
 *
 * Windows 인스톨러(NSIS custom page)는 선택 결과를
 *   <userData>/install-options.json  =  { dataRoot?, autoRuntime?, autoCodex?, autoClaude? }
 * 로 남기고, 앱 첫 부팅이 consumeInstallOptions() 로 **한 번** 삼켜 config 에
 * 반영한 뒤 파일을 지운다. mac/linux 는 인스톨러 UI 가 없으므로 같은 기본이
 * 첫 부팅에 그대로 적용된다(= 기본 체크 상태).
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ConnectorConfig } from './config';

/** 인스톨러가 남기는 선택 파일 이름 (userData 아래). */
export const INSTALL_OPTIONS_FILE = 'install-options.json';

export interface InstallOptions {
  dataRoot?: string;
  autoRuntime?: boolean;
  autoCodex?: boolean;
  autoClaude?: boolean;
}

/** 통합 루트 — config.dataRoot 존중, 기본 ~/xgen-connector. */
export function resolveDataRoot(cfg: Pick<ConnectorConfig, 'dataRoot'>, home = homedir()): string {
  const r = (cfg.dataRoot ?? '').trim();
  return r ? resolve(r) : join(home, 'xgen-connector');
}

export function workspaceDirOf(root: string): string {
  return join(root, 'workspace');
}
export function cloudDirOf(root: string): string {
  return join(root, 'cloud');
}
export function runtimeDirOf(root: string): string {
  return join(root, 'local-runtime');
}

/**
 * 첫 부팅 정착 — dataRoot 트리를 만들고, 미설정 경로들을 dataRoot 파생 기본으로
 * config 에 채운다. **명시 설정은 절대 덮지 않는다.** 반환: config 패치(변경분만).
 */
export function settleDataRoot(
  cfg: ConnectorConfig,
  home = homedir(),
): { root: string; patch: Partial<ConnectorConfig> } {
  const root = resolveDataRoot(cfg, home);
  const patch: Partial<ConnectorConfig> = {};
  for (const d of [root, workspaceDirOf(root), cloudDirOf(root), runtimeDirOf(root)]) {
    try {
      mkdirSync(d, { recursive: true });
    } catch {
      /* 권한 문제 등 — 사용처에서 다시 드러난다 */
    }
  }
  if (!(cfg.dataRoot ?? '').trim()) patch.dataRoot = root;
  // PC 컨트롤 작업 폴더(=에이전트 로컬 동기화 루트) 기본.
  if (!(cfg.localShell?.cwd ?? '').trim()) {
    patch.localShell = { ...(cfg.localShell ?? {}), cwd: workspaceDirOf(root) };
  }
  // 스토리지(가상 드라이브) 루트 기본.
  if (!(cfg.workspace?.root ?? '').trim()) {
    patch.workspace = { agents: [], ...(cfg.workspace ?? {}), root: cloudDirOf(root) };
  }
  return { root, patch };
}

/**
 * 인스톨러 선택 1회 반영 — userData 의 install-options.json 을 읽어 config 패치로
 * 돌려주고 파일을 지운다(재부팅마다 재적용 방지). 없거나 손상이면 null.
 */
export function consumeInstallOptions(userDataDir: string): Partial<ConnectorConfig> | null {
  const p = join(userDataDir, INSTALL_OPTIONS_FILE);
  if (!existsSync(p)) return null;
  let opts: InstallOptions | null = null;
  try {
    opts = JSON.parse(readFileSync(p, 'utf-8')) as InstallOptions;
  } catch {
    opts = null;
  }
  try {
    rmSync(p, { force: true });
  } catch {
    /* 지우기 실패 — 다음 부팅에 또 시도돼도 무해(같은 값) */
  }
  if (!opts || typeof opts !== 'object') return null;
  const patch: Partial<ConnectorConfig> = {};
  if (typeof opts.dataRoot === 'string' && opts.dataRoot.trim()) patch.dataRoot = opts.dataRoot.trim();
  const le: NonNullable<ConnectorConfig['localExec']> = {};
  if (typeof opts.autoRuntime === 'boolean') le.autoRuntime = opts.autoRuntime;
  if (typeof opts.autoCodex === 'boolean') le.autoCodex = opts.autoCodex;
  if (typeof opts.autoClaude === 'boolean') le.autoClaude = opts.autoClaude;
  if (Object.keys(le).length) patch.localExec = le;
  return Object.keys(patch).length ? patch : null;
}
