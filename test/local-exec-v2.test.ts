// 커넥터 로컬 실행 v2 — 라우팅(로컬 우선·명시적 폴백)·사이드카 데몬 프로토콜·
// 서버 클라이언트 v2(매니페스트/보고 메타)·서버 버전 수렴 계획·CLI 버전 URL.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatEvent, ChatRequest } from '../src/core/types';
import {
  SidecarDaemon,
  defaultSidecarCommand,
  resolveSidecarCommand,
  type LocalTurnRequest,
  type SidecarEvent,
  type SidecarTerminal,
} from '../src/main/local-agent-sidecar';
import { makeServerClient, type ServerClient } from '../src/main/local-agent-server-client';
import {
  describeFallback,
  runLocalChatTurn,
  WORKSPACE_UNSYNCED_DETAIL,
  MEMORY_OFFLINE_DETAIL,
  type LocalChatDeps,
  serverCliAuth,
} from '../src/main/local-chat-route';
import { QuotaExceededError } from '../src/main/local-agent-server-client';
import { SessionStore, type SessionTransport } from '../src/renderer/src/session-store';
import type { Agent } from '../src/core/types';
import { planConverge } from '../src/main/local-runtime-converge';
import { codexAssetUrl, ensureCliConverged } from '../src/main/cli-provision';
import { pythonExePath } from '../src/main/local-runtime-install';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── 공통 픽스처 ──────────────────────────────────────────────────────

const REQ: ChatRequest = {
  workflowId: 'wf1',
  workflowName: 'A',
  input: '안녕',
  interactionId: 'i1',
};
const CTX = {
  agent: { provider: 'codex', model: 'gpt-5.3-codex' },
  // 서버 일원화 인증: codex oauth 모드 + 중앙 자격증명(서버가 준다) — 프리플라이트 통과
  context: {
    api_keys: { openai: 'sk' },
    settings: { CODEX_AUTH_MODE: 'oauth', CODEX_CREDENTIALS_JSON: '{"tokens":{}}' },
  },
  server: { url: 'https://s', token: 't' },
  protocol: 2,
};

function fakeServer(over: Partial<ServerClient> = {}): ServerClient & { reports: unknown[] } {
  const reports: unknown[] = [];
  return {
    reports,
    fetchLocalTurnContext: async () => CTX,
    reportTurnResult: async (_wf, _iid, r) => {
      reports.push(r);
    },
    fetchRuntimeManifest: async () => ({
      protocol: 2,
      runtime: { version: '3.7.0', wheel_url: 'u' },
      claude: {},
      codex: {},
    }),
    ...over,
  };
}

function fakeRunner(
  script: (req: LocalTurnRequest, emit: (e: SidecarEvent) => void) => SidecarTerminal,
) {
  const seen: LocalTurnRequest[] = [];
  return {
    seen,
    runTurn: async (req: LocalTurnRequest, onEvent: (e: SidecarEvent) => void) => {
      seen.push(req);
      return { terminal: script(req, onEvent) };
    },
  };
}

function baseDeps(over: Partial<LocalChatDeps>): LocalChatDeps {
  return {
    serverUrl: () => 'https://s',
    token: () => 't',
    fetch: (async () => new Response()) as never,
    resolveWorkspaceDir: async () => ({ dir: '/ws', synced: true }),
    runtimeInstalled: async () => true,
    server: fakeServer(),
    runner: fakeRunner((_r, emit) => {
      emit({ type: 'started', surface: 'connector_local' });
      emit({ type: 'chunk', text: '반' });
      emit({
        type: 'tool',
        data: { type: 'tool_call', tool_name: 'Bash', tool_input: '{"cmd":"ls"}' },
      });
      emit({
        type: 'tool',
        data: { type: 'tool_result', tool_name: 'Bash', result: 'a b', result_length: 3 },
      });
      emit({ type: 'chunk', text: '가워' });
      emit({ type: 'done', text: '반가워' });
      return 'done';
    }),
    cliSettings: () => ({
      CODEX_BINARY_PATH: '/pc/codex',
      XGEN_LOCAL_CODEX_HOME: '/pc/codex-home',
    }),
    ...over,
  };
}

// ── 라우팅 ────────────────────────────────────────────────────────────

test('로컬 턴: status(connector_local) → text/tool → end, 로컬 CLI 경로·격리 홈 주입, flush 후 v2 보고', async () => {
  const events: ChatEvent[] = [];
  const server = fakeServer();
  const runner = fakeRunner((_r, emit) => {
    emit({ type: 'chunk', text: 'x' });
    emit({ type: 'tool', data: { type: 'tool_call', tool_name: 'Bash', tool_input: '{}' } });
    emit({ type: 'done', text: 'x' });
    return 'done';
  });
  const flushed: string[] = [];
  const r = await runLocalChatTurn(
    REQ,
    baseDeps({
      server,
      runner,
      flushSync: async (wf) => (flushed.push(wf), true),
      deviceName: () => 'PC-1',
    }),
    (e) => events.push(e),
  );
  assert.equal(r.handled, true);
  assert.deepEqual(
    events.map((e) => e.kind),
    ['status', 'text', 'tool', 'end'],
  );
  const st = events[0] as Extract<ChatEvent, { kind: 'status' }>;
  assert.equal(st.surface, 'connector_local');
  assert.equal(st.provider, 'codex');
  const tool = events[2] as Extract<ChatEvent, { kind: 'tool' }>;
  assert.equal(tool.event.eventType, 'tool_call');
  assert.equal(tool.event.toolName, 'Bash');
  // 사이드카 요청: 서버 settings 위에 이 PC 의 CLI 경로/격리 홈이 덮인다.
  const sent = runner.seen[0];
  assert.equal(sent.context?.settings?.CODEX_BINARY_PATH, '/pc/codex');
  assert.equal(sent.context?.settings?.XGEN_LOCAL_CODEX_HOME, '/pc/codex-home');
  assert.equal(sent.context?.settings?.CODEX_AUTH_MODE, 'oauth');
  assert.equal(sent.options?.interaction_id, 'i1');
  assert.deepEqual(flushed, ['wf1']);
  const rep = server.reports[0] as Record<string, unknown>;
  assert.equal(rep.status, 'ok');
  assert.equal(rep.agentText, 'x');
  assert.equal(rep.provider, 'codex');
  assert.equal(rep.model, 'gpt-5.3-codex');
  assert.equal(rep.deviceName, 'PC-1');
  assert.equal((rep.toolEvents as unknown[]).length, 1);
});

