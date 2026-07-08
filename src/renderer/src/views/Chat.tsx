/**
 * Chat view — streams a conversation with the selected agent.
 *
 * Node-agnostic: works for agent_geny / agent_xgen / agent_harness because it
 * uses the single execute-stream endpoint. A session is either a fresh chat with
 * an agent or a resumed past conversation (loads its turns via history.turns).
 * Reuses one `interactionId` for the session so follow-ups continue it. Renders
 * streamed text live, tool activity as chips, RAG sources as citation pills, and
 * exposes the streaming state to the avatar slot.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { xgen } from '../bridge';
import type { Agent, ChatEvent, ToolEvent, Citation } from '../../../core/index';
import type { AvatarState } from '../avatar/AvatarSlot';
import { XgenMark } from '../brand/Logo';
import { SendIcon, StopIcon, PlusIcon, ChatIcon, DocIcon, PanelLeftIcon } from '../brand/icons';

/** An open chat: a fresh agent chat, or a resumed past conversation. */
export interface ChatSession {
  agent: Agent;
  /** Present when resuming a past conversation. */
  interactionId?: string;
  /** True → load this conversation's history on open. */
  resume?: boolean;
}

interface Msg {
  role: 'user' | 'assistant';
  text: string;
  tools?: ToolEvent[];
  citations?: Citation[];
  streaming?: boolean;
  error?: boolean;
}

function newInteractionId(workflowId: string): string {
  return `conn-${workflowId}-${Date.now()}`;
}

