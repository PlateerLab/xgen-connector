/**
 * XgenClient — the single entry point for the XGEN connector transport layer.
 *
 * ```ts
 * const xgen = new XgenClient({ baseUrl: 'https://xgen.example.com' });
 * await xgen.login('me@corp.com', 'password');   // stores token in memory
 * const { items } = await xgen.agents.list();     // my agents (agent 목록)
 * for await (const ev of xgen.chat.stream({       // chat with one, streamed
 *   workflowId: items[0].workflowId,
 *   workflowName: items[0].workflowName,
 *   input: '안녕하세요',
 *   interactionId: 'conv-1',
 * })) {
 *   if (ev.kind === 'text') process.stdout.write(ev.content);
 * }
 * ```
 *
 * Node-agnostic: the same chat stream drives agent_geny, agent_xgen and
 * agent_harness agents. The class holds tokens in memory only — persistence
 * (keychain) and base-URL config are the host's concern (Electron main).
 */
import { AgentsApi } from './agents';
import { AuthApi } from './auth';
import { ChatApi } from './chat';
import { HistoryApi } from './history';
import { HttpClient, type FetchLike } from './client';
import type { CurrentUser, LoginResult } from './types';

export interface XgenClientOptions {
  baseUrl: string;
  fetch?: FetchLike;
  accessToken?: string;
  refreshToken?: string;
  onAuthFailure?: () => void;
}

export class XgenClient {
  readonly http: HttpClient;
  readonly auth: AuthApi;
  readonly agents: AgentsApi;
  readonly chat: ChatApi;
  readonly history: HistoryApi;

  private refreshToken?: string;
  user: CurrentUser | null = null;

  constructor(opts: XgenClientOptions) {
    this.http = new HttpClient({
      baseUrl: opts.baseUrl,
      fetch: opts.fetch,
      onAuthFailure: opts.onAuthFailure,
    });
    if (opts.accessToken) this.http.setToken(opts.accessToken);
    this.refreshToken = opts.refreshToken;
    this.auth = new AuthApi(this.http);
    this.agents = new AgentsApi(this.http);
    this.chat = new ChatApi(this.http);
    this.history = new HistoryApi(this.http);
  }

  setBaseUrl(baseUrl: string): void {
    this.http.setBaseUrl(baseUrl);
  }

  setTokens(accessToken: string | null, refreshToken?: string): void {
    this.http.setToken(accessToken);
    if (refreshToken !== undefined) this.refreshToken = refreshToken;
  }

  /** Log in and adopt the returned tokens. */
  async login(email: string, password: string): Promise<LoginResult> {
    const res = await this.auth.login(email, password);
    this.http.setToken(res.accessToken);
    this.refreshToken = res.refreshToken;
    this.user = {
      userId: res.userId,
      username: res.username,
      isSuperuser: false,
      roles: [],
      permissions: [],
    };
    // Resolve full identity/permissions (best-effort).
    try {
      const { user } = await this.auth.validate(res.accessToken, res.refreshToken);
      if (user) this.user = user;
    } catch {
      /* keep the minimal identity */
    }
    return res;
  }

  /**
   * Validate the current session, rotating the access token if the gateway
   * returned a fresh one. Returns true if still/again authenticated.
   */
  async restore(accessToken: string, refreshToken?: string): Promise<boolean> {
    this.http.setToken(accessToken);
    this.refreshToken = refreshToken;
    try {
      const { user, newAccessToken } = await this.auth.validate(accessToken, refreshToken);
      if (newAccessToken) this.http.setToken(newAccessToken);
      if (user) {
        this.user = user;
        return true;
      }
    } catch {
      /* fall through */
    }
    // Try an explicit refresh as a fallback.
    if (refreshToken) {
      const fresh = await this.auth.refresh(refreshToken).catch(() => null);
      if (fresh) {
        this.http.setToken(fresh);
        const { user } = await this.auth.validate(fresh, refreshToken).catch(() => ({ user: null }));
        if (user) {
          this.user = user;
          return true;
        }
      }
    }
    return false;
  }

  getAccessTokenAfterRotation(): string {
    // The HttpClient holds the current (possibly rotated) token.
    return (this.http as unknown as { accessToken: string }).accessToken ?? '';
  }

  /** The current refresh token, so the host can persist it (e.g. keychain). */
  getRefreshToken(): string | undefined {
    return this.refreshToken;
  }

  async logout(): Promise<void> {
    const token = this.getAccessTokenAfterRotation();
    if (token) await this.auth.logout(token);
    this.http.setToken(null);
    this.refreshToken = undefined;
    this.user = null;
  }
}

export * from './types';
export { ApiError } from './client';
export { SseParser } from './sse';
export { frameToChatEvent } from './chat';
export { sha256Hex } from './hash';
