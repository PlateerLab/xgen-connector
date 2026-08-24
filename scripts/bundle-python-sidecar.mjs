#!/usr/bin/env node
/**
 * bundle-python-sidecar — 커넥터 로컬 실행 사이드카(Python)를 앱 리소스로 담는다.
 *
 * 커넥터는 커넥터-세션 턴을 `python -m xgen_agent_runtime.host.sidecar` 로 로컬 실행한다
 * (src/main/local-agent-sidecar.ts). 그러려면 **이식형 Python + 런타임/host 패키지**
 * 가 앱에 번들되어야 한다. 이 스크립트가 그 트리를 `resources/python-sidecar/` 로
 * 조립하고, electron-builder 의 extraResources 가 앱 `resources/python` 으로 복사한다
 * (resolveSidecarCommand 의 packaged 경로 `<resources>/python/...` 와 정렬).
 *
 * 조립 단계(각 OS 러너에서 prepackage 로 실행):
 *   1) 이식형 CPython(astral-sh/python-build-standalone, install_only) 다운로드/추출
 *      → resources/python-sidecar/python  (bin/python3 | python.exe)
 *   2) 그 python 으로 런타임 설치(사이드카 xgen_agent_runtime.host 포함):
 *        python -m pip install <RUNTIME_SPEC>
 *      기본 SPEC 은 워크스페이스 로컬 경로(../xgen-agent-runtime).
 *      CI 는 wheel URL/버전 핀으로 env 오버라이드.
 *   3) 용량 절감: __pycache__ / *.dist-info / tests 정리.
 *
 * env 오버라이드:
 *   PBS_RELEASE          python-build-standalone 릴리스 태그(날짜). 기본 최신 핀.
 *   PBS_PYTHON           CPython 버전(예 3.12.11).
 *   PBS_TRIPLE           타깃 트리플 강제(크로스). 기본은 현재 OS/arch 로 해석.
 *   XGEN_RUNTIME_SPEC    pip 스펙(경로/URL/`xgen-agent-runtime==x`). 기본 로컬 경로.
 *   XGEN_SIDECAR_SKIP=1  조립 스킵(로컬 dev — env 폴백 사용).
 *
 * ⚠ 실제 다운로드·설치는 **네트워크와 각 OS 러너**가 필요하다 — 로컬 dev 는 번들
 * 대신 env(XGEN_SIDECAR_PYTHON/XGEN_SIDECAR_PYTHONPATH)로 시스템 Python 을 쓴다.
 * 그래서 네트워크/러너가 없으면 이 스크립트는 실패가 아니라 **스킵**한다(빌드 무중단).
 *
 * electron-builder.yml 에 추가할 스니펫(트리 생성 검증 후 적용):
 *   extraResources:
 *     - from: resources/python-sidecar
 *       to: python
 *       filter: ['**\/*']
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createWriteStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONNECTOR = resolve(HERE, '..');
const WORKSPACE = resolve(CONNECTOR, '..');
const OUT = join(CONNECTOR, 'resources', 'python-sidecar');
const PY_DIR = join(OUT, 'python');

const PBS_RELEASE = process.env.PBS_RELEASE || '20250808';
const PBS_PYTHON = process.env.PBS_PYTHON || '3.12.11';
// host(turn executor + sidecar)는 xgen-agent-runtime 안(xgen_agent_runtime.host)
// 으로 합쳐졌다 — 런타임 하나만 설치하면 사이드카까지 들어온다.
// 기본 SPEC: 워크스페이스 로컬 경로(개발) → 없으면 릴리스 wheel(CI — 커넥터
// 저장소만 체크아웃돼 로컬 경로가 없다).
// ⚠ src/main/local-runtime-install.ts 의 RUNTIME_WHEEL_VERSION 과 같은 버전이어야 한다
//   (test/bundle-layout.test.ts 가 잠근다 — .mjs 는 TS 상수를 import 하지 못한다).
const RELEASED_RUNTIME_VERSION = '3.8.3';
const RELEASED_RUNTIME_WHEEL = `https://github.com/PlateerLab/xgen-agent-runtime/releases/download/v${RELEASED_RUNTIME_VERSION}/xgen_agent_runtime-${RELEASED_RUNTIME_VERSION}-py3-none-any.whl`;
const localRuntimePath = join(WORKSPACE, 'xgen-agent-runtime');
const RUNTIME_SPEC =
  process.env.XGEN_RUNTIME_SPEC ||
  (existsSync(localRuntimePath) ? localRuntimePath : RELEASED_RUNTIME_WHEEL);

function log(m) {
  process.stdout.write(`[bundle-python-sidecar] ${m}\n`);
}

/** 현재(또는 강제) OS/arch → python-build-standalone install_only 트리플. */
function resolveTriple() {
  if (process.env.PBS_TRIPLE) return process.env.PBS_TRIPLE;
  const p = process.platform;
  const a = process.arch;
  const arch = a === 'arm64' ? 'aarch64' : a === 'x64' ? 'x86_64' : null;
  if (!arch) throw new Error(`지원하지 않는 arch: ${a}`);
  if (p === 'linux') return `${arch}-unknown-linux-gnu`;
  if (p === 'darwin') return `${arch}-apple-darwin`;
  if (p === 'win32') return `${arch}-pc-windows-msvc`;
  throw new Error(`지원하지 않는 platform: ${p}`);
}

function archiveUrl(triple) {
  // install_only 변형 = 바로 실행 가능한 python. win 은 .tar.gz 도 제공된다.
  const name = `cpython-${PBS_PYTHON}+${PBS_RELEASE}-${triple}-install_only.tar.gz`;
  return `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/${name}`;
}

