/**
 * local-runtime-ensure — 로컬 실행 런타임(이식형 Python + xgen-agent-runtime)이 **항상
 * 쓸 수 있는 상태**가 되도록 보장하는 자가치유 사다리. 서버와 무관하게 동작한다.
 *
 * 런타임 후보(우선순위):
 *   1. 설치 폴더  <dataRoot>/local-runtime/python      (인스톨러가 복사 / 여기서 복구)
 *   2. 앱 내장 번들 <resources>/python                  (설치본에 동봉 — 복사 원본이자 즉시 폴백)
 *   3. 레거시     <userData>/local-runtime/python       (구버전 설치)
 * "쓸 수 있다"의 기준은 파일 존재가 아니라 **스모크**(python -c "import
 * xgen_agent_runtime.host.sidecar")다 — 반쪽 복사/손상 트리(Windows MAX_PATH 로 깊은
 * 파일이 빠진 경우 등)를 '설치됨'으로 오판하지 않는다. 스모크 결과는 후보별로
 * (python 실행파일 mtime 기준) 캐시한다.
 *
 * 사다리(ensure):
 *   · 설치 폴더 후보가 건강 → 끝.
 *   · 아니면 내장 번들이 건강 → 번들을 설치 폴더로 **복사**(Node fs.cp, Windows 는 \\?\
 *     긴 경로 접두로 MAX_PATH 우회) → 스모크 → 끝. 복사 중에도 라우팅은 번들을 바로 쓴다.
 *   · 번들도 없으면 → 네트워크 설치(이식형 Python 다운로드 + pip, 비파괴).
 * 모든 단계는 진행/실패를 상태로 남겨 설정 화면이 **현재 상태와 원인**을 그대로 보여준다.
 */
import { execFile } from 'node:child_process';
import { existsSync, promises as fsp, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  installLocalRuntime,
  pythonExePath,
  readInstalledVersion,
  resolvePythonExe,
  type InstallProgress,
} from './local-runtime-install';

const execFileP = promisify(execFile);

export type RuntimeSource = 'install' | 'bundle' | 'legacy';

export interface RuntimeCandidate {
  source: RuntimeSource;
  /** 런타임 루트(…/local-runtime 또는 resources) — python/ 의 부모. */
  runtimeDir: string;
  python: string;
  exists: boolean;
  /** 스모크 통과(캐시). undefined = 아직 안 돌림. */
  healthy?: boolean;
  version?: string;
  error?: string;
}

export interface EnsureState {
  phase: 'idle' | 'checking' | 'copying' | 'downloading' | 'ready' | 'failed';
  message?: string;
  lastError?: string;
  lastRunAt?: number;
  /** 지금 라우팅이 쓰는 런타임(건강한 첫 후보). */
  active?: { source: RuntimeSource; python: string; version?: string };
  candidates: RuntimeCandidate[];
}

export interface EnsureDeps {
  /** 설치 폴더 런타임 루트(<dataRoot>/local-runtime). */
  installDir: () => string;
  /** 앱 내장 번들 루트(<resources>) — 없으면 null. */
  bundleDir: () => string | null;
  /** 레거시 userData 런타임 루트 — 없으면 null. */
  legacyDir?: () => string | null;
  fetch?: typeof fetch;
  onProgress?: (p: InstallProgress) => void;
  log?: (m: string) => void;
  /** 테스트 주입: 스모크(기본 python -c import). */
  smoke?: (python: string) => Promise<{ ok: boolean; error?: string }>;
  /** 테스트 주입: 트리 복사(기본 fs.cp + 긴 경로). */
  copyTree?: (src: string, dst: string) => Promise<void>;
  /** 인스톨러에서 런타임 자동 설치를 껐나(false 면 버튼 외엔 복사/다운로드 안 함). */
  autoRepair?: () => boolean;
  /** 테스트 주입: 네트워크 설치. */
  download?: (
    runtimeDir: string,
    onProgress: (p: InstallProgress) => void,
  ) => Promise<{ ok: boolean; error?: string }>;
}

/** Windows 긴 경로(\\?\) 접두 — 260자 넘는 site-packages 경로를 fs.cp 가 다룰 수 있게. */
export function longPath(p: string): string {
  if (process.platform !== 'win32') return p;
  if (p.startsWith('\\\\?\\')) return p;
  if (/^[A-Za-z]:\\/.test(p)) return `\\\\?\\${p}`;
  if (p.startsWith('\\\\')) return `\\\\?\\UNC\\${p.slice(2)}`;
  return p;
}

