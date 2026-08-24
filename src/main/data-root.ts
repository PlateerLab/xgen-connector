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
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ConnectorConfig } from './config';

/** 인스톨러가 남기는 선택 파일 이름 (userData 아래). */
export const INSTALL_OPTIONS_FILE = 'install-options.json';
/** 앱이 매 부팅 남기는 **실효 데이터 루트** 마커(userData 아래, 평문 1줄). 인스톨러(업데이트)와
 *  언인스톨러가 config.json 을 파싱하지 않고도 같은 루트를 보게 한다. */
export const DATA_ROOT_MARKER_FILE = 'data-root.txt';

/**
 * 인스톨러가 쓴 텍스트 디코드 — NSIS Unicode 빌드의 FileWrite 는 ANSI(CP949…)로 쓰고
 * FileWriteUTF16LE /BOM 은 UTF-16LE(BOM)로 쓴다. BOM 으로 판별하고, BOM 은 떼어 낸다
 * (한글 프로필 경로가 U+FFFD 로 깨져 config 에 저장되던 문제).
 */
export function readInstallerText(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe)
    return buf.subarray(2).toString('utf16le');
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
    return buf.subarray(3).toString('utf8');
  return buf.toString('utf8');
}

/**
 * 설치 로그 **한 줄** 디코드 — install.log 는 인스톨러(NSIS `FileWrite` = ANSI, 한국어 Windows 에선
 * CP949)와 앱(UTF-8)이 같은 파일에 이어 쓴다. 통째로 utf-8 로 읽으면 인스톨러 줄의 '→'/한글이
 * U+FFFD 로 깨진다(v1.68~1.70 설정 화면의 "copy done �� C:\…"). 줄마다
 *   BOM(FF FE) → UTF-16LE · 유효한 UTF-8 → 그대로 · 아니면 EUC-KR(CP949) · (ICU 부재) latin1
 * 순으로 판별한다. 끝의 \r 과 앞의 \0(UTF-16 줄 분할 잔여)은 떼어 낸다.
 */
export function decodeInstallerLogLine(line: Buffer): string {
  let b = line;
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return stripCr(b.subarray(2).toString('utf16le'));
  let start = 0;
  while (start < b.length && b[start] === 0x00) start++;
  if (start) b = b.subarray(start);
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  try {
    return stripCr(new TextDecoder('utf-8', { fatal: true }).decode(b));
  } catch {
    /* UTF-8 아님 — 인스톨러(ANSI) 줄 */
  }
  try {
    return stripCr(new TextDecoder('euc-kr').decode(b));
  } catch {
    return stripCr(b.toString('latin1'));
  }
}
function stripCr(s: string): string {
  return s.replace(/\r+$/, '');
}

/** 설치 로그 전체 → 줄 배열(줄별 인코딩 판별). 파일 전체가 UTF-16LE(BOM)면 그대로 한 번에. */
export function readInstallLogText(buf: Buffer): string[] {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe)
    return buf
      .subarray(2)
      .toString('utf16le')
      .split(/\r?\n/)
      .map((l) => l.replace(/^\uFEFF/, ''));
  const out: string[] = [];
  let from = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i === buf.length || buf[i] === 0x0a) {
      out.push(decodeInstallerLogLine(buf.subarray(from, i)));
      from = i + 1;
    }
  }
  return out;
}

/** 실효 데이터 루트 마커 기록(부팅마다) — 실패는 무시. */
export function writeDataRootMarker(userDataDir: string, root: string): void {
  try {
    mkdirSync(userDataDir, { recursive: true });
    // UTF-16LE(BOM 없음) — NSIS Unicode 빌드의 FileReadUTF16LE 가 그대로 읽는다(한글 경로 안전).
    writeFileSync(join(userDataDir, DATA_ROOT_MARKER_FILE), Buffer.from(root + '\r\n', 'utf16le'));
  } catch {
    /* 무시 */
  }
}

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
    opts = JSON.parse(readInstallerText(readFileSync(p))) as InstallOptions;
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
  if (typeof opts.dataRoot === 'string' && opts.dataRoot.trim())
    patch.dataRoot = opts.dataRoot.trim();
  const le: NonNullable<ConnectorConfig['localExec']> = {};
  if (typeof opts.autoRuntime === 'boolean') le.autoRuntime = opts.autoRuntime;
  if (typeof opts.autoCodex === 'boolean') le.autoCodex = opts.autoCodex;
  if (typeof opts.autoClaude === 'boolean') le.autoClaude = opts.autoClaude;
  if (Object.keys(le).length) patch.localExec = le;
  return Object.keys(patch).length ? patch : null;
}

// ── CLI 설치 스크립트 — 설치 폴더에 내장되는, 사람이 직접 실행 가능한 스크립트 ──
//
// 요구사항: 바이너리를 설치본에 싣지 않는다(용량). 대신 설치 폴더 루트에
// **공식 소스에서 <설치폴더>/local-runtime/bin 으로 설치하는 스크립트**를 둔다.
// 앱의 [설치] 버튼/부팅 프로비저닝(cli-provision)과 같은 소스·같은 목적지 —
// 스크립트는 그 과정을 투명하게 드러내고, 앱 없이도 수동 설치/복구를 가능하게
// 한다. 부팅마다 덮어써 항상 최신 내용을 유지한다.
// (win .cmd 는 콘솔 코드페이지 문제를 피해 영어 메시지 — curl/tar 는 Win10+ 내장.)

