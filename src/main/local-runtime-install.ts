/**
 * local-runtime-install — 커넥터의 **독립 로컬 실행 환경**을 설치/관리한다.
 *
 * 커넥터가 에이전트 턴을 **사용자 PC 에서** 돌리려면(무발산: 서버 웹과 같은
 * AgentTurnExecutor 를 로컬 스폰), 이식형 Python + xgen-agent-runtime(사이드카
 * xgen_agent_runtime.host 포함)이 앱과 **독립된** 위치에 있어야 한다. 시스템
 * Python 을 건드리지 않고, 앱 userData 아래 자기만의 트리를 쓴다:
 *
 *   <userData>/local-runtime/python/…   (bin/python3 | python.exe)
 *
 * 사용자가 [설정 → 일반]의 버튼으로 설치한다(운영체제별 자동). 설치 후
 * resolveSidecarCommand 가 이 python 을 사이드카 인터프리터로 쓴다.
 *
 * 설치 단계(installLocalRuntime):
 *   1) 이식형 CPython(astral-sh/python-build-standalone, install_only)을 현재
 *      OS/arch 트리플로 다운로드·추출.
 *   2) 그 python 으로 xgen-agent-runtime(RUNTIME_WHEEL_VERSION wheel, host 포함) 설치.
 *   3) import 스모크(xgen_agent_runtime.host.sidecar) 로 검증.
 * 각 단계에서 onProgress 로 진행 상황을 알린다.
 *
 * 네트워크/전송은 주입 가능(테스트) — 순수 경로 계산은 부수효과 없이 단위 검증.
 */
import { execFile } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/**
 * 기본 핀 — 릴리스된 runtime(host 서브패키지 포함) 버전. scripts/bundle-python-sidecar.mjs 의
 * RELEASED_RUNTIME_WHEEL 과 **같은 버전**이어야 한다(test/bundle-layout.test.ts 가 잠근다 —
 * .mjs 는 TS 를 import 할 수 없어 상수를 공유하지 못한다).
 */
export const RUNTIME_WHEEL_VERSION = '3.8.1';
/** GitHub Release 의 wheel URL(버전 → URL, 패턴 고정). */
export function runtimeWheelUrl(version: string): string {
  const v = version.replace(/^v/, '');
  return `https://github.com/PlateerLab/xgen-agent-runtime/releases/download/v${v}/xgen_agent_runtime-${v}-py3-none-any.whl`;
}
/** 기본 핀 — 릴리스된 runtime(host 서브패키지 포함) wheel. */
export const DEFAULT_RUNTIME_WHEEL = runtimeWheelUrl(RUNTIME_WHEEL_VERSION);
const PBS_RELEASE = '20250808';
const PBS_PYTHON = '3.12.11';

export interface InstallDeps {
  /** 설치 루트 — 보통 <userData>/local-runtime (주입: app.getPath). */
  runtimeDir: string;
  /** 런타임 pip 스펙(기본 RUNTIME_WHEEL_VERSION 의 wheel URL). 로컬 경로/버전 핀도 가능. */
  runtimeSpec?: string;
  /** 주입 fetch(사설 인증서 정책·테스트). 기본 전역 fetch. */
  fetch?: typeof fetch;
  /** 트리플 강제(테스트/크로스). 기본은 현재 process.platform/arch. */
  triple?: string;
}

export interface InstallProgress {
  phase: 'download' | 'extract' | 'pip' | 'smoke' | 'done' | 'error';
  message: string;
  /** 0..1 (알 수 있을 때만). */
  fraction?: number;
}

export interface RuntimeStatus {
  installed: boolean;
  pythonPath: string;
  /** 설치된 xgen-agent-runtime 버전(있으면). */
  version?: string;
  /** 사이드카 모듈 import 되나(설치 무결성). */
  sidecarOk?: boolean;
}

/** 이 OS 의 python 실행파일 경로(설치 트리 기준 — 표준 레이아웃 <runtimeDir>/python/...). */
export function pythonExePath(runtimeDir: string): string {
  const root = join(runtimeDir, 'python');
  return process.platform === 'win32' ? join(root, 'python.exe') : join(root, 'bin', 'python3');
}

/** 런타임 루트 후보 — 표준(<dir>/python) 과 한 단계 더 깊은 레이아웃(<dir>/python/python).
 *  v1.62~1.66 설치본은 extraResources 의 from 이 상위 폴더라 번들/복사본이 한 단계 더
 *  깊게 들어갔다. 그 트리도 그대로 쓸 수 있게(재복사 없이) 둘 다 인정한다. */
