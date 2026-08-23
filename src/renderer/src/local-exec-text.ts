/**
 * local-exec-text — 설정 → 설치 섹션의 **상태 문구**(순수 함수). 렌더러(Settings.tsx)가 쓰고
 * 테스트(test/local-exec-text.test.ts)가 문구 계약을 고정한다.
 *
 * 원칙: 상태만 보여 준다(토글 없음). 미검증(healthy===undefined)은 '손상'이 아니다 — 사다리는 첫
 * 건강한 후보에서 멈추므로 나머지 후보는 스모크를 안 돌렸을 뿐이다(v1.68~1.70 "앱 내장: 손상" 오표시).
 * "(없음)"/"(null)" 같은 내부 값은 절대 화면에 내지 않는다.
 */

export type RuntimeSourceLike = 'install' | 'bundle' | 'legacy';
export interface CandidateLike {
  source: RuntimeSourceLike;
  runtimeDir: string;
  python: string;
  exists: boolean;
  healthy?: boolean;
  version?: string;
  error?: string;
}
export interface EnsureLike {
  phase: 'idle' | 'checking' | 'copying' | 'downloading' | 'ready' | 'failed';
  message?: string;
  lastError?: string;
  active?: { source: RuntimeSourceLike; python: string; version?: string };
  candidates: CandidateLike[];
}
export interface ServerLike {
  runtime?: string;
  claude?: string | null;
  codex?: string | null;
  claudeAuth?: CliAuthLike | null;
  codexAuth?: CliAuthLike | null;
}
export interface CliAuthLike {
  mode?: string;
  ready?: boolean;
  source?: string | null;
}
export interface ConvergeLike {
  running: boolean;
  lastRunAt?: number;
  lastError?: string;
  summary?: string;
}

export const SOURCE_LABEL: Record<RuntimeSourceLike, string> = {
  install: '설치 폴더',
  bundle: '앱 내장',
  legacy: '이전 설치',
};

/** 부팅 오류 행의 한 줄 힌트. */
export const BOOT_ERROR_HINT = '앱을 다시 시작해도 남으면 진단 복사 후 공유';

function short(err?: string): string {
  return err ? ` — ${err.slice(0, 120)}` : '';
}

/**
 * 런타임 후보 한 개의 문구. healthy: true=정상 / false=실제 스모크 실패(손상) / undefined=미검증.
 *   설치 폴더: 설치됨 (3.8.0) | 손상(검증 실패) — … | 있음 (3.8.0, 검증 중) | 없음
 *   앱 내장:   있음 (3.8.0) | 손상 — … | 있음 (3.8.0, 미검증 — 설치 폴더 사용 중) | 없음 (경로)
 */
export function describeCandidate(
  c: CandidateLike | undefined,
  ctx: { activeSource?: RuntimeSourceLike; phase?: EnsureLike['phase'] },
  fallback?: { kind: RuntimeSourceLike; note?: string },
): string {
  const kind = c?.source ?? fallback?.kind ?? 'install';
  const label = SOURCE_LABEL[kind];
  if (!c) return `${label}: 없음${fallback?.note ? ` (${fallback.note})` : ''}`;
  const ver = c.version ?? '?';
  if (c.healthy === true) return `${label}: ${kind === 'install' ? '설치됨' : '있음'} (${ver})`;
  if (c.healthy === false)
    return `${label}: 손상${kind === 'install' ? '(검증 실패)' : ''}${short(c.error)}`;
  if (!c.exists) return `${label}: 없음${kind === 'install' ? '' : ` (${c.python})`}`;
  // 실재하지만 미검증 — 왜 미검증인지 말한다(다른 후보 사용 중 / 아직 검증 중).
  const busy = ctx.phase === 'checking' || ctx.phase === 'idle' || ctx.phase === 'copying';
  const usingOther = ctx.activeSource && ctx.activeSource !== kind;
  const why = usingOther
    ? `미검증 — ${SOURCE_LABEL[ctx.activeSource as RuntimeSourceLike]} 사용 중`
    : busy
      ? '검증 중'
      : '미검증';
  return `${label}: 있음 (${ver}, ${why})`;
}

/** 로컬 실행 런타임 행 전체 — 후보별 문구 + 서버 비교를 ' · ' 로 잇는다. */
export function describeRuntimeCandidates(st: {
  ensure?: EnsureLike | null;
  bundlePath?: string | null;
  isPackaged?: boolean;
  server?: ServerLike | null;
  version?: string;
}): string {
  const ensure = st.ensure ?? undefined;
  const cands = ensure?.candidates ?? [];
  const ctx = { activeSource: ensure?.active?.source, phase: ensure?.phase };
  const inst = cands.find((c) => c.source === 'install');
  const bun = cands.find((c) => c.source === 'bundle');
  const leg = cands.find((c) => c.source === 'legacy');
  const parts: string[] = [];
  parts.push(describeCandidate(inst, ctx, { kind: 'install' }));
  parts.push(
    describeCandidate(bun, ctx, {
      kind: 'bundle',
      note: `${st.bundlePath ?? '번들 경로 없음'}${st.isPackaged === false ? ', 개발 빌드' : ''}`,
    }),
  );
  if (leg?.exists) parts.push(describeCandidate(leg, ctx));
  if (st.server?.runtime) {
    const current = ensure?.active?.version ?? st.version;
    parts.push(
      st.server.runtime === current ? `서버와 동일 (${st.server.runtime})` : `서버 ${st.server.runtime}`,
    );
  }
  return parts.join(' · ');
}

