// 로컬 MCP 실행 로그가 디스크 없이 제한된 메모리에만 유지되는지 검증한다.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendMcpRuntimeLog,
  clearMcpRuntimeLogs,
  mcpRuntimeLogs,
  onMcpRuntimeLog,
} from '../src/main/mcp-runtime-log';

test.beforeEach(() => clearMcpRuntimeLogs());

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
