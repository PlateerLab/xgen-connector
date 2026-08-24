/**
 * SessionStore — the connector's multi-session runtime, lifted OUT of the React
 * tree so a conversation's live connection survives view switches.
 *
 * Why this exists
 * ───────────────
 * Chat streaming runs in the **main process**, keyed by a `streamId`; each
 * ChatEvent is pushed back to the renderer (see main/index.ts chatStart). The
 * stream keeps running as long as the window lives — it is NOT tied to any React
 * component. Previously the Chat component owned the messages + stream handle and
 * cancelled the stream whenever the open session changed, so switching agents
 * killed an in-flight answer and wiped its transcript.
 *
 * This store holds every open session at once:
 *   · switching the foreground session never cancels another session's stream,
 *   · a background turn keeps accumulating text/tool/citation events into its
 *     transcript, so returning to it shows the completed (or still-streaming) answer,
 *   · only an explicit 채팅 종료 (endChat) or the window closing tears a stream down.
 *
 * The class is framework-agnostic (no Electron/React imports) and takes its
 * transport by injection, so the whole lifecycle is unit-testable. The renderer
 * wires the real bridge + a React subscription in `session.ts`.
 */
import type { Agent, ChatEvent, ChatRequest, Citation, ToolEvent } from '../../core/index';
import { stripBrowserContext } from '../../core/browser';
import { stripTeamsContext } from '../../core/teams-bridge';

/** One rendered chat message (mirrors the old Chat.Msg shape). */
export interface ChatMsg {
  role: 'user' | 'assistant';
  text: string;
  tools?: ToolEvent[];
  citations?: Citation[];
  streaming?: boolean;
  error?: boolean;
  /** 이 메시지와 함께 보낸 화면 캡처 — 무엇을 찍었는지(창 이름). */
  screenshot?: { sourceName: string; width: number; height: number };
}

