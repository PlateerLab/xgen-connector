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
  /** stdio: full command line, e.g. `npx -y @modelcontextprotocol/server-filesystem /path`. */
  command?: string;
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
  /** Device-local voice OUTPUT (TTS) toggle. Default true. Server gate applies. */
  voiceOutput?: boolean;
  /** Enable hosting local MCP servers + bridging their tools to your agents. */
  mcp?: boolean;
  /** Configured local MCP servers. */
  mcpServers?: McpServerConfig[];
}

const DEFAULTS: ConnectorConfig = {
  serverUrl: '',
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

/** Strip trailing slashes so `${base}/api/...` never yields `//api`. */
export function normalizeServerUrl(url: string): string {
  return (url || '').trim().replace(/\/+$/, '');
}
