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
 */
import type { RuntimeManifest, ServerClient } from './local-agent-server-client';
import { ensureCliConverged, getCliStatus, type CliDeps, type CliProgress } from './cli-provision';
import {
  getStatusFast,
  upgradeRuntimeWheel,
  type InstallDeps,
  type InstallProgress,
} from './local-runtime-install';

export interface ConvergeState {
  /** 마지막으로 받은 서버 매니페스트(없으면 v1 서버/미로그인). */
  manifest: RuntimeManifest | null;
  manifestAt?: number;
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
  const rtTarget = want(manifest?.runtime?.version);
  const runtimeAction: ConvergePlan['runtime']['action'] = !local.runtimeInstalled
    ? 'skip-missing-python'
    : flags?.autoRuntime === false || !rtTarget || rtTarget === local.runtimeVersion
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

  constructor(private deps: () => ConvergeDeps) {}

  status(): ConvergeState {
    return { ...this.state };
  }

  /** 매니페스트만 갱신(설치는 하지 않음). v1 서버면 null. */
  async refreshManifest(): Promise<RuntimeManifest | null> {
    const d = this.deps();
    try {
      const m = await d.server.fetchRuntimeManifest();
      this.state.manifest = m;
      this.state.manifestAt = Date.now();
      return m;
    } catch (err) {
      d.log?.(`manifest 조회 실패(서버 v1 이거나 미연결): ${(err as Error).message}`);
      return null;
    }
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
      const manifest = await this.refreshManifest();
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
