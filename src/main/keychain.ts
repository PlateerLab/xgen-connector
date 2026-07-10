/**
 * OS-keychain-backed token storage (keytar): Keychain / Credential Manager /
 * libsecret. The JWT never touches the config file. Mirrors geny-connector.
 *
 * keytar is a native module; if it fails to load (missing libsecret on a bare
 * Linux box, etc.) we fall back to an in-memory store for the session so the
 * app still works — the user just re-logs in after a restart.
 */
const SERVICE = 'xgen-connector';
const ACCESS = 'xgen_access_token';
const REFRESH = 'xgen_refresh_token';
const CREDS = 'xgen_login_credentials';

type Keytar = typeof import('keytar');
let keytarMod: Keytar | null | undefined;
const memory = new Map<string, string>();

async function keytar(): Promise<Keytar | null> {
  if (keytarMod !== undefined) return keytarMod;
  try {
    keytarMod = (await import('keytar')).default as unknown as Keytar;
  } catch {
    keytarMod = null; // fall back to in-memory
  }
  return keytarMod;
}

async function set(account: string, value: string | null): Promise<void> {
  const k = await keytar();
  if (!k) {
    if (value === null) memory.delete(account);
    else memory.set(account, value);
    return;
  }
  if (value === null) await k.deletePassword(SERVICE, account).catch(() => {});
  else await k.setPassword(SERVICE, account, value);
}

async function get(account: string): Promise<string | null> {
  const k = await keytar();
  if (!k) return memory.get(account) ?? null;
  return k.getPassword(SERVICE, account);
}

export const tokenStore = {
  async setAccess(token: string | null) {
    await set(ACCESS, token);
  },
  async getAccess() {
    return get(ACCESS);
  },
  async setRefresh(token: string | null) {
    await set(REFRESH, token);
  },
  async getRefresh() {
    return get(REFRESH);
  },
  async clear() {
    await set(ACCESS, null);
    await set(REFRESH, null);
  },
};

/** Auto-login credentials (email + password) in the OS keychain — only stored
 *  when the user opts into "자동 로그인". Never written to the config file. */
export interface SavedCredentials {
  email: string;
  password: string;
}
export const credentialStore = {
  async save(creds: SavedCredentials): Promise<void> {
    await set(CREDS, JSON.stringify(creds));
  },
  async get(): Promise<SavedCredentials | null> {
    const raw = await get(CREDS);
    if (!raw) return null;
    try {
      const c = JSON.parse(raw) as SavedCredentials;
      return c && typeof c.email === 'string' && typeof c.password === 'string' ? c : null;
    } catch {
      return null;
    }
  },
  async clear(): Promise<void> {
    await set(CREDS, null);
  },
};
