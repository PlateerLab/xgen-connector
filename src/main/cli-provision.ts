/**
 * cli-provision — 커넥터의 로컬 실행용 **CLI 바이너리**(codex / Claude Code)를
 * 공식 배포처에서 설치·관리한다. 서버가 부팅 시 CLI 를 갖추는 것과 동형으로,
 * 커넥터도 모든 provider 의 실행환경을 스스로 갖춘다.
 *
 * 설치 위치: <userData>/local-runtime/bin/{codex[.exe], claude[.exe]}
 *   (Python 런타임과 같은 독립 트리 — 시스템 PATH 를 건드리지 않는다.)
 *
 * 공식 소스(실검증):
 *   codex  — github.com/openai/codex 릴리스, `releases/latest/download/<고정 자산명>`
 *            (플랫폼별 tar.gz/zip; 리다이렉트 URL 의 태그에서 버전 추출)
 *   claude — downloads.claude.ai/claude-code-releases:
 *            `/stable`(버전 텍스트) → `/{v}/{platform}/claude[.exe]`
 *            + `/{v}/manifest.json` 의 sha256 으로 무결성 검증
 *
 * 사이드카 주입: 설치돼 있으면 local-chat-route 가 turn context.settings 에
 * CODEX_BINARY_PATH / CLAUDE_CODE_BINARY_PATH 로 넣는다 — LocalHostServices 의
 * setting() 이 그대로 읽어 CLI 클라이언트가 이 바이너리를 스폰한다.
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

const CODEX_LATEST = 'https://github.com/openai/codex/releases/latest/download';
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

/** claude 배포 플랫폼 키 (manifest.json 의 키와 동일). */
export function claudePlatformKey(platform: NodeJS.Platform, arch: string): string {
  const a = arch === 'arm64' ? 'arm64' : 'x64';
  if (platform === 'linux') return `linux-${a}`;
  if (platform === 'darwin') return `darwin-${a}`;
  if (platform === 'win32') return `win32-${a}`;
  throw new Error(`지원하지 않는 platform: ${platform}`);
}

export function getCliStatus(deps: CliDeps): CliStatus {
  const stamp = readStamp(deps);
  const one = (tool: CliTool): CliToolStatus => {
    const p = cliBinaryPath(deps, tool);
    return { installed: existsSync(p), path: p, version: stamp[tool] };
  };
  return { codex: one('codex'), claude: one('claude') };
}

async function download(url: string, dest: string, fetchImpl: typeof fetch): Promise<Response> {
  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`다운로드 실패 ${res.status}: ${url}`);
  await pipeline(Readable.fromWeb(res.body as import('stream/web').ReadableStream), createWriteStream(dest));
  return res;
}

/** codex 설치 — latest 자산 다운로드 → tar 추출(zip 도 bsdtar) → bin/ 배치. */
export async function installCodexCli(
  deps: CliDeps,
  onProgress: (p: CliProgress) => void,
): Promise<{ ok: boolean; version?: string; error?: string }> {
  const fetchImpl = deps.fetch ?? fetch;
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  mkdirSync(binDir(deps), { recursive: true });
  // 같은 드라이브 임시(EXDEV 방지 — 윈도우 TEMP≠설치 드라이브 가능).
  const tmp = mkdtempSync(join(binDir(deps), '.tmp-'));
  try {
    const asset = codexAssetName(platform, arch);
    onProgress({ tool: 'codex', phase: 'download', message: `codex 다운로드 (${asset})…` });
    const archive = join(tmp, asset);
    const res = await download(`${CODEX_LATEST}/${asset}`, archive, fetchImpl);
    // 리다이렉트 최종 URL 의 태그(rust-vX.Y.Z)에서 버전(추정 — 설치 후 --version 이 진실).
    const m = /\/(rust-v?[^/]+)\/(?:[^/]+)$/.exec(res.url || '');
    const tagVersion = (m?.[1] ?? 'latest').replace(/^rust-v?/, '');

    onProgress({ tool: 'codex', phase: 'extract', message: 'codex 추출 중…' });
    execFileSync('tar', ['-xf', archive, '-C', tmp]); // bsdtar: tar.gz + zip 모두
    // 추출물에서 codex 실행파일 찾기(자산명 그대로 or codex[.exe]).
    const want = exeName('codex', platform);
    const cand = readdirSync(tmp).filter((f) => f !== asset && /^codex.*(\.exe)?$/i.test(f));
    const found = cand.find((f) => f === want) ?? cand[0];
    if (!found) throw new Error('추출물에서 codex 실행파일을 찾지 못함');
    const target = cliBinaryPath(deps, 'codex');
    rmSync(target, { force: true });
    renameSync(join(tmp, found), target);
    if (platform !== 'win32') chmodSync(target, 0o755);
    // 리다이렉트 태그 파싱은 자산 URL 형태에 따라 빗나갈 수 있다 — 설치본의
    // `--version` 출력("codex-cli X.Y.Z")이 정확한 진실이다.
    let version = tagVersion;
    try {
      const out = execFileSync(target, ['--version'], { timeout: 15_000 }).toString();
      const vm = /(\d+\.\d+\.\d+)/.exec(out);
      if (vm) version = vm[1];
    } catch {
      /* 버전 조회 실패 — 태그 추정치 유지 */
    }
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

/** claude 설치 — stable 버전 → 플랫폼 바이너리 → manifest sha256 검증 → bin/. */
export async function installClaudeCli(
  deps: CliDeps,
  onProgress: (p: CliProgress) => void,
): Promise<{ ok: boolean; version?: string; error?: string }> {
  const fetchImpl = deps.fetch ?? fetch;
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  mkdirSync(binDir(deps), { recursive: true });
  const tmp = mkdtempSync(join(binDir(deps), '.tmp-'));
  try {
    onProgress({ tool: 'claude', phase: 'resolve', message: 'Claude Code 버전 확인…' });
    const vres = await fetchImpl(`${CLAUDE_BASE}/stable`, { redirect: 'follow' });
    if (!vres.ok) throw new Error(`버전 조회 실패 ${vres.status}`);
    const version = (await vres.text()).trim();
    if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`버전 형식 이상: ${version.slice(0, 40)}`);

    const key = claudePlatformKey(platform, arch);
    const file = platform === 'win32' ? 'claude.exe' : 'claude';
    onProgress({ tool: 'claude', phase: 'download', message: `Claude Code v${version} 다운로드 (${key})…` });
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
          if (got !== want) throw new Error(`sha256 불일치 (기대 ${want.slice(0, 12)}…, 실제 ${got.slice(0, 12)}…)`);
        }
      }
    } catch (e) {
      if (e instanceof Error && /sha256/.test(e.message)) throw e; // 불일치는 치명
      /* manifest 조회 실패 — 검증 스킵 */
    }

    const target = cliBinaryPath(deps, 'claude');
    rmSync(target, { force: true });
    renameSync(tmpBin, target);
    if (platform !== 'win32') chmodSync(target, 0o755);
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
 * 사이드카 turn 에 주입할 CLI 경로 settings — 설치된 것만.
 * LocalHostServices.setting() 이 context.settings 를 우선 읽으므로, 이 값이
 * codex/claude_code provider 의 바이너리 해석을 이 PC 설치본으로 고정한다.
 */
export function cliSettings(deps: CliDeps): Record<string, string> {
  const s = getCliStatus(deps);
  const out: Record<string, string> = {};
  if (s.codex.installed) out.CODEX_BINARY_PATH = s.codex.path;
  if (s.claude.installed) out.CLAUDE_CODE_BINARY_PATH = s.claude.path;
  return out;
}
