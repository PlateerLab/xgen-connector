/**
 * Shared types for the XGEN connector transport layer.
 *
 * These mirror the real XGEN gateway/workflow API (see docs/PROTOCOL.md). The
 * transport layer is framework-agnostic (no Electron/React imports) so it can
 * be unit-tested and reused by the renderer, the main process, or headless
 * tooling.
 */

export interface ServerConfig {
  /** Gateway origin, e.g. "https://xgen.example.com" or "http://localhost:8000". */
  baseUrl: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string; // "bearer"
}

export interface CurrentUser {
  userId: string;
  username: string;
  isSuperuser: boolean;
  roles: string[];
  permissions: string[];
}

export interface LoginResult extends AuthTokens {
  userId: string;
  username: string;
}

/** One agent (agentflow) as shown in the "Agent 목록" grid. */
export interface Agent {
  id: number;
  workflowId: string;
  workflowName: string;
  nodeCount: number;
  isShared: boolean; // false=개인(personal), true=공유(shared)
  isDeployed: boolean; // false=미배포, true=배포
  isCompleted: boolean;
  workflowType: string; // "canvas" | "harness"
  description: string;
  username: string;
  fullName: string;
  createdAt: string;
  updatedAt: string;
}

export interface Pagination {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

export interface AgentListResult {
  items: Agent[];
  pagination: Pagination;
}

export interface AgentListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  /** active | draft | unactive | active_or_draft | archived */
  status?: string;
  /** "personal" (개인) | "shared" (공유) */
  owner?: 'personal' | 'shared';
  includeHarness?: boolean;
}

/** A citation attached to a tool result (RAG source). */
export interface Citation {
  fileName?: string;
  pageNumber?: number;
  score?: number;
  chunkText?: string;
  [k: string]: unknown;
}

/** A tool / agent activity event surfaced during a chat turn. */
export interface ToolEvent {
  eventType: 'tool_call' | 'tool_start' | 'tool_result' | 'tool_error' | string;
  toolName?: string;
  toolInput?: unknown;
  result?: string;
  resultLength?: number;
  error?: string;
  citations?: Citation[];
  runId?: string;
  indicator?: unknown;
  durationMs?: number;
  timestamp?: string;
  [k: string]: unknown;
}

export interface NodeStatusEvent {
  nodeId: string;
  status: string;
  [k: string]: unknown;
}

/**
 * Normalized chat stream events delivered to the caller. The raw SSE protocol
 * (named `event:` frames + default `data:` frames carrying a `type`) is
 * flattened into this single discriminated union.
 */
export type ChatEvent =
  | { kind: 'text'; content: string } // streamed assistant text chunk
  | { kind: 'tool'; event: ToolEvent } // tool / agent activity
  | { kind: 'node_status'; event: NodeStatusEvent }
  | { kind: 'log'; data: unknown }
  | { kind: 'execution_io'; executionIoId: number }
  | { kind: 'download'; data: Record<string, unknown> }
  | { kind: 'ui_command'; surface: 'a2ui' | 'floui'; command: Record<string, unknown> }
  | { kind: 'quota'; level: 'warning' | 'exceeded'; data: Record<string, unknown> }
  | { kind: 'summary'; text: string; data: Record<string, unknown> }
  | { kind: 'error'; detail: string }
  | { kind: 'end' };

export interface ChatRequest {
  workflowId: string;
  workflowName: string;
  input: string | Record<string, unknown> | unknown[];
  /** Conversation key — reuse across turns to continue a conversation. */
  interactionId: string;
  selectedCollections?: string[];
  selectedFiles?: (string | Record<string, unknown>)[];
  includeLogs?: boolean;
  includeNodeStatus?: boolean;
  includeToolEvents?: boolean;
}

/** One past turn from the conversation history (io-logs). */
export interface HistoryTurn {
  logId: number;
  ioId: number;
  interactionId: string;
  workflowId: string;
  workflowName: string;
  input: string;
  output: string;
  updatedAt: string;
}

/** A past conversation (interaction) for the sidebar. */
export interface Conversation {
  id: number;
  interactionId: string;
  workflowId: string;
  workflowName: string;
  interactionCount: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
