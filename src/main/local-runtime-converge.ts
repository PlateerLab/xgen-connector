/**
 * local-runtime-converge — 커넥터의 로컬 실행 환경을 **서버와 같은 버전**으로 맞춘다.
 *
 * 서버(xgen-workflow)는 `GET /api/agentflow/geny-agent/local-runtime/manifest` 로
 * 자기 런타임(xgen-agent-runtime wheel) 버전과 Claude Code / Codex 의 목표 버전을
 * 준다. 커넥터는 로그인 직후(그리고 설정의 [서버 버전으로 맞추기])에 이 매니페스트를
 * 받아:
 *   1) 런타임 wheel 이 다르면 설치 폴더의 Python 에 `pip install <wheel>` (Python 자체는
 *      다시 받지 않는다 — 수십 MB 의 wheel + 의존만),
 *   2) Claude Code / Codex 가 목표 버전이 아니면 공식 배포처에서 그 버전을 설치한다.
 * 실패는 상태로만 드러나고(lastError) 기존 설치본은 그대로 둔다 — 무소음·비파괴.
 *
 * 서버가 v1(매니페스트 엔드포인트 없음)이면 "수렴 대상 없음"으로 끝난다(로컬 실행은
 * 현재 설치본으로 계속 동작).
 *
 * 마지막 매니페스트는 <runtimeDir>/server-manifest.json 에 **영속**한다 — 다음 부팅에
 * 서버가 답하기 전(미로그인/오프라인)에도 CLI 자동 설치가 서버 목표 버전을 쓰게(감사 #40).
 * 런타임 wheel 업그레이드가 성공하면 onRuntimeUpgraded 훅으로 상주 사이드카를 내리고
 * ensurer 캐시를 비운다 — 다음 턴이 새 런타임으로 뜨게(감사 #17).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeManifest, ServerClient } from './local-agent-server-client';
import { ensureCliConverged, getCliStatus, type CliDeps, type CliProgress } from './cli-provision';
import {
  getStatusFast,
  upgradeRuntimeWheel,
  type InstallDeps,
  type InstallProgress,
} from './local-runtime-install';

/** 영속 매니페스트 파일 이름(<runtimeDir> 아래). */
export const MANIFEST_CACHE_FILE = 'server-manifest.json';
/** 영속 매니페스트 경로. */
export function manifestCachePath(runtimeDir: string): string {
  return join(runtimeDir, MANIFEST_CACHE_FILE);
}

/** 영속 매니페스트 읽기 — 없거나 깨졌으면 null. */
export function loadManifestCache(file: string): { manifest: RuntimeManifest; at: number } | null {
  try {
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as {
      manifest?: RuntimeManifest;
      at?: number;
    };
    if (!raw || typeof raw !== 'object' || !raw.manifest || typeof raw.manifest !== 'object')
      return null;
    if (!raw.manifest.runtime || typeof raw.manifest.runtime !== 'object') return null;
    return { manifest: raw.manifest, at: typeof raw.at === 'number' ? raw.at : 0 };
  } catch {
    return null;
  }
}

/** 영속 매니페스트 쓰기(원자적 rename). 실패는 무시 — 캐시일 뿐. */
export function saveManifestCache(file: string, manifest: RuntimeManifest, at: number): boolean {
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ at, manifest }, null, 2));
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** 사이드카 데몬의 최소 표면(테스트 주입용) — SidecarDaemon 과 구조적으로 호환. */
export interface SidecarLike {
  status(): { running: boolean; activeTurns: number };
  shutdown(): void;
}

/**
 * 런타임 업그레이드 뒤 상주 사이드카를 **유휴 시점에** 내린다 — 활성 턴이 없으면 즉시,
 * 있으면 끝날 때까지(폴링) 기다렸다가 내린다. 데몬은 다음 턴에 새 런타임으로 다시 뜬다
 * (SidecarDaemon.runTurn → ensure). 돌지 않는 데몬은 건드리지 않는다.
 */
