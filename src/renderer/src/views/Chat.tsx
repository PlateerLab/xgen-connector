/**
 * Chat view — streams a conversation with the selected agent.
 *
 * Node-agnostic: works for agent_geny / agent_xgen / agent_harness because it
 * uses the single execute-stream endpoint. Reuses one `interactionId` per agent
 * session to continue the conversation. Renders streamed text live, tool
 * activity as compact chips, and exposes the streaming state to the avatar slot.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { xgen } from '../bridge';
import type { Agent, ChatEvent, ToolEvent } from '../../../core/index';
import { AvatarSlot, hasAvatarRenderer, type AvatarState } from '../avatar/AvatarSlot';

interface Msg {
  role: 'user' | 'assistant';
  text: string;
  tools?: ToolEvent[];
  streaming?: boolean;
}

function newInteractionId(workflowId: string): string {
  return `conn-${workflowId}-${Date.now()}`;
}

export const Chat: React.FC<{ agent: Agent }> = ({ agent }) => {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [interactionId, setInteractionId] = useState(() => newInteractionId(agent.workflowId));
  const cancelRef = useRef<{ cancel: () => void } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Reset the conversation when the selected agent changes.
  useEffect(() => {
    cancelRef.current?.cancel();
    cancelRef.current = null;
    setMessages([]);
    setInteractionId(newInteractionId(agent.workflowId));
    setStreaming(false);
  }, [agent.workflowId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');
    setMessages((m) => [...m, { role: 'user', text }, { role: 'assistant', text: '', tools: [], streaming: true }]);
    setStreaming(true);

    const tools: ToolEvent[] = [];
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
          } else if (ev.kind === 'error') {
            last.text += (last.text ? '\n\n' : '') + `⚠️ ${ev.detail}`;
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

  return (
    <div className="chat">
      <div className="chat-header">
        <div>
          <strong>{agent.workflowName}</strong>
          <span className="muted small">
            {' '}
            · {agent.workflowType === 'harness' ? 'Harness' : 'Canvas'} · {agent.nodeCount}개 노드
          </span>
        </div>
        <button
          className="link"
          onClick={() => {
            cancelRef.current?.cancel();
            setMessages([]);
            setInteractionId(newInteractionId(agent.workflowId));
          }}
        >
          새 대화
        </button>
      </div>

      {hasAvatarRenderer() && <AvatarSlot state={avatarState} />}

      <div className="chat-log" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="center muted small">이 에이전트와 대화를 시작하세요.</div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.tools && m.tools.length > 0 && (
              <div className="tools">
                {m.tools.map((t, j) => (
                  <span key={j} className={`tool-chip ${t.eventType}`} title={t.toolName}>
                    {t.eventType === 'tool_error' ? '⚠ ' : t.eventType === 'tool_result' ? '✓ ' : '⚙ '}
                    {t.toolName ?? 'tool'}
                  </span>
                ))}
              </div>
            )}
            <div className="bubble-text">
              {m.text || (m.streaming ? <span className="cursor">▍</span> : '')}
            </div>
          </div>
        ))}
      </div>

      <div className="chat-input">
        <textarea
          value={input}
          placeholder="메시지를 입력하세요… (Enter 전송, Shift+Enter 줄바꿈)"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
        />
        {streaming ? (
          <button className="secondary" onClick={stop}>
            중지
          </button>
        ) : (
          <button className="primary" onClick={() => void send()} disabled={!input.trim()}>
            전송
          </button>
        )}
      </div>
    </div>
  );
};
