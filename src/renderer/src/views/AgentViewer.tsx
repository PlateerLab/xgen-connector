/**
 * AgentViewer — 한 에이전트(workflow)의 **읽기 전용** 관측 뷰어.
 *
 * 채팅 헤더의 [...] 메뉴에서 새 탭으로 열린다. 여섯 하위 탭(기본정보/메모리/작업/
 * 도구/스토리지/전체로그)을 두고, 각 하위 뷰는 `window.xgen.agentData.*`(전부 GET)로
 * 서버 데이터를 읽어 상세 뷰처럼 보여 준다. 생성/삭제/변경은 없다.
 *
 * [기본정보] 는 **커넥터 표면만** 보여 준다 — 이 앱에서 도는 턴이 그 표면이기
 * 때문이다. 웹 화면은 반대로 web 표면만 보여 준다. 한 화면에서 둘을 토글하던
 * 예전 방식은 지금 보고 있는 게 어느 실행의 것인지 매번 확인해야 했다.
 *
 * 시각 언어는 커넥터 기존 것을 따른다(ToolLogModal 의 배지·펼침 행, --panel/
 * --border/--text-dim 토큰, --font-mono 코드 블록).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { xgen, copyText } from '../bridge';
import { BotIcon, CopyIcon, FolderIcon, FolderOpenIcon, DocIcon } from '../brand/icons';
import type { AgentViewerSub } from './workspace-layout';
import type {
  Span,
  Trace,
  MemoryFile,
  MemoryDetail,
  Task,
  Job,
  JobRun,
  ForgedTool,
  WsNode,
} from '../../../core/index';

interface Props {
  workflowId: string;
  workflowName?: string;
  initialSub?: AgentViewerSub;
  /** 닫기 — 지금은 탭 X 가 담당하므로 미사용(호환용 optional). */
  onClose?: () => void;
}

const SUBS: [AgentViewerSub, string][] = [
  ['basic', '기본정보'],
  ['memory', '메모리'],
  ['tasks', '작업'],
  ['tools', '도구'],
  ['storage', '스토리지'],
  ['fulllog', '전체로그'],
];