export function restartSidecarWhenIdle(
  daemon: SidecarLike,
  opts?: { pollMs?: number; maxWaitMs?: number; log?: (m: string) => void },
): { done: Promise<'shutdown' | 'not-running' | 'timeout'>; cancel: () => void } {
  const pollMs = opts?.pollMs ?? 2_000;
  const maxWaitMs = opts?.maxWaitMs ?? 30 * 60_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  let settle: ((r: 'shutdown' | 'not-running' | 'timeout') => void) | null = null;
  const started = Date.now();
  const done = new Promise<'shutdown' | 'not-running' | 'timeout'>((resolve) => {
    settle = resolve;
    const tick = () => {
      if (cancelled) return resolve('not-running');
      const st = daemon.status();
      if (!st.running) {
        opts?.log?.('런타임 업그레이드 — 사이드카 미기동(다음 턴에 새 런타임)');
        return resolve('not-running');
      }
      if (st.activeTurns === 0) {
        opts?.log?.('런타임 업그레이드 — 유휴 사이드카 종료(다음 턴에 새 런타임으로 재기동)');
        daemon.shutdown();
        return resolve('shutdown');
      }
      if (Date.now() - started >= maxWaitMs) {
        opts?.log?.('런타임 업그레이드 — 사이드카가 계속 바쁨, 재기동 대기 포기');
        return resolve('timeout');
      }
      timer = setTimeout(tick, pollMs);
      timer.unref?.();
    };
    tick();
  });
  return {
    done,
    cancel: () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      settle?.('not-running');
    },
  };
}

export interface ConvergeState {
  /** 마지막으로 받은 서버 매니페스트(없으면 v1 서버/미로그인). 디스크 캐시에서 복원될 수 있다. */
  manifest: RuntimeManifest | null;
  manifestAt?: number;
  /** 매니페스트 출처 — 이번 세션에 서버가 준 것인가, 이전 세션의 디스크 캐시인가. */
  manifestSource?: 'server' | 'cache';
  /** 진행 중인지. */
  running: boolean;
  lastRunAt?: number;
  lastError?: string;
  /** 마지막 실행의 요약(UI 한 줄). */
  summary?: string;
}

export interface ConvergeDeps {
  server: ServerClient;
  runtimeDir: string;
  fetch?: typeof fetch;
  /** 런타임 wheel 설치를 건너뛴다(인스톨러 체크 해제). */
  autoRuntime?: boolean;
  autoCodex?: boolean;
  autoClaude?: boolean;
  onProgress?: (p: InstallProgress | CliProgress) => void;
  log?: (m: string) => void;
  /** 마지막 매니페스트 영속 파일. 기본 <runtimeDir>/server-manifest.json, null 이면 영속 안 함. */
  manifestFile?: string | null;
  /** 런타임 wheel 업그레이드 **성공** 후 훅 — 사이드카 유휴 재기동·ensurer 캐시 무효화 배선. */
  onRuntimeUpgraded?: (info: { from?: string; to?: string }) => void;
}

export interface ConvergePlan {
  runtime: {
    current?: string;
    target?: string;
    action: 'none' | 'upgrade' | 'skip-missing-python';
  };
  codex: { current?: string; target?: string | null; action: 'none' | 'install' };
  claude: { current?: string; target?: string | null; action: 'none' | 'install' };
}