export function pythonRootCandidates(runtimeDir: string): string[] {
  return [runtimeDir, join(runtimeDir, 'python')];
}

/** 실제로 존재하는 python 실행파일(표준 → 중첩 순). 없으면 표준 경로(존재 X). */
export function resolvePythonExe(runtimeDir: string): {
  python: string;
  root: string;
  exists: boolean;
} {
  for (const root of pythonRootCandidates(runtimeDir)) {
    const python = pythonExePath(root);
    if (existsSync(python)) return { python, root, exists: true };
  }
  return { python: pythonExePath(runtimeDir), root: runtimeDir, exists: false };
}

/** 현재(또는 주입) OS/arch → python-build-standalone install_only 트리플. */
export function resolveTriple(triple?: string): string {
  if (triple) return triple;
  const a = process.arch;
  const arch = a === 'arm64' ? 'aarch64' : a === 'x64' ? 'x86_64' : null;
  if (!arch) throw new Error(`지원하지 않는 arch: ${a}`);
  if (process.platform === 'linux') return `${arch}-unknown-linux-gnu`;
  if (process.platform === 'darwin') return `${arch}-apple-darwin`;
  if (process.platform === 'win32') return `${arch}-pc-windows-msvc`;
  throw new Error(`지원하지 않는 platform: ${process.platform}`);
}

export function pythonArchiveUrl(triple: string): string {
  const name = `cpython-${PBS_PYTHON}+${PBS_RELEASE}-${triple}-install_only.tar.gz`;
  return `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/${name}`;
}

/**
 * 빠른 상태 — **파일 존재 기반**(python 실행 없음). UI/라우팅 판정용.
 * 실행 스모크(getStatus)는 사용자 머신의 보안 정책/환경에 따라 실패해
 * "내장돼 있는데 준비 중"으로 오표시될 수 있다(실기) — 존재가 진실이고,
 * 실제 실행 문제는 턴 시점 error 로 드러난다. 버전은 dist-info 파일에서.
 */
export function getStatusFast(deps: InstallDeps): RuntimeStatus {
  const py = pythonExePath(deps.runtimeDir);
  if (!existsSync(py)) return { installed: false, pythonPath: py };
  // 사이드카 모듈 파일이 실제로 있는지(반쪽 복사/손상 트리 판별) — python 실행 없이.
  const sidecarOk = sitePackagesDirs(deps.runtimeDir).some((sp) =>
    existsSync(join(sp, 'xgen_agent_runtime', 'host', 'sidecar.py')),
  );
  return {
    installed: sidecarOk,
    pythonPath: py,
    version: readInstalledVersion(deps.runtimeDir),
    sidecarOk,
  };
}

/** 이 런타임 트리의 site-packages 후보들(OS 별 레이아웃). */
export function sitePackagesDirs(runtimeDir: string): string[] {
  if (process.platform === 'win32') return [join(runtimeDir, 'python', 'Lib', 'site-packages')];
  const lib = join(runtimeDir, 'python', 'lib');
  try {
    return readdirSync(lib)
      .filter((d) => d.startsWith('python3'))
      .map((d) => join(lib, d, 'site-packages'));
  } catch {
    return [];
  }
}

/** 번들 스탬프 파일 경로 — <runtimeDir>/python/RUNTIME_VERSION (형식: <runtime version>\n<python tag>). */
export function runtimeVersionStampPath(runtimeDir: string): string {
  return join(runtimeDir, 'python', 'RUNTIME_VERSION');
}

/** 번들 스탬프(RUNTIME_VERSION 첫 줄)의 버전 — 없거나 형식이 아니면 undefined. */
export function readStampVersion(runtimeDir: string): string | undefined {
  try {
    const stamp = readFileSync(runtimeVersionStampPath(runtimeDir), 'utf-8')
      .split(/\r?\n/)[0]
      .trim();
    if (/^\d+\.\d+\.\d+/.test(stamp)) return stamp;
  } catch {
    /* 스탬프 없음 */
  }
  return undefined;
}

