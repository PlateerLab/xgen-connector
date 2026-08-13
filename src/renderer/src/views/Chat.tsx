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
import type { McpBridgeStatusLike, McpRuntimeLogEntryLike } from '../../../preload/index';
import { collapseToolSteps, nextToolIndex } from './tool-activity-model';
import { mcpChatStatus } from './mcp-status-model';
import { ToolLogModal } from './ToolLogModal';
import type { AvatarState } from '../avatar/AvatarSlot';
import { XgenMark } from '../brand/Logo';
import { ChatIcon, DocIcon, MicIcon, MonitorIcon, PanelLeftIcon, PlusIcon, SendIcon, SpeakerIcon, SpeakerOffIcon, StopIcon } from '../brand/icons';

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
  /** 이 메시지와 함께 보낸 화면 캡처 — 무엇을 찍었는지(창 이름). 사용자가
   *  자기 화면이 언제 나갔는지 대화 기록에서 확인할 수 있어야 한다. */
  screenshot?: { sourceName: string; width: number; height: number };
}

/** 도구 활동 표시 — **한 번에 하나**만 보여주고 다음 것으로 스르륵 교체된다.
 *
 * 이전에는 한 턴에서 쓴 도구 칩이 전부 쌓여 화면을 덮었다(스크린샷 30개+).
 * 지금은 "지금 쓰는 도구" 한 칸만 유지한다:
 *   · 같은 도구의 연속 이벤트(tool_call→tool_start→tool_result)는 **제자리**
 *     에서 아이콘만 바뀐다 (불필요한 깜빡임 없음)
 *   · 다른 도구로 넘어갈 때만 페이드 아웃 → 인
 *   · 여러 도구가 몰아치면 중간을 건너뛰고 최신으로 점프한다 (슥 지나감)
 *   · 턴이 끝나면 사라진다 (완료된 답변 위에 낡은 칩을 남기지 않는다)
 */
const TOOL_STEP_MS = 320; // 한 도구가 최소로 머무는 시간
const TOOL_FADE_MS = 220; // 교체 크로스페이드 길이

interface ToolSlot {
  key: number;
  ev: ToolEvent;
}