test('사이드카 notice(memory_offline) → status detail 부착(폴백 아님, 로컬 계속)', async () => {
  const events: ChatEvent[] = [];
  const server = fakeServer();
  const runner = fakeRunner((_r, emit) => {
    emit({ type: 'started', surface: 'connector_local' });
    emit({
      type: 'notice',
      data: { code: 'memory_offline', message: MEMORY_OFFLINE_DETAIL },
    });
    emit({ type: 'chunk', text: 'x' });
    emit({ type: 'done', text: 'x' });
    return 'done';
  });
  const r = await runLocalChatTurn(REQ, baseDeps({ server, runner }), (e) => events.push(e));
  // 폴백이 아니다 — 로컬이 이 턴을 소유하고 정상 종료(text→end).
  assert.equal(r.handled, true);
  assert.deepEqual(
    events.map((e) => e.kind),
    ['status', 'status', 'text', 'end'],
  );
  // 두 번째 status 는 memory_offline 안내를 detail 로 실은 connector_local 상태.
  const st = events[1] as Extract<ChatEvent, { kind: 'status' }>;
  assert.equal(st.surface, 'connector_local');
  assert.equal(st.detail, MEMORY_OFFLINE_DETAIL);
  assert.equal(st.provider, 'codex');
  // 보고는 정상(ok) — degrade 는 알림일 뿐 실패가 아니다.
  assert.equal((server.reports[0] as { status: string }).status, 'ok');
});

test('notice(memory_offline) 메시지 없으면 기본 안내로 detail 부착; 미지의 code 는 무시', async () => {
  const events: ChatEvent[] = [];
  const runner = fakeRunner((_r, emit) => {
    emit({ type: 'notice', data: { code: 'something_else' } }); // 미지의 code → 무시
    emit({ type: 'notice', data: { code: 'memory_offline' } }); // 메시지 없음 → 기본값
    emit({ type: 'done', text: '' });
    return 'done';
  });
  await runLocalChatTurn(REQ, baseDeps({ runner }), (e) => events.push(e));
  const statuses = events.filter(
    (e): e is Extract<ChatEvent, { kind: 'status' }> => e.kind === 'status',
  );
  // 초기 status + memory_offline status(미지 code 는 status 를 만들지 않는다).
  assert.equal(statuses.length, 2);
  assert.equal(statuses[1].detail, MEMORY_OFFLINE_DETAIL);
});

test('폴백 사유는 숨기지 않는다 — runtime_missing/attachments/composite/context/workspace/cli', async () => {
  const noEmit = (e: ChatEvent) => assert.fail(`emit 금지: ${e.kind}`);
  let r = await runLocalChatTurn(REQ, baseDeps({ runtimeInstalled: async () => false }), noEmit);
  assert.deepEqual([r.handled, r.reason], [false, 'runtime_missing']);
  r = await runLocalChatTurn({ ...REQ, selectedFiles: ['a.pdf'] }, baseDeps({}), noEmit);
  assert.equal(r.reason, 'attachments');
  r = await runLocalChatTurn({ ...REQ, input: { some: 'object' } }, baseDeps({}), noEmit);
  assert.equal(r.reason, 'composite_input');
  r = await runLocalChatTurn(
    REQ,
    baseDeps({
      server: fakeServer({
        fetchLocalTurnContext: async () => {
          throw new Error('404 no endpoint');
        },
      }),
    }),
    noEmit,
  );
  assert.equal(r.reason, 'context_unavailable');
  assert.match(r.detail ?? '', /404/);
  r = await runLocalChatTurn(
    REQ,
    baseDeps({
      resolveWorkspaceDir: async () => {
        throw new Error('no sync');
      },
    }),
    noEmit,
  );
  assert.equal(r.reason, 'workspace_unavailable');
  r = await runLocalChatTurn(REQ, baseDeps({ ensureCli: async () => false }), noEmit);
  assert.equal(r.reason, 'cli_missing');
  assert.match(describeFallback('runtime_missing'), /서버 sandbox/);
  assert.match(describeFallback('cli_missing', 'codex'), /codex/);
});

test('사이드카 error(출력 후) → error 이벤트 + end, 보고 status=error (로컬이 소유); 출력 전 error 는 서버 폴백', async () => {
  const events: ChatEvent[] = [];
  const server = fakeServer();
  const runner = fakeRunner((_r, emit) => {
    emit({ type: 'chunk', text: '부분' });
    emit({ type: 'error', message: 'boom' });
    return 'error';
  });
  const r = await runLocalChatTurn(REQ, baseDeps({ server, runner }), (e) => events.push(e));
  assert.equal(r.handled, true);
  assert.deepEqual(
    events.map((e) => e.kind),
    ['status', 'text', 'error', 'end'],
  );
  assert.equal((server.reports[0] as { status: string }).status, 'error');
  // 출력 전 오류(인증 만료·바이너리 실행 실패 등)는 로컬 시작 실패 → 서버 폴백
  const runner2 = fakeRunner((_r, emit) => {
    emit({ type: 'error', message: 'Not logged in' });
    return 'error';
  });
  const r2 = await runLocalChatTurn(REQ, baseDeps({ server, runner: runner2 }), () => {});
  assert.deepEqual([r2.handled, r2.reason], [false, 'local_start_failed']);
});