/** 격리 인터프리터 env — 사용자 PYTHONHOME/PYTHONPATH/PYTHONSTARTUP 이 내장 런타임을 깨지 않게. */
export function isolatedPythonEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (/^PYTHON(HOME|PATH|STARTUP|USERBASE|SAFEPATH)$/i.test(k)) continue;
    env[k] = v;
  }
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONNOUSERSITE = '1';
  return env;
}

/**
 * 스모크: 사이드카 모듈 import + **sys.prefix 가 그 트리 안**인지 확인 — 심볼릭 링크가
 * 원본(번들)을 가리키는 껍데기 복사본(mac/linux fs.cp 기본 동작)을 '건강'으로 오판하지 않게.
 */
async function defaultSmoke(python: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const { stdout } = await execFileP(
      python,
      [
        '-I',
        '-X',
        'utf8',
        '-c',
        'import os,sys; import xgen_agent_runtime.host.sidecar; print(os.path.realpath(sys.prefix))',
      ],
      { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, env: isolatedPythonEnv(), windowsHide: true },
    );
    const prefix = String(stdout || '').trim();
    if (prefix) {
      const { realpathSync } = await import('node:fs');
      const { dirname, resolve, sep } = await import('node:path');
      let root = dirname(python);
      if (process.platform !== 'win32') root = dirname(root); // …/python/bin/python3 → …/python
      const rootReal = realpathSync(root);
      const inside = resolve(prefix) === rootReal || resolve(prefix).startsWith(rootReal + sep);
      if (!inside)
        return {
          ok: false,
          error: `sys.prefix=${prefix} 가 런타임 트리(${rootReal}) 밖 — 링크 껍데기 복사본`,
        };
    }
    return { ok: true };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return { ok: false, error: (err.stderr || err.message || String(e)).slice(-400) };
  }
}

async function defaultCopyTree(src: string, dst: string): Promise<void> {
  // verbatimSymlinks: bin/python3 → python3.12 같은 **상대** 링크를 그대로 보존한다(기본값은
  // 원본 절대 경로로 풀어 써 복사본이 번들/.app/AppImage 마운트를 가리키는 껍데기가 된다).
  await fsp.cp(longPath(src), longPath(dst), {
    recursive: true,
    force: true,
    errorOnExist: false,
    verbatimSymlinks: true,
  });
}

/**
 * 런타임 보장 — 상태는 status() 로 읽고, ensure() 는 single-flight.
 */
export class LocalRuntimeEnsurer {
  private state: EnsureState = { phase: 'idle', candidates: [] };
  private inflight: Promise<EnsureState> | null = null;
  private smokeInflight = new Map<string, Promise<RuntimeCandidate>>();
  private healthCache = new Map<
    string,
    { mtime: number; healthy: boolean; version?: string; error?: string }
  >();

  constructor(private deps: EnsureDeps) {}

  status(): EnsureState {
    return { ...this.state, candidates: this.state.candidates.map((c) => ({ ...c })) };
  }

  /** 후보 나열(파일 존재만 — 스모크 없음). */
  candidates(): RuntimeCandidate[] {
    const list: RuntimeCandidate[] = [];
    const push = (source: RuntimeSource, dir: string | null) => {
      if (!dir) return;
      // 표준(<dir>/python) → 중첩(<dir>/python/python) 순으로 실재하는 python 을 고른다.
      const r = resolvePythonExe(dir);
      const python = r.python;
      const exists = r.exists;
      const cached = exists ? this.cached(python) : undefined;
      list.push({
        source,
        runtimeDir: r.root,
        python,
        exists,
        healthy: cached?.healthy,
        version: exists ? (cached?.version ?? readInstalledVersion(r.root)) : undefined,
        error: cached?.error,
      });
    };
    push('install', this.deps.installDir());
    push('bundle', this.deps.bundleDir());
    push('legacy', this.deps.legacyDir?.() ?? null);
    return list;
  }

  private cached(python: string) {
    const c = this.healthCache.get(python);
    if (!c) return undefined;
    try {
      if (statSync(python).mtimeMs !== c.mtime) return undefined;
    } catch {
      return undefined;
    }
    return c;
  }