async function download(url, dest) {
  log(`다운로드: ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`다운로드 실패 ${res.status}: ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

function pythonExe(root) {
  return process.platform === 'win32' ? join(root, 'python.exe') : join(root, 'bin', 'python3');
}

function cleanTree(root) {
  // __pycache__ / tests / *.dist-info 재귀 삭제(용량).
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '__pycache__' || e.name === 'tests' || e.name === 'test') {
          rmSync(full, { recursive: true, force: true });
        } else {
          stack.push(full);
        }
      }
    }
  }
}

async function main() {
  // extraResources 가 이 dir 를 복사한다 — **없으면 패키징이 실패**하므로 스킵
  // 경로에서도 빈 트리는 항상 만들어 둔다(빈 번들 = 사이드카 해석이 폴백).
  mkdirSync(OUT, { recursive: true });
  // extraResources 의 from 은 OUT/python — 스킵 경로에서도 디렉터리는 있어야 패키징이
  // 실패하지 않는다(빈 트리 = 앱이 "앱 내장: 없음" 으로 정직하게 표시).
  mkdirSync(PY_DIR, { recursive: true });
  // 이전 실행이 크래시로 남긴 임시 트리 정리 — extraResources 에 실리면 안 된다.
  for (const e of readdirSync(OUT)) {
    if (e.startsWith('.tmp-')) rmSync(join(OUT, e), { recursive: true, force: true });
  }
  if (process.env.XGEN_SIDECAR_SKIP === '1') {
    log('XGEN_SIDECAR_SKIP=1 — 조립 스킵(dev env 폴백).');
    return;
  }
  if (existsSync(pythonExe(PY_DIR))) {
    log(`이미 조립됨 — 스킵 (${PY_DIR}). 다시 만들려면 이 폴더를 지운다.`);
    return;
  }

  let triple;
  try {
    triple = resolveTriple();
  } catch (e) {
    log(`⚠ 트리플 해석 불가(${e.message}) — 스킵. dev 는 env 폴백 사용.`);
    return;
  }

  // ⚠ OS 임시 폴더가 아니라 **목적지와 같은 드라이브**에 임시 dir 를 만든다 —
  // 윈도우 러너는 TEMP=C:, 워크스페이스=D: 라 renameSync 가 EXDEV 로 죽는다(실기).
  const tmp = mkdtempSync(join(OUT, '.tmp-'));
  const tarball = join(tmp, 'python.tar.gz');
  try {
    // 1) 이식형 CPython.
    await download(archiveUrl(triple), tarball);
    log('추출 중…');
    // install_only tarball 은 최상위 `python/` 로 풀린다.
    execFileSync('tar', ['-xzf', tarball, '-C', tmp], { stdio: 'inherit' });
    const extracted = join(tmp, 'python');
    if (!existsSync(extracted)) throw new Error('추출 결과에 python/ 없음');
    rmSync(PY_DIR, { recursive: true, force: true });
    renameSync(extracted, PY_DIR);

    const py = pythonExe(PY_DIR);
    if (!existsSync(py)) throw new Error(`python 실행파일 없음: ${py}`);
    log(`Python: ${py}`);

    // 2) 런타임 설치(사이드카 xgen_agent_runtime.host 포함).
    log(`설치: ${RUNTIME_SPEC}`);
    execFileSync(py, ['-m', 'pip', 'install', '--no-warn-script-location', RUNTIME_SPEC], {
      stdio: 'inherit',
    });

    // 3) 정리.
    log('정리(__pycache__/tests)…');
    cleanTree(PY_DIR);

    // 런타임 버전 스탬프 — 인스톨러가 "이미 같은 버전이 설치돼 있으면 재복사 생략" 을 판정하는 데 쓴다
    // (dist-info 를 NSIS 가 읽기 어렵다). 형식: <runtime version>\n<python tag>
    const rtVer = execFileSync(py, [
      '-c',
      'import importlib.metadata as m; print(m.version("xgen-agent-runtime"))',
    ])
      .toString()
      .trim();
    writeFileSync(join(PY_DIR, 'RUNTIME_VERSION'), `${rtVer}\n${PBS_PYTHON}+${PBS_RELEASE}\n`);
    log(`스탬프: RUNTIME_VERSION = ${rtVer} (python ${PBS_PYTHON}+${PBS_RELEASE})`);

    // 스모크: sidecar 모듈이 import 되나.
    execFileSync(py, ['-c', 'import xgen_agent_runtime.host.sidecar; print("sidecar OK")'], {
      stdio: 'inherit',
    });
    const bytes = dirSize(PY_DIR);
    log(`완료 — ${PY_DIR} (${(bytes / 1e6).toFixed(0)} MB)`);
  } catch (e) {
    // 네트워크/러너 부재 등 — dev 빌드를 막지 않는다(env 폴백). CI 는 실패로 보게
    // XGEN_SIDECAR_STRICT=1 로 강제 가능.
    rmSync(PY_DIR, { recursive: true, force: true });
    if (process.env.XGEN_SIDECAR_STRICT === '1') throw e;
    log(`⚠ 조립 실패(${e.message}) — 스킵. dev 는 XGEN_SIDECAR_PYTHON env 로 진행.`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function dirSize(root) {
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else {
        try {
          total += statSync(full).size;
        } catch {
          /* skip */
        }
      }
    }
  }
  return total;
}

main().catch((e) => {
  process.stderr.write(`bundle-python-sidecar 실패: ${e?.stack || e}\n`);
  process.exit(1);
});