test('취소(cancelled) → error 없이 end, 보고 status=cancelled', async () => {
  const events: ChatEvent[] = [];
  const server = fakeServer();
  const runner = fakeRunner((_r, emit) => {
    emit({ type: 'chunk', text: '부분' });
    emit({ type: 'cancelled' });
    return 'cancelled';
  });
  await runLocalChatTurn(REQ, baseDeps({ server, runner }), (e) => events.push(e));
  assert.deepEqual(
    events.map((e) => e.kind),
    ['status', 'text', 'end'],
  );
  assert.equal((server.reports[0] as { status: string }).status, 'cancelled');
});

test('보고 실패해도 턴은 end 로 끝난다(다음 sync 가 따라잡음)', async () => {
  const events: ChatEvent[] = [];
  const server = fakeServer({
    reportTurnResult: async () => {
      throw new Error('503');
    },
  });
  const r = await runLocalChatTurn(REQ, baseDeps({ server }), (e) => events.push(e));
  assert.equal(r.handled, true);
  assert.equal(events[events.length - 1].kind, 'end');
});

// ── 사이드카 데몬 프로토콜 (node 로 흉내 낸 사이드카) ──────────────────

const FAKE_DAEMON = `
  const rl = require('readline').createInterface({ input: process.stdin });
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  out({ type: 'ready', pid: process.pid, protocol: 2, runtime_version: '3.7.0', python: '3.12.11' });
  const timers = new Map();
  rl.on('line', (line) => {
    let c; try { c = JSON.parse(line); } catch { return; }
    if (c.op === 'ping') return out({ type: 'pong', id: c.id, protocol: 2, runtime_version: '3.7.0' });
    if (c.op === 'shutdown') return process.exit(0);
    if (c.op === 'cancel') { const t = timers.get(c.id); if (t) { clearTimeout(t); timers.delete(c.id); out({ id: c.id, type: 'cancelled' }); } return; }
    if (c.op === 'turn') {
      out({ id: c.id, type: 'started', surface: 'connector_local' });
      if (c.text === 'slow') { timers.set(c.id, setTimeout(() => { out({ id: c.id, type: 'done', text: 'late' }); }, 5000)); return; }
      out({ id: c.id, type: 'chunk', text: 'echo:' + c.text });
      out({ id: c.id, type: 'tool', data: { type: 'tool_call', tool_name: 'Bash' } });
      out({ id: c.id, type: 'usage', data: { input_tokens: 10, output_tokens: 3, model: 'm' } });
      out({ id: c.id, type: 'done', text: 'echo:' + c.text });
    }
  });
`;
const daemonCmd = () => ({
  command: process.execPath,
  args: ['-e', FAKE_DAEMON],
  env: process.env,
});

test('데몬: ready → 다중 턴 id 상관 → ping → 유휴 종료 없음(활성 중)', async () => {
  const d = new SidecarDaemon({ command: daemonCmd, idleMs: 0 });
  const ev1: SidecarEvent[] = [];
  const ev2: SidecarEvent[] = [];
  const [r1, r2] = await Promise.all([
    d.runTurn({ workspace_dir: '/w', provider: 'openai', text: 'a' }, (e) => ev1.push(e)),
    d.runTurn({ workspace_dir: '/w', provider: 'openai', text: 'b' }, (e) => ev2.push(e)),
  ]);
  assert.equal(r1.terminal, 'done');
  assert.equal(r2.terminal, 'done');
  assert.deepEqual(
    ev1.map((e) => e.type),
    ['started', 'chunk', 'tool', 'usage', 'done'],
  );
  // usage 는 1급 v2 이벤트 — 데몬이 그대로 통과시킨다(meta 로 강등 안 함).
  assert.deepEqual((ev1[3] as { data: Record<string, unknown> }).data, {
    input_tokens: 10,
    output_tokens: 3,
    model: 'm',
  });
  assert.equal((ev1[1] as { text: string }).text, 'echo:a');
  assert.equal((ev2[1] as { text: string }).text, 'echo:b');
  const pong = await d.ping();
  assert.equal(pong?.type, 'pong');
  const st = d.status();
  assert.equal(st.running, true);
  assert.equal(st.runtimeVersion, '3.7.0');
  assert.equal(st.protocol, 2);
  d.shutdown();
});

test('데몬: AbortSignal → cancel 명령 → cancelled 로 종료', async () => {
  const d = new SidecarDaemon({ command: daemonCmd, idleMs: 0, cancelGraceMs: 2000 });
  const ac = new AbortController();
  const evs: SidecarEvent[] = [];
  const p = d.runTurn(
    { workspace_dir: '/w', provider: 'openai', text: 'slow' },
    (e) => {
      evs.push(e);
      if (e.type === 'started') setTimeout(() => ac.abort(), 50);
    },
    { signal: ac.signal },
  );
  const r = await p;
  assert.equal(r.terminal, 'cancelled');
  assert.deepEqual(
    evs.map((e) => e.type),
    ['started', 'cancelled'],
  );
  d.shutdown();
});

