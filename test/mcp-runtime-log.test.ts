// 로컬 MCP 실행 로그가 디스크 없이 제한된 메모리에만 유지되는지 검증한다.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendMcpRuntimeLog,
  clearMcpRuntimeLogs,
  mcpRuntimeLogs,
  onMcpRuntimeLog,
  setMcpRuntimeLogEnabled,
} from '../src/main/mcp-runtime-log';

test.beforeEach(() => {
  setMcpRuntimeLogEnabled(true);
  clearMcpRuntimeLogs();
});

test.afterEach(() => setMcpRuntimeLogEnabled(false));

test('디버그 모드가 꺼지면 로그를 수집하거나 전달하지 않는다', () => {
  const received: number[] = [];
  const off = onMcpRuntimeLog((entry) => received.push(entry.id));
  setMcpRuntimeLogEnabled(false);
  const entry = appendMcpRuntimeLog({ kind: 'call', message: '호출' });
  off();

  assert.equal(entry, null);
  assert.deepEqual(received, []);
  assert.deepEqual(mcpRuntimeLogs(), []);
});

test('추가된 로그를 구독자와 현재 실행 목록에 전달한다', () => {
  const received: number[] = [];
  const off = onMcpRuntimeLog((entry) => received.push(entry.id));
  const entry = appendMcpRuntimeLog({
    kind: 'call',
    message: '호출',
    server: 'uuid',
    tool: 'random_uuid',
  });
  off();

  assert.ok(entry);
  assert.deepEqual(received, [entry.id]);
  assert.deepEqual(mcpRuntimeLogs(), [entry]);
});

test('최근 200개만 보관하고 초기화한다', () => {
  for (let i = 0; i < 205; i += 1) {
    appendMcpRuntimeLog({ kind: 'catalog', message: `catalog ${i}` });
  }
  const logs = mcpRuntimeLogs();
  assert.equal(logs.length, 200);
  assert.equal(logs[0].message, 'catalog 5');

  clearMcpRuntimeLogs();
  assert.deepEqual(mcpRuntimeLogs(), []);
});
