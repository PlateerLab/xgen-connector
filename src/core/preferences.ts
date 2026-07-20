/**
 * User preferences — the per-user avatar config lives in xgen-core
 * `preferences.avatar` and is read via the profile endpoint. The connector shows
 * the user's DEFAULT avatar globally (not per-session), so this is the only
 * avatar source the overlay needs.
 */
import { HttpClient } from './client';

export type AvatarRuntime = 'live2d' | 'spine' | 'image';

export interface AvatarDescriptor {
  id: string;
  name: string;
  runtime: AvatarRuntime;
  source: string;
  modelUrl: string; // e.g. /api/storage/avatar/{user}/{id}/x.model3.json (relative)
  atlasUrl?: string;
  thumbnail?: string | null;
  scale?: number;
  position?: { x: number; y: number };
  idleMotionGroupName?: string;
  emotionMap?: Record<string, number>;
  emotionMotionMap?: Record<string, string>;
  tapMotions?: Record<string, Record<string, number>>;
  hiddenParts?: string[];
}

export interface AvatarConfig {
  enabled: boolean;
  defaultAvatarId: string | null;
  avatars: AvatarDescriptor[];
}

export const EMPTY_AVATAR_CONFIG: AvatarConfig = { enabled: false, defaultAvatarId: null, avatars: [] };

interface RawProfile {
  // preferences may arrive as a parsed object OR (defensively) a JSON string.
  user?: { preferences?: Record<string, unknown> | string | null } | null;
}

export class PreferencesApi {
  constructor(private http: HttpClient) {}

  /** GET /api/admin/user → preferences.avatar.
   *
   *  THROWS on failure (network / 401 / not-yet-authenticated) rather than
   *  returning an empty config: at startup the overlay's fetch can beat the
   *  main window's session restore, and masking that as `{enabled:false}` made
   *  the avatar look permanently absent. Propagating lets the caller retry until
   *  the client is authed. A genuinely empty config (feature off) still returns
   *  normally. */
  async getAvatarConfig(): Promise<AvatarConfig> {
    const res = await this.http.get<RawProfile>('/api/admin/user');
    if (!res || !res.user) {
      // Unauthenticated pass-through / no profile yet → not a real answer.
      throw new Error('avatar config: no authenticated profile');
    }
    let prefs: unknown = res.user.preferences ?? {};
    if (typeof prefs === 'string') {
      try {
        prefs = JSON.parse(prefs);
      } catch {
        prefs = {};
      }
    }
    const raw = ((prefs as Record<string, unknown> | null)?.avatar ?? {}) as Partial<AvatarConfig>;
    return {
      enabled: !!raw.enabled,
      defaultAvatarId: typeof raw.defaultAvatarId === 'string' ? raw.defaultAvatarId : null,
      avatars: Array.isArray(raw.avatars) ? (raw.avatars as AvatarDescriptor[]) : [],
    };
  }

  /** Persist the whole avatar config (PUT shallow-merges preferences top-level,
   *  so sending {avatar} replaces just that key). Used when the overlay adjusts
   *  the avatar's scale/position in-place. */
  async saveAvatarConfig(config: AvatarConfig): Promise<void> {
    await this.http.put('/api/admin/user', { preferences: { avatar: config } });
  }

  /** Persist ONE avatar's scale/position — read-modify-write against the
   *  CURRENT server config. Saving a cached whole-config snapshot silently
   *  reverted changes made in between on the web (아바타 선택이 예전 값으로
   *  되돌아가 "바꿔도 커넥터에 적용 안 됨" 증상), so partial updates must
   *  always re-read first and patch only their own field. */
  async saveAvatarTransform(
    avatarId: string,
    tf: { scale: number; position: { x: number; y: number } },
  ): Promise<void> {
    const cfg = await this.getAvatarConfig();
    const next: AvatarConfig = {
      ...cfg,
      avatars: cfg.avatars.map((a) =>
        a.id === avatarId ? { ...a, scale: tf.scale, position: tf.position } : a,
      ),
    };
    await this.saveAvatarConfig(next);
  }
}