test('데몬: 프로세스가 죽으면 대기 턴은 error 로 끝난다(매달리지 않음) + 다음 턴에 재기동', async () => {
  const d = new SidecarDaemon({ command: daemonCmd, idleMs: 0 });
  const evs: SidecarEvent[] = [];
  const p = d.runTurn({ workspace_dir: '/w', provider: 'openai', text: 'slow' }, (e) => {
    evs.push(e);
    if (e.type === 'started') d.kill();
  });
  const r = await p;
  assert.equal(r.terminal, 'error');
  assert.equal(d.status().running, false);
  const again: SidecarEvent[] = [];
  const r2 = await d.runTurn({ workspace_dir: '/w', provider: 'openai', text: 'z' }, (e) =>
    again.push(e),
  );
  assert.equal(r2.terminal, 'done');
  d.shutdown();
});

test('데몬: 스폰 불가 → error 이벤트(예외 아님)', async () => {
  const d = new SidecarDaemon({
    command: () => ({ command: '/nonexistent/python-xgen', args: ['-m', 'x'], env: process.env }),
    idleMs: 0,
  });
  const evs: SidecarEvent[] = [];
  const r = await d.runTurn({ workspace_dir: '/w', provider: 'openai', text: 'a' }, (e) =>
    evs.push(e),
  );
  assert.equal(r.terminal, 'error');
  assert.equal(evs[0].type, 'error');
});

test('명령 해석 — serve 플래그·PATH 선행·인코딩 env', () => {
  const c = resolveSidecarCommand({
    env: { XGEN_SIDECAR_PYTHON: '/py', PATH: '/usr/bin' },
    serve: true,
    prependPath: ['/install/local-runtime/bin'],
  });
  assert.equal(c.command, '/py');
  assert.deepEqual(c.args, ['-m', 'xgen_agent_runtime.host.sidecar', '--serve']);
  assert.equal(c.env?.PYTHONIOENCODING, 'utf-8');
  assert.ok(String(c.env?.PATH).startsWith('/install/local-runtime/bin'));
});

// ── 서버 클라이언트 v2 ─────────────────────────────────────────────────

test('서버 클라이언트: manifest GET + report v2 body', async () => {
  const calls: { url: string; body?: unknown }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const payload = url.endsWith('/local-runtime/manifest')
      ? {
          protocol: 2,
          runtime: { version: '3.7.0', wheel_url: 'https://w' },
          claude: { target: '2.1.231' },
          codex: { target: '0.149.0' },
        }
      : { ok: true };
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => '',
    } as unknown as Response;
  }) as never;
  const c = makeServerClient({ serverUrl: () => 'https://x/', token: () => 'tok', fetch });
  const m = await c.fetchRuntimeManifest();
  assert.equal(m.runtime.version, '3.7.0');
  assert.equal(calls[0].url, 'https://x/api/agentflow/geny-agent/local-runtime/manifest');
  await c.reportTurnResult('wf', 'i', {
    userText: 'u',
    agentText: 'a',
    status: 'error',
    error: 'e',
    toolEvents: [{ type: 'tool_call' }],
    usage: { input_tokens: 1 },
    provider: 'codex',
    model: 'm',
    durationMs: 9,
    deviceName: 'PC',
  });
  const body = calls[1].body as Record<string, unknown>;
  assert.equal(calls[1].url, 'https://x/api/agentflow/geny-agent/wf/report-turn');
  assert.equal(body.status, 'error');
  assert.equal(body.device_name, 'PC');
  assert.equal(body.duration_ms, 9);
  assert.deepEqual(body.tool_events, [{ type: 'tool_call' }]);
});

// ── 서버 버전 수렴 계획 ────────────────────────────────────────────────

test('planConverge: 런타임 wheel 차이 → upgrade, CLI 목표 차이 → install, 서버 비활성 → none', () => {
  const manifest = {
    protocol: 2,
    runtime: { version: '3.7.0', wheel_url: 'u' },
    claude: { enabled: true, target: '2.1.231' },
    codex: { enabled: false, target: '0.149.0' },
  };
  const plan = planConverge(manifest, {
    runtimeInstalled: true,
    runtimeVersion: '3.6.0',
    codex: { installed: false },
    claude: { installed: true, version: '2.1.200' },
  });
  assert.equal(plan.runtime.action, 'upgrade');
  assert.equal(plan.claude.action, 'install');
  assert.equal(plan.claude.target, '2.1.231');
  assert.equal(plan.codex.action, 'none'); // 서버가 codex 를 껐다
  const same = planConverge(manifest, {
    runtimeInstalled: true,
    runtimeVersion: '3.7.0',
    codex: { installed: true, version: '0.149.0' },
    claude: { installed: true, version: '2.1.231' },
  });
  assert.equal(same.runtime.action, 'none');
  assert.equal(same.claude.action, 'none');
  const none = planConverge(null, {
    runtimeInstalled: false,
    codex: { installed: false },
    claude: { installed: false },
  });
  assert.equal(none.runtime.action, 'skip-missing-python');
  assert.equal(none.codex.action, 'install'); // 매니페스트 없어도 미설치면 최신 설치
  const off = planConverge(
    manifest,
    {
      runtimeInstalled: true,
      runtimeVersion: '3.6.0',
      codex: { installed: false },
      claude: { installed: false },
    },
    { autoRuntime: false, autoClaude: false },
  );
  assert.equal(off.runtime.action, 'none');
  assert.equal(off.claude.action, 'none');
});

test('codexAssetUrl: 버전 지정은 rust-v 태그, 없으면 latest', () => {
  assert.equal(
    codexAssetUrl('linux', 'x64', '0.149.0'),
    'https://github.com/openai/codex/releases/download/rust-v0.149.0/codex-x86_64-unknown-linux-musl.tar.gz',
  );
  assert.match(
    codexAssetUrl('win32', 'arm64'),
    /releases\/latest\/download\/codex-aarch64-pc-windows-msvc\.exe\.zip$/,
  );
});