/** 임의 값 → 사람이 읽는 문자열(문자열은 그대로, 그 외엔 예쁜 JSON). */
function pretty(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function fmtWhen(v?: string | null): string {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
}

/** 로딩/오류/빈 상태를 한 곳에서 다루는 작은 데이터 훅. */
function useLoader<T>(
  fn: () => Promise<T>,
  deps: React.DependencyList,
): { data: T | null; loading: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fn()
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e) => {
        if (alive) setError(errText(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return { data, loading, error, reload: () => setNonce((n) => n + 1) };
}

const StateNote: React.FC<{ loading: boolean; error: string | null; empty?: boolean; emptyText?: string }> = ({
  loading,
  error,
  empty,
  emptyText,
}) => {
  if (loading) return <div className="viewer-note">불러오는 중…</div>;
  if (error) return <div className="viewer-note err">불러오지 못했습니다: {error}</div>;
  if (empty) return <div className="viewer-note">{emptyText ?? '내용이 없습니다.'}</div>;
  return null;
};

// ─────────────────────────────────────────────────────────────
// 전체로그 (fulllog)
// ─────────────────────────────────────────────────────────────
type Level = 'all' | 'tool' | 'llm' | 'rag' | 'error';
const LEVELS: [Level, string][] = [
  ['all', '전체'],
  ['tool', '도구'],
  ['llm', 'LLM'],
  ['rag', 'RAG'],
  ['error', '오류'],
];

/** span_type → 배지 톤(색). */
function spanTone(t: string): string {
  if (t === 'tool_call' || t === 'tool_output') return 'blue';
  if (t === 'error') return 'red';
  if (t === 'warning') return 'amber';
  if (t === 'llm_call') return 'slate';
  if (t === 'rag_search') return 'emerald';
  if (t === 'agent_input' || t === 'agent_output') return 'violet';
  return 'gray';
}

function spanInLevel(s: Span, level: Level): boolean {
  if (level === 'all') return true;
  const t = s.span_type;
  if (level === 'tool') return t === 'tool_call' || t === 'tool_output';
  if (level === 'llm') return t === 'llm_call';
  if (level === 'rag') return t === 'rag_search';
  if (level === 'error') return t === 'error' || t === 'warning' || !!s.error_message;
  return true;
}

const SpanRow: React.FC<{ span: Span; idx: number }> = ({ span, idx }) => {
  const [open, setOpen] = useState(false);
  const input = pretty(span.input_data);
  const output = pretty(span.output_data);
  // 서버는 metadata 를 JSON **문자열**로 내려준다(컬럼이 text) — 한 번 파싱해
  // 보고, 아니면 원문 그대로 보여 준다.
  const meta = useMemo(() => {
    const raw = span.metadata;
    if (raw === undefined || raw === null || raw === '') return '';
    if (typeof raw === 'string') {
      try {
        return pretty(JSON.parse(raw));
      } catch {
        return raw;
      }
    }
    return pretty(raw);
  }, [span.metadata]);
  const hasDetail = !!(input || output || meta || span.error_message);
  return (
    <div className={`viewer-span ${span.error_message ? 'err' : ''}`}>
      <button className="viewer-span-row" onClick={() => hasDetail && setOpen((o) => !o)}>
        <span className="viewer-idx">{idx + 1}</span>
        <span className={`viewer-badge ${spanTone(span.span_type)}`}>{span.span_type}</span>
        {span.tool_name && (
          <span className="viewer-span-name" title={span.tool_name}>
            {span.tool_name}
          </span>
        )}
        <span className="viewer-spacer" />
        {typeof span.duration_ms === 'number' && (
          <span className="viewer-ms">{span.duration_ms}ms</span>
        )}
        {hasDetail && <span className="viewer-caret">{open ? '−' : '+'}</span>}
      </button>
      {open && hasDetail && (
        <div className="viewer-span-detail">
          {span.error_message && (
            <>
              <div className="viewer-label err">오류</div>
              <pre className="err">{span.error_message}</pre>
            </>
          )}
          {input && (
            <>
              <div className="viewer-label">입력 (args)</div>
              <pre>{input}</pre>
            </>
          )}
          {output && (
            <>
              <div className="viewer-label">출력 (result)</div>
              <pre>{output}</pre>
            </>
          )}
          {meta && (
            <>
              <div className="viewer-label">부가 정보</div>
              <pre>{meta}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
};

const TraceCard: React.FC<{ trace: Trace; spans: Span[]; level: Level }> = ({
  trace,
  spans,
  level,
}) => {
  const [open, setOpen] = useState(true);
  const shown = spans.filter((s) => spanInLevel(s, level));
  return (
    <div className={`viewer-trace ${trace.error_message ? 'err' : ''}`}>
      <button className="viewer-trace-head" onClick={() => setOpen((o) => !o)}>
        <span className={`viewer-badge ${trace.status === 'error' ? 'red' : 'emerald'}`}>
          {trace.status || '—'}
        </span>
        <span className="viewer-trace-model">{trace.model_name || trace.provider || '실행'}</span>
        <span className="viewer-trace-meta">
          {typeof trace.total_tool_calls === 'number' ? `도구 ${trace.total_tool_calls}` : ''}
          {typeof trace.total_llm_calls === 'number' ? ` · LLM ${trace.total_llm_calls}` : ''}
          {typeof trace.duration_ms === 'number' ? ` · ${trace.duration_ms}ms` : ''}
        </span>
        <span className="viewer-spacer" />
        <span className="viewer-when">{fmtWhen(trace.created_at)}</span>
        <span className="viewer-caret">{open ? '−' : '+'}</span>
      </button>
      {trace.error_message && <div className="viewer-trace-err">{trace.error_message}</div>}
      {open && (
        <div className="viewer-span-list">
          {shown.length === 0 ? (
            <div className="viewer-note sm">이 필터에 해당하는 단계가 없습니다.</div>
          ) : (
            shown.map((s, i) => <SpanRow key={i} span={s} idx={i} />)
          )}
        </div>
      )}
    </div>
  );
};

const FullLogView: React.FC<{ workflowId: string }> = ({ workflowId }) => {
  const [level, setLevel] = useState<Level>('all');
  const loader = useLoader(async () => {
    const list = await xgen.agentData.traceList(workflowId);
    const traces = list.traces ?? [];
    const details = await Promise.all(
      traces.map((t) =>
        xgen.agentData.traceDetail(t.trace_id).catch(() => ({ trace: t, spans: [] as Span[] })),
      ),
    );
    return details.map((d, i) => ({ trace: d.trace ?? traces[i], spans: d.spans ?? [] }));
  }, [workflowId]);

  return (
    <div className="viewer-pane">
      <div className="viewer-toolbar">
        <div className="viewer-filters">
          {LEVELS.map(([lv, label]) => (
            <button
              key={lv}
              className={`viewer-chip ${level === lv ? 'active' : ''}`}
              onClick={() => setLevel(lv)}
            >
              {label}
            </button>
          ))}
        </div>
        <button className="viewer-btn" onClick={loader.reload} disabled={loader.loading}>
          새로고침
        </button>
      </div>
      <div className="viewer-scroll">
        <StateNote
          loading={loader.loading}
          error={loader.error}
          empty={!!loader.data && loader.data.length === 0}
          emptyText="실행 기록이 아직 없습니다."
        />
        {loader.data?.map((d) => (
          <TraceCard key={d.trace.trace_id} trace={d.trace} spans={d.spans} level={level} />
        ))}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// 메모리
// ─────────────────────────────────────────────────────────────
const MemoryView: React.FC<{ workflowId: string }> = ({ workflowId }) => {
  const list = useLoader(() => xgen.agentData.memoryList(workflowId), [workflowId]);
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<MemoryDetail | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const open = useCallback(
    async (file: MemoryFile) => {
      setSel(file.filename);
      setDetail(null);
      setDetailErr(null);
      setDetailLoading(true);
      try {
        setDetail(await xgen.agentData.memoryRead(workflowId, file.filename));
      } catch (e) {
        setDetailErr(errText(e));
      } finally {
        setDetailLoading(false);
      }
    },
    [workflowId],
  );

  const files = list.data?.files ?? [];
  return (
    <div className="viewer-split">
      <div className="viewer-list">
        <StateNote
          loading={list.loading}
          error={list.error}
          empty={!!list.data && files.length === 0}
          emptyText="메모리 노트가 없습니다."
        />
        {files.map((f) => (
          <button
            key={f.filename}
            className={`viewer-listitem ${sel === f.filename ? 'active' : ''}`}
            onClick={() => void open(f)}
          >
            <div className="viewer-listitem-title">{f.title || f.filename}</div>
            <div className="viewer-listitem-sub">
              {f.category && f.category !== 'root' ? `${f.category} · ` : ''}
              {typeof f.char_count === 'number' ? `${f.char_count}자` : ''}
              {f.modified ? ` · ${fmtWhen(f.modified)}` : ''}
            </div>
            {f.tags && f.tags.length > 0 && (
              <div className="viewer-tags">
                {f.tags.map((t) => (
                  <span key={t} className="viewer-tag">
                    #{t}
                  </span>
                ))}
              </div>
            )}
          </button>
        ))}
      </div>
      <div className="viewer-detail">
        {!sel && !detailLoading && <div className="viewer-note">왼쪽에서 노트를 고르세요.</div>}
        <StateNote loading={detailLoading} error={detailErr} />
        {detail && (
          <>
            <div className="viewer-detail-head">
              <strong>{detail.title || detail.filename}</strong>
              <button
                className="viewer-btn sm"
                onClick={() => void copyText(detail.body || '')}
                title="본문 복사"
              >
                <CopyIcon size={12} /> 복사
              </button>
            </div>
            {detail.tags && detail.tags.length > 0 && (
              <div className="viewer-tags">
                {detail.tags.map((t) => (
                  <span key={t} className="viewer-tag">
                    #{t}
                  </span>
                ))}
              </div>
            )}
            {detail.linked_from && detail.linked_from.length > 0 && (
              <div className="viewer-sub">역링크: {detail.linked_from.join(', ')}</div>
            )}
            <pre className="viewer-body">{detail.body}</pre>
          </>
        )}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// 작업 (tasks + jobs)
// ─────────────────────────────────────────────────────────────
const TasksView: React.FC<{ workflowId: string }> = ({ workflowId }) => {
  const list = useLoader(() => xgen.agentData.tasksList(workflowId), [workflowId]);
  const [selTask, setSelTask] = useState<string | null>(null);
  const [output, setOutput] = useState<string>('');
  const [selJob, setSelJob] = useState<string | null>(null);
  const [runs, setRuns] = useState<JobRun[] | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const openTask = useCallback(
    async (t: Task) => {
      setSelTask(t.task_id);
      setSelJob(null);
      setRuns(null);
      setOutput('');
      setDetailErr(null);
      setDetailLoading(true);
      try {
        const out = await xgen.agentData.taskOutput(workflowId, t.task_id);
        setOutput(out.output || out.result || '(출력 없음)');
      } catch (e) {
        setDetailErr(errText(e));
      } finally {
        setDetailLoading(false);
      }
    },
    [workflowId],
  );

  const openJob = useCallback(
    async (j: Job) => {
      setSelJob(j.session_id);
      setSelTask(null);
      setOutput('');
      setRuns(null);
      setDetailErr(null);
      setDetailLoading(true);
      try {
        const res = await xgen.agentData.taskRuns(workflowId, j.session_id);
        setRuns(res.runs ?? []);
      } catch (e) {
        setDetailErr(errText(e));
      } finally {
        setDetailLoading(false);
      }
    },
    [workflowId],
  );

  const tasks = list.data?.tasks ?? [];
  const jobs = list.data?.jobs ?? [];
  const nothing = !!list.data && tasks.length === 0 && jobs.length === 0;

  return (
    <div className="viewer-split">
      <div className="viewer-list">
        <StateNote
          loading={list.loading}
          error={list.error}
          empty={nothing}
          emptyText="작업이 없습니다."
        />
        {tasks.length > 0 && <div className="viewer-list-section">작업</div>}
        {tasks.map((t) => (
          <button
            key={t.task_id}
            className={`viewer-listitem ${selTask === t.task_id ? 'active' : ''}`}
            onClick={() => void openTask(t)}
          >
            <div className="viewer-listitem-title">
              <span className={`viewer-badge ${t.status === 'failed' ? 'red' : 'slate'}`}>
                {t.status || '—'}
              </span>
              {t.title || t.task_id}
            </div>
            <div className="viewer-listitem-sub">
              {t.kind || ''}
              {t.duration_s != null ? ` · ${t.duration_s}s` : ''}
              {t.created_at ? ` · ${fmtWhen(t.created_at)}` : ''}
            </div>
          </button>
        ))}
        {jobs.length > 0 && <div className="viewer-list-section">예약 작업</div>}
        {jobs.map((j) => (
          <button
            key={j.session_id}
            className={`viewer-listitem ${selJob === j.session_id ? 'active' : ''}`}
            onClick={() => void openJob(j)}
          >
            <div className="viewer-listitem-title">
              <span className={`viewer-badge ${j.status === 'active' ? 'emerald' : 'gray'}`}>
                {j.status || '—'}
              </span>
              {j.name || j.session_id}
            </div>
            <div className="viewer-listitem-sub">
              {j.schedule_type || ''}
              {j.cron_expression ? ` · ${j.cron_expression}` : ''}
              {typeof j.total_executions === 'number' ? ` · ${j.total_executions}회` : ''}
            </div>
          </button>
        ))}
      </div>
      <div className="viewer-detail">
        {!selTask && !selJob && !detailLoading && (
          <div className="viewer-note">왼쪽에서 작업을 고르세요.</div>
        )}
        <StateNote loading={detailLoading} error={detailErr} />
        {selTask && output && (
          <>
            <div className="viewer-detail-head">
              <strong>작업 출력</strong>
              <button className="viewer-btn sm" onClick={() => void copyText(output)}>
                <CopyIcon size={12} /> 복사
              </button>
            </div>
            <pre className="viewer-body">{output}</pre>
          </>
        )}
        {selJob && runs && (
          <>
            <div className="viewer-detail-head">
              <strong>실행 기록 ({runs.length})</strong>
            </div>
            {runs.length === 0 ? (
              <div className="viewer-note sm">실행 기록이 없습니다.</div>
            ) : (
              runs.map((r, i) => (
                <div key={i} className={`viewer-run ${r.error_message ? 'err' : ''}`}>
                  <div className="viewer-run-head">
                    <span className={`viewer-badge ${r.status === 'failed' ? 'red' : 'slate'}`}>
                      {r.status || '—'}
                    </span>
                    <span className="viewer-sub">
                      #{r.execution_number ?? i + 1}
                      {r.scheduled_time ? ` · ${fmtWhen(r.scheduled_time)}` : ''}
                      {r.duration_s != null ? ` · ${r.duration_s}s` : ''}
                    </span>
                  </div>
                  {r.error_message && <pre className="err">{r.error_message}</pre>}
                  {r.output && <pre className="viewer-body">{r.output}</pre>}
                </div>
              ))
            )}
          </>
        )}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// 도구 (forged tools)
// ─────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────
// 기본정보 — 이 앱에서 도는 턴의 **실제** 프롬프트 + 도구 표면
//
// 서버는 두 표면(web/connector)을 다 돌려주지만 여기서는 **connector 만** 쓴다.
// 이 창에서 시작한 턴이 그 표면으로 돌기 때문이다. 웹 화면은 반대로 web 만
// 보여 준다 — 한 화면에서 토글하던 예전 방식은 지금 보는 게 어느 실행의 것인지
// 매번 확인해야 했다.

const BasicInfoView: React.FC<{ workflowId: string }> = ({ workflowId }) => {
  const loader = useLoader(() => xgen.agentData.basicInfo(workflowId), [workflowId]);
  const [tab, setTab] = useState<'prompt' | 'tools'>('prompt');
  const [raw, setRaw] = useState(false);

  const info = loader.data;
  const view = info?.surfaces?.connector ?? null;
  const groups = useMemo(
    () => (view?.provision?.stages ?? []).flatMap((st) => st.groups),
    [view],
  );
  const toolCount = useMemo(
    () => groups.reduce((n, g) => n + (g.tools?.length ?? 0), 0),
    [groups],
  );

  return (
    <div className="viewer-pane">
      <div className="viewer-toolbar">
        <div className="viewer-filters">
          {([
            ['prompt', '프롬프트'],
            ['tools', `연결된 도구${toolCount ? ` ${toolCount}` : ''}`],
          ] as const).map(([k, label]) => (
            <button
              key={k}
              className={`viewer-chip ${tab === k ? 'active' : ''}`}
              onClick={() => setTab(k)}
            >
              {label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {tab === 'prompt' && view && (
            <>
              <button className="viewer-btn" onClick={() => setRaw((v) => !v)}>
                {raw ? '섹션 보기' : '원문 전체 보기'}
              </button>
              <button
                className="viewer-btn"
                onClick={() => void copyText(view.prompt?.full_prompt ?? '')}
              >
                <CopyIcon /> 복사
              </button>
            </>
          )}
          <button className="viewer-btn" onClick={loader.reload} disabled={loader.loading}>
            새로고침
          </button>
        </div>
      </div>
      <div className="viewer-scroll">
        <StateNote loading={loader.loading} error={loader.error} />
        {!loader.loading && !loader.error && !view && (
          <div className="viewer-note">
            이 서버는 커넥터 표면 정보를 제공하지 않습니다 (서버 업데이트가 필요합니다).
          </div>
        )}
        {view && (
          <>
            <div className="viewer-kv">
              <span className="viewer-label">실행</span>
              <span>
                {info?.provider ?? '?'} · {info?.model || '모델 미지정'}
              </span>
            </div>
            {view.provision?.mode_note && (
              <div className="viewer-note">{view.provision.mode_note}</div>
            )}
            {(info?.errors?.length ?? 0) > 0 && (
              <div className="viewer-note err">
                일부 항목을 재구성하지 못했습니다: {info?.errors.join(' · ')}
              </div>
            )}

            {tab === 'prompt' ? (
              raw ? (
                <pre className="viewer-body">{view.prompt?.full_prompt || '(비어 있음)'}</pre>
              ) : (
                (view.prompt?.sections ?? []).map((sec) => (
                  <div key={sec.key} className="viewer-run">
                    <div className="viewer-run-head">
                      <span className="viewer-listitem-title">{sec.title}</span>
                      {sec.dynamic && <span className="viewer-badge">실행 시 주입</span>}
                      <span className="viewer-listitem-sub">{sec.source}</span>
                    </div>
                    <pre className="viewer-body">{sec.text || sec.template || '(비어 있음)'}</pre>
                  </div>
                ))
              )
            ) : (
              <>
                {groups.length === 0 && (
                  <div className="viewer-note">이 턴에 노출되는 도구가 없습니다.</div>
                )}
                {groups.map((g) => (
                  <div key={g.key} className="viewer-run">
                    <div className="viewer-run-head">
                      <span className="viewer-listitem-title">{g.title}</span>
                      <span className="viewer-badge">{g.tools?.length ?? 0}</span>
                    </div>
                    {g.note && <div className="viewer-note">{g.note}</div>}
                    {g.disclosure && <div className="viewer-note">{g.disclosure}</div>}
                    {(g.tools ?? []).map((t) => (
                      <div key={t.name} className="viewer-kv">
                        <span className="viewer-path">{t.name}</span>
                        <span className="viewer-listitem-sub">{t.description}</span>
                      </div>
                    ))}
                  </div>
                ))}
                {view.native_tools && (
                  <div className="viewer-run">
                    <div className="viewer-run-head">
                      <span className="viewer-listitem-title">CLI 네이티브 도구</span>
                      <span className="viewer-badge">차단 {view.native_tools.removed.length}</span>
                    </div>
                    <div className="viewer-note">{view.native_tools.note}</div>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
};

const ToolsView: React.FC<{ workflowId: string }> = ({ workflowId }) => {
  const list = useLoader(() => xgen.agentData.toolsList(workflowId), [workflowId]);
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<ForgedTool | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const open = useCallback(
    async (t: ForgedTool) => {
      setSel(t.name);
      setDetail(null);
      setDetailErr(null);
      setDetailLoading(true);
      try {
        setDetail(await xgen.agentData.toolGet(workflowId, t.name));
      } catch (e) {
        setDetailErr(errText(e));
      } finally {
        setDetailLoading(false);
      }
    },
    [workflowId],
  );

  const tools = list.data?.tools ?? [];
  return (
    <div className="viewer-split">
      <div className="viewer-list">
        <StateNote
          loading={list.loading}
          error={list.error}
          empty={!!list.data && tools.length === 0}
          emptyText="제작된 도구가 없습니다."
        />
        {tools.map((t) => (
          <button
            key={t.name}
            className={`viewer-listitem ${sel === t.name ? 'active' : ''}`}
            onClick={() => void open(t)}
          >
            <div className="viewer-listitem-title">
              <span
                className={`viewer-badge ${
                  t.status === 'broken' ? 'red' : t.verified ? 'emerald' : 'amber'
                }`}
              >
                {t.status === 'broken' ? '고장' : t.verified ? '검증됨' : '미검증'}
              </span>
              {t.name}
            </div>
            <div className="viewer-listitem-sub">
              {t.runtime || ''}
              {typeof t.calls === 'number' ? ` · 호출 ${t.calls}` : ''}
              {!t.enabled ? ' · 비활성' : ''}
            </div>
          </button>
        ))}
      </div>
      <div className="viewer-detail">
        {!sel && !detailLoading && <div className="viewer-note">왼쪽에서 도구를 고르세요.</div>}
        <StateNote loading={detailLoading} error={detailErr} />
        {detail && (
          <>
            <div className="viewer-detail-head">
              <strong>{detail.name}</strong>
              {detail.source && (
                <button className="viewer-btn sm" onClick={() => void copyText(detail.source || '')}>
                  <CopyIcon size={12} /> 코드 복사
                </button>
              )}
            </div>
            {detail.description && <div className="viewer-sub">{detail.description}</div>}
            <div className="viewer-kv">
              {detail.entrypoint && (
                <span>
                  <b>엔트리</b> {detail.entrypoint}
                </span>
              )}
              {detail.runtime && (
                <span>
                  <b>런타임</b> {detail.runtime}
                </span>
              )}
              {detail.env_keys && detail.env_keys.length > 0 && (
                <span>
                  <b>ENV</b> {detail.env_keys.join(', ')}
                </span>
              )}
              {detail.dependencies && detail.dependencies.length > 0 && (
                <span>
                  <b>의존성</b> {detail.dependencies.join(', ')}
                </span>
              )}
            </div>
            {detail.last_test_error && (
              <>
                <div className="viewer-label err">마지막 테스트 오류</div>
                <pre className="err">{detail.last_test_error}</pre>
              </>
            )}
            <div className="viewer-label">소스 코드</div>
            {detail.source_error ? (
              <div className="viewer-note err">{detail.source_error}</div>
            ) : (
              <pre className="viewer-body code">{detail.source || '(소스 없음)'}</pre>
            )}
            {detail.source_truncated && <div className="viewer-sub">※ 소스가 잘렸습니다.</div>}
          </>
        )}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// 스토리지 (workspace)
// ─────────────────────────────────────────────────────────────
interface TreeNode {
  node: WsNode;
  children: TreeNode[];
}

function buildTree(files: WsNode[]): TreeNode[] {
  const byPath = new Map<string, TreeNode>();
  for (const n of files) byPath.set(n.path, { node: n, children: [] });
  const roots: TreeNode[] = [];
  for (const tn of byPath.values()) {
    const parent = tn.node.path.split('/').slice(0, -1).join('/');
    const p = parent && byPath.get(parent);
    if (p) p.children.push(tn);
    else roots.push(tn);
  }
  const sort = (arr: TreeNode[]): void => {
    arr.sort(
      (a, b) =>
        Number(b.node.is_dir) - Number(a.node.is_dir) ||
        a.node.name.localeCompare(b.node.name),
    );
    for (const t of arr) sort(t.children);
  };
  sort(roots);
  return roots;
}

const TreeRow: React.FC<{
  tn: TreeNode;
  depth: number;
  selected: string | null;
  onFile: (n: WsNode) => void;
}> = ({ tn, depth, selected, onFile }) => {
  const [open, setOpen] = useState(depth < 1);
  const isDir = tn.node.is_dir;
  return (
    <>
      <button
        className={`viewer-tree-row ${selected === tn.node.path ? 'active' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => (isDir ? setOpen((o) => !o) : onFile(tn.node))}
      >
        <span className="viewer-tree-icon">
          {isDir ? (
            open ? (
              <FolderOpenIcon size={14} />
            ) : (
              <FolderIcon size={14} />
            )
          ) : (
            <DocIcon size={12} />
          )}
        </span>
        <span className="viewer-tree-name">{tn.node.name}</span>
        {!isDir && typeof tn.node.size === 'number' && (
          <span className="viewer-tree-size">{tn.node.size}B</span>
        )}
      </button>
      {isDir &&
        open &&
        tn.children.map((c) => (
          <TreeRow key={c.node.path} tn={c} depth={depth + 1} selected={selected} onFile={onFile} />
        ))}
    </>
  );
};

const StorageView: React.FC<{ workflowId: string }> = ({ workflowId }) => {
  const list = useLoader(() => xgen.agentData.workspaceTree(workflowId), [workflowId]);
  const [sel, setSel] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [detailNote, setDetailNote] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const openFile = useCallback(
    async (n: WsNode) => {
      setSel(n.path);
      setContent('');
      setDetailErr(null);
      setDetailNote(null);
      setDetailLoading(true);
      try {
        const f = await xgen.agentData.workspaceFile(workflowId, n.path);
        setContent(f.content);
      } catch (e) {
        // 서버는 바이너리에 415, 과대 파일에 413 을 준다 — 오류가 아니라 안내로.
        const msg = errText(e);
        if (/→ 415/.test(msg)) setDetailNote('미리보기할 수 없는 파일입니다(바이너리).');
        else if (/→ 413/.test(msg)) setDetailNote('파일이 너무 커서 미리보기할 수 없습니다.');
        else setDetailErr(msg);
      } finally {
        setDetailLoading(false);
      }
    },
    [workflowId],
  );

  const tree = useMemo(() => buildTree(list.data?.files ?? []), [list.data]);
  return (
    <div className="viewer-split">
      <div className="viewer-list tree">
        <StateNote
          loading={list.loading}
          error={list.error}
          empty={!!list.data && tree.length === 0}
          emptyText="파일이 없습니다."
        />
        {tree.map((tn) => (
          <TreeRow key={tn.node.path} tn={tn} depth={0} selected={sel} onFile={(n) => void openFile(n)} />
        ))}
      </div>
      <div className="viewer-detail">
        {!sel && !detailLoading && <div className="viewer-note">파일을 고르면 미리보기합니다.</div>}
        <StateNote loading={detailLoading} error={detailErr} />
        {detailNote && <div className="viewer-note">{detailNote}</div>}
        {sel && content && (
          <>
            <div className="viewer-detail-head">
              <strong className="viewer-path">{sel}</strong>
              <button className="viewer-btn sm" onClick={() => void copyText(content)}>
                <CopyIcon size={12} /> 복사
              </button>
            </div>
            <pre className="viewer-body code">{content}</pre>
          </>
        )}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
export const AgentViewer: React.FC<Props> = ({ workflowId, workflowName, initialSub }) => {
  const [sub, setSub] = useState<AgentViewerSub>(initialSub ?? 'fulllog');
  return (
    <div className="agent-viewer">
      {/* 한 줄 헤더 — [아이콘 이름] ──────── [탭]. 닫기(X)는 탭에 이미 있으므로 생략. */}
      <div className="viewer-header">
        <div className="viewer-title">
          <BotIcon size={16} />
          <strong>{workflowName || '에이전트'}</strong>
        </div>
        <div className="viewer-subtabs" role="tablist">
          {SUBS.map(([s, label]) => (
            <button
              key={s}
              role="tab"
              aria-selected={sub === s}
              className={`viewer-subtab ${sub === s ? 'active' : ''}`}
              onClick={() => setSub(s)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="viewer-content">
        {sub === 'basic' && <BasicInfoView workflowId={workflowId} />}
        {sub === 'fulllog' && <FullLogView workflowId={workflowId} />}
        {sub === 'memory' && <MemoryView workflowId={workflowId} />}
        {sub === 'tasks' && <TasksView workflowId={workflowId} />}
        {sub === 'tools' && <ToolsView workflowId={workflowId} />}
        {sub === 'storage' && <StorageView workflowId={workflowId} />}
      </div>
    </div>
  );
};
