// 커넥터 로컬 실행 러너 — Node↔Python 사이드카 배관을 검증한다. 실제 Python
// 사이드카(AgentTurnExecutor 로컬 실행)는 xgen_agent_runtime.host 쪽에서 이미 증명됐고,
// 여기서는 **이벤트 스트림 파싱·종료·무언종료 합성·명령 해석**만 본다(가짜 사이드카).
import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import {
  resolveSidecarCommand,
  runLocalTurn,
  type SidecarCommand,
  type SidecarEvent,
} from '../src/main/local-agent-sidecar';

/** stdin 요청을 읽어 JSON-lines 이벤트를 뱉는 가짜 사이드카(node -e). */
function fakeSidecar(script: string): SidecarCommand {
  return { command: process.execPath, args: ['-e', script] };
}

const REQ = { workspace_dir: '/tmp/ws', provider: 'openai', text: '안녕' };

test('사이드카 이벤트 스트림을 순서대로 읽어 콜백으로 흘린다', async () => {
  const events: SidecarEvent[] = [];
  const script = `
    let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      const req=JSON.parse(d);
      process.stdout.write(JSON.stringify({type:'chunk',text:'안녕 '})+'\\n');
      process.stdout.write(JSON.stringify({type:'done',text:'안녕 '+req.text})+'\\n');
    });`;
  const { code } = await runLocalTurn(REQ, (e) => events.push(e), { command: fakeSidecar(script) });
  assert.equal(code, 0);
  assert.deepEqual(
    events.map((e) => e.type),
    ['chunk', 'done'],
  );
  assert.equal((events[1] as { text: string }).text, '안녕 안녕'); // 요청 text 왕복 확인
});

test('요청이 stdin 으로 실제 전달된다 (왕복)', async () => {
  let got = '';
  const script = `
    let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      const req=JSON.parse(d);
      process.stdout.write(JSON.stringify({type:'done',text:req.workspace_dir})+'\\n');
    });`;
  await runLocalTurn(
    REQ,
    (e) => {
      if (e.type === 'done') got = e.text;
    },
    { command: fakeSidecar(script) },
  );
  assert.equal(got, '/tmp/ws');
});

test('결과 없이 죽으면 error 이벤트를 합성한다 (커넥터가 매달리지 않게)', async () => {
  const events: SidecarEvent[] = [];
  // 아무것도 출력하지 않고 즉시 종료.
  await runLocalTurn(REQ, (e) => events.push(e), {
    command: fakeSidecar('process.stdin.resume(); process.stdin.on("end",()=>process.exit(3));'),
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'error');
  assert.match((events[0] as { message: string }).message, /결과 없이 종료.*code=3/);
});

test('사이드카 error 이벤트는 그대로 전달된다', async () => {
  const events: SidecarEvent[] = [];
  const script =
    'process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({type:"error",message:"boom"})+"\\n")});';
  await runLocalTurn(REQ, (e) => events.push(e), { command: fakeSidecar(script) });
  assert.deepEqual(events, [{ type: 'error', message: 'boom' }]);
});

test('JSON 아닌 stderr/경고 줄은 무시한다', async () => {
  const events: SidecarEvent[] = [];
  const script = `
    process.stdin.resume(); process.stdin.on('end',()=>{
      process.stdout.write('DeprecationWarning: something\\n');
      process.stdout.write(JSON.stringify({type:'done',text:'ok'})+'\\n');
    });`;
  await runLocalTurn(REQ, (e) => events.push(e), { command: fakeSidecar(script) });
  assert.deepEqual(events, [{ type: 'done', text: 'ok' }]);
});

test('스폰 실패는 error 이벤트로 (예외 아님)', async () => {
  const events: SidecarEvent[] = [];
  await runLocalTurn(REQ, (e) => events.push(e), {
    command: { command: '/nonexistent/xgen-python-xyz', args: [] },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'error');
});

test('명령 해석 — env 오버라이드(XGEN_SIDECAR_PYTHON/PYTHONPATH)', () => {
  const cmd = resolveSidecarCommand({
    env: {
      XGEN_SIDECAR_PYTHON: '/opt/py',
      XGEN_SIDECAR_PYTHONPATH: '/pkg/src',
    } as NodeJS.ProcessEnv,
  });
  assert.equal(cmd.command, '/opt/py');
  assert.deepEqual(cmd.args, ['-m', 'xgen_agent_runtime.host.sidecar']);
  assert.equal(cmd.env?.PYTHONPATH, '/pkg/src');
});

test('명령 해석 — 패키지 빌드는 번들 Python 을 가리킨다', () => {
  const cmd = resolveSidecarCommand({
    isPackaged: true,
    resourcesPath: '/app/resources',
    env: {} as NodeJS.ProcessEnv,
  });
  // OS 경로 구분자 중립 — Windows 러너에서는 backslash 로 조립된다(join).
  const expected =
    process.platform === 'win32'
      ? join('/app/resources', 'python', 'python.exe')
      : join('/app/resources', 'python', 'bin', 'python3');
  assert.equal(cmd.command, expected);
  // 표준 경로는 격리 인터프리터(-I -X utf8 -u) — 사용자 PYTHON* 환경이 내장 런타임을 깨지 않게
  assert.deepEqual(cmd.args, ['-I', '-X', 'utf8', '-u', '-m', 'xgen_agent_runtime.host.sidecar']);
  assert.equal(cmd.env?.PYTHONNOUSERSITE, '1');
});