/** site-packages 의 xgen_agent_runtime dist-info 에서 버전 읽기(실행 없이). 없으면 undefined. */
export function readDistInfoVersion(runtimeDir: string): string | undefined {
  for (const sp of sitePackagesDirs(runtimeDir)) {
    try {
      const di = readdirSync(sp).find((d) => /^xgen_agent_runtime-.*\.dist-info$/.test(d));
      if (!di) continue;
      const meta = readFileSync(join(sp, di, 'METADATA'), 'utf-8');
      const m = /^Version:\s*(\S+)/m.exec(meta);
      if (m) return m[1];
      const vm = /^xgen_agent_runtime-([^-]+)\.dist-info$/.exec(di);
      if (vm) return vm[1];
    } catch {
      /* 다음 루트 */
    }
  }
  return undefined;
}

/**
 * 설치된 런타임 버전(실행 없이) — **dist-info 우선**, 없으면 번들 스탬프(RUNTIME_VERSION).
 * 번들은 용량 절감으로 dist-info 를 지우므로 스탬프만 남지만, pip 로 wheel 을 올리면
 * dist-info 가 새 버전으로 생긴다 — 그때 낡은 스탬프를 믿으면 수렴기가 매번 'upgrade' 를
 * 다시 계획하고 UI 가 옛 버전을 보인다(감사 #16). 업그레이드 성공 시 스탬프도 새로 쓴다.
 */
export function readInstalledVersion(runtimeDir: string): string | undefined {
  return readDistInfoVersion(runtimeDir) ?? readStampVersion(runtimeDir);
}

/**
 * 번들 스탬프(RUNTIME_VERSION) 첫 줄을 새 버전으로 다시 쓴다(둘째 줄 python 태그는 보존).
 * 파일이 없으면 만든다. 실패는 무시(스탬프는 보조 정보 — dist-info 가 진실).
 */
export function writeRuntimeVersionStamp(runtimeDir: string, version: string): boolean {
  const path = runtimeVersionStampPath(runtimeDir);
  try {
    let rest: string[] = [];
    try {
      rest = readFileSync(path, 'utf-8').split(/\r?\n/).slice(1);
    } catch {
      /* 새로 만든다 */
    }
    const tail = rest.filter((l) => l.trim()).join('\n');
    writeFileSync(path, `${version}\n${tail ? `${tail}\n` : ''}`);
    return true;
  } catch {
    return false;
  }
}

/** 설치 상태 조회 — python 존재 + runtime 버전 + 사이드카 import 여부. */
export async function getStatus(deps: InstallDeps): Promise<RuntimeStatus> {
  const py = pythonExePath(deps.runtimeDir);
  if (!existsSync(py)) return { installed: false, pythonPath: py };
  let version: string | undefined;
  let sidecarOk = false;
  try {
    const { stdout } = await execFileP(
      py,
      ['-I', '-c', 'import importlib.metadata as m; print(m.version("xgen-agent-runtime"))'],
      { windowsHide: true },
    );
    version = stdout.trim() || undefined;
  } catch {
    /* 버전 조회 실패 — 설치 불완전 */
  }
  try {
    await execFileP(py, ['-I', '-c', 'import xgen_agent_runtime.host.sidecar'], {
      windowsHide: true,
    });
    sidecarOk = true;
  } catch {
    sidecarOk = false;
  }
  return { installed: sidecarOk, pythonPath: py, version, sidecarOk };
}

async function download(url: string, dest: string, fetchImpl: typeof fetch): Promise<void> {
  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`다운로드 실패 ${res.status}: ${url}`);
  await pipeline(
    Readable.fromWeb(res.body as import('stream/web').ReadableStream),
    createWriteStream(dest),
  );
}

/**
 * 로컬 실행 환경 설치 — 이식형 Python + runtime(host 포함). 진행률은 onProgress.
 * 실패는 throw 하지 않고 {ok:false, error} 로 돌려 UI 가 표시하게 한다.
 */
