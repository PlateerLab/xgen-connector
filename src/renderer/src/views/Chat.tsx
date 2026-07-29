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
import { SendIcon, StopIcon, PlusIcon, ChatIcon, DocIcon, PanelLeftIcon, MicIcon, SpeakerIcon, SpeakerOffIcon } from '../brand/icons';

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

/** TTS 용 텍스트 정리 — 코드블록/마크다운 기호/링크를 걷어내 읽을 문장만 남긴다. */
function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' 코드 블록. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 스트리밍 텍스트에서 "완결 문장까지" 잘라낼 위치를 찾는다 (없으면 0).
 *  문장부호(./!/?/…/。/！/？) + 공백/개행, 또는 빈 줄 경계. 너무 짧은 조각
 *  (MIN_TTS_CHUNK 미만)은 다음 경계까지 기다린다. */
const MIN_TTS_CHUNK = 12;
function sentenceCut(pending: string): number {
  let cut = 0;
  const re = /[.!?…。！？](?=["')\]]?(\s|$))|\n{2,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pending)) !== null) {
    const end = m.index + m[0].length;
    if (end >= MIN_TTS_CHUNK) cut = end;
  }
  return cut;
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
  // 음성 합성 실패를 조용히 삼키지 않는다 — 마지막 오류를 잠깐 표시.
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const voiceErrTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  // 기기 로컬 볼륨 (0~300%) — 100% 초과 부스트는 WebAudio GainNode 로.
  const volumeRef = useRef(100);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
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
      setVoiceError(null);
      url = URL.createObjectURL(blob);
      let el = audioRef.current;
      if (!el) {
        el = new Audio();
        audioRef.current = el;
        // WebAudio 게인 체인 — element.volume 은 1.0 이 상한이라 100% 초과
        // 부스트가 불가능하다. MediaElementSource 는 요소당 1회만 생성 가능
        // 하므로 여기서 한 번 배선하고 gain 값만 갱신한다.
        try {
          const ctx = new AudioContext();
          const srcNode = ctx.createMediaElementSource(el);
          const gain = ctx.createGain();
          srcNode.connect(gain);
          gain.connect(ctx.destination);
          audioCtxRef.current = ctx;
          gainRef.current = gain;
        } catch {
          /* WebAudio 불가 → element.volume 폴백 (≤100%) */
        }
      }
      const vol = Math.max(0, Math.min(300, volumeRef.current)) / 100;
      if (gainRef.current) {
        gainRef.current.gain.value = vol;
        el.volume = 1;
        void audioCtxRef.current?.resume().catch(() => undefined);
      } else {
        el.volume = Math.min(1, vol);
      }
      el.onended = done;
      el.onerror = done;
      el.src = url;
      await el.play();
    } catch (e) {
      // 합성/재생 실패 — 원인(예: 'TTS upstream 404: voice_profile_not_found...')
      // 을 잠깐 보여 준다. 큐의 다음 문장은 계속 시도한다.
      const msg = e instanceof Error && e.message ? e.message : '음성 합성에 실패했습니다.';
      setVoiceError(msg);
      if (voiceErrTimer.current) clearTimeout(voiceErrTimer.current);
      voiceErrTimer.current = setTimeout(() => setVoiceError(null), 6000);
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
    // 문장 단위 스트리밍 TTS — 응답이 흐르는 동안 완결 문장을 즉시 큐에 넣어
    // "바로바로" 소리가 나게 한다 (끝까지 기다리지 않음).
    let assistantText = '';
    let spokenUpto = 0;
    const flushSpeech = (force: boolean) => {
      if (!ttsOnRef.current) return;
      const pending = assistantText.slice(spokenUpto);
      if (!pending) return;
      if (force) {
        const tail = cleanForSpeech(pending);
        if (tail) enqueueTts(tail);
        spokenUpto = assistantText.length;
        return;
      }
      const cut = sentenceCut(pending);
      if (cut > 0) {
        const chunk = cleanForSpeech(pending.slice(0, cut));
        if (chunk) enqueueTts(chunk);
        spokenUpto += cut;
      }
    };
    const handle = xgen.chat.stream(
      {
        workflowId: agent.workflowId,
        workflowName: agent.workflowName,
        input: text,
        interactionId,
      },
      (ev: ChatEvent) => {
        if (ev.kind === 'text') {
          assistantText += ev.content;
          flushSpeech(false);
        } else if (ev.kind === 'summary' && !assistantText) {
          assistantText = ev.text;
        }
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
          // 남은 꼬리 문장 재생 (스트리밍 중 이미 대부분 재생됨).
          if (ev.kind === 'end') flushSpeech(true);
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
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // 구버전 preload(업데이트 직후) / 목 하네스에는 voice 브릿지가 없을 수 있다.
    // 기동 직후 인증 준비 전 401 이면 몇 번 재시도해 TTS 가 영구히 꺼진 채
    // 남지 않게 한다. avatarRefresh(로그인 완료/설정 변경)에도 재조회.
    const loadVoice = () => {
      xgen.voice
        ?.getConfig?.()
        ?.then((c) => alive && setVoiceCfg(c))
        ?.catch(() => {
          if (alive && tries < 5) {
            tries += 1;
            timer = setTimeout(loadVoice, 2000);
          }
        });
    };
    loadVoice();
    const offRefresh = xgen.user?.onAvatarRefresh?.(() => {
      tries = 0;
      loadVoice();
    });
    xgen.config
      .get()
      .then((cfg) => {
        if (!alive) return;
        setLocalVoice({ input: cfg.voiceInput !== false, output: cfg.voiceOutput !== false });
        volumeRef.current = typeof cfg.voiceVolume === 'number' ? cfg.voiceVolume : 100;
      })
      .catch(() => undefined);
    const off = xgen.config.onChange((cfg) => {
      setLocalVoice({ input: cfg.voiceInput !== false, output: cfg.voiceOutput !== false });
      volumeRef.current = typeof cfg.voiceVolume === 'number' ? cfg.voiceVolume : 100;
      // 재생 중에도 즉시 반영
      if (gainRef.current) gainRef.current.gain.value = Math.max(0, Math.min(300, volumeRef.current)) / 100;
    });
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      offRefresh?.();
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
              {muted ? <SpeakerOffIcon size={15} /> : <SpeakerIcon size={15} />}
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
        {voiceError && (
          <div className="voice-error small" title={voiceError}>
            음성 재생 실패: {voiceError}
          </div>
        )}
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
              {transcribing ? '…' : recording ? <StopIcon size={15} /> : <MicIcon size={16} />}
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
