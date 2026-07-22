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
import type { Agent, ChatEvent, ToolEvent, Citation, VoiceConfig } from '../../../core/index';
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

  // ── Voice (STT/TTS) state ──────────────────────────────────────
  const [voiceCfg, setVoiceCfg] = useState<VoiceConfig | null>(null);
  const [localVoice, setLocalVoice] = useState({ input: true, output: true });
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [muted, setMuted] = useState(false);

  // Effective gates: server must enable AND this device must not have turned off.
  const sttOn = !!voiceCfg?.stt?.enabled && localVoice.input;
  const ttsOn = !!voiceCfg?.tts?.enabled && localVoice.output;

  // Mic capture refs.
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  // TTS playback refs — a simple serial queue so replies never overlap.
  const ttsQueueRef = useRef<string[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playingRef = useRef(false);
  // Mirrors for use inside async/stream callbacks (avoid stale closures + dep churn).
  const mutedRef = useRef(muted);
  const ttsOnRef = useRef(ttsOn);

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

  // ── TTS playback: serial queue (one HTMLAudioElement, plays next on end) ──
  const playNext = useCallback(async () => {
    if (playingRef.current) return;
    const text = ttsQueueRef.current.shift();
    if (!text) return;
    playingRef.current = true;
    let url: string | null = null;
    const done = () => {
      if (url) URL.revokeObjectURL(url);
      playingRef.current = false;
      void playNext();
    };
    try {
      const blob = await xgen.voice.speak(text);
      url = URL.createObjectURL(blob);
      let el = audioRef.current;
      if (!el) {
        el = new Audio();
        audioRef.current = el;
      }
      el.onended = done;
      el.onerror = done;
      el.src = url;
      await el.play();
    } catch {
      done();
    }
  }, []);

  const enqueueTts = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t || mutedRef.current) return;
      ttsQueueRef.current.push(t);
      void playNext();
    },
    [playNext],
  );

  const stopTts = useCallback(() => {
    ttsQueueRef.current = [];
    const el = audioRef.current;
    if (el) {
      el.pause();
      el.onended = null;
      el.onerror = null;
      el.src = '';
    }
    playingRef.current = false;
  }, []);

  const send = useCallback((override?: string) => {
    const text = (override ?? input).trim();
    if (!text || streaming) return;
    if (override === undefined) setInput('');
    setMessages((m) => [
      ...m,
      { role: 'user', text },
      { role: 'assistant', text: '', tools: [], citations: [], streaming: true },
    ]);
    setStreaming(true);

    const tools: ToolEvent[] = [];
    let citations: Citation[] = [];
    // Accumulate the assistant reply so we can hand the FULL text to TTS on end.
    let assistantText = '';
    const handle = xgen.chat.stream(
      {
        workflowId: agent.workflowId,
        workflowName: agent.workflowName,
        input: text,
        interactionId,
      },
      (ev: ChatEvent) => {
        if (ev.kind === 'text') assistantText += ev.content;
        else if (ev.kind === 'summary' && !assistantText) assistantText = ev.text;
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
          // Speak the finished reply (auto-TTS), if enabled and not muted.
          if (ev.kind === 'end' && ttsOnRef.current) enqueueTts(assistantText);
        }
      },
    );
    cancelRef.current = handle;
  }, [input, streaming, agent, interactionId, enqueueTts]);

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

  // ── STT: push-to-talk mic capture (getUserMedia + MediaRecorder) ──
  const startRecording = useCallback(async () => {
    if (recording || transcribing) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = (e) => {
        if (e.data && e.data.size) chunksRef.current.push(e.data);
      };
      mr.onstop = async () => {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' });
        chunksRef.current = [];
        if (!blob.size) return;
        setTranscribing(true);
        try {
          const lang = voiceCfg?.stt?.language || undefined;
          const t = (await xgen.voice.transcribe(blob, lang)).trim();
          if (t) send(t);
        } catch {
          /* transcription failed — leave the input untouched */
        } finally {
          setTranscribing(false);
        }
      };
      mr.start();
      mediaRef.current = mr;
      setRecording(true);
    } catch {
      // Permission denied / no mic — reset state.
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setRecording(false);
    }
  }, [recording, transcribing, voiceCfg, send]);

  const stopRecording = useCallback(() => {
    const mr = mediaRef.current;
    if (mr && mr.state !== 'inactive') mr.stop();
    mediaRef.current = null;
    setRecording(false);
  }, []);

  const toggleMic = useCallback(() => {
    if (recording) stopRecording();
    else void startRecording();
  }, [recording, startRecording, stopRecording]);

  // Load voice config (server hints) + device-local overrides; track live changes.
  useEffect(() => {
    let alive = true;
    xgen.voice
      .getConfig()
      .then((c) => alive && setVoiceCfg(c))
      .catch(() => undefined);
    xgen.config
      .get()
      .then((cfg) => alive && setLocalVoice({ input: cfg.voiceInput !== false, output: cfg.voiceOutput !== false }))
      .catch(() => undefined);
    const off = xgen.config.onChange((cfg) =>
      setLocalVoice({ input: cfg.voiceInput !== false, output: cfg.voiceOutput !== false }),
    );
    return () => {
      alive = false;
      off();
    };
  }, []);

  // Keep async-callback mirrors in sync; muting also stops in-flight playback.
  useEffect(() => {
    mutedRef.current = muted;
    if (muted) stopTts();
  }, [muted, stopTts]);
  useEffect(() => {
    ttsOnRef.current = ttsOn;
    if (!ttsOn) stopTts();
  }, [ttsOn, stopTts]);

  // Tear down mic + audio when the view unmounts / session switches.
  useEffect(
    () => () => {
      stopRecording();
      stopTts();
    },
    [stopRecording, stopTts],
  );

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

  // Quick-chat: a message from the global hotkey bar sends to this agent.
  useEffect(() => xgen.quickChat.onQuickSend((t) => send(t)), [send]);

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
          {ttsOn && (
            <button
              className="secondary"
              onClick={() => setMuted((v) => !v)}
              title={muted ? '음성 출력 켜기' : '음성 출력 끄기'}
              aria-label={muted ? '음성 출력 켜기' : '음성 출력 끄기'}
            >
              {muted ? '🔇' : '🔊'}
            </button>
          )}
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
                {m.role === 'assistant' && ttsOn && m.text && !m.streaming && !m.error && (
                  <button
                    className="link msg-tts"
                    onClick={() => enqueueTts(m.text)}
                    title="다시 듣기"
                  >
                    🔊 재생
                  </button>
                )}
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
          {sttOn && (
            <button
              className={`composer-mic${recording ? ' recording' : ''}`}
              onClick={toggleMic}
              disabled={transcribing || streaming}
              title={transcribing ? '변환 중…' : recording ? '녹음 중지' : '음성 입력'}
              aria-label="음성 입력"
            >
              {transcribing ? '…' : recording ? '⏹' : '🎤'}
            </button>
          )}
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