test('ensureCliConverged: 설치돼 있고 목표 없음/일치 → no-op(changed=false)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-conv-'));
  try {
    mkdirSync(join(dir, 'bin'), { recursive: true });
    const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
    writeFileSync(join(dir, 'bin', exe), '');
    writeFileSync(join(dir, 'bin', '.versions.json'), JSON.stringify({ codex: '0.149.0' }));
    const r1 = await ensureCliConverged({ runtimeDir: dir }, 'codex', null, () => {});
    assert.deepEqual([r1.ok, r1.changed, r1.version], [true, false, '0.149.0']);
    const r2 = await ensureCliConverged({ runtimeDir: dir }, 'codex', '0.149.0', () => {});
    assert.equal(r2.changed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI 인증 프리플라이트: 로컬 로그인도 서버 인증도 없으면 cli_auth_missing 으로 서버 폴백(무 emit)', async () => {
  const noEmit = (e: ChatEvent) => assert.fail(`emit 금지: ${e.kind}`);
  const r = await runLocalChatTurn(
    REQ,
    baseDeps({ cliAuth: async (_tool, settings) => ({ ok: false, source: 'none', settings }) }),
    noEmit,
  );
  assert.deepEqual([r.handled, r.reason], [false, 'cli_auth_missing']);
});

test('CLI 인증 프리플라이트가 settings 를 덮는다(이 PC 로그인 → oauth, 중앙 자격증명 제거)', async () => {
  const runner = fakeRunner((_r, emit) => {
    emit({ type: 'chunk', text: 'ok' });
    emit({ type: 'done', text: 'ok' });
    return 'done';
  });
  await runLocalChatTurn(
    REQ,
    baseDeps({
      runner,
      cliAuth: async (_tool, settings) => ({
        ok: true,
        source: 'local_login',
        settings: {
          ...settings,
          CODEX_AUTH_MODE: 'oauth',
          CODEX_CREDENTIALS_JSON: undefined as never,
        },
      }),
    }),
    () => {},
  );
  assert.equal(runner.seen[0].context?.settings?.CODEX_AUTH_MODE, 'oauth');
  assert.equal(runner.seen[0].context?.settings?.CODEX_BINARY_PATH, '/pc/codex');
});

test('로컬 시작 실패(첫 출력 전 [ERROR]/error) → local_start_failed 로 서버 폴백, 보고 없음', async () => {
  const server = fakeServer();
  const events: ChatEvent[] = [];
  const runner = fakeRunner((_r, emit) => {
    emit({ type: 'started', surface: 'connector_local' });
    emit({
      type: 'chunk',
      text: '\n[ERROR] geny agent could not start: Codex(api_key 모드): OPENAI_API_KEY 가 설정되어 있지 않습니다',
    });
    emit({ type: 'done', text: '' });
    return 'done';
  });
  const r = await runLocalChatTurn(REQ, baseDeps({ server, runner }), (e) => events.push(e));
  assert.equal(r.handled, false);
  assert.equal(r.reason, 'local_start_failed');
  assert.match(r.detail ?? '', /OPENAI_API_KEY/);
  assert.deepEqual(
    events.map((e) => e.kind),
    ['status'],
  ); // 텍스트는 보여 주지 않았다
  assert.equal(server.reports.length, 0);
  // 출력이 이미 나간 뒤의 오류는 로컬이 소유한다(기존 동작)
  const runner2 = fakeRunner((_r, emit) => {
    emit({ type: 'chunk', text: '부분' });
    emit({ type: 'error', message: 'boom' });
    return 'error';
  });
  const r2 = await runLocalChatTurn(REQ, baseDeps({ server, runner: runner2 }), () => {});
  assert.equal(r2.handled, true);
});

test('serverCliAuth: 서버가 준 인증만 — api_key 키 / setup_token 토큰 / oauth 중앙 자격증명, 없으면 none(서버 실행)', () => {
  assert.equal(
    serverCliAuth('codex', { CODEX_AUTH_MODE: 'api_key' }, { openai: 'sk' }).source,
    'server_api_key',
  );
  assert.equal(serverCliAuth('codex', { CODEX_AUTH_MODE: 'api_key' }, {}).ok, false);
  assert.equal(
    serverCliAuth('codex', { CODEX_AUTH_MODE: 'oauth', CODEX_CREDENTIALS_JSON: '{}' }, {}).source,
    'server_credentials',
  );
  assert.equal(serverCliAuth('codex', { CODEX_AUTH_MODE: 'oauth' }, {}).ok, false);
  assert.equal(
    serverCliAuth(
      'claude',
      { CLAUDE_CODE_AUTH_MODE: 'setup_token', CLAUDE_CODE_OAUTH_TOKEN: 't' },
      {},
    ).source,
    'server_token',
  );
  assert.equal(serverCliAuth('claude', { CLAUDE_CODE_AUTH_MODE: 'oauth' }, {}).ok, false); // 파드 로컬 로그인은 PC 로 못 온다
  assert.equal(serverCliAuth('claude', {}, { anthropic: 'k' }).source, 'server_api_key');
});

test('서버 인증이 없는 CLI provider 는 기본 프리플라이트만으로 cli_auth_missing → 서버 실행(무 emit)', async () => {
  const noEmit = (e: ChatEvent) => assert.fail(`emit 금지: ${e.kind}`);
  const server = fakeServer({
    fetchLocalTurnContext: async () => ({
      agent: { provider: 'claude_code', model: 'sonnet' },
      context: { api_keys: {}, settings: { CLAUDE_CODE_AUTH_MODE: 'oauth' } },
      server: { url: 'https://s', token: 't' },
      protocol: 2,
    }),
  });
  const r = await runLocalChatTurn(REQ, baseDeps({ server, cliSettings: () => ({}) }), noEmit);
  assert.deepEqual([r.handled, r.reason], [false, 'cli_auth_missing']);
});