  /** 후보 스모크(캐시 + 같은 python 에 대한 동시 스모크는 하나로 합친다). */
  async check(c: RuntimeCandidate): Promise<RuntimeCandidate> {
    if (!c.exists) return { ...c, healthy: false };
    const cached = this.cached(c.python);
    if (cached)
      return { ...c, healthy: cached.healthy, version: cached.version, error: cached.error };
    const inflight = this.smokeInflight.get(c.python);
    if (inflight) {
      const r = await inflight;
      return { ...c, healthy: r.healthy, version: r.version, error: r.error };
    }
    const run = (async () => {
      const smoke = this.deps.smoke ?? defaultSmoke;
      const r = await smoke(c.python);
      let mtime = 0;
      try {
        mtime = statSync(c.python).mtimeMs;
      } catch {
        /* ignore */
      }
      const version = readInstalledVersion(c.runtimeDir);
      this.healthCache.set(c.python, { mtime, healthy: r.ok, version, error: r.error });
      return { ...c, healthy: r.ok, version, error: r.error };
    })().finally(() => this.smokeInflight.delete(c.python));
    this.smokeInflight.set(c.python, run);
    return run;
  }

  /** 지금 라우팅에 쓸 python — 건강한 첫 후보(설치 폴더 → 번들 → 레거시). 없으면 null. */
  activePython(): { source: RuntimeSource; python: string; version?: string } | null {
    const a = this.state.active;
    if (a && !existsSync(a.python)) {
      // 부팅 후 런타임이 사라졌다(업데이트 RMDir/AV 격리/사용자 삭제) — 낡은 active 를 믿지 않는다.
      this.healthCache.delete(a.python);
      this.state.active = undefined;
      return null;
    }
    return a ?? null;
  }