const SH_CODEX = `#!/bin/sh
# XGEN Connector — codex CLI 설치 (공식 install.sh: github.com/openai/codex)
# 설치 위치: <이 폴더>/local-runtime/bin/codex  (서버 파드와 같은 공식 채널)
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="$DIR/local-runtime/bin"; mkdir -p "$BIN"
curl -fsSL https://github.com/openai/codex/releases/latest/download/install.sh \\
  | CODEX_NON_INTERACTIVE=true CODEX_INSTALL_DIR="$BIN" sh
"$BIN/codex" --version
echo "installed: $BIN/codex"
`;

const SH_CLAUDE = `#!/bin/sh
# XGEN Connector — Claude Code CLI 설치 (공식 배포: downloads.claude.ai)
# 설치 위치: <이 폴더>/local-runtime/bin/claude
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="$DIR/local-runtime/bin"; mkdir -p "$BIN"
BASE="https://downloads.claude.ai/claude-code-releases"
V="$(curl -fsSL "$BASE/stable")"
case "$(uname -m)" in arm64|aarch64) A=arm64;; *) A=x64;; esac
case "$(uname -s)" in Darwin) P="darwin-$A";; *) P="linux-$A";; esac
URL="$BASE/$V/$P/claude"
echo "download: $URL"
curl -fsSL "$URL" -o "$BIN/claude"
chmod 755 "$BIN/claude"
"$BIN/claude" --version
echo "installed: $BIN/claude"
`;

const CMD_CODEX = `@echo off\r
rem XGEN Connector - install codex CLI (official: github.com/openai/codex)\r
rem installs to: <this folder>\\local-runtime\\bin\\codex.exe\r
setlocal\r
set "BIN=%~dp0local-runtime\\bin"\r
if not exist "%BIN%" mkdir "%BIN%"\r
set "ARCH=x86_64"\r
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=aarch64"\r
set "URL=https://github.com/openai/codex/releases/latest/download/codex-%ARCH%-pc-windows-msvc.exe.zip"\r
set "TMPD=%TEMP%\\xgen-codex-%RANDOM%"\r
mkdir "%TMPD%"\r
echo download: %URL%\r
curl -fsSL "%URL%" -o "%TMPD%\\codex.zip" || goto :fail\r
tar -xf "%TMPD%\\codex.zip" -C "%TMPD%" || goto :fail\r
for %%F in ("%TMPD%\\codex*.exe") do copy /Y "%%F" "%BIN%\\codex.exe" >nul\r
"%BIN%\\codex.exe" --version || goto :fail\r
rmdir /S /Q "%TMPD%" 2>nul\r
echo installed: %BIN%\\codex.exe\r
exit /b 0\r
:fail\r
echo install failed\r
rmdir /S /Q "%TMPD%" 2>nul\r
exit /b 1\r
`;

const CMD_CLAUDE = `@echo off\r
rem XGEN Connector - install Claude Code CLI (official: downloads.claude.ai)\r
rem installs to: <this folder>\\local-runtime\\bin\\claude.exe\r
setlocal\r
set "BIN=%~dp0local-runtime\\bin"\r
if not exist "%BIN%" mkdir "%BIN%"\r
set "BASE=https://downloads.claude.ai/claude-code-releases"\r
for /f %%V in ('curl -fsSL %BASE%/stable') do set "VER=%%V"\r
if "%VER%"=="" goto :fail\r
set "ARCH=x64"\r
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=arm64"\r
set "URL=%BASE%/%VER%/win32-%ARCH%/claude.exe"\r
echo download: %URL%\r
curl -fsSL "%URL%" -o "%BIN%\\claude.exe" || goto :fail\r
"%BIN%\\claude.exe" --version || goto :fail\r
echo installed: %BIN%\\claude.exe\r
exit /b 0\r
:fail\r
echo install failed\r
exit /b 1\r
`;

/**
 * 설치 폴더 루트에 CLI 설치 스크립트를 쓴다(부팅마다 덮어써 최신 유지).
 * POSIX: install-codex.sh / install-claude-code.sh (0755)
 * win  : install-codex.cmd / install-claude-code.cmd
 */
export function writeCliInstallScripts(
  root: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const out: string[] = [];
  const put = (name: string, body: string, exec: boolean) => {
    const p = join(root, name);
    writeFileSync(p, body);
    if (exec) {
      try {
        chmodSync(p, 0o755);
      } catch {
        /* fs 제약 — 실행 시 sh 로 */
      }
    }
    out.push(p);
  };
  if (platform === 'win32') {
    put('install-codex.cmd', CMD_CODEX, false);
    put('install-claude-code.cmd', CMD_CLAUDE, false);
  } else {
    put('install-codex.sh', SH_CODEX, true);
    put('install-claude-code.sh', SH_CLAUDE, true);
  }
  return out;
}
