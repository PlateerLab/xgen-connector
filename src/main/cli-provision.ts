/**
 * cli-provision — 커넥터의 로컬 실행용 **CLI 바이너리**(codex / Claude Code)를
 * 공식 배포처에서 설치·관리한다. 서버가 부팅 시 CLI 를 갖추는 것과 동형으로,
 * 커넥터도 모든 provider 의 실행환경을 스스로 갖춘다 — 그리고 **서버와 같은
 * 버전**으로 수렴한다(서버 런타임 매니페스트의 target 버전; 없으면 최신/안정).
 *
 * 설치 위치: <설치폴더>/local-runtime/bin/{codex[.exe], claude[.exe]}
 *   (Python 런타임과 같은 독립 트리 — 시스템 PATH 를 건드리지 않는다.)
 * CLI 홈 격리: <설치폴더>/local-runtime/{codex-home, claude-home}
 *   (사용자 개인 ~/.codex, ~/.claude 와 분리 — 사이드카가 CODEX_HOME /
 *    CLAUDE_CONFIG_DIR 로 주입; 서버 중앙 자격증명이 여기로 물질화된다.)
 *
 * 공식 소스(실검증):
 *   codex  — github.com/openai/codex 릴리스: `releases/download/rust-v<ver>/<자산>`
 *            (버전 지정) 또는 `releases/latest/download/<자산>` (최신)
 *   claude — downloads.claude.ai/claude-code-releases:
 *            `/stable`(버전 텍스트) → `/{v}/{platform}/claude[.exe]`
 *            + `/{v}/manifest.json` 의 sha256 으로 무결성 검증
 *
 * 사이드카 주입: 설치돼 있으면 local-chat-route 가 turn context.settings 에
 * CODEX_BINARY_PATH / CLAUDE_CODE_BINARY_PATH + 격리 홈을 넣는다 — LocalHostServices 가
 * 그대로 읽어 CLI 클라이언트가 이 바이너리를 스폰한다.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type CliTool = 'codex' | 'claude';

export interface CliDeps {
  /** local-runtime 루트 — bin/ 아래에 설치한다. */
  runtimeDir: string;
  fetch?: typeof fetch;
  /** 플랫폼 강제(테스트). 기본 process.platform/arch. */
  platform?: NodeJS.Platform;
  arch?: string;
}

export interface CliProgress {
  tool: CliTool;
  phase: 'resolve' | 'download' | 'extract' | 'verify' | 'done' | 'error';
  message: string;
}

export interface CliToolStatus {
  installed: boolean;
  path: string;
  version?: string;
}
export interface CliStatus {
  codex: CliToolStatus;
  claude: CliToolStatus;
}

const CODEX_RELEASES = 'https://github.com/openai/codex/releases';
const CLAUDE_BASE = 'https://downloads.claude.ai/claude-code-releases';