/** 매니페스트 + 로컬 상태 → 해야 할 일(순수 함수, 테스트 대상). */
export function planConverge(
  manifest: RuntimeManifest | null,
  local: {
    runtimeInstalled: boolean;
    runtimeVersion?: string;
    codex: { installed: boolean; version?: string };
    claude: { installed: boolean; version?: string };
  },
  flags?: { autoRuntime?: boolean; autoCodex?: boolean; autoClaude?: boolean },
): ConvergePlan {
  const want = (v?: string | null) => (v ?? '').trim().replace(/^v/, '') || undefined;
  // semver 비교(숫자 3자리, 부족분 0). a>b → 1, a<b → -1, 같으면 0. 파싱 실패는 0(비교 보류).
  const cmpSemver = (a?: string, b?: string): number => {
    const pa = (a ?? '').split('.').map((x) => parseInt(x, 10));
    const pb = (b ?? '').split('.').map((x) => parseInt(x, 10));
    for (let i = 0; i < 3; i++) {
      const na = pa[i],
        nb = pb[i];
      if (Number.isNaN(na) || Number.isNaN(nb)) return 0;
      if (na !== nb) return na > nb ? 1 : -1;
    }
    return 0;
  };
  const rtTarget = want(manifest?.runtime?.version);
  // 런타임은 **다운그레이드하지 않는다**. 서버 매니페스트가 더 낮은 버전을 광고해도
  // (예: 서버 파드가 아직 이전 버전) 이미 설치된 더 높은 런타임을 끌어내리면 그 버전에서
  // 고친 버그(예: 3.8.1 memory_wire)가 되살아난다 — target 이 설치본보다 **높을 때만** 올린다.
  const runtimeAction: ConvergePlan['runtime']['action'] = !local.runtimeInstalled
    ? 'skip-missing-python'
    : flags?.autoRuntime === false || !rtTarget || cmpSemver(rtTarget, local.runtimeVersion) <= 0
      ? 'none'
      : 'upgrade';
  const cli = (
    st: { installed: boolean; version?: string },
    target: string | null | undefined,
    enabled: boolean | undefined,
    auto: boolean | undefined,
  ) => {
    const t = want(target);
    // 서버가 그 provider 를 껐으면 굳이 설치하지 않는다(이미 있으면 둔다).
    if (auto === false || enabled === false)
      return { current: st.version, target: t ?? null, action: 'none' as const };
    if (!st.installed) return { current: undefined, target: t ?? null, action: 'install' as const };
    if (t && st.version && st.version !== t)
      return { current: st.version, target: t, action: 'install' as const };
    return { current: st.version, target: t ?? null, action: 'none' as const };
  };
  return {
    runtime: { current: local.runtimeVersion, target: rtTarget, action: runtimeAction },
    codex: cli(local.codex, manifest?.codex?.target, manifest?.codex?.enabled, flags?.autoCodex),
    claude: cli(
      local.claude,
      manifest?.claude?.target,
      manifest?.claude?.enabled,
      flags?.autoClaude,
    ),
  };
}

export class LocalRuntimeConverger {
  private state: ConvergeState = { manifest: null, running: false };
  private inflight: Promise<ConvergeState> | null = null;
  private cacheLoaded = false;

  constructor(private deps: () => ConvergeDeps) {}

  private manifestFile(d: ConvergeDeps): string | null {
    if (d.manifestFile === null) return null;
    return d.manifestFile ?? manifestCachePath(d.runtimeDir);
  }

  /** 디스크 캐시를 1회 복원 — 서버가 답하기 전에도 마지막 목표 버전을 안다. */
  private loadCacheOnce(): void {
    if (this.cacheLoaded) return;
    this.cacheLoaded = true;
    const d = this.deps();
    const file = this.manifestFile(d);
    if (!file) return;
    const c = loadManifestCache(file);
    if (c && !this.state.manifest) {
      this.state.manifest = c.manifest;
      this.state.manifestAt = c.at || undefined;
      this.state.manifestSource = 'cache';
      d.log?.(`manifest 캐시 복원 (runtime ${c.manifest.runtime?.version ?? '?'})`);
    }
  }

  status(): ConvergeState {
    this.loadCacheOnce();
    return { ...this.state };
  }