// ── 크로스-리포 계약: TLS · USAGE · GRAPH · QUOTA · 동기화 미완료 안내 ──────────

test('[TLS] 사설 인증서 허용이면 사이드카 요청 server.tls.verify=false, 기본은 true', async () => {
  const runner = fakeRunner((_r, emit) => {
    emit({ type: 'chunk', text: 'x' });
    emit({ type: 'done', text: 'x' });
    return 'done';
  });
  await runLocalChatTurn(REQ, baseDeps({ runner, tlsVerify: () => false }), () => {});
  assert.deepEqual(runner.seen[0].server, { url: 'https://s', token: 't', tls: { verify: false } });
  // tlsVerify 미주입(기본) → 검증 켜짐
  await runLocalChatTurn(REQ, baseDeps({ runner }), () => {});
  assert.equal(runner.seen[1].server?.tls?.verify, true);
  await runLocalChatTurn(REQ, baseDeps({ runner, tlsVerify: () => true }), () => {});
  assert.equal(runner.seen[2].server?.tls?.verify, true);
});

test('[USAGE] 사이드카 usage 이벤트 → report-turn usage (화면 표시 없음)', async () => {
  const events: ChatEvent[] = [];
  const server = fakeServer();
  const usage = {
    input_tokens: 120,
    output_tokens: 45,
    cache_read_tokens: 30,
    cache_creation_tokens: null,
    total_cost_usd: 0.0012,
    model: 'gpt-5.3-codex',
    provider: 'codex',
  };
  const runner = fakeRunner((_r, emit) => {
    emit({ type: 'chunk', text: 'x' });
    emit({ type: 'usage', data: usage });
    emit({ type: 'done', text: 'x' });
    return 'done';
  });
  const r = await runLocalChatTurn(REQ, baseDeps({ server, runner }), (e) => events.push(e));
  assert.equal(r.handled, true);
  assert.deepEqual(
    events.map((e) => e.kind),
    ['status', 'text', 'end'],
  );
  const rep = server.reports[0] as { usage?: unknown };
  assert.deepEqual(rep.usage, usage);
  // usage 이벤트가 없으면 보고에도 없다(null 로 직렬화는 서버 클라이언트 몫).
  const server2 = fakeServer();
  await runLocalChatTurn(REQ, baseDeps({ server: server2 }), () => {});
  assert.equal((server2.reports[0] as { usage?: unknown }).usage, undefined);
});

test('[GRAPH] graph.local_supported=false → graph_suppliers 폴백(무 emit), 사유 문구 한국어', async () => {
  const noEmit = (e: ChatEvent) => assert.fail(`emit 금지: ${e.kind}`);
  const runner = fakeRunner(() => 'done');
  const r = await runLocalChatTurn(
    REQ,
    baseDeps({
      runner,
      server: fakeServer({
        fetchLocalTurnContext: async () => ({
          ...CTX,
          graph: {
            suppliers: [{ port: 'tools', node_id: 'n1', node_type: 'tool/mcp' }],
            shipped: ['memory'],
            unsupported: ['tools', 'rag'],
            local_supported: false,
          },
        }),
      }),
    }),
    noEmit,
  );
  assert.deepEqual([r.handled, r.reason, r.detail], [false, 'graph_suppliers', 'tools,rag']);
  assert.equal(runner.seen.length, 0);
  assert.equal(
    describeFallback('graph_suppliers'),
    '캔버스 공급 노드(도구·RAG 등)는 서버에서 실행',
  );
  assert.match(describeFallback('graph_suppliers', 'tools,rag'), /tools,rag/);
  // local_supported=true(또는 graph 없음)면 로컬 진행
  const runner2 = fakeRunner((_r, emit) => {
    emit({ type: 'done', text: '' });
    return 'done';
  });
  const r2 = await runLocalChatTurn(
    REQ,
    baseDeps({
      runner: runner2,
      server: fakeServer({
        fetchLocalTurnContext: async () => ({
          ...CTX,
          graph: { suppliers: [], shipped: ['memory'], unsupported: [], local_supported: true },
        }),
      }),
    }),
    () => {},
  );
  assert.equal(r2.handled, true);
  assert.equal(runner2.seen.length, 1);
});

test('[GRAPH] 서버가 실은 memory/output_schema 옵션은 사이드카 options 로 그대로 통과한다', async () => {
  const memory = [
    { role: 'user', content: '이전 질문' },
    { role: 'assistant', content: '이전 답' },
  ];
  const runner = fakeRunner((_r, emit) => {
    emit({ type: 'done', text: '' });
    return 'done';
  });
  await runLocalChatTurn(
    REQ,
    baseDeps({
      runner,
      server: fakeServer({
        fetchLocalTurnContext: async () => ({
          ...CTX,
          // 에이전트 파라미터 옆(agent 안)에 실린 키
          agent: { ...CTX.agent, memory },
          // 별도 options 키로 실린 것도 통과
          options: { output_schema: { type: 'object' } },
        }),
      }),
    }),
    () => {},
  );
  const opts = runner.seen[0].options ?? {};
  assert.deepEqual(opts.memory, memory);
  assert.deepEqual(opts.output_schema, { type: 'object' });
  // 커넥터가 정하는 키는 서버 값 위에 덮인다(턴 상관 키).
  assert.equal(opts.workflow_id, 'wf1');
  assert.equal(opts.interaction_id, 'i1');
  assert.equal(opts.streaming, true);
});