/** Public, immutable-per-change snapshot of one open session. */
export interface SessionState {
  /** Stable identity — equals interactionId. */
  key: string;
  agent: Agent;
  interactionId: string;
  /** Opened from history (이어보기) rather than started fresh. */
  resume: boolean;
  loadingHistory: boolean;
  historyLoaded: boolean;
  messages: ChatMsg[];
  /** A turn is actively streaming (the connector is live). */
  streaming: boolean;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

/** The whole store as one immutable snapshot for useSyncExternalStore. */
export interface StoreSnapshot {
  /** Insertion order. */
  sessions: SessionState[];
  activeKey: string | null;
}

/** A screen capture attached to an outgoing message. */
export interface OutgoingShot {
  dataUrl?: string;
  sourceName?: string;
  width?: number;
  height?: number;
}

/** Injected transport — the renderer passes the real xgen bridge. */
export interface SessionTransport {
  stream(req: ChatRequest, onEvent: (e: ChatEvent) => void): { cancel: () => void };
  historyTurns(
    workflowId: string,
    interactionId: string,
    name?: string,
  ): Promise<Array<{ input: string; output: string }>>;
}

/** Per-session mutable runtime kept out of the public snapshot. */
interface Runtime {
  cancel: (() => void) | null;
  tools: ToolEvent[];
  citations: Citation[];
}

export function newInteractionId(workflowId: string, now: number): string {
  return `conn-${workflowId}-${now}`;
}

/** Dedupe-merge citations by fileName#page (mirrors the old Chat helper). */
export function mergeCitations(into: Citation[], add?: Citation[]): Citation[] {
  if (!add?.length) return into;
  const seen = new Set(into.map((c) => `${c.fileName ?? ''}#${c.pageNumber ?? ''}`));
  const out = [...into];
  for (const c of add) {
    const k = `${c.fileName ?? ''}#${c.pageNumber ?? ''}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(c);
    }
  }
  return out;
}

/** A session is worth keeping (listed, preserved on switch) once it has content
 *  or a live stream. A brand-new empty session is a throwaway. */
export function isKeepable(s: SessionState): boolean {
  return s.streaming || s.messages.length > 0;
}

/** Open sessions, most-recently-active first. */
export function openSessions(all: SessionState[]): SessionState[] {
  return all.filter(isKeepable).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Open sessions for one agent, most-recently-active first. */
export function agentSessions(all: SessionState[], workflowId: string): SessionState[] {
  return openSessions(all).filter((s) => s.agent.workflowId === workflowId);
}

export class SessionStore {
  private map = new Map<string, SessionState>();
  private rt = new Map<string, Runtime>();
  private _active: string | null = null;
  private listeners = new Set<() => void>();
  private snap: StoreSnapshot = { sessions: [], activeKey: null };

  constructor(
    private transport: SessionTransport,
    private now: () => number = () => Date.now(),
  ) {}

  // ── useSyncExternalStore contract (stable arrow refs) ──────────────
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };
  getSnapshot = (): StoreSnapshot => this.snap;

  private emit(): void {
    // Rebuild the snapshot only here → getSnapshot returns a stable reference
    // between mutations (required by useSyncExternalStore).
    this.snap = { sessions: [...this.map.values()], activeKey: this._active };
    for (const l of this.listeners) l();
  }

  private patch(key: string, updater: (s: SessionState) => SessionState): void {
    const s = this.map.get(key);
    if (!s) return;
    this.map.set(key, updater(s));
  }

  get activeKey(): string | null {
    return this._active;
  }

  active(): SessionState | null {
    return this._active ? (this.map.get(this._active) ?? null) : null;
  }

  get(key: string): SessionState | null {
    return this.map.get(key) ?? null;
  }

  // ── Opening sessions ───────────────────────────────────────────────

  /**
   * Start (or reuse) a fresh conversation with `agent` and focus it. If the
   * current session is already an empty, non-resumed chat with the same agent
   * we reuse it — pressing 새 대화 twice shouldn't pile up blank sessions.
   */
  openNew(agent: Agent): string {
    const cur = this._active ? this.map.get(this._active) : null;
    if (
      cur &&
      cur.agent.workflowId === agent.workflowId &&
      !cur.resume &&
      !cur.streaming &&
      cur.messages.length === 0
    ) {
      return cur.key;
    }
    this.gcActiveIfEmpty();
    const t = this.now();
    const iid = newInteractionId(agent.workflowId, t);
    this.map.set(iid, {
      key: iid,
      agent,
      interactionId: iid,
      resume: false,
      loadingHistory: false,
      historyLoaded: true,
      messages: [],
      streaming: false,
      error: null,
      createdAt: t,
      updatedAt: t,
    });
    this.rt.set(iid, { cancel: null, tools: [], citations: [] });
    this._active = iid;
    this.emit();
    return iid;
  }

  /**
   * Reopen a past conversation (이어보기). If it is already open we simply focus
   * it — keeping any in-flight stream — otherwise we create it and load history.
   */
  openResume(agent: Agent, interactionId: string, workflowName?: string): string {
    if (this.map.has(interactionId)) {
      this.setActive(interactionId);
      return interactionId;
    }
    this.gcActiveIfEmpty();
    const t = this.now();
    this.map.set(interactionId, {
      key: interactionId,
      agent,
      interactionId,
      resume: true,
      loadingHistory: true,
      historyLoaded: false,
      messages: [],
      streaming: false,
      error: null,
      createdAt: t,
      updatedAt: t,
    });
    this.rt.set(interactionId, { cancel: null, tools: [], citations: [] });
    this._active = interactionId;
    this.emit();
    void this.loadHistory(interactionId, agent, workflowName);
    return interactionId;
  }

  private async loadHistory(key: string, agent: Agent, name?: string): Promise<void> {
    try {
      const turns = await this.transport.historyTurns(
        agent.workflowId,
        key,
        name ?? agent.workflowName,
      );
      const msgs: ChatMsg[] = [];
      for (const tn of turns) {
        // 최종 방어: text 는 무조건 문자열이어야 렌더가 안전하다 (transport 가
        // 이미 문자열화하지만, 다른 주입 경로가 생겨도 여기서 못 뚫게 한다).
        // 봉투는 **두 겹**일 수 있다 — 브라우저 컨텍스트와 Teams 컨텍스트가 같은
        // 턴에 붙는다. 붙인 순서(teams → browser)의 역순으로 벗긴다.
        const input = stripTeamsContext(
          stripBrowserContext(
            typeof tn.input === 'string' ? tn.input : tn.input == null ? '' : String(tn.input),
          ),
        );
        const output =
          typeof tn.output === 'string' ? tn.output : tn.output == null ? '' : String(tn.output);
        if (input) msgs.push({ role: 'user', text: input });
        if (output) msgs.push({ role: 'assistant', text: output });
      }
      // Only overwrite the transcript if a live turn hasn't started meanwhile.
      this.patch(key, (s) =>
        s.streaming || s.messages.length > 0
          ? { ...s, loadingHistory: false, historyLoaded: true }
          : {
              ...s,
              messages: msgs,
              loadingHistory: false,
              historyLoaded: true,
              updatedAt: this.now(),
            },
      );
    } catch {
      this.patch(key, (s) => ({ ...s, loadingHistory: false, historyLoaded: true }));
    }
    this.emit();
  }

  // ── Focus / GC ─────────────────────────────────────────────────────

  setActive(key: string | null): void {
    if (this._active === key) return;
    const prev = this._active;
    this._active = key;
    if (prev && prev !== key) this.gcIfEmpty(prev);
    this.emit();
  }

  private gcActiveIfEmpty(): void {
    if (this._active) this.gcIfEmpty(this._active);
  }

  /** Drop a throwaway (no messages, not streaming, not mid-load) session. */
  private gcIfEmpty(key: string): void {
    const s = this.map.get(key);
    if (!s) return;
    if (!s.streaming && !s.loadingHistory && s.messages.length === 0) {
      this.rt.get(key)?.cancel?.();
      this.rt.delete(key);
      this.map.delete(key);
      if (this._active === key) this._active = null;
    }
  }

  // ── Sending / streaming ────────────────────────────────────────────

  /** Send a turn on `key`. Safe to call for a non-focused session. */
  send(key: string, text: string, shot?: OutgoingShot | null): void {
    const s = this.map.get(key);
    const rt = this.rt.get(key);
    if (!s || !rt || s.streaming || !text.trim()) return;
    rt.tools = [];
    rt.citations = [];
    const userMsg: ChatMsg = {
      role: 'user',
      text,
      screenshot: shot
        ? {
            sourceName: shot.sourceName ?? '화면',
            width: shot.width ?? 0,
            height: shot.height ?? 0,
          }
        : undefined,
    };
    const asst: ChatMsg = {
      role: 'assistant',
      text: '',
      tools: [],
      citations: [],
      streaming: true,
    };
    this.patch(key, (st) => ({
      ...st,
      messages: [...st.messages, userMsg, asst],
      streaming: true,
      error: null,
      updatedAt: this.now(),
    }));
    this.emit();
    const input: ChatRequest['input'] = shot?.dataUrl
      ? [
          { type: 'text', text },
          { type: 'image_url', image_url: { url: shot.dataUrl } },
        ]
      : text;
    const handle = this.transport.stream(
      {
        workflowId: s.agent.workflowId,
        workflowName: s.agent.workflowName,
        input,
        interactionId: s.interactionId,
      },
      (ev) => this.onEvent(key, ev),
    );
    rt.cancel = handle.cancel;
  }

  private onEvent(key: string, ev: ChatEvent): void {
    const rt = this.rt.get(key);
    if (!rt) return;
    this.patch(key, (s) => {
      const messages = s.messages.slice();
      const last = messages[messages.length - 1];
      if (!last || last.role !== 'assistant') return s;
      const nl: ChatMsg = { ...last };
      if (ev.kind === 'text') nl.text = nl.text + ev.content;
      else if (ev.kind === 'summary' && !nl.text) nl.text = ev.text;
      else if (ev.kind === 'tool') {
        rt.tools = [...rt.tools, ev.event];
        nl.tools = rt.tools;
        rt.citations = mergeCitations(rt.citations, ev.event.citations);
        nl.citations = rt.citations;
      } else if (ev.kind === 'error') {
        nl.text = nl.text + (nl.text ? '\n\n' : '') + `⚠️ ${ev.detail}`;
        nl.error = true;
      }
      let streaming = s.streaming;
      let error = s.error;
      if (ev.kind === 'end' || ev.kind === 'error') {
        streaming = false;
        nl.streaming = false;
        if (ev.kind === 'error') error = ev.detail;
      }
      messages[messages.length - 1] = nl;
      return { ...s, messages, streaming, error, updatedAt: this.now() };
    });
    if (ev.kind === 'end' || ev.kind === 'error') rt.cancel = null;
    this.emit();
  }

  /** Stop the in-flight turn on `key` (the transcript so far is kept). */
  stop(key: string): void {
    const rt = this.rt.get(key);
    rt?.cancel?.();
    if (rt) rt.cancel = null;
    this.patch(key, (s) => {
      const messages = s.messages.slice();
      const last = messages[messages.length - 1];
      if (last?.role === 'assistant') messages[messages.length - 1] = { ...last, streaming: false };
      return { ...s, messages, streaming: false, updatedAt: this.now() };
    });
    this.emit();
  }

  /** 채팅 종료 — cancel any stream and forget the session entirely. */
  endChat(key: string): void {
    this.rt.get(key)?.cancel?.();
    this.rt.delete(key);
    this.map.delete(key);
    if (this._active === key) {
      const rest = [...this.map.values()]
        .filter(isKeepable)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      this._active = rest[0]?.key ?? null;
    }
    this.emit();
  }

  /** Tear everything down (logout / auth failure). */
  reset(): void {
    for (const rt of this.rt.values()) rt.cancel?.();
    this.map.clear();
    this.rt.clear();
    this._active = null;
    this.emit();
  }
}
