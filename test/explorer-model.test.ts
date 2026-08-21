// 탐색기 사이드바 순수 모델 — 섹션 구성·경로 결합·정렬·크기 표시를 검증한다.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENTS_ROOT,
  CLOUD_ROOT,
  childPath,
  formatSize,
  sectionsFor,
  sortEntries,
} from '../src/renderer/src/views/explorer-model';

test('상태가 없어도 XgenCloud 섹션은 항상 있다', () => {
  const sections = sectionsFor(null);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].id, 'cloud');
  assert.equal(sections[0].title, 'XgenCloud');
  assert.equal(sections[0].path, CLOUD_ROOT);
});

test('연결된 에이전트마다 workspace 섹션이 뒤따른다', () => {
  const sections = sectionsFor({
    agents: [
      { workflowId: 'wf-1', label: '마케팅 리서치', folder: '마케팅 리서치' },
      { workflowId: 'wf-2', label: '', folder: '보고서 봇' },
    ],
  });
  assert.equal(sections.length, 3);
  assert.equal(sections[1].id, 'agent:wf-1');
  assert.equal(sections[1].title, '마케팅 리서치');
  assert.equal(sections[1].path, `${AGENTS_ROOT}/마케팅 리서치`);
  // label 이 비면 폴더명이 제목이 된다 — 빈 헤더는 누를 수 없는 섹션이 된다.
  assert.equal(sections[2].title, '보고서 봇');
});

test('섹션 id 는 workflowId 기반이라 폴더명이 바뀌어도 접힘 상태가 유지된다', () => {
  const a = sectionsFor({ agents: [{ workflowId: 'wf-1', label: 'A', folder: 'A' }] });
  const b = sectionsFor({ agents: [{ workflowId: 'wf-1', label: 'A2', folder: 'A2' }] });
  assert.equal(a[1].id, b[1].id);
});

test('childPath 는 루트와 하위 경로를 모두 안전하게 잇는다', () => {
  assert.equal(childPath('/', '클라우드'), '/클라우드');
  assert.equal(childPath('/클라우드', '보고서.md'), '/클라우드/보고서.md');
  assert.equal(childPath('/에이전트/봇', '메모'), '/에이전트/봇/메모');
});

test('정렬은 폴더 먼저, 그 다음 이름순이다', () => {
  const sorted = sortEntries([
    { name: 'b.txt', isDir: false, size: 1, mtime: 0 },
    { name: '나', isDir: true, size: 0, mtime: 0 },
    { name: 'a.txt', isDir: false, size: 1, mtime: 0 },
    { name: '가', isDir: true, size: 0, mtime: 0 },
  ]);
  assert.deepEqual(
    sorted.map((e) => e.name),
    ['가', '나', 'a.txt', 'b.txt'],
  );
});

test('정렬은 입력 배열을 바꾸지 않는다', () => {
  const input = [
    { name: 'b', isDir: false, size: 0, mtime: 0 },
    { name: 'a', isDir: false, size: 0, mtime: 0 },
  ];
  sortEntries(input);
  assert.equal(input[0].name, 'b');
});

test('파일 크기는 사람 단위로 줄인다', () => {
  assert.equal(formatSize(0), '0B');
  assert.equal(formatSize(512), '512B');
  assert.equal(formatSize(1536), '1.5KB');
  assert.equal(formatSize(10 * 1024 * 1024), '10MB');
  assert.equal(formatSize(-1), '');
});