export async function installLocalRuntime(
  deps: InstallDeps,
  onProgress: (p: InstallProgress) => void,
): Promise<{ ok: boolean; status?: RuntimeStatus; error?: string }> {
  const fetchImpl = deps.fetch ?? fetch;
  const runtimeSpec = deps.runtimeSpec ?? DEFAULT_RUNTIME_WHEEL;
  const pyRoot = join(deps.runtimeDir, 'python');
  // 목적지와 같은 드라이브에 임시 dir — 윈도우에서 TEMP 가 다른 드라이브면
  // renameSync 가 EXDEV 로 실패한다(러너 실기).
  mkdirSync(deps.runtimeDir, { recursive: true });
  const tmp = mkdtempSync(join(deps.runtimeDir, '.tmp-'));
  const tarball = join(tmp, 'python.tar.gz');
  // ⚠ 비파괴: 새 트리를 임시 위치에 **완성한 뒤** 기존 트리와 바꾼다. 다운로드/
  // pip 가 중간에 실패해도 지금 동작하는 런타임은 그대로 남는다(예전엔 먼저
  // 지워서 네트워크 한 번 끊기면 런타임이 사라졌다).
  try {
    const triple = resolveTriple(deps.triple);
    onProgress({ phase: 'download', message: `이식형 Python 다운로드 (${triple})…` });
    await download(pythonArchiveUrl(triple), tarball, fetchImpl);

    onProgress({ phase: 'extract', message: 'Python 추출 중…' });
    // install_only tarball 은 최상위 python/ 로 풀린다.
    await execFileP('tar', ['-xzf', tarball, '-C', tmp], { windowsHide: true });
    const extracted = join(tmp, 'python');
    if (!existsSync(extracted)) throw new Error('추출 결과에 python/ 없음');
    const stagedRoot = join(tmp, 'staged');
    mkdirSync(stagedRoot, { recursive: true });
    renameSync(extracted, join(stagedRoot, 'python'));

    const py = pythonExePath(stagedRoot);
    if (!existsSync(py)) throw new Error(`python 실행파일 없음: ${py}`);

    onProgress({ phase: 'pip', message: '에이전트 런타임 설치 중(수 분 소요)…' });
    await execFileP(py, ['-m', 'pip', 'install', '--no-warn-script-location', runtimeSpec], {
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });

    onProgress({ phase: 'smoke', message: '설치 검증 중…' });
    await execFileP(py, ['-I', '-c', 'import xgen_agent_runtime.host.sidecar'], {
      windowsHide: true,
    });

    // 완성된 트리로 교체 — 기존 트리는 .old 로 밀어 두고 성공 후 삭제.
    const old = join(deps.runtimeDir, '.python.old');
    rmSync(old, { recursive: true, force: true });
    if (existsSync(pyRoot)) renameSync(pyRoot, old);
    renameSync(join(stagedRoot, 'python'), pyRoot);
    rmSync(old, { recursive: true, force: true });

    const status = await getStatus(deps);
    onProgress({ phase: 'done', message: `설치 완료 (runtime ${status.version ?? '?'})` });
    return { ok: true, status };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    onProgress({ phase: 'error', message: `설치 실패: ${error}` });
    // 기존 트리는 건드리지 않았다 — 실패해도 이전 런타임은 그대로 동작한다.
    return { ok: false, error };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * 런타임 wheel 만 교체(Python 은 그대로) — 서버 매니페스트의 wheel_url 로 수렴할 때.
 * `pip install --upgrade <wheel>` + import 스모크. 실패해도 기존 설치본은 남는다
 * (pip 는 실패 시 이전 배포를 유지한다).
 */
export async function upgradeRuntimeWheel(
  deps: InstallDeps,
  wheelUrl: string,
  onProgress: (p: InstallProgress) => void,
): Promise<{ ok: boolean; version?: string; error?: string }> {
  const py = pythonExePath(deps.runtimeDir);
  if (!existsSync(py)) return { ok: false, error: '로컬 런타임(Python)이 설치되어 있지 않습니다' };
  try {
    onProgress({
      phase: 'pip',
      message: `에이전트 런타임 업데이트 중 (${wheelUrl.split('/').pop()})…`,
    });
    await execFileP(
      py,
      ['-m', 'pip', 'install', '--no-warn-script-location', '--upgrade', wheelUrl],
      {
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
    );
    onProgress({ phase: 'smoke', message: '업데이트 검증 중…' });
    await execFileP(py, ['-I', '-c', 'import xgen_agent_runtime.host.sidecar'], {
      windowsHide: true,
    });
    // 설치된 진짜 버전(dist-info)으로 번들 스탬프를 덮어쓴다 — 낡은 스탬프가 남아
    // 수렴기가 'upgrade' 를 되풀이하고 UI 가 옛 버전을 보이던 문제(감사 #16).
    const distVersion = readDistInfoVersion(deps.runtimeDir);
    if (distVersion) writeRuntimeVersionStamp(deps.runtimeDir, distVersion);
    const version = distVersion ?? readInstalledVersion(deps.runtimeDir);
    onProgress({ phase: 'done', message: `런타임 업데이트 완료 (${version ?? '?'})` });
    return { ok: true, version };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    onProgress({ phase: 'error', message: `런타임 업데이트 실패: ${error}` });
    return { ok: false, error };
  }
}
