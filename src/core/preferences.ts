/**
 * User preferences — the per-user avatar config lives in xgen-core
 * `preferences.avatar` and is read via the profile endpoint. The connector shows
 * the user's DEFAULT avatar globally (not per-session), so this is the only
 * avatar source the overlay needs.
 */
import { HttpClient } from './client';

export type AvatarRuntime = 'live2d' | 'spine';

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

  /** GET /api/admin/user → preferences.avatar (defensive: empty on any failure). */
  async getAvatarConfig(): Promise<AvatarConfig> {
    try {
      const res = await this.http.get<RawProfile>('/api/admin/user');
      let prefs: unknown = res?.user?.preferences ?? {};
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
    } catch {
      return { ...EMPTY_AVATAR_CONFIG };
    }
  }
}
