/** SessionStore — multi-session runtime: 전환해도 진행 중 스트림/전사가 유지된다. */
import assert from 'assert'
import { test } from 'node:test'
import {
  SessionStore,
  isKeepable,
  openSessions,
  agentSessions,
  type SessionTransport,
} from '../src/renderer/src/session-store'
import type { Agent, ChatEvent } from '../src/core/index'

function agent(workflowId: string, name = workflowId): Agent {
  return {
    id: 1,
    workflowId,
    workflowName: name,
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
  }
}

interface FakeStream {
  interactionId: string
  onEvent: (e: ChatEvent) => void
  cancelled: boolean
}

function makeStore(history: Record<string, Array<{ input: string; output: string }>> = {}) {
  const streams: FakeStream[] = []
  let historyCalls = 0
  const transport: SessionTransport = {
    stream(req, onEvent) {
      const s: FakeStream = { interactionId: req.interactionId, onEvent, cancelled: false }
      streams.push(s)
      return { cancel: () => { s.cancelled = true } }
    },
    async historyTurns(_w, interactionId) {
      historyCalls++
      return history[interactionId] ?? []
    },
  }
  let clock = 1000
  const store = new SessionStore(transport, () => clock++)
  return { store, streams, historyCalls: () => historyCalls }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

test('openNew 는 세션을 만들고 활성화한다', () => {
  const { store } = makeStore()
  const key = store.openNew(agent('A'))
  assert.equal(store.activeKey, key)
  assert.equal(store.get(key)?.agent.workflowId, 'A')
  assert.equal(store.getSnapshot().sessions.length, 1)
})

test('같은 에이전트로 새 대화를 다시 열면 빈 세션을 재사용한다', () => {
  const { store } = makeStore()
  const k1 = store.openNew(agent('A'))
  const k2 = store.openNew(agent('A'))
  assert.equal(k1, k2, '빈 세션 재사용')
  assert.equal(store.getSnapshot().sessions.length, 1)
})

test('빈 세션은 다른 세션으로 전환할 때 회수된다', () => {
  const { store } = makeStore()
  const kA = store.openNew(agent('A'))
  const kB = store.openNew(agent('B'))
  assert.equal(store.get(kA), null, '빈 A 는 GC')
  assert.equal(store.activeKey, kB)
  assert.equal(store.getSnapshot().sessions.length, 1)
})

test('send 는 사용자·assistant 메시지를 넣고 스트림을 연다', () => {
  const { store, streams } = makeStore()
  const k = store.openNew(agent('A'))
  store.send(k, '질문')
  const s = store.get(k)!
  assert.equal(s.streaming, true)
  assert.deepEqual(s.messages.map((m) => m.role), ['user', 'assistant'])
  assert.equal(s.messages[0].text, '질문')
  assert.equal(streams.length, 1)
})

test('스트림 이벤트가 텍스트·도구·출처를 누적하고 end 에서 멈춘다', () => {
  const { store, streams } = makeStore()
  const k = store.openNew(agent('A'))
  store.send(k, 'q')
  streams[0].onEvent({ kind: 'text', content: 'Hel' })
  streams[0].onEvent({ kind: 'text', content: 'lo' })
  streams[0].onEvent({
    kind: 'tool',
    event: { eventType: 'tool_result', toolName: 'X', citations: [{ fileName: 'a.pdf', pageNumber: 1 }] },
  })
  streams[0].onEvent({ kind: 'end' })
  const last = store.get(k)!.messages.at(-1)!
  assert.equal(last.text, 'Hello')
  assert.equal(last.tools?.length, 1)
  assert.equal(last.citations?.length, 1)
  assert.equal(last.streaming, false)
  assert.equal(store.get(k)!.streaming, false)
})

test('다른 세션으로 전환해도 진행 중 스트림이 죽지 않고 백그라운드로 누적된다', () => {
  const { store, streams } = makeStore()
  const kA = store.openNew(agent('A'))
  store.send(kA, 'q')
  // A 가 스트리밍 중일 때 B 로 전환
  const kB = store.openNew(agent('B'))
  assert.equal(streams[0].cancelled, false, 'A 스트림은 취소되지 않음')
  assert.equal(store.activeKey, kB)
  // 포그라운드가 아닌 A 로 이벤트가 계속 흐른다
  streams[0].onEvent({ kind: 'text', content: '백그라운드' })
  streams[0].onEvent({ kind: 'end' })
  const a = store.get(kA)!
  assert.equal(a.messages.at(-1)!.text, '백그라운드')
  assert.equal(a.streaming, false)
  assert.equal(store.activeKey, kB, '활성 세션은 여전히 B')
})

test('setActive 로 되돌아오면 그 전사가 그대로 보인다', () => {
  const { store, streams } = makeStore()
  const kA = store.openNew(agent('A'))
  store.send(kA, 'q')
  streams[0].onEvent({ kind: 'text', content: '진행' })
  const kB = store.openNew(agent('B'))
  store.send(kB, 'q2')
  store.setActive(kA)
  assert.equal(store.activeKey, kA)
  assert.equal(store.get(kA)!.messages.at(-1)!.text, '진행')
})

test('stop 은 스트림을 취소하고 스트리밍 상태를 내린다', () => {
  const { store, streams } = makeStore()
  const k = store.openNew(agent('A'))
  store.send(k, 'q')
  store.stop(k)
  assert.equal(streams[0].cancelled, true)
  assert.equal(store.get(k)!.streaming, false)
  assert.equal(store.get(k)!.messages.at(-1)!.streaming, false)
})

test('endChat 은 스트림을 끊고 세션을 지우며 다음 세션을 활성화한다', () => {
  const { store, streams } = makeStore()
  const kA = store.openNew(agent('A'))
  store.send(kA, 'a')
  const kB = store.openNew(agent('B'))
  store.send(kB, 'b')
  store.endChat(kB)
  assert.equal(streams[1].cancelled, true)
  assert.equal(store.get(kB), null)
  assert.equal(store.activeKey, kA, '남은 세션 중 최신이 활성')
  store.endChat(kA)
  assert.equal(store.activeKey, null)
})

test('openResume 는 히스토리를 불러오고, 이미 열려 있으면 다시 불러오지 않는다', async () => {
  const { store, historyCalls } = makeStore({ 'iid-1': [{ input: 'u', output: 'a' }] })
  store.openResume(agent('A'), 'iid-1')
  assert.equal(store.get('iid-1')!.loadingHistory, true)
  await flush()
  const s = store.get('iid-1')!
  assert.equal(s.loadingHistory, false)
  assert.deepEqual(s.messages.map((m) => m.text), ['u', 'a'])
  // 다시 열기 → 포커스만, 히스토리 재호출 없음
  store.setActive(null)
  store.openResume(agent('A'), 'iid-1')
  await flush()
  assert.equal(historyCalls(), 1, '히스토리는 한 번만 로드')
})

test('진행 중 턴이 히스토리 로드를 덮어쓰지 않는다', async () => {
  const { store, streams } = makeStore({ 'iid-2': [{ input: 'old', output: 'answer' }] })
  store.openResume(agent('A'), 'iid-2')
  // 히스토리 도착 전에 새 턴 시작
  store.send('iid-2', '새질문')
  streams[0].onEvent({ kind: 'text', content: '새답변' })
  await flush()
  const s = store.get('iid-2')!
  // 히스토리(old/answer)로 덮지 않고 라이브 전사를 유지
  assert.ok(s.messages.some((m) => m.text === '새질문'))
  assert.ok(!s.messages.some((m) => m.text === 'old'))
})

test('reset 은 모든 스트림을 끊고 비운다', () => {
  const { store, streams } = makeStore()
  const kA = store.openNew(agent('A'))
  store.send(kA, 'a')
  const kB = store.openNew(agent('B'))
  store.send(kB, 'b')
  store.reset()
  assert.equal(streams[0].cancelled, true)
  assert.equal(streams[1].cancelled, true)
  assert.equal(store.getSnapshot().sessions.length, 0)
  assert.equal(store.activeKey, null)
})

test('getSnapshot 은 변화가 없으면 같은 참조를 돌려준다', () => {
  const { store } = makeStore()
  store.openNew(agent('A'))
  const snap1 = store.getSnapshot()
  const snap2 = store.getSnapshot()
  assert.equal(snap1, snap2, '동일 참조 (useSyncExternalStore 요건)')
})

test('unseen: 백그라운드에서 끝난 턴은 unseen 이 서고, 포그라운드에서 끝나면 안 선다', () => {
  const { store, streams } = makeStore()
  const kA = store.openNew(agent('A'))
  store.send(kA, 'q')
  const kB = store.openNew(agent('B')) // A 는 백그라운드로
  streams[0].onEvent({ kind: 'end' })
  assert.equal(store.get(kA)!.unseen, true, '백그라운드에서 끝나면 unseen')
  assert.equal(store.get(kB)!.unseen, false, '지금 보고 있는 세션은 아직 아무 턴도 안 끝남')

  store.send(kB, 'q2')
  streams[1].onEvent({ kind: 'end' })
  assert.equal(store.get(kB)!.unseen, false, '포그라운드에서 끝나면 unseen 이 안 선다')
})

test('unseen: 오류로 끝나도 백그라운드면 선다(빨간 점 재료)', () => {
  const { store, streams } = makeStore()
  const kA = store.openNew(agent('A'))
  store.send(kA, 'q')
  store.openNew(agent('B'))
  streams[0].onEvent({ kind: 'error', detail: '실패' })
  const a = store.get(kA)!
  assert.equal(a.unseen, true)
  assert.equal(a.error, '실패')
})

test('unseen: setActive 로 그 탭을 보면 꺼진다', () => {
  const { store, streams } = makeStore()
  const kA = store.openNew(agent('A'))
  store.send(kA, 'q')
  store.openNew(agent('B'))
  streams[0].onEvent({ kind: 'end' })
  assert.equal(store.get(kA)!.unseen, true)
  store.setActive(kA)
  assert.equal(store.get(kA)!.unseen, false)
})

test('unseen: 새 턴을 보내면 이전 unseen 은 초기화된다', () => {
  const { store, streams } = makeStore()
  const kA = store.openNew(agent('A'))
  store.send(kA, 'q1')
  store.openNew(agent('B'))
  streams[0].onEvent({ kind: 'end' })
  assert.equal(store.get(kA)!.unseen, true)
  store.send(kA, 'q2') // 백그라운드에서 바로 다음 턴 시작
  assert.equal(store.get(kA)!.unseen, false, '진행 중인 턴은 unseen 결과가 아니다(스트리밍 점이 대신 뜬다)')
})

test('helpers: isKeepable / openSessions / agentSessions', () => {
  const { store, streams } = makeStore()
  const kA = store.openNew(agent('A'))
  store.send(kA, 'a')
  streams[0].onEvent({ kind: 'end' })
  const kB = store.openNew(agent('B')) // empty
  const all = store.getSnapshot().sessions
  assert.equal(isKeepable(store.get(kA)!), true)
  assert.equal(isKeepable(store.get(kB)!), false, '빈 세션은 keepable 아님')
  assert.equal(openSessions(all).length, 1)
  assert.equal(agentSessions(all, 'A').length, 1)
  assert.equal(agentSessions(all, 'B').length, 0)
})