test('[QUOTA] 429 quota_exceeded → 서버 폴백 없이 차단: status(blocked) + error + end, 실행·보고 없음', async () => {
  const events: ChatEvent[] = [];
  const runner = fakeRunner(() => 'done');
  const server = fakeServer({
    fetchLocalTurnContext: async () => {
      throw new QuotaExceededError('이번 달 토큰 한도를 초과했습니다', { used: 10 }, { max: 5 });
    },
  });
  const r = await runLocalChatTurn(REQ, baseDeps({ runner, server }), (e) => events.push(e));
  assert.deepEqual([r.handled, r.blocked, r.reason], [true, true, undefined]);
  assert.deepEqual(
    events.map((e) => e.kind),
    ['status', 'error', 'end'],
  );
  const st = events[0] as Extract<ChatEvent, { kind: 'status' }>;
  assert.equal(st.surface, 'blocked');
  assert.equal(st.reason, 'quota_exceeded');
  assert.equal(st.detail, '이번 달 토큰 한도를 초과했습니다');
  assert.equal((events[1] as { detail: string }).detail, '이번 달 토큰 한도를 초과했습니다');
  assert.equal(runner.seen.length, 0);
  assert.equal(server.reports.length, 0);
  // 실 HTTP 경로: makeServerClient 가 429 본문을 QuotaExceededError 로 승격 → 같은 차단
  const fetch = (async () =>
    ({
      ok: false,
      status: 429,
      text: async () =>
        JSON.stringify({
          detail: { code: 'quota_exceeded', message: '한도 초과', usage: 1, limit: 1 },
        }),
    }) as unknown as Response) as never;
  const events2: ChatEvent[] = [];
  const r2 = await runLocalChatTurn(REQ, baseDeps({ runner, server: undefined, fetch }), (e) =>
    events2.push(e),
  );
  assert.equal(r2.blocked, true);
  assert.deepEqual(
    events2.map((e) => e.kind),
    ['status', 'error', 'end'],
  );
  assert.equal((events2[0] as { detail?: string }).detail, '한도 초과');
  // 429 라도 quota_exceeded 계약이 아니면 기존대로 context_unavailable 폴백
  const fetch3 = (async () =>
    ({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({ detail: 'rate limited' }),
    }) as unknown as Response) as never;
  const r3 = await runLocalChatTurn(
    REQ,
    baseDeps({ runner, server: undefined, fetch: fetch3 }),
    () => assert.fail('emit 금지'),
  );
  assert.deepEqual([r3.handled, r3.reason], [false, 'context_unavailable']);
});

test('[M#19] 동기화 미완료(synced=false)면 폴백 없이 로컬 실행 + status detail 안내', async () => {
  const events: ChatEvent[] = [];
  const runner = fakeRunner((_r, emit) => {
    emit({ type: 'chunk', text: 'x' });
    emit({ type: 'done', text: 'x' });
    return 'done';
  });
  const r = await runLocalChatTurn(
    REQ,
    baseDeps({ runner, resolveWorkspaceDir: async () => ({ dir: '/ws', synced: false }) }),
    (e) => events.push(e),
  );
  assert.equal(r.handled, true);
  const st = events[0] as Extract<ChatEvent, { kind: 'status' }>;
  assert.equal(st.surface, 'connector_local');
  assert.equal(st.workspaceDir, '/ws');
  assert.equal(st.detail, WORKSPACE_UNSYNCED_DETAIL);
  assert.equal(runner.seen[0].workspace_dir, '/ws');
  // synced=true 면 detail 없음
  const events2: ChatEvent[] = [];
  await runLocalChatTurn(REQ, baseDeps({ runner }), (e) => events2.push(e));
  assert.equal((events2[0] as { detail?: string }).detail, undefined);
});

// ── 렌더러 배지(session-store) — blocked / 동기화 미완료 안내 텍스트 ──────────

function badgeStore() {
  const streams: Array<{ onEvent: (e: ChatEvent) => void }> = [];
  const transport: SessionTransport = {
    stream(_req, onEvent) {
      streams.push({ onEvent });
      return { cancel: () => {} };
    },
    async historyTurns() {
      return [];
    },
  };
  const agent: Agent = {
    id: 1,
    workflowId: 'wf1',
    workflowName: 'A',
    nodeCount: 1,
    isShared: false,
    isDeployed: false,
    isCompleted: true,
    workflowType: 'canvas',
    description: '',
    username: '',
    fullName: '',
    createdAt: '',
    updatedAt: '',
  };
  const store = new SessionStore(transport, () => 1);
  const key = store.openNew(agent);
  store.send(key, 'q');
  return { store, key, stream: streams[0] };
}

