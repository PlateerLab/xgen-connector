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
import { AvatarsApi } from './avatars';
import { ChatApi } from './chat';
import { HistoryApi } from './history';
import { PreferencesApi } from './preferences';
import { VoiceApi } from './voice';
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
  readonly preferences: PreferencesApi;
  readonly avatars: AvatarsApi;
  readonly voice: VoiceApi;

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
    this.preferences = new PreferencesApi(this.http);
    this.avatars = new AvatarsApi(this.http);
    this.voice = new VoiceApi(this.http);
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
    return this.adoptLogin(await this.auth.login(email, password));
  }

  /** Adopt tokens returned by an external SSO bridge and resolve full identity. */
  async adoptLogin(res: LoginResult): Promise<LoginResult> {
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
    return (await this.restoreDetailed(accessToken, refreshToken)) === 'valid';
  }

  /**
   * restore() 의 판정 세분화 — 호출자가 토큰 폐기 여부를 올바르게 정할 수
   * 있게 한다 (geny-connector validateAndRefreshAuth 강건성 이식):
   *   'valid'   — 인증 성공 (토큰 회전 반영됨)
   *   'invalid' — 서버가 **응답으로** 거부 (토큰 폐기가 맞다)
   *   'network' — 서버 미응답/네트워크 오류 (토큰을 지우면 안 된다 — 일시
   *               장애 후 재시작에서 재로그인을 강요하게 된다)
   */
  async restoreDetailed(
    accessToken: string,
    refreshToken?: string,
  ): Promise<'valid' | 'invalid' | 'network'> {
    this.http.setToken(accessToken);
    this.refreshToken = refreshToken;
    let sawNetworkError = false;
    try {
      const { user, newAccessToken } = await this.auth.validate(accessToken, refreshToken);
      if (newAccessToken) this.http.setToken(newAccessToken);
      if (user) {
        this.user = user;
        return 'valid';
      }
    } catch {
      sawNetworkError = true;
    }
    // Try an explicit refresh as a fallback.
    if (refreshToken) {
      try {
        const fresh = await this.auth.refresh(refreshToken);
        if (fresh) {
          this.http.setToken(fresh);
          const { user } = await this.auth.validate(fresh, refreshToken);
          if (user) {
            this.user = user;
            return 'valid';
          }
        }
        // 서버가 응답했고 거부했다 — 명시적 invalid.
        sawNetworkError = false;
      } catch {
        sawNetworkError = true;
      }
    }
    return sawNetworkError ? 'network' : 'invalid';
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
export type { StoreAvatar } from './avatars';