const ToolActivity: React.FC<{ events: ToolEvent[]; streaming: boolean }> = ({ events, streaming }) => {
  // 연속 동일 도구 이벤트를 한 단계로 접는다 (마지막 상태만 유지).
  const steps = useMemo(() => collapseToolSteps(events), [events]);

  const [idx, setIdx] = useState(0);
  // 크로스페이드: 나가는 칩과 들어오는 칩을 **동시에** 겹쳐 둔다. 한 요소의
  // 클래스만 바꿔 out→in 을 순차로 돌리면 중간에 빈 구간이 생겨 전환이
  // 끊겨 보인다 (첫 구현의 문제).
  const [cur, setCur] = useState<ToolSlot | null>(null);
  const [out, setOut] = useState<ToolSlot | null>(null);

  // 밀린 단계 전진 — 많이 밀렸으면 최신으로 점프 (여러 도구를 빠르게 쓰면 슥 지나감).
  useEffect(() => {
    if (!steps.length) return;
    if (idx > steps.length - 1) { setIdx(steps.length - 1); return; }
    if (idx === steps.length - 1) return;
    const t = setTimeout(() => setIdx((i) => nextToolIndex(i, steps.length)), TOOL_STEP_MS);
    return () => clearTimeout(t);
  }, [steps.length, idx]);

  // 표시 대상 갱신 — 같은 단계의 상태 변화(⚙→✓)는 제자리, 단계가 바뀌면 크로스페이드.
  useEffect(() => {
    const target = steps[Math.min(idx, steps.length - 1)];
    if (!target) return;
    setCur((prev) => {
      if (prev && prev.key === idx) {
        return prev.ev === target ? prev : { key: idx, ev: target }; // 제자리 갱신
      }
      if (prev) setOut(prev); // 이전 칩은 나가는 레이어로
      return { key: idx, ev: target };
    });
  }, [idx, steps]);

  // 나가는 레이어 정리 (애니메이션이 끝난 뒤 언마운트).
  useEffect(() => {
    if (!out) return;
    const t = setTimeout(() => setOut(null), TOOL_FADE_MS);
    return () => clearTimeout(t);
  }, [out]);

  // 턴 종료 → 스르륵 사라짐.
  useEffect(() => {
    if (streaming || !cur) return;
    setOut(cur);
    setCur(null);
  }, [streaming, cur]);

  if (!cur && !out) return null;
  const chip = (slot: ToolSlot, leaving: boolean) => (
    <span
      key={`${slot.key}-${leaving ? 'out' : 'in'}`}
      className={`tool-chip ${slot.ev.eventType ?? ''} ${leaving ? 'leaving' : 'entering'}`}
      title={slot.ev.toolName}
    >
      <span className="tname">{slot.ev.toolName ?? 'tool'}</span>
      {!leaving && steps.length > 1 && (
        <span className="tstep">{Math.min(slot.key + 1, steps.length)}/{steps.length}</span>
      )}
    </span>
  );
  return (
    <div className="tool-activity">
      {out && chip(out, true)}
      {cur && chip(cur, false)}
    </div>
  );
};

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
  mcpDebug?: boolean;
  onExpandSidebar?: () => void;
}> = ({ session, collapsed, mcpDebug = false, onExpandSidebar }) => {
  const { agent } = session;
  const [messages, setMessages] = useState<Msg[]>([]);
  // 아바타에게는 **이 세션에서 라이브로 흐른 텍스트만** 준다.
  //
  // 예전에는 "마지막 assistant 메시지"를 messages 변경마다 밀어 넣었다.
  // 그러면 대화 기록을 열기만 해도 그 대화의 마지막 답변이 아바타 말풍선에
  // 떠서, 아바타가 방금 말한 것처럼 보였다 (사용자 신고). 기록을 읽는 것과
  // 말하는 것은 다른 일이다 — 책장을 펼쳤다고 배우가 대사를 치면 안 된다.
  const [liveText, setLiveText] = useState('');

  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  // 화면 캡처 — 기본 꺼짐. 화면에는 다른 사람의 메시지·비밀번호·미공개 문서가
  // 있을 수 있어서, 서버로 보내는 것은 사용자가 명시적으로 골라야 한다.
  const [screenCaptureOn, setScreenCaptureOn] = useState(false);
  const [captureNotice, setCaptureNotice] = useState('');
  // 전체 도구 로그 — 흐름에는 하나씩 지나가게 두고, 필요할 때 여기서 펼친다.
  const [logFor, setLogFor] = useState<ToolEvent[] | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [mcpStatus, setMcpStatus] = useState<McpBridgeStatusLike | null>(null);
  const [mcpLogs, setMcpLogs] = useState<McpRuntimeLogEntryLike[]>([]);
  const [mcpLogsOpen, setMcpLogsOpen] = useState(false);
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
  const playingRef = useRef(false);
  // 기기 로컬 볼륨 (0~300%) — 100% 초과 부스트는 WebAudio GainNode 로.
  const volumeRef = useRef(100);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const bufferSrcRef = useRef<AudioBufferSourceNode | null>(null);
  // stopTts 세대 표식 — 중단 이후 도착한 이전 세대의 합성/재생 결과를 버린다.
  const ttsEpochRef = useRef(0);
  // Mirrors for use inside async/stream callbacks (avoid stale closures + dep churn).
  const mutedRef = useRef(muted);
  const ttsOnRef = useRef(ttsOn);

  // A stable signature of the open session — changing it resets the view.
  const sessionSig = `${agent.workflowId}::${session.resume ? session.interactionId : 'new'}`;

  useEffect(() => {
    if (!mcpDebug) {
      setMcpStatus(null);
      return;
    }
    let alive = true;
    void xgen.mcp
      .status()
      .then((status) => alive && setMcpStatus(status))
      .catch(() => undefined);
    const off = xgen.mcp.onStatus((status) => setMcpStatus(status));
    return () => {
      alive = false;
      off();
    };
  }, [mcpDebug]);

  useEffect(() => {
    if (!mcpDebug) {
      setMcpLogs([]);
      setMcpLogsOpen(false);
      return;
    }
    let alive = true;
    void xgen.mcp
      .runtimeLogs()
      .then((logs) => alive && setMcpLogs(logs))
      .catch(() => undefined);
    const off = xgen.mcp.onRuntimeLog((entry) => {
      setMcpLogs((logs) => [...logs.slice(-199), entry]);
    });
    return () => {
      alive = false;
      off();
    };
  }, [mcpDebug]);

  useEffect(() => {
    cancelRef.current?.cancel();
    cancelRef.current = null;
    setStreaming(false);
    const iid = session.interactionId ?? newInteractionId(agent.workflowId);
    setInteractionId(iid);

    setLiveText('');
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

  // ── TTS playback: serial queue over WebAudio (Geny 방식) ──
  // HTMLAudioElement + blob URL 은 CSP media-src 의 지배를 받고(누락 시
  // "no supported source" 로 조용히 죽는다) 재생 오류 이벤트가 이중 콜백
  // 레이스를 만든다. decodeAudioData + AudioBufferSourceNode 는 바이트를
  // 직접 디코드하므로 CSP/MIME 과 무관하고, onended 단일 경로로 직렬이 보장된다.
  const playNext = useCallback(async () => {
    if (playingRef.current) return;
    const text = ttsQueueRef.current.shift();
    if (!text) return;
    playingRef.current = true;
    const epoch = ttsEpochRef.current;
    try {
      const blob = await xgen.voice.speak(text);
      if (ttsEpochRef.current !== epoch) return;
      let ctx = audioCtxRef.current;
      if (!ctx || ctx.state === 'closed') {
        ctx = new AudioContext();
        audioCtxRef.current = ctx;
        const gain = ctx.createGain();
        gain.connect(ctx.destination);
        gainRef.current = gain;
      }
      if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
      const bytes = await blob.arrayBuffer();
      let decoded: AudioBuffer;
      try {
        decoded = await ctx.decodeAudioData(bytes.slice(0));
      } catch {
        // 디코드 실패 = 서버가 오디오가 아닌 것을 보냈다는 뜻 — 원인 추적이
        // 되도록 응답의 정체(타입/크기/시그니처)를 오류에 담는다.
        const head = new Uint8Array(bytes.slice(0, 4));
        const sig = String.fromCharCode(...head).replace(/[^\x20-\x7e]/g, '?');
        throw new Error(
          `오디오 디코드 실패 (type=${blob.type || '?'}, ${bytes.byteLength}B, head="${sig}")`,
        );
      }
      setVoiceError(null);
      if (ttsEpochRef.current !== epoch) return;
      if (gainRef.current) {
        gainRef.current.gain.value = Math.max(0, Math.min(300, volumeRef.current)) / 100;
      }
      await new Promise<void>((resolve) => {
        const src = ctx.createBufferSource();
        src.buffer = decoded;
        src.connect(gainRef.current ?? ctx.destination);
        src.onended = () => resolve();
        bufferSrcRef.current = src;
        src.start();
      });
    } catch (e) {
      // 합성/재생 실패 — 원인(예: 'TTS upstream 404: voice_profile_not_found...')
      // 을 잠깐 보여 준다. 큐의 다음 문장은 계속 시도한다.
      const msg = e instanceof Error && e.message ? e.message : '음성 합성에 실패했습니다.';
      setVoiceError(msg);
      if (voiceErrTimer.current) clearTimeout(voiceErrTimer.current);
      voiceErrTimer.current = setTimeout(() => setVoiceError(null), 6000);
    } finally {
      // 세대가 바뀌었으면(stopTts) 새 루프가 이미 소유권을 가진다 — 손대지 않는다.
      if (ttsEpochRef.current === epoch) {
        bufferSrcRef.current = null;
        playingRef.current = false;
        void playNext();
      }
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
    ttsEpochRef.current += 1;
    try {
      bufferSrcRef.current?.stop();
    } catch {
      /* 이미 종료된 소스 */
    }
    bufferSrcRef.current = null;
    playingRef.current = false;
  }, []);

  useEffect(() => {
    const apply = (c: { screenCapture?: boolean }): void => setScreenCaptureOn(!!c.screenCapture);
    void xgen.config.get().then(apply);
    return xgen.config.onChange(apply);
  }, []);

  // 캡처 실패 안내는 잠깐만 — 다음 전송이 성공하면 지워진다.
  useEffect(() => {
    if (!captureNotice) return;
    const t = setTimeout(() => setCaptureNotice(''), 8000);
    return () => clearTimeout(t);
  }, [captureNotice]);

  const send = useCallback(async (override?: string) => {
    const text = (override ?? input).trim();
    if (!text || streaming) return;
    if (override === undefined) setInput('');

    // 화면 캡처가 켜져 있으면 **보내기 직전** 한 장 찍는다. 주기적으로 올리지
    // 않는 이유: 사용자가 언제 무엇이 나갔는지 알 수 있어야 한다.
    //
    // 실패해도 대화를 막지 않는다 — 캡처는 덤이고, 못 찍었다고 사용자의 질문이
    // 사라지면 그게 더 나쁘다. 대신 **조용히 넘어가지 않고** 이유를 남긴다.
    let shot: { dataUrl?: string; sourceName?: string; width?: number; height?: number } | null = null;
    if (screenCaptureOn) {
      try {
        const r = await xgen.capture.screen();
        if (r.ok && r.dataUrl) shot = r;
        else if (r.error) setCaptureNotice(r.error);
      } catch (e) {
        setCaptureNotice(e instanceof Error ? e.message : '화면을 캡처하지 못했습니다');
      }
    }

    setMessages((m) => [
      ...m,
      {
        role: 'user',
        text,
        screenshot: shot
          ? {
              sourceName: shot.sourceName ?? '화면',
              width: shot.width ?? 0,
              height: shot.height ?? 0,
            }
          : undefined,
      },
      { role: 'assistant', text: '', tools: [], citations: [], streaming: true },
    ]);
    setStreaming(true);
    setLiveText('');

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
        // 캡처가 있으면 멀티모달 content 로 보낸다 — 백엔드가 받는 형식이
        // [{type:'text'},{type:'image_url'}] 이다. 없으면 예전처럼 문자열.
        input: shot?.dataUrl
          ? [
              { type: 'text', text },
              { type: 'image_url', image_url: { url: shot.dataUrl } },
            ]
          : text,
        interactionId,
      },
      (ev: ChatEvent) => {
        if (ev.kind === 'text') {
          assistantText += ev.content;
          setLiveText(assistantText);
          flushSpeech(false);
        } else if (ev.kind === 'summary' && !assistantText) {
          assistantText = ev.text;
          setLiveText(assistantText);
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
  }, [input, streaming, agent, interactionId, enqueueTts, screenCaptureOn]);

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

  const avatarState: AvatarState = useMemo(
    () => ({
      workflowId: agent.workflowId,
      workflowName: agent.workflowName,
      streamingText: liveText,
      speaking: streaming,
    }),
    [liveText, streaming, agent],
  );

  // Feed the live state to the floating avatar overlay (a no-op if it's closed).
  useEffect(() => {
    xgen.overlay.pushState(avatarState);
  }, [avatarState]);

  // Quick-chat: a message from the global hotkey bar sends to this agent.
  useEffect(() => xgen.quickChat.onQuickSend((t) => send(t)), [send]);

  const kind = AGENT_KIND[agent.workflowType ?? ''] ?? (agent.workflowType || 'Agent');
  const mcpIndicator = mcpChatStatus(mcpStatus);

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
          {mcpDebug && (
            <button
              type="button"
              className={`mcp-chat-status ${mcpIndicator.tone}`}
              title={mcpIndicator.title}
              aria-label={mcpIndicator.title}
              aria-expanded={mcpLogsOpen}
              onClick={() => setMcpLogsOpen((open) => !open)}
            >
              <span className="mcp-chat-status-dot" />
              {mcpIndicator.label}
            </button>
          )}
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

      {mcpDebug && mcpLogsOpen && (
        <div className="mcp-runtime-log" role="log" aria-label="로컬 MCP 실행 로그">
          <div className="mcp-runtime-log-head">
            <strong>로컬 MCP 실행 로그</strong>
            <div className="row">
              <button
                className="link"
                onClick={() => {
                  void xgen.mcp.clearRuntimeLogs();
                  setMcpLogs([]);
                }}
                disabled={mcpLogs.length === 0}
              >
                초기화
              </button>
              <button className="link" onClick={() => setMcpLogsOpen(false)}>
                닫기
              </button>
            </div>
          </div>
          {mcpLogs.length === 0 ? (
            <div className="mcp-runtime-log-empty">현재 실행에서 기록된 도구 호출이 없습니다.</div>
          ) : (
            <div className="mcp-runtime-log-list">
              {[...mcpLogs].reverse().map((entry) => (
                <div className={`mcp-runtime-log-entry ${entry.ok === false ? 'error' : ''}`} key={entry.id}>
                  <time>{new Date(entry.timestamp).toLocaleTimeString()}</time>
                  <span className="mcp-runtime-log-kind">{entry.kind}</span>
                  <span className="mcp-runtime-log-message">
                    {entry.server && entry.tool ? `${entry.server}.${entry.tool} · ` : ''}
                    {entry.message}
                    {entry.durationMs !== undefined ? ` · ${entry.durationMs}ms` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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
                  <ToolActivity events={m.tools} streaming={!!m.streaming} />
                )}
                <div className={`bubble ${m.role} ${m.error ? 'error' : ''}`}>
                  {m.text || (m.streaming ? <span className="cursor" /> : '')}
                  {m.text && m.streaming && <span className="cursor" />}
                </div>
                {/* 이 메시지와 함께 화면이 나갔다는 사실을 남긴다. 대화 기록만
                    봐도 언제 무엇을 보냈는지 알 수 있어야 한다. */}
                {m.screenshot && (
                  <div className="shot-note" title={`${m.screenshot.width}×${m.screenshot.height}`}>
                    <MonitorIcon size={11} />
                    <span>화면 첨부 · {m.screenshot.sourceName}</span>
                  </div>
                )}
                {/* 전체 도구 로그 — 흐름의 도구 칩은 하나씩 지나가므로,
                    무엇이 있었는지 되짚으려면 펼칠 곳이 필요하다. 답변이
                    끝난 뒤에만 보인다 (진행 중에는 아직 늘어난다). */}
                {m.role === 'assistant' && !m.streaming && m.tools && m.tools.length > 0 && (
                  <button className="toollog-open" onClick={() => setLogFor(m.tools ?? [])}>
                    전체 로그 보기 · {m.tools.length}건
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
        {voiceError && (
          <div className="voice-error small" title={voiceError}>
            음성 재생 실패: {voiceError}
          </div>
        )}
        {logFor && <ToolLogModal events={logFor} onClose={() => setLogFor(null)} />}
        {captureNotice && (
          <div className="voice-error small" title={captureNotice}>
            화면을 첨부하지 못했습니다: {captureNotice}
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
          {/* 화면 캡처 토글 — 켜져 있으면 보낼 때마다 지금 화면이 함께 간다.
              그 사실이 항상 보여야 한다: 켜 둔 것을 잊고 민감한 화면을 보내는
              것이 이 기능의 유일한 위험이다. */}
          <button
            className={`composer-shot${screenCaptureOn ? ' on' : ''}`}
            onClick={() => void xgen.config.set({ screenCapture: !screenCaptureOn })}
            disabled={streaming}
            title={
              screenCaptureOn
                ? '화면 첨부 켜짐 — 보낼 때마다 지금 화면이 함께 전송됩니다. 눌러서 끄기'
                : '화면 첨부 — 메시지를 보낼 때 지금 화면을 함께 보냅니다'
            }
            aria-label="화면 첨부"
            aria-pressed={screenCaptureOn}
          >
            <MonitorIcon size={16} />
          </button>
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