function binDir(deps: CliDeps): string {
  return join(deps.runtimeDir, 'bin');
}
function exeName(tool: CliTool, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${tool}.exe` : tool;
}
export function cliBinaryPath(deps: CliDeps, tool: CliTool): string {
  return join(binDir(deps), exeName(tool, deps.platform ?? process.platform));
}
/** CLI 격리 홈(설치 폴더 아래) — codex-home / claude-home. */
export function cliHomeDir(deps: Pick<CliDeps, 'runtimeDir'>, tool: CliTool): string {
  return join(deps.runtimeDir, tool === 'codex' ? 'codex-home' : 'claude-home');
}
function stampPath(deps: CliDeps): string {
  return join(binDir(deps), '.versions.json');
}
function readStamp(deps: CliDeps): Record<string, string> {
  try {
    return JSON.parse(readFileSync(stampPath(deps), 'utf-8')) as Record<string, string>;
  } catch {
    return {};
  }
}
function writeStamp(deps: CliDeps, tool: CliTool, version: string): void {
  const s = readStamp(deps);
  s[tool] = version;
  writeFileSync(stampPath(deps), JSON.stringify(s, null, 2));
}

/** codex 릴리스의 고정 자산명 — 플랫폼/arch 별 (실검증: latest/download 200). */
export function codexAssetName(platform: NodeJS.Platform, arch: string): string {
  const a = arch === 'arm64' ? 'aarch64' : 'x86_64';
  if (platform === 'linux') return `codex-${a}-unknown-linux-musl.tar.gz`;
  if (platform === 'darwin') return `codex-${a}-apple-darwin.tar.gz`;
  if (platform === 'win32') return `codex-${a}-pc-windows-msvc.exe.zip`;
  throw new Error(`지원하지 않는 platform: ${platform}`);
}

/** codex 자산 URL — 버전 지정이면 rust-v<ver> 태그, 아니면 latest. */
export function codexAssetUrl(platform: NodeJS.Platform, arch: string, version?: string): string {
  const asset = codexAssetName(platform, arch);
  const v = (version ?? '').trim().replace(/^v/, '');
  if (v && /^\d+\.\d+\.\d+/.test(v)) return `${CODEX_RELEASES}/download/rust-v${v}/${asset}`;
  return `${CODEX_RELEASES}/latest/download/${asset}`;
}

/** claude 배포 플랫폼 키 (manifest.json 의 키와 동일). */
export function claudePlatformKey(platform: NodeJS.Platform, arch: string): string {
  const a = arch === 'arm64' ? 'arm64' : 'x64';
  if (platform === 'linux') return `linux-${a}`;
  if (platform === 'darwin') return `darwin-${a}`;
  if (platform === 'win32') return `win32-${a}`;
  throw new Error(`지원하지 않는 platform: ${platform}`);
}

export function getCliStatus(deps: CliDeps, opts?: { probe?: boolean }): CliStatus {
  const stamp = readStamp(deps);
  const one = (tool: CliTool): CliToolStatus => {
    const p = cliBinaryPath(deps, tool);
    const installed = existsSync(p);
    let version = stamp[tool];
    // 스탬프가 없는 설치본(구버전이 latest 로 깔아 버전을 못 적은 경우) — 실행파일의
    // --version 으로 한 번 확정하고 스탬프에 적어 둔다(이후엔 실행 없음).
    if (installed && opts?.probe !== false && !/^\d+\.\d+\.\d+/.test(version ?? '')) {
      const probed = probeCliVersion(deps, tool);
      if (probed) {
        version = probed;
        try {
          writeStamp(deps, tool, probed);
        } catch {
          /* 스탬프 쓰기 실패 — 다음에 다시 프로브 */
        }
      }
    }
    return { installed, path: p, version };
  };
  return { codex: one('codex'), claude: one('claude') };
}

/** 실행 파일의 실제 버전(--version) — 스탬프가 없거나 의심스러울 때. */
export function probeCliVersion(deps: CliDeps, tool: CliTool): string | undefined {
  const p = cliBinaryPath(deps, tool);
  if (!existsSync(p)) return undefined;
  try {
    const out = execFileSync(p, ['--version'], { timeout: 15_000, windowsHide: true }).toString();
    const m = /(\d+\.\d+\.\d+)/.exec(out);
    return m?.[1];
  } catch {
    return undefined;
  }
}

async function download(url: string, dest: string, fetchImpl: typeof fetch): Promise<Response> {
  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`다운로드 실패 ${res.status}: ${url}`);
  await pipeline(
    Readable.fromWeb(res.body as import('stream/web').ReadableStream),
    createWriteStream(dest),
  );
  return res;
}

export interface CliInstallOptions {
  /** 목표 버전(서버 매니페스트 target). 없으면 codex=latest / claude=stable. */
  version?: string;
}

/** codex 설치 — 자산 다운로드 → tar 추출(zip 도 bsdtar) → bin/ 배치. */
export async function installCodexCli(
  deps: CliDeps,
  onProgress: (p: CliProgress) => void,
  opts?: CliInstallOptions,
): Promise<{ ok: boolean; version?: string; error?: string }> {
  const fetchImpl = deps.fetch ?? fetch;
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  mkdirSync(binDir(deps), { recursive: true });
  // 같은 드라이브 임시(EXDEV 방지 — 윈도우 TEMP≠설치 드라이브 가능).
  const tmp = mkdtempSync(join(binDir(deps), '.tmp-'));
  try {
    const asset = codexAssetName(platform, arch);
    const url = codexAssetUrl(platform, arch, opts?.version);
    onProgress({
      tool: 'codex',
      phase: 'download',
      message: `codex 다운로드 (${opts?.version ? `v${opts.version}` : 'latest'}, ${asset})…`,
    });
    const archive = join(tmp, asset);
    const res = await download(url, archive, fetchImpl);
    // 리다이렉트 최종 URL 의 태그(rust-vX.Y.Z)에서 버전(추정 — 설치 후 --version 이 진실).
    const m = /\/(rust-v?[^/]+)\/(?:[^/]+)$/.exec(res.url || '');
    const tagVersion = (m?.[1] ?? opts?.version ?? 'latest').replace(/^rust-v?/, '');

    onProgress({ tool: 'codex', phase: 'extract', message: 'codex 추출 중…' });
    execFileSync('tar', ['-xf', archive, '-C', tmp], { windowsHide: true }); // bsdtar: tar.gz + zip 모두
    // 추출물에서 codex 실행 **파일** 찾기 — 정확한 이름(codex[.exe]) 우선, 그다음
    // 자산명과 같은 이름의 파일(codex-x86_64-…). 디렉터리는 절대 고르지 않는다.
    const want = exeName('codex', platform);
    const entries = readdirSync(tmp).filter((f) => f !== asset);
    const isFile = (f: string) => {
      try {
        return statSync(join(tmp, f)).isFile();
      } catch {
        return false;
      }
    };
    const found =
      entries.find((f) => f === want && isFile(f)) ??
      entries.find((f) => /^codex(-[a-z0-9_.-]+)?(\.exe)?$/i.test(f) && isFile(f));
    if (!found) throw new Error('추출물에서 codex 실행파일을 찾지 못함');
    const target = cliBinaryPath(deps, 'codex');
    const staged = join(tmp, `${want}.staged`);
    renameSync(join(tmp, found), staged);
    if (platform !== 'win32') chmodSync(staged, 0o755);
    // 설치본의 `--version` 출력("codex-cli X.Y.Z")이 정확한 진실이다.
    let version = tagVersion;
    try {
      const out = execFileSync(staged, ['--version'], {
        timeout: 15_000,
        windowsHide: true,
      }).toString();
      const vm = /(\d+\.\d+\.\d+)/.exec(out);
      if (vm) version = vm[1];
    } catch {
      /* 버전 조회 실패 — 태그 추정치 유지 */
    }
    rmSync(target, { force: true });
    renameSync(staged, target);
    if (/^\d+\.\d+\.\d+/.test(version)) writeStamp(deps, 'codex', version);
    onProgress({ tool: 'codex', phase: 'done', message: `codex 설치 완료 (v${version})` });
    return { ok: true, version };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    onProgress({ tool: 'codex', phase: 'error', message: `codex 설치 실패: ${error}` });
    return { ok: false, error };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** claude 설치 — (지정 버전 | stable) → 플랫폼 바이너리 → manifest sha256 검증 → bin/. */
export async function installClaudeCli(
  deps: CliDeps,
  onProgress: (p: CliProgress) => void,
  opts?: CliInstallOptions,
): Promise<{ ok: boolean; version?: string; error?: string }> {
  const fetchImpl = deps.fetch ?? fetch;
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  mkdirSync(binDir(deps), { recursive: true });
  const tmp = mkdtempSync(join(binDir(deps), '.tmp-'));
  try {
    let version = (opts?.version ?? '').trim().replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+/.test(version)) {
      onProgress({ tool: 'claude', phase: 'resolve', message: 'Claude Code 버전 확인(stable)…' });
      const vres = await fetchImpl(`${CLAUDE_BASE}/stable`, { redirect: 'follow' });
      if (!vres.ok) throw new Error(`버전 조회 실패 ${vres.status}`);
      version = (await vres.text()).trim();
      if (!/^\d+\.\d+\.\d+/.test(version))
        throw new Error(`버전 형식 이상: ${version.slice(0, 40)}`);
    }

    const key = claudePlatformKey(platform, arch);
    const file = platform === 'win32' ? 'claude.exe' : 'claude';
    onProgress({
      tool: 'claude',
      phase: 'download',
      message: `Claude Code v${version} 다운로드 (${key})…`,
    });
    const tmpBin = join(tmp, file);
    await download(`${CLAUDE_BASE}/${version}/${key}/${file}`, tmpBin, fetchImpl);

    // manifest sha256 검증(공식 설치 스크립트 동형) — 없으면 스킵(best-effort).
    onProgress({ tool: 'claude', phase: 'verify', message: '무결성 검증…' });
    try {
      const mres = await fetchImpl(`${CLAUDE_BASE}/${version}/manifest.json`);
      if (mres.ok) {
        const manifest = (await mres.json()) as {
          platforms?: Record<string, { checksum?: string }>;
        };
        const want = manifest.platforms?.[key]?.checksum;
        if (want) {
          const got = createHash('sha256').update(readFileSync(tmpBin)).digest('hex');
          if (got !== want)
            throw new Error(
              `sha256 불일치 (기대 ${want.slice(0, 12)}…, 실제 ${got.slice(0, 12)}…)`,
            );
        }
      }
    } catch (e) {
      if (e instanceof Error && /sha256/.test(e.message)) throw e; // 불일치는 치명
      /* manifest 조회 실패 — 검증 스킵 */
    }

    const target = cliBinaryPath(deps, 'claude');
    if (platform !== 'win32') chmodSync(tmpBin, 0o755);
    rmSync(target, { force: true });
    renameSync(tmpBin, target);
    writeStamp(deps, 'claude', version);
    onProgress({ tool: 'claude', phase: 'done', message: `Claude Code 설치 완료 (v${version})` });
    return { ok: true, version };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    onProgress({ tool: 'claude', phase: 'error', message: `Claude Code 설치 실패: ${error}` });
    return { ok: false, error };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * 서버 목표 버전으로 수렴 — 설치돼 있고 스탬프가 목표와 같으면 no-op, 아니면 설치.
 * target 이 없으면(채널 조회 실패/미지정) 미설치일 때만 최신/안정 설치.
 */
export async function ensureCliConverged(
  deps: CliDeps,
  tool: CliTool,
  target: string | null | undefined,
  onProgress: (p: CliProgress) => void,
): Promise<{ ok: boolean; changed: boolean; version?: string; error?: string }> {
  const st = getCliStatus(deps)[tool];
  const want = (target ?? '').trim().replace(/^v/, '');
  const current = st.installed ? (st.version ?? probeCliVersion(deps, tool)) : undefined;
  if (st.installed && (!want || current === want))
    return { ok: true, changed: false, version: current };
  const r =
    tool === 'codex'
      ? await installCodexCli(deps, onProgress, { version: want || undefined })
      : await installClaudeCli(deps, onProgress, { version: want || undefined });
  return { ok: r.ok, changed: r.ok, version: r.version, error: r.error };
}

/**
 * 격리 홈에 물질화되는 **자격증명 파일** — 로그아웃/계정 전환 시 지워야 한다(감사 #41).
 *   codex  : <codex-home>/auth.json (LocalHostServices._materialize_codex_credentials,
 *            서버 중앙 CODEX_CREDENTIALS_JSON 을 파일로) + 쓰다 만 auth.json.tmp-*
 *   claude : <claude-home>/.credentials.json (Claude Code 가 로그인 시 쓰는 토큰 파일 — 런타임은
 *            setup_token 을 env 로만 주지만, CLI 가 파일을 남겼을 수 있다) + .tmp-*
 */
export const CLI_CREDENTIAL_FILES: Record<CliTool, string[]> = {
  codex: ['auth.json'],
  claude: ['.credentials.json'],
};

/**
 * 격리 홈의 자격증명 파일 삭제 — 로그아웃/계정 전환 시. 바이너리·설정(xgen-local-settings.json)
 * 은 남긴다(다음 로그인에 재사용). 없는 파일/홈은 조용히 넘어간다.
 */
export function purgeCliCredentials(deps: Pick<CliDeps, 'runtimeDir'>): {
  removed: string[];
  errors: string[];
} {
  const removed: string[] = [];
  const errors: string[] = [];
  for (const tool of ['codex', 'claude'] as const) {
    const home = cliHomeDir(deps, tool);
    let entries: string[];
    try {
      entries = readdirSync(home);
    } catch {
      continue; // 홈 없음
    }
    for (const name of CLI_CREDENTIAL_FILES[tool]) {
      for (const f of entries) {
        if (f !== name && !f.startsWith(`${name}.tmp-`)) continue;
        const p = join(home, f);
        try {
          rmSync(p, { force: true });
          removed.push(p);
        } catch (e) {
          errors.push(`${p}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }
  return { removed, errors };
}

/**
 * 사이드카 turn 에 주입할 CLI settings — 설치된 바이너리 경로 + **격리 홈**.
 * LocalHostServices.setting() 이 context.settings 를 우선 읽으므로, 이 값이
 * codex/claude_code provider 의 바이너리·홈 해석을 이 PC 설치본으로 고정한다.
 */
export function cliSettings(deps: CliDeps): Record<string, string> {
  const s = getCliStatus(deps);
  const out: Record<string, string> = {};
  if (s.codex.installed) out.CODEX_BINARY_PATH = s.codex.path;
  if (s.claude.installed) out.CLAUDE_CODE_BINARY_PATH = s.claude.path;
  for (const [tool, key] of [
    ['codex', 'XGEN_LOCAL_CODEX_HOME'],
    ['claude', 'XGEN_LOCAL_CLAUDE_CONFIG_DIR'],
  ] as const) {
    const home = cliHomeDir(deps, tool);
    try {
      mkdirSync(home, { recursive: true });
    } catch {
      /* 생성 실패 — 사이드카가 기본 홈으로 폴백 */
      continue;
    }
    out[key] = home;
  }
  return out;
}