  /** 건강한 첫 후보를 찾아 active 로 기록(스모크 포함, 복구 없음). */
  async resolveActive(): Promise<EnsureState['active']> {
    // 후보 목록은 **스모크 전에** 먼저 상태에 싣는다 — 콜드 스모크(수십 초)가 도는 동안에도
    // 설정 화면이 "설치 폴더: 있음(검증 중)" 을 보여 줄 수 있게(빈 목록 = "없음" 오표시 방지).
    const cands: RuntimeCandidate[] = this.candidates();
    this.state.candidates = cands.map((c) => ({ ...c }));
    let active: EnsureState['active'];
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      const checked =
        c.exists && !active ? await this.check(c) : { ...c, healthy: c.exists ? c.healthy : false };
      cands[i] = checked;
      this.state.candidates = cands.map((x) => ({ ...x }));
      if (!active && checked.healthy)
        active = { source: checked.source, python: checked.python, version: checked.version };
    }
    this.state.active = active;
    return active;
  }

  /** 사다리 실행(single-flight). */
  ensure(reason = 'boot'): Promise<EnsureState> {
    if (this.inflight) return this.inflight;
    this.inflight = this.run(reason).finally(() => {
      this.inflight = null;
      // 최종 상태 1회 통지 — 설정 화면이 '검증 중'에 머물지 않게(설치 폴더 정상/복사 실패/예외
      // 경로는 그동안 진행 이벤트를 내지 않았다).
      this.deps.onProgress?.({
        phase: this.state.active ? 'done' : 'error',
        message: this.state.message ?? this.state.lastError ?? '',
      });
    });
    return this.inflight;
  }

  private progress(p: InstallProgress): void {
    this.state.message = p.message;
    this.deps.onProgress?.(p);
  }

  private async run(reason: string): Promise<EnsureState> {
    const log = this.deps.log ?? (() => {});
    this.state.phase = 'checking';
    this.state.lastError = undefined;
    this.state.lastRunAt = Date.now();
    try {
      const installDir = this.deps.installDir();
      const active = await this.resolveActive();
      const install = this.state.candidates.find((c) => c.source === 'install');
      if (install?.healthy) {
        this.state.phase = 'ready';
        this.state.message = `설치 폴더 런타임 준비됨 (${install.version ?? '?'})`;
        log(`ensure(${reason}): install ok ${install.version ?? ''}`);
        return this.status();
      }
      // 인스톨러에서 런타임 자동 설치를 끈 경우 — [지금 설치/복구] 버튼 외엔 복사/다운로드하지 않는다.
      if (reason !== 'button' && this.deps.autoRepair?.() === false) {
        this.state.phase = active ? 'ready' : 'failed';
        this.state.message = active
          ? '내장/기존 런타임 사용 중 (자동 설치·복구 꺼짐 — 인스톨러 선택)'
          : '런타임 없음 (자동 설치 꺼짐 — [지금 설치/복구]로 수동 설치)';
        log(`ensure(${reason}): autoRepair off — skip (active=${active?.source ?? 'none'})`);
        return this.status();
      }
      // 설치 폴더가 없거나 손상 — 번들이 건강하면 복사(그동안 라우팅은 번들 사용).
      const bundle = this.state.candidates.find((c) => c.source === 'bundle');
      if (bundle?.exists && (bundle.healthy ?? (await this.check(bundle)).healthy)) {
        this.state.phase = 'copying';
        this.progress({
          phase: 'extract',
          message: `내장 런타임을 설치 폴더로 복사 중… (${bundle.version ?? '?'})`,
        });
        log(
          `ensure(${reason}): copy bundle → ${installDir} (install ${install?.exists ? 'damaged' : 'missing'}: ${install?.error ?? ''})`,
        );
        const dst = join(installDir, 'python');
        const staging = join(installDir, '.python.new');
        const old = join(installDir, '.python.old');
        try {
          await fsp.mkdir(installDir, { recursive: true });
          await fsp.rm(longPath(staging), { recursive: true, force: true });
          await (this.deps.copyTree ?? defaultCopyTree)(join(bundle.runtimeDir, 'python'), staging);
          this.progress({ phase: 'smoke', message: '복사본 검증 중…' });
          const smoke = this.deps.smoke ?? defaultSmoke;
          const stagedPython =
            process.platform === 'win32'
              ? join(staging, 'python.exe')
              : join(staging, 'bin', 'python3');
          const r = await smoke(stagedPython);
          if (!r.ok) throw new Error(`복사본 스모크 실패: ${r.error ?? ''}`);
          await fsp.rm(longPath(old), { recursive: true, force: true });
          if (existsSync(dst)) await fsp.rename(dst, old);
          await fsp.rename(staging, dst);
          await fsp.rm(longPath(old), { recursive: true, force: true }).catch(() => {});
          this.healthCache.delete(pythonExePath(installDir));
          this.healthCache.delete(pythonExePath(join(installDir, 'python')));
          await this.resolveActive();
          this.state.phase = 'ready';
          this.progress({
            phase: 'done',
            message: `설치 폴더 런타임 준비됨 (${bundle.version ?? '?'})`,
          });
          return this.status();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.state.lastError = `번들 복사 실패: ${msg}`;
          log(`ensure(${reason}): copy failed: ${msg}`);
          await fsp.rm(longPath(staging), { recursive: true, force: true }).catch(() => {});
          // 번들 자체는 건강하므로 라우팅은 계속 번들로 — 실패는 상태로만 남긴다.
          this.state.phase = active ? 'ready' : 'failed';
          this.state.message = active ? `내장 런타임 사용 중 (설치 폴더 복사 실패)` : undefined;
          return this.status();
        }
      }
      // 번들 없음/손상 — 네트워크 설치(비파괴).
      this.state.phase = 'downloading';
      log(`ensure(${reason}): no healthy bundle (${bundle?.error ?? 'absent'}) — download`);
      const dl =
        this.deps.download ??
        ((dir: string, onProgress: (p: InstallProgress) => void) =>
          installLocalRuntime({ runtimeDir: dir, fetch: this.deps.fetch }, onProgress).then(
            (r) => ({ ok: r.ok, error: r.error }),
          ));
      const r = await dl(installDir, (p) => this.progress(p));
      if (!r.ok) {
        this.state.lastError = `런타임 설치 실패: ${r.error ?? ''}`;
        this.state.phase = active ? 'ready' : 'failed';
        return this.status();
      }
      this.healthCache.delete(pythonExePath(installDir));
      await this.resolveActive();
      this.state.phase = this.state.active ? 'ready' : 'failed';
      if (!this.state.active) this.state.lastError = '설치 후에도 런타임 스모크 실패';
      return this.status();
    } catch (e) {
      this.state.lastError = e instanceof Error ? e.message : String(e);
      this.state.phase = this.state.active ? 'ready' : 'failed';
      return this.status();
    }
  }
}
