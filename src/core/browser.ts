/** Shared browser contracts used by the main process, preload and renderer. */

export type BrowserPageMode = 'shared' | 'background';

export type BrowserLoadingState = 'idle' | 'loading' | 'error';

export interface BrowserPageInfo {
  pageId: string;
  workflowId: string;
  workflowName: string;
  mode: BrowserPageMode;
  url: string;
  title: string;
  loading: BrowserLoadingState;
  error?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Persisted Electron partition. It contains only a hashed account key. */
  partition: string;
  /** Changes when navigation/process replacement invalidates snapshot refs. */
  generation: number;
}

export interface BrowserState {
  enabled: boolean;
  pages: BrowserPageInfo[];
  activeByWorkflow: Record<string, string>;
}

export interface BrowserCreateRequest {
  workflowId: string;
  workflowName?: string;
  mode?: BrowserPageMode;
  url?: string;
}

export interface BrowserNavigateRequest {
  pageId: string;
  action: 'goto' | 'back' | 'forward' | 'reload' | 'stop';
  url?: string;
}

export type BrowserErrorCode =
  | 'browser_disabled'
  | 'browser_no_page'
  | 'browser_page_not_found'
  | 'browser_stale_ref'
  | 'browser_timeout'
  | 'browser_denied';

export const BROWSER_CONTEXT_START = '<xgen_browser_context>';
export const BROWSER_CONTEXT_END = '</xgen_browser_context>';

/** Only expose origin + pathname to chat. Query strings and fragments can hold secrets. */
export function sanitizedBrowserUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol === 'about:') return 'about:blank';
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return `${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
}

/** Remove the connector-only browser envelope before text is shown to a user. */
export function stripBrowserContext(text: string): string {
  if (typeof text !== 'string' || !text.startsWith(BROWSER_CONTEXT_START)) return text;
  const end = text.indexOf(BROWSER_CONTEXT_END);
  if (end < 0) return text;
  return text.slice(end + BROWSER_CONTEXT_END.length).replace(/^\r?\n/, '');
}

/** Add a machine-readable envelope only when this workflow owns live pages. */
export function prependBrowserContext(
  input: string,
  workflowId: string,
  state: BrowserState,
): string {
  if (!state.enabled) return input;
  const pages = state.pages
    .filter((page) => page.workflowId === workflowId)
    .map((page) => ({
      workflow_id: page.workflowId,
      page_id: page.pageId,
      mode: page.mode,
      title: page.title,
      url: sanitizedBrowserUrl(page.url),
    }));
  if (!pages.length) return input;
  const envelope = JSON.stringify({ workflow_id: workflowId, pages });
  return `${BROWSER_CONTEXT_START}\n${envelope}\n${BROWSER_CONTEXT_END}\n${input}`;
}
