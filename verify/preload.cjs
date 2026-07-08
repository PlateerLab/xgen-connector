// Mock bridge for visual verification — exposes window.xgen with canned data
// (no network). Mirrors src/preload/index.ts's API surface.
const { contextBridge } = require('electron');

const user = { userId: '1', username: 'admin', isSuperuser: true, roles: [], permissions: [] };
const agents = [
  { workflowId: 'wf1', workflowName: '한국마사회 RAG 상담', nodeCount: 7, isShared: false, isDeployed: true, workflowType: 'canvas', description: '' },
  { workflowId: 'wf2', workflowName: '경마 데이터 분석가', nodeCount: 12, isShared: true, isDeployed: false, workflowType: 'canvas', description: '' },
  { workflowId: 'wf3', workflowName: 'Agentflow (4)', nodeCount: 4, isShared: false, isDeployed: false, workflowType: 'canvas', description: '' },
  { workflowId: 'wf4', workflowName: '사내 문서 도우미', nodeCount: 9, isShared: true, isDeployed: true, workflowType: 'harness', description: '' },
  { workflowId: 'wf5', workflowName: '릴리즈 노트 작성기', nodeCount: 5, isShared: false, isDeployed: false, workflowType: 'canvas', description: '' },
];

const state = { theme: process.env.VERIFY_THEME || 'system' };
const config = { serverUrl: 'https://xgen.plateer.com', theme: state.theme, autoUpdate: true, lang: 'ko' };

const restoreUser = process.env.VERIFY_STAGE === 'login' ? null : user;

const api = {
  config: {
    get: async () => ({ ...config, theme: state.theme }),
    set: async (patch) => { Object.assign(config, patch); if (patch.theme) state.theme = patch.theme; return { ...config }; },
    onChange: () => () => {},
  },
  auth: {
    login: async () => ({ user }),
    restore: async () => ({ user: restoreUser }),
    logout: async () => true,
    status: async () => ({ user }),
    onAuthFailed: () => () => {},
  },
  agents: {
    list: async (q) => {
      let items = agents.slice();
      if (q && q.owner === 'personal') items = items.filter((a) => !a.isShared);
      if (q && q.owner === 'shared') items = items.filter((a) => a.isShared);
      if (q && q.search) items = items.filter((a) => a.workflowName.includes(q.search));
      return { items, pagination: { page: 1, pageSize: 24, totalCount: items.length, totalPages: 1 } };
    },
  },
  history: { turns: async () => [], conversations: async () => [] },
  chat: {
    stream: (req, onEvent) => {
      const script = [
        { d: 120, ev: { kind: 'text', content: '안녕하세요! 😊\n\n' } },
        { d: 260, ev: { kind: 'text', content: '무엇을 도와드릴까요? 한국마사회 관련 자료나 ' } },
        { d: 220, ev: { kind: 'tool', event: { eventType: 'tool_start', toolName: 'knowledge_search', toolInput: {}, citations: [] } } },
        { d: 260, ev: { kind: 'text', content: '경마에 대해 궁금하신 점이 있으시면 ' } },
        { d: 240, ev: { kind: 'tool', event: { eventType: 'tool_result', toolName: 'knowledge_search', result: 'ok', citations: [
          { fileName: '2023년도_보고서.pdf', pageNumber: 12 },
          { fileName: '2020년도_불임2.docx', pageNumber: 3 },
          { fileName: '경마시행규정.pdf' },
        ] } } },
        { d: 220, ev: { kind: 'text', content: '언제든지 질문해 주세요!' } },
        { d: 160, ev: { kind: 'end' } },
      ];
      let i = 0;
      let cancelled = false;
      const tick = () => {
        if (cancelled || i >= script.length) return;
        const step = script[i++];
        setTimeout(() => { if (!cancelled) { onEvent(step.ev); tick(); } }, step.d);
      };
      tick();
      return { cancel: () => { cancelled = true; } };
    },
  },
  updater: {
    check: async () => ({}),
    getEnabled: async () => true,
    setEnabled: async () => true,
    onMessage: () => () => {},
  },
  openExternal: async () => {},
};

contextBridge.exposeInMainWorld('xgen', api);
