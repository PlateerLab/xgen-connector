// 커넥터 로컬 실행 v2 — 라우팅(로컬 우선·명시적 폴백)·사이드카 데몬 프로토콜·
// 서버 클라이언트 v2(매니페스트/보고 메타)·서버 버전 수렴 계획·CLI 버전 URL.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatEvent, ChatRequest } from '../src/core/types';
import {
  SidecarDaemon,
  resolveSidecarCommand,
  type LocalTurnRequest,
  type SidecarEvent,
  type SidecarTerminal,
} from '../src/main/local-agent-sidecar';
import { makeServerClient, type ServerClient } from '../src/main/local-agent-server-client';
import {
  describeFallback,
  runLocalChatTurn,
  type LocalChatDeps,
} from '../src/main/local-chat-route';
import { planConverge } from '../src/main/local-runtime-converge';
import { codexAssetUrl, ensureCliConverged } from '../src/main/cli-provision';
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
  context: { api_keys: { openai: 'sk' }, settings: { CODEX_AUTH_MODE: 'oauth' } },
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
    resolveWorkspaceDir: async () => '/ws',
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
    ['started', 'chunk', 'tool', 'done'],
  );
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