const CLI_LABEL: Record<'codex' | 'claude', string> = { codex: 'Codex CLI', claude: 'Claude Code CLI' };

/**
 * 서버 버전 맞추기(수렴) 결과 한 줄. 수렴기의 summary("런타임 3.7.0→3.8.0 · codex v0.1")를 사람이 읽는
 * 문구로 — 같은 버전이면 "런타임 서버와 동일 (3.8.0)" (X→X 금지), CLI 부분도 그대로 보인다.
 */
export function describeConverge(
  conv: ConvergeLike | null | undefined,
  server?: ServerLike | null,
): string {
  if (!conv) return '—';
  if (conv.running) return '맞추는 중…';
  if (conv.lastError) return `실패: ${conv.lastError}`;
  if (!conv.summary) return conv.lastRunAt ? '완료' : '아직 실행 안 됨 (로그인 후 자동 실행)';
  const notes = conv.summary
    .split(' · ')
    .map((n) => n.trim())
    .filter(Boolean)
    .map((n) => {
      let m = /^런타임 (\S+)→(\S+)$/.exec(n);
      if (m) return m[1] === m[2] ? `런타임 서버와 동일 (${m[2]})` : `런타임 ${m[1]} → ${m[2]} 업그레이드`;
      m = /^(codex|claude) v(.+)$/.exec(n);
      if (m) return `${CLI_LABEL[m[1] as 'codex' | 'claude']} v${m[2]} 설치`;
      m = /^(codex|claude) 설치 실패: (.*)$/.exec(n);
      if (m) return `${CLI_LABEL[m[1] as 'codex' | 'claude']} 설치 실패: ${m[2]}`;
      if (n === '서버와 동일') return server?.runtime ? `서버와 동일 (${server.runtime})` : '서버와 동일';
      if (n === '서버 매니페스트 없음') return '서버가 버전 정보를 주지 않음 (현재 설치본 유지)';
      return n;
    });
  return notes.join(' · ');
}

/** 서버 인증 출처 한글명 — 내부 식별자를 그대로 내지 않는다. */
export function cliAuthSourceLabel(source?: string | null, mode?: string): string {
  switch (source ?? '') {
    case 'node_api_key':
      return '에이전트 노드 키';
    case 'admin_api_key':
      return '관리자 API 키';
    case 'api_key':
    case 'server_api_key':
      return 'API 키';
    case 'setup_token':
    case 'server_token':
      return '중앙 장수명 토큰';
    case 'central_credentials':
    case 'credentials':
    case 'server_credentials':
      return '중앙 ChatGPT 자격증명';
    default:
      return mode === 'setup_token'
        ? '중앙 장수명 토큰'
        : mode === 'oauth'
          ? '중앙 ChatGPT 자격증명'
          : 'API 키';
  }
}

/**
 * CLI 인증 행의 도구별 문구.
 *   준비: "Codex: 서버 인증 사용(관리자 API 키)"
 *   없음: "Codex: 서버에 인증 없음 → Codex 대화는 서버에서 실행"  ("(없음)"/"(null)" 금지)
 *   Claude 파드 로그인: "Claude Code: 서버 파드 로그인(PC 전달 불가) → Claude Code 대화는 서버에서 실행"
 */
export function describeCliAuth(
  name: 'Claude Code' | 'Codex',
  a: CliAuthLike | null | undefined,
): string {
  if (!a) return `${name}: 서버 정보 없음`;
  if (a.ready) return `${name}: 서버 인증 사용(${cliAuthSourceLabel(a.source, a.mode)})`;
  if (name === 'Claude Code' && a.mode === 'oauth')
    return `${name}: 서버 파드 로그인(PC 전달 불가) → ${name} 대화는 서버에서 실행`;
  return `${name}: 서버에 인증 없음 → ${name} 대화는 서버에서 실행`;
}

/** CLI 행 전체(서버 미연결 안내 포함). */
export function describeCliAuthRow(server: ServerLike | null | undefined): string {
  if (!server) return '서버 연결 후 표시됩니다 (인증은 서버 관리자 LLM 설정을 그대로 사용)';
  return [describeCliAuth('Claude Code', server.claudeAuth), describeCliAuth('Codex', server.codexAuth)].join(
    ' · ',
  );
}

/** CLI 설치/재설치 버튼 문구 — 설치는 항상 서버 매니페스트 목표 버전(없으면 최신). */
export function cliInstallButtonLabel(o: {
  busy: boolean;
  installed: boolean;
  serverVersion?: string | null;
  installedVersion?: string;
}): string {
  if (o.busy) return '설치 중…';
  if (!o.installed) return '설치';
  if (o.serverVersion && o.serverVersion !== o.installedVersion) return `서버 버전(v${o.serverVersion})으로`;
  return o.serverVersion ? '서버 버전으로 재설치' : '재설치';
}

/** CLI 행 상태 문구. */
export function describeCliRow(
  tool: 'codex' | 'claude',
  desc: string,
  cli: { installed: boolean; version?: string } | undefined,
  server: ServerLike | null | undefined,
): string {
  const sv = server?.[tool] ?? null;
  if (cli?.installed) {
    const v = /\d/.test(cli.version ?? '') ? ` (v${cli.version})` : '';
    const cmp = sv ? (sv === cli.version ? ' · 서버와 동일' : ` · 서버 v${sv}`) : '';
    return `설치됨${v}${cmp}`;
  }
  return `${desc}${sv ? ` · 서버 v${sv}` : ''}`;
}
