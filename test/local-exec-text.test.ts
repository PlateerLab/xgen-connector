/**
 * 설정 → 설치 섹션 문구 계약(local-exec-text.ts) — 미검증≠손상, 내부값("(없음)"/"(null)") 미노출,
 * 수렴 요약 X→X 금지, CLI 인증 출처 한글명, 버튼 문구.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOOT_ERROR_HINT,
  cliAuthSourceLabel,
  cliInstallButtonLabel,
  describeCandidate,
  describeCliAuth,
  describeCliAuthRow,
  describeCliRow,
  describeConverge,
  describeRuntimeCandidates,
  type CandidateLike,
} from '../src/renderer/src/local-exec-text';

const inst = (over: Partial<CandidateLike> = {}): CandidateLike => ({
  source: 'install',
  runtimeDir: 'C:\\u\\xgen-connector\\local-runtime',
  python: 'C:\\u\\xgen-connector\\local-runtime\\python\\python.exe',
  exists: true,
  version: '3.8.0',
  ...over,
});
const bun = (over: Partial<CandidateLike> = {}): CandidateLike => ({
  source: 'bundle',
  runtimeDir: 'C:\\Program Files\\XGEN Connector\\resources',
  python: 'C:\\Program Files\\XGEN Connector\\resources\\python\\python.exe',
  exists: true,
  version: '3.8.0',
  ...over,
});

test('후보 문구: 미검증(healthy undefined)은 손상이 아니다 — 설치 폴더 사용 중이면 그 이유를 말한다', () => {
  const ctx = { activeSource: 'install' as const, phase: 'ready' as const };
  assert.equal(
    describeCandidate(bun(), ctx),
    '앱 내장: 있음 (3.8.0, 미검증 — 설치 폴더 사용 중)',
  );
  // 실제 스모크 실패만 손상
  assert.equal(describeCandidate(bun({ healthy: false, error: 'ImportError: x' }), ctx), '앱 내장: 손상 — ImportError: x');
  assert.equal(describeCandidate(bun({ healthy: true }), ctx), '앱 내장: 있음 (3.8.0)');
  assert.equal(describeCandidate(inst({ healthy: true }), ctx), '설치 폴더: 설치됨 (3.8.0)');
  assert.equal(
    describeCandidate(inst({ healthy: false, error: 'boom' }), ctx),
    '설치 폴더: 손상(검증 실패) — boom',
  );
  // 검증 중(사다리 진행) 은 "검증 중"
  assert.equal(
    describeCandidate(inst(), { phase: 'checking' }),
    '설치 폴더: 있음 (3.8.0, 검증 중)',
  );
  assert.equal(describeCandidate(inst({ exists: false, version: undefined }), ctx), '설치 폴더: 없음');
  assert.equal(describeCandidate(undefined, ctx, { kind: 'bundle', note: 'X\\python' }), '앱 내장: 없음 (X\\python)');
});

test('런타임 행: 설치 폴더 정상 + 번들 미검증 + 서버 동일(버전 표기) — 손상 문구가 없다', () => {
  const line = describeRuntimeCandidates({
    ensure: {
      phase: 'ready',
      active: { source: 'install', python: inst().python, version: '3.8.0' },
      candidates: [inst({ healthy: true }), bun()],
    },
    server: { runtime: '3.8.0' },
  });
  assert.equal(
    line,
    '설치 폴더: 설치됨 (3.8.0) · 앱 내장: 있음 (3.8.0, 미검증 — 설치 폴더 사용 중) · 서버와 동일 (3.8.0)',
  );
  assert.doesNotMatch(line, /손상/);
});

test('수렴 요약: 런타임 X→X 는 "서버와 동일 (X)", 업그레이드/CLI 부분은 사람 문구로', () => {
  assert.equal(
    describeConverge({ running: false, summary: '런타임 3.7.0→3.7.0', lastRunAt: 1 }),
    '런타임 서버와 동일 (3.7.0)',
  );
  assert.equal(
    describeConverge({ running: false, summary: '런타임 3.7.0→3.8.0 · codex v0.150.0 · claude v2.1.0' }),
    '런타임 3.7.0 → 3.8.0 업그레이드 · Codex CLI v0.150.0 설치 · Claude Code CLI v2.1.0 설치',
  );
  assert.equal(describeConverge({ running: false, summary: '서버와 동일' }, { runtime: '3.8.0' }), '서버와 동일 (3.8.0)');
  assert.equal(describeConverge({ running: true }), '맞추는 중…');
  assert.equal(describeConverge({ running: false, lastError: 'net' }), '실패: net');
  assert.equal(describeConverge({ running: false }), '아직 실행 안 됨 (로그인 후 자동 실행)');
  assert.equal(
    describeConverge({ running: false, summary: 'codex 설치 실패: 404' }),
    'Codex CLI 설치 실패: 404',
  );
  assert.equal(describeConverge(undefined), '—');
});

test('CLI 인증: 없음은 "서버에 인증 없음 → … 서버에서 실행", 준비는 출처 한글명, (없음)/(null) 미노출', () => {
  assert.equal(
    describeCliAuth('Codex', { mode: 'api_key', ready: false, source: null }),
    'Codex: 서버에 인증 없음 → Codex 대화는 서버에서 실행',
  );
  assert.equal(
    describeCliAuth('Codex', { mode: 'api_key', ready: true, source: 'admin_api_key' }),
    'Codex: 서버 인증 사용(관리자 API 키)',
  );
  assert.equal(cliAuthSourceLabel('node_api_key'), '에이전트 노드 키');
  assert.equal(cliAuthSourceLabel('setup_token'), '중앙 장수명 토큰');
  assert.equal(cliAuthSourceLabel('central_credentials'), '중앙 ChatGPT 자격증명');
  assert.equal(
    describeCliAuth('Claude Code', { mode: 'oauth', ready: false, source: null }),
    'Claude Code: 서버 파드 로그인(PC 전달 불가) → Claude Code 대화는 서버에서 실행',
  );
  const row = describeCliAuthRow({
    claudeAuth: { mode: 'setup_token', ready: true, source: 'setup_token' },
    codexAuth: { mode: 'api_key', ready: false, source: null },
  });
  assert.doesNotMatch(row, /\(없음\)|null|undefined/);
  assert.match(row, /Claude Code: 서버 인증 사용\(중앙 장수명 토큰\)/);
  assert.equal(describeCliAuthRow(null), '서버 연결 후 표시됩니다 (인증은 서버 관리자 LLM 설정을 그대로 사용)');
});

test('CLI 버튼/행: "재설치(최신)" 대신 "서버 버전으로 재설치"; 버전 차이면 서버 버전으로', () => {
  assert.equal(cliInstallButtonLabel({ busy: true, installed: true }), '설치 중…');
  assert.equal(cliInstallButtonLabel({ busy: false, installed: false }), '설치');
  assert.equal(
    cliInstallButtonLabel({ busy: false, installed: true, serverVersion: '0.2', installedVersion: '0.2' }),
    '서버 버전으로 재설치',
  );
  assert.equal(
    cliInstallButtonLabel({ busy: false, installed: true, serverVersion: '0.3', installedVersion: '0.2' }),
    '서버 버전(v0.3)으로',
  );
  assert.equal(cliInstallButtonLabel({ busy: false, installed: true }), '재설치');
  assert.equal(describeCliRow('codex', 'desc', { installed: true, version: '0.2' }, { codex: '0.2' }), '설치됨 (v0.2) · 서버와 동일');
  assert.equal(describeCliRow('codex', 'desc', { installed: false }, { codex: '0.2' }), 'desc · 서버 v0.2');
  assert.match(BOOT_ERROR_HINT, /진단 복사/);
});
