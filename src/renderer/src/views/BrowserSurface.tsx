import React, { useRef } from 'react';
import type { BrowserPageInfo } from '../../../core/browser';
import { xgen } from '../bridge';
import type { BrowserSurfaceRect } from './BrowserPane';

type ElectronWebview = HTMLElement & {
  getWebContentsId(): number;
  __xgenAttachBound?: boolean;
  __xgenFocusBound?: boolean;
};

const PersistentWebview: React.FC<{
  page: BrowserPageInfo;
  rect?: BrowserSurfaceRect;
  dragging: boolean;
  onFocusPage: (pageId: string) => void;
}> = ({ page, rect, dragging, onFocusPage }) => {
  // src/partition remain creation values. Reflecting every navigation into src
  // would reload SPAs and lose scroll/form state.
  const initial = useRef({ src: page.url, partition: page.partition });
  const style: React.CSSProperties = rect
    ? {
        left: rect.left,
        top: rect.top,
        width: Math.max(0, rect.width),
        height: Math.max(0, rect.height),
        visibility: 'visible',
        pointerEvents: dragging ? 'none' : 'auto',
      }
    : {
        left: -10000,
        top: -10000,
        width: 1,
        height: 1,
        visibility: 'hidden',
        pointerEvents: 'none',
      };
  const setRef = (element: ElectronWebview | null): void => {
    if (!element) return;
    const bind = () => {
      try {
        void xgen.browser.bindShared(page.pageId, element.getWebContentsId());
      } catch {
        /* attachment can race with a closed tab */
      }
    };
    if (!element.__xgenAttachBound) {
      element.__xgenAttachBound = true;
      element.addEventListener('did-attach', bind, { once: true });
    }
    if (!element.__xgenFocusBound) {
      element.__xgenFocusBound = true;
      element.addEventListener('focus', () => onFocusPage(page.pageId));
    }
  };
  return React.createElement('webview', {
    ref: setRef,
    className: 'browser-webview',
    src: initial.current.src,
    partition: initial.current.partition,
    webpreferences: 'sandbox=yes,contextIsolation=yes,nodeIntegration=no,webSecurity=yes',
    style,
  });
};

export const BrowserSurface: React.FC<{
  pages: BrowserPageInfo[];
  rects: Record<string, BrowserSurfaceRect>;
  dragging: boolean;
  onFocusPage: (pageId: string) => void;
}> = ({ pages, rects, dragging, onFocusPage }) => (
  <div className={`browser-surface-layer ${dragging ? 'dragging' : ''}`} aria-hidden>
    {pages
      .filter((page) => page.mode === 'shared')
      .map((page) => (
        <PersistentWebview
          key={page.pageId}
          page={page}
          rect={rects[page.pageId]}
          dragging={dragging}
          onFocusPage={onFocusPage}
        />
      ))}
  </div>
);
