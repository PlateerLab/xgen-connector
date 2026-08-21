import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

export const BROWSER_PARTITION_PREFIX = 'persist:xgen-browser-';

export function browserPartition(serverUrl: string, userId: string): string {
  const digest = createHash('sha256')
    .update(`${serverUrl.replace(/\/+$/, '').toLowerCase()}|${userId}`)
    .digest('hex')
    .slice(0, 24);
  return `${BROWSER_PARTITION_PREFIX}${digest}`;
}

export function allowedBrowserUrl(raw: unknown): string | null {
  const value = String(raw ?? '').trim();
  if (!value || value === 'about:blank') return 'about:blank';
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return resolve(homedir(), path.slice(2));
  return path;
}

/** Upload/download paths share the structured local-tool allowedRoots scope. */
export function browserPathWithinRoots(path: unknown, roots: string[]): string | null {
  const raw = String(path ?? '').trim();
  if (!raw) return null;
  const absolute = resolve(isAbsolute(expandHome(raw)) ? expandHome(raw) : resolve(homedir(), raw));
  const allowed = (roots.length ? roots : [homedir()]).map((root) => resolve(expandHome(root)));
  return allowed.some((root) => {
    const rel = relative(root, absolute);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  })
    ? absolute
    : null;
}