  /** 매니페스트만 갱신(설치는 하지 않음). v1 서버/미연결이면 null(캐시된 값은 상태에 남는다). */
  async refreshManifest(): Promise<RuntimeManifest | null> {
    this.loadCacheOnce();
    const d = this.deps();
    try {
      const m = await d.server.fetchRuntimeManifest();
      this.state.manifest = m;
      this.state.manifestAt = Date.now();
      this.state.manifestSource = 'server';
      const file = this.manifestFile(d);
      if (file) saveManifestCache(file, m, this.state.manifestAt);
      return m;
    } catch (err) {
      d.log?.(`manifest 조회 실패(서버 v1 이거나 미연결): ${(err as Error).message}`);
      return null;
    }
  }

  /** 매니페스트 잊기(메모리+디스크) — 서버가 바뀌었을 때(구 서버의 목표 버전은 무의미). */
  clearManifest(): void {
    this.cacheLoaded = true;
    this.state.manifest = null;
    this.state.manifestAt = undefined;
    this.state.manifestSource = undefined;
    const file = this.manifestFile(this.deps());
    if (file) rmSync(file, { force: true });
  }

  /** 매니페스트 조회 + 수렴 실행. 동시 호출은 한 번만 돈다(single-flight). */
  converge(): Promise<ConvergeState> {
    if (this.inflight) return this.inflight;
    this.inflight = this.run().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async run(): Promise<ConvergeState> {
    const d = this.deps();
    this.state.running = true;
    this.state.lastError = undefined;
    const notes: string[] = [];
    try {
      // 서버가 답하지 않으면(오프라인/v1) 디스크 캐시의 마지막 매니페스트로 수렴한다.
      const manifest = (await this.refreshManifest()) ?? this.state.manifest;
      const rtDeps: InstallDeps = { runtimeDir: d.runtimeDir, fetch: d.fetch };
      const cliDeps: CliDeps = { runtimeDir: d.runtimeDir, fetch: d.fetch };
      const rt = getStatusFast(rtDeps);
      const cli = getCliStatus(cliDeps);
      const plan = planConverge(
        manifest,
        {
          runtimeInstalled: rt.installed,
          runtimeVersion: rt.version,
          codex: cli.codex,
          claude: cli.claude,
        },
        { autoRuntime: d.autoRuntime, autoCodex: d.autoCodex, autoClaude: d.autoClaude },
      );
      d.log?.(`plan ${JSON.stringify(plan)}`);
      const progress = (p: InstallProgress | CliProgress) => d.onProgress?.(p);

      if (plan.runtime.action === 'upgrade' && manifest?.runtime?.wheel_url) {
        const r = await upgradeRuntimeWheel(rtDeps, manifest.runtime.wheel_url, progress);
        notes.push(
          r.ok
            ? `런타임 ${plan.runtime.current ?? '?'}→${r.version ?? plan.runtime.target}`
            : `런타임 업그레이드 실패: ${r.error}`,
        );
        if (!r.ok) this.state.lastError = r.error;
        else {
          // 새 wheel 이 같은 python 트리에 들어갔다 — 상주 사이드카/캐시는 옛 코드다(감사 #17).
          try {
            d.onRuntimeUpgraded?.({ from: plan.runtime.current, to: r.version });
          } catch (e) {
            d.log?.(`onRuntimeUpgraded 훅 실패: ${(e as Error).message}`);
          }
        }
      } else if (plan.runtime.action === 'skip-missing-python') {
        notes.push('런타임 미설치(Python 없음)');
      }
      for (const tool of ['codex', 'claude'] as const) {
        const p = plan[tool];
        if (p.action !== 'install') continue;
        const r = await ensureCliConverged(cliDeps, tool, p.target ?? undefined, progress);
        notes.push(
          r.ok ? `${tool} v${r.version ?? p.target ?? '?'}` : `${tool} 설치 실패: ${r.error}`,
        );
        if (!r.ok) this.state.lastError = r.error;
      }
      this.state.summary = notes.length
        ? notes.join(' · ')
        : manifest
          ? '서버와 동일'
          : '서버 매니페스트 없음';
      this.state.lastRunAt = Date.now();
    } catch (err) {
      this.state.lastError = (err as Error).message;
    } finally {
      this.state.running = false;
    }
    return this.status();
  }
}