test('렌더러 배지: blocked 상태는 surface=blocked + 차단 메시지, 로컬 안내(detail)는 connector_local 옆에', () => {
  const a = badgeStore();
  a.stream.onEvent({
    kind: 'status',
    surface: 'blocked',
    reason: 'quota_exceeded',
    detail: '한도 초과',
  });
  a.stream.onEvent({ kind: 'error', detail: '한도 초과' });
  a.stream.onEvent({ kind: 'end' });
  let last = a.store.get(a.key)!.messages.at(-1)!;
  assert.equal(last.surface, 'blocked');
  assert.equal(last.surfaceNote, '한도 초과');
  assert.equal(last.error, true);

  const b = badgeStore();
  b.stream.onEvent({
    kind: 'status',
    surface: 'connector_local',
    provider: 'codex',
    workspaceDir: '/ws',
    detail: WORKSPACE_UNSYNCED_DETAIL,
  });
  last = b.store.get(b.key)!.messages.at(-1)!;
  assert.equal(last.surface, 'connector_local');
  assert.equal(last.surfaceNote, WORKSPACE_UNSYNCED_DETAIL);

  const c = badgeStore();
  c.stream.onEvent({ kind: 'status', surface: 'connector_local', provider: 'codex' });
  assert.equal(c.store.get(c.key)!.messages.at(-1)!.surfaceNote, undefined);

  const d = badgeStore();
  d.stream.onEvent({
    kind: 'status',
    surface: 'server_sandbox',
    reason: describeFallback('graph_suppliers'),
  });
  assert.equal(
    d.store.get(d.key)!.messages.at(-1)!.surfaceNote,
    '캔버스 공급 노드(도구·RAG 등)는 서버에서 실행',
  );
});

// ── preflight_error: 서버 사전 점검 실패 → 사이드카 미기동, reason 'preflight' ──────────

test('[PREFLIGHT] ctx.preflight_error 문자열이면 사이드카를 시작하지 않고 preflight 로 서버 폴백(무 emit), detail 은 120자 절단', async () => {
  const noEmit = (e: ChatEvent) => assert.fail(`emit 금지: ${e.kind}`);
  const longMsg = 'vLLM 모델이 선택되지 않았습니다. ' + 'x'.repeat(200);
  const server = fakeServer({
    fetchLocalTurnContext: async () => ({ ...CTX, preflight_error: longMsg }),
  });
  const runner = fakeRunner(() => assert.fail('사이드카 기동 금지'));
  let wsResolved = false;
  const r = await runLocalChatTurn(
    REQ,
    baseDeps({
      server,
      runner,
      resolveWorkspaceDir: async () => ((wsResolved = true), { dir: '/ws', synced: true }),
    }),
    noEmit,
  );
  assert.deepEqual([r.handled, r.reason], [false, 'preflight']);
  assert.equal(r.detail?.length, 120);
  assert.ok(r.detail?.startsWith('vLLM 모델이 선택되지 않았습니다.'));
  assert.equal(runner.seen.length, 0);
  assert.equal(wsResolved, false, '워크스페이스 확보 전에 끊는다');
  assert.equal(server.reports.length, 0);
  // 배지 문구(렌더러는 describeFallback 결과를 그대로 보인다)
  assert.equal(
    describeFallback('preflight'),
    '사전 점검 실패(모델 미선택·비활성·미인가) — 서버가 같은 안내 문구를 냅니다',
  );
  assert.match(describeFallback('preflight', 'vLLM 모델 미선택'), /\(vLLM 모델 미선택\)$/);
});

test('[PREFLIGHT] preflight_error 가 null/빈 문자열/공백이면 통과(기존 경로 그대로 로컬 실행)', async () => {
  for (const v of [null, '', '   ', undefined]) {
    const runner = fakeRunner((_r, emit) => {
      emit({ type: 'chunk', text: 'ok' });
      emit({ type: 'done', text: 'ok' });
      return 'done';
    });
    const server = fakeServer({
      fetchLocalTurnContext: async () => ({ ...CTX, preflight_error: v as string | null }),
    });
    const r = await runLocalChatTurn(REQ, baseDeps({ server, runner }), () => {});
    assert.equal(r.handled, true, String(v));
    assert.equal(runner.seen.length, 1);
  }
});

// ── defaultSidecarCommand: 설치 폴더 런타임 루트는 호출부가 넘긴다(정적 import, config 비의존) ──

test('defaultSidecarCommand: runtimeDir 의 python 이 있으면 그걸 쓰고 PATH 앞에 <runtimeDir>/bin 을 붙인다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sidecar-cmd-'));
  try {
    const py = pythonExePath(dir);
    mkdirSync(join(py, '..'), { recursive: true });
    writeFileSync(py, '');
    const cmd = defaultSidecarCommand(true, undefined, { runtimeDir: dir });
    assert.equal(cmd.command, py);
    assert.ok(cmd.args.includes('--serve'));
    const env = cmd.env ?? {};
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    assert.ok(String(env[pathKey]).startsWith(join(dir, 'bin')), env[pathKey]);
    // override 가 우선
    assert.equal(
      defaultSidecarCommand(true, '/override/python', { runtimeDir: dir }).command,
      '/override/python',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('[LOCAL MCP] deps.connectorMcpServers → context.connector_mcp_servers 전달, 없으면 미포함', async () => {
  const ignore = (_e: ChatEvent) => {};
  const runner = fakeRunner((_r, emit) => {
    emit({ type: 'done', text: 'x' });
    return 'done';
  });
  const servers = [
    { name: 'atlassian', transport: 'stdio', command: 'uvx', args: ['mcp-atlassian'] },
  ];
  await runLocalChatTurn(
    REQ,
    baseDeps({ runner, connectorMcpServers: async () => servers }),
    ignore,
  );
  assert.deepEqual(
    (runner.seen[0].context as Record<string, unknown>)?.connector_mcp_servers,
    servers,
    '외부 MCP 서버 설정이 context 로 전달돼야 한다',
  );

  const r2 = fakeRunner((_r, emit) => {
    emit({ type: 'done', text: 'x' });
    return 'done';
  });
  await runLocalChatTurn(
    REQ,
    baseDeps({ runner: r2, connectorMcpServers: async () => [] }),
    ignore,
  );
  assert.equal(
    (r2.seen[0].context as Record<string, unknown>)?.connector_mcp_servers,
    undefined,
    '서버가 없으면 connector_mcp_servers 키를 넣지 않는다',
  );
});
