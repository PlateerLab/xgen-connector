/** 도구 활동 표시 로직 — 한 번에 하나, 연속 상태는 제자리, 몰리면 건너뛰기. */
import assert from 'assert'
import { test } from 'node:test'
import { collapseToolSteps, nextToolIndex } from '../src/renderer/src/views/tool-activity-model'

const ev = (toolName: string, eventType: string) => ({ toolName, eventType })

test('연속된 같은 도구 이벤트는 한 단계로 접힌다 (마지막 상태 유지)', () => {
  const steps = collapseToolSteps([
    ev('Bash', 'tool_call'), ev('Bash', 'tool_start'), ev('Bash', 'tool_error'),
    ev('DocAnalyze', 'tool_call'), ev('DocAnalyze', 'tool_result'),
  ])
  assert.equal(steps.length, 2, '도구 2종 → 단계 2개')
  assert.deepEqual(steps[0], ev('Bash', 'tool_error'))
  assert.deepEqual(steps[1], ev('DocAnalyze', 'tool_result'))
})

test('스크린샷 시나리오(30 이벤트)가 도구 수만큼으로 접힌다', () => {
  const names = ['Bash', 'mcp__connector__Bash', 'mcp__connector__DocAnalyze',
    'mcp__connector__DocGuide', 'mcp__connector__DocBuild', 'mcp__connector__DocAnalyze',
    'mcp__connector__DocGuide', 'mcp__connector__DocXmlRead', 'mcp__connector__Bash', 'Write']
  const events = names.flatMap((n) => [ev(n, 'tool_call'), ev(n, 'tool_start'), ev(n, 'tool_result')])
  assert.equal(events.length, 30)
  assert.equal(collapseToolSteps(events).length, names.length, '30칩 벽 → 도구 단계 10개')
})

test('같은 도구가 떨어져서 다시 쓰이면 별도 단계다', () => {
  const steps = collapseToolSteps([ev('Bash', 'tool_result'), ev('Write', 'tool_result'), ev('Bash', 'tool_call')])
  assert.equal(steps.length, 3)
})

test('전진 규칙: 최신이면 대기, 조금 밀리면 한 칸, 많이 밀리면 최신으로 점프', () => {
  assert.equal(nextToolIndex(4, 5), 4, '최신 표시 중이면 그대로')
  assert.equal(nextToolIndex(0, 2), 1, '한 단계 밀림 → +1 (교체가 보이게)')
  assert.equal(nextToolIndex(0, 4), 1, '3단계 밀림(경계) → +1')
  assert.equal(nextToolIndex(0, 12), 11, '많이 밀리면 최신으로 점프 (슥 지나감)')
  assert.equal(nextToolIndex(9, 12), 10, '2단계 밀림 → +1')
  assert.equal(nextToolIndex(0, 5), 4, '4단계 밀림 → 점프')
})

test('빈 목록/범위 밖 인덱스에서도 안전하다', () => {
  assert.equal(nextToolIndex(0, 0), 0)
  assert.equal(nextToolIndex(99, 3), 2)
  assert.deepEqual(collapseToolSteps([]), [])
})