function mergeCitations(into: Citation[], add?: Citation[]): Citation[] {
  if (!add?.length) return into;
  const seen = new Set(into.map((c) => `${c.fileName ?? ''}#${c.pageNumber ?? ''}`));
  for (const c of add) {
    const key = `${c.fileName ?? ''}#${c.pageNumber ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      into.push(c);
    }
  }
  return [...into];
}

const AGENT_KIND: Record<string, string> = { canvas: 'Canvas', harness: 'Harness' };

export const Chat: React.FC<{
  session: ChatSession;
  collapsed?: boolean;
  onExpandSidebar?: () => void;
}> = ({ session, collapsed, onExpandSidebar }) => {
  const { agent } = session;
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [interactionId, setInteractionId] = useState(
    () => session.interactionId ?? newInteractionId(agent.workflowId),
  );
  const cancelRef = useRef<{ cancel: () => void } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // A stable signature of the open session — changing it resets the view.
  const sessionSig = `${agent.workflowId}::${session.resume ? session.interactionId : 'new'}`;

  useEffect(() => {
    cancelRef.current?.cancel();
    cancelRef.current = null;
    setStreaming(false);
    const iid = session.interactionId ?? newInteractionId(agent.workflowId);
    setInteractionId(iid);

    if (session.resume && session.interactionId) {
      setMessages([]);
      setLoadingHistory(true);
      let alive = true;
      xgen.history
        .turns(agent.workflowId, session.interactionId, agent.workflowName)
        .then((turns) => {
          if (!alive) return;
          const msgs: Msg[] = [];
          for (const t of turns) {
            if (t.input) msgs.push({ role: 'user', text: t.input });
            if (t.output) msgs.push({ role: 'assistant', text: t.output });
          }
          setMessages(msgs);
        })
        .catch(() => alive && setMessages([]))
        .finally(() => alive && setLoadingHistory(false));
      return () => {
        alive = false;
      };
    }
    setMessages([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionSig]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 150)}px`;
  }, [input]);

  const newConversation = useCallback(() => {
    cancelRef.current?.cancel();
    cancelRef.current = null;
    setMessages([]);
    setInteractionId(newInteractionId(agent.workflowId));
    setStreaming(false);
  }, [agent.workflowId]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');
    setMessages((m) => [
      ...m,
      { role: 'user', text },
      { role: 'assistant', text: '', tools: [], citations: [], streaming: true },
    ]);
    setStreaming(true);

    const tools: ToolEvent[] = [];
    let citations: Citation[] = [];
    const handle = xgen.chat.stream(
      {
        workflowId: agent.workflowId,
        workflowName: agent.workflowName,
        input: text,
        interactionId,
      },
      (ev: ChatEvent) => {
        setMessages((m) => {
          const copy = [...m];
          const last = copy[copy.length - 1];
          if (!last || last.role !== 'assistant') return m;
          if (ev.kind === 'text') last.text += ev.content;
          else if (ev.kind === 'summary' && !last.text) last.text = ev.text;
          else if (ev.kind === 'tool') {
            tools.push(ev.event);
            last.tools = [...tools];
            citations = mergeCitations(citations, ev.event.citations);
            last.citations = citations;
          } else if (ev.kind === 'error') {
            last.text += (last.text ? '\n\n' : '') + `⚠️ ${ev.detail}`;
            last.error = true;
          }
          return copy;
        });
        if (ev.kind === 'end' || ev.kind === 'error') {
          setStreaming(false);
          setMessages((m) => {
            const copy = [...m];
            const last = copy[copy.length - 1];
            if (last?.role === 'assistant') last.streaming = false;
            return copy;
          });
          cancelRef.current = null;
        }
      },
    );
    cancelRef.current = handle;
  }, [input, streaming, agent, interactionId]);

  const stop = useCallback(() => {
    cancelRef.current?.cancel();
    cancelRef.current = null;
    setStreaming(false);
    setMessages((m) => {
      const copy = [...m];
      const last = copy[copy.length - 1];
      if (last?.role === 'assistant') last.streaming = false;
      return copy;
    });
  }, []);

  const avatarState: AvatarState = useMemo(() => {
    const last = messages[messages.length - 1];
    return {
      workflowId: agent.workflowId,
      workflowName: agent.workflowName,
      streamingText: last?.role === 'assistant' ? last.text : '',
      speaking: streaming,
    };
  }, [messages, streaming, agent]);

  // Feed the live state to the floating avatar overlay (a no-op if it's closed).
  useEffect(() => {
    xgen.overlay.pushState(avatarState);
  }, [avatarState]);

  const kind = AGENT_KIND[agent.workflowType ?? ''] ?? (agent.workflowType || 'Agent');

  return (
    <div className="chat">
      <div className="chat-header">
        <div className="chat-title">
          {collapsed && (
            <button
              className="icon-btn sidebar-toggle"
              title="사이드바 펼치기"
              onClick={onExpandSidebar}
            >
              <PanelLeftIcon size={18} />
            </button>
          )}
          <span className="agent-mark">
            <XgenMark height={18} variant="color" />
          </span>
          <div className="chat-title-text">
            <strong>{agent.workflowName}</strong>
            <div className="agent-meta">
              {kind}
              {agent.nodeCount ? ` · 노드 ${agent.nodeCount}개` : ''}
              {agent.isShared ? ' · 공유' : ''}
              {session.resume ? ' · 이어보기' : ''}
            </div>
          </div>
        </div>
        <div className="chat-header-actions">
          <button className="secondary" onClick={newConversation}>
            <PlusIcon size={15} /> 새 대화
          </button>
        </div>
      </div>

      <div className="chat-log" ref={scrollRef}>
        {loadingHistory ? (
          <div className="chat-empty">
            <p>대화를 불러오는 중…</p>
          </div>
        ) : messages.length === 0 ? (
          <div className="chat-empty">
            <ChatIcon size={44} className="mark" />
            <h3>{agent.workflowName}</h3>
            <p>이 에이전트와 대화를 시작하세요.</p>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`msg-row ${m.role}`}>
              {m.role === 'assistant' && (
                <div className="msg-avatar assistant">
                  <XgenMark height={18} variant="mono" />
                </div>
              )}
              <div className="msg-col">
                {m.tools && m.tools.length > 0 && (
                  <div className="tools">
                    {m.tools.map((t, j) => (
                      <span key={j} className={`tool-chip ${t.eventType ?? ''}`} title={t.toolName}>
                        {t.eventType === 'tool_error' ? '⚠' : t.eventType === 'tool_result' ? '✓' : '⚙'}
                        <span className="tname">{t.toolName ?? 'tool'}</span>
                      </span>
                    ))}
                  </div>
                )}
                <div className={`bubble ${m.role} ${m.error ? 'error' : ''}`}>
                  {m.text || (m.streaming ? <span className="cursor" /> : '')}
                  {m.text && m.streaming && <span className="cursor" />}
                </div>
                {m.citations && m.citations.length > 0 && (
                  <div className="citations">
                    <span className="label">출처</span>
                    {m.citations.map((c, j) => (
                      <span className="cite-pill" key={j} title={c.fileName}>
                        <DocIcon size={11} />
                        <span className="fname">
                          {c.fileName ?? '문서'}
                          {c.pageNumber ? ` p.${c.pageNumber}` : ''}
                        </span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="chat-input">
        <div className="composer">
          <textarea
            ref={taRef}
            className="composer-input"
            value={input}
            placeholder="메시지를 입력하세요…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            spellCheck={false}
          />
          {streaming ? (
            <button className="composer-send stop" onClick={stop} title="중지" aria-label="중지">
              <StopIcon size={15} />
            </button>
          ) : (
            <button
              className="composer-send"
              onClick={() => void send()}
              disabled={!input.trim()}
              title="전송"
              aria-label="전송"
            >
              <SendIcon size={17} />
            </button>
          )}
        </div>
        <div className="composer-foot">
          <span className="kbd-hint">
            <kbd>Enter</kbd> 전송 · <kbd>Shift + Enter</kbd> 줄바꿈
          </span>
        </div>
      </div>
    </div>
  );
};
