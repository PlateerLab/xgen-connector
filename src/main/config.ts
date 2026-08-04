/**
 * connector.json — the connector's local config file (Electron userData dir).
 *
 * Mirrors geny-connector: a tiny JSON file holding the server URL and app
 * preferences. The JWT token is NOT stored here — it lives in the OS keychain
 * (see keychain.ts). `XGEN_SERVER_URL` env pre-seeds the base URL on first run.
 */
import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A local MCP server the connector hosts + proxies to the user's XGEN agents. */
export interface McpServerConfig {
  /** Unique, stable id used to namespace the server's tools. */
  name: string;
  transport: 'stdio' | 'http';
  /** stdio: 실행 명령. `args` 가 없으면 따옴표 인식 분해로 argv 를 만든다
   *  (사람이 한 줄로 적는 경로), `args` 가 있으면 이 값은 **실행 파일**이다. */
  command?: string;
  /** stdio: 표준 MCP 설정(JSON)에서 가져온 argv. 문자열로 합쳤다 다시 쪼개면
   *  공백·따옴표가 든 인자가 깨지므로 분리 보존한다. */
  args?: string[];
  /** stdio: extra environment merged over the connector's env (e.g. API tokens). */
  env?: Record<string, string>;
  /** http: the MCP endpoint URL (Streamable HTTP). */
  url?: string;
  /** http: extra request headers (e.g. Authorization). */
  headers?: Record<string, string>;
  /** Off servers are never connected/advertised. Default true. */
  enabled?: boolean;
}

export interface ConnectorConfig {
  /** Gateway origin, e.g. "https://xgen.example.com". Empty on first run. */
  serverUrl: string;
  /** 설정된 서버에서 사설 CA 신뢰 실패만 예외로 허용한다. 기본 false. */
  allowPrivateCertificate?: boolean;
  /** 로그인 화면에서 SSO 팝업 로그인을 제공한다. 기본 false. */
  ssoEnabled?: boolean;
  /** 서버 origin 기준 SSO 진입 상대 경로. 예: "/sso/signin". */
  ssoPath?: string;
  theme?: 'system' | 'dark' | 'light';
  lang?: 'ko' | 'en';
  autoUpdate?: boolean; // default true
  autoLaunch?: boolean;
  /** Last selected agent (workflow_id) so the app reopens on it. */
  lastWorkflowId?: string;
  /** Persisted window bounds. */
  window?: { width: number; height: number; x?: number; y?: number };
  /** Show the floating avatar overlay window (Geny-style). Default false. */
  avatarOverlay?: boolean;
  /** Hide only the avatar inside the overlay (keep the floating chat + subtitle). */
  avatarHidden?: boolean;
  /** Show the live subtitle bubble on the overlay. Default true. */
  subtitles?: boolean;
  /** Subtitle typewriter pace — ms per character (throttles fast streams so the
   * speech bubble stays readable). Lower = faster. Default 50. */
  subtitleCharMs?: number;
  /** Speech-bubble size on the overlay: sm ≈ 3 lines, md ≈ 4–5, lg ≈ 6–7.
   * Default 'sm'. */
  subtitleSize?: 'sm' | 'md' | 'lg';
  /** Remember credentials and sign in automatically on launch. Default false. */
  autoLogin?: boolean;
  /** Persisted floating-overlay bounds (legacy single-monitor fallback). */
  overlayBounds?: { width: number; height: number; x?: number; y?: number };
  /** Avatar overlay geometry remembered PER MONITOR (key = display signature),
   *  so moving across mixed-DPI monitors restores each screen's own size instead
   *  of a rescaled one. Preferred over `overlayBounds`. */
  overlayByDisplay?: Record<string, { x: number; y: number; width: number; height: number }>;
  /** Enable the global quick-chat hotkey (Spotlight-style input bar). */
  quickChat?: boolean;
  /** Quick-chat global accelerator. Default Control+Shift+/ (Ctrl + ?). */
  quickChatHotkey?: string;
  /** Remembered quick-chat bar position. */
  quickChatBar?: { x: number; y: number };
  /** Device-local voice INPUT (STT) toggle. Default true. The server gate still
   *  applies — voice input works only when preferences.stt.enabled is also on. */
  voiceInput?: boolean;
  /** 아바타 오버레이 핸즈프리 음성 대화 (VAD 마이크 → STT → 자동 전송). */
  voiceHandsfree?: boolean;
  /** TTS 재생 볼륨 % (0~300, 100 = 원음) — 이 기기 로컬, WebAudio 게인. */
  voiceVolume?: number;
  /** Device-local voice OUTPUT (TTS) toggle. Default true. Server gate applies. */
  voiceOutput?: boolean;
  /** Enable hosting local MCP servers + bridging their tools to your agents. */
  mcp?: boolean;
  /** Configured local MCP servers. */
  mcpServers?: McpServerConfig[];
  /** Workspace 동기화 페어링 (에이전트 workflow ↔ 로컬 폴더). */
  syncPairs?: SyncPairPersistConfig[];
  /** 이 설치본의 안정 디바이스 id (최초 1회 생성) — 동기화 텔레메트리/충돌 사본 이름. */
  deviceId?: string;
  /** Linux 전용: 오버레이 클릭 통과 옵트인 ({forward:true} 미지원 플랫폼 안전장치). */
  linuxClickThrough?: boolean;
}

/** 동기화 페어링의 영속 형태 (sync-manager.SyncPairConfig 와 동일 필드 —
 *  main 이외에서 sync-manager 를 import 하지 않도록 여기 재선언). */
export interface SyncPairPersistConfig {
  id: string;
  workflowId: string;
  workflowLabel?: string;
  localPath: string;
  paused?: boolean;
  pausedReason?: string;
}

const DEFAULTS: ConnectorConfig = {
  serverUrl: '',
  allowPrivateCertificate: false,
  ssoEnabled: false,
  ssoPath: '/sso/signin',
  theme: 'system',
  lang: 'ko',
  autoUpdate: true,
  autoLaunch: false,
};

function configPath(): string {
  const dir = app.getPath('userData');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'connector.json');
}

export function loadConfig(): ConnectorConfig {
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf-8'));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS, serverUrl: process.env.XGEN_SERVER_URL || '' };
  }
}

export function saveConfig(patch: Partial<ConnectorConfig>): ConnectorConfig {
  const next = { ...loadConfig(), ...patch };
  writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

/** Server-URL 정규화 (geny-connector 동형):
 *  - 뒤 슬래시 제거 (`${base}/api/...` 가 `//api` 가 되지 않게)
 *  - 스킴 없는 입력 보정: localhost/.local/IPv4 → http://, 그 외 → https://
 *    ("xgen.example.com" 만 입력해도 base URL 이 깨지지 않는다). */
export function normalizeServerUrl(url: string): string {
  let u = (url || '').trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\//i.test(u)) {
    const host = u.split('/')[0].split(':')[0];
    const isLocal =
      host === 'localhost' ||
      host.endsWith('.local') ||
      /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
    u = `${isLocal ? 'http' : 'https'}://${u}`;
  }
  return u;
}
