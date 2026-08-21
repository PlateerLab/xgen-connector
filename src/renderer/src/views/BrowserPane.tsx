import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BrowserPageInfo } from '../../../core/browser';
import { xgen } from '../bridge';
import { useBrowserState } from '../browser-state';
import {
  BackIcon,
  BrowserIcon,
  CloseIcon,
  ForwardIcon,
  PlusIcon,
  RefreshIcon,
  StopIcon,
} from '../brand/icons';

export interface BrowserSurfaceRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const BrowserPane: React.FC<{
  workflowId: string;
  workflowName: string;
  onSurface: (pageId: string, rect: BrowserSurfaceRect | null) => void;
}> = ({ workflowId, workflowName, onSurface }) => {
  const state = useBrowserState();
  const pages = useMemo(
    () => state.pages.filter((page) => page.workflowId === workflowId && page.mode === 'shared'),
    [state.pages, workflowId],
  );
  const preferred = state.activeByWorkflow[workflowId];
  const active = pages.find((page) => page.pageId === preferred) ?? pages[0] ?? null;
  const [address, setAddress] = useState(active?.url ?? '');
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!state.enabled || pages.length) return;
    void xgen.browser.ensureShared(workflowId, workflowName);
  }, [state.enabled, pages.length, workflowId, workflowName]);

  useEffect(() => setAddress(active?.url ?? ''), [active?.pageId, active?.url]);

  useEffect(() => {
    const element = surfaceRef.current;
    if (!element || !active) return;
    const report = () => {
      const rect = element.getBoundingClientRect();
      onSurface(active.pageId, {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      });
    };
    const observer = new ResizeObserver(report);
    observer.observe(element);
    window.addEventListener('resize', report);
    report();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', report);
      onSurface(active.pageId, null);
    };
  }, [active?.pageId, onSurface]);

  const navigate = useCallback(
    (action: 'goto' | 'back' | 'forward' | 'reload' | 'stop', url?: string) => {
      if (!active) return;
      void xgen.browser.navigate({ pageId: active.pageId, action, url }).catch(() => undefined);
    },
    [active],
  );

  const addPage = useCallback(() => {
    void xgen.browser
      .create({ workflowId, workflowName, mode: 'shared' })
      .then((page) => xgen.browser.activate(page.pageId));
  }, [workflowId, workflowName]);

  const closePage = useCallback(
    async (page: BrowserPageInfo) => {
      await xgen.browser.close(page.pageId);
      if (pages.length === 1) await xgen.browser.ensureShared(workflowId, workflowName);
    },
    [pages.length, workflowId, workflowName],
  );

  return (
    <div className="browser-pane">
      <div className="browser-page-tabs" role="tablist" aria-label="웹 페이지">
        {pages.map((page) => (
          <button
            key={page.pageId}
            role="tab"
            aria-selected={page.pageId === active?.pageId}
            className={`browser-page-tab ${page.pageId === active?.pageId ? 'active' : ''}`}
            onClick={() => void xgen.browser.activate(page.pageId)}
            title={page.title || page.url}
          >
            <BrowserIcon size={12} />
            <span>{page.title || '새 탭'}</span>
            {page.loading === 'loading' && <i className="browser-loading-dot" />}
            <span
              className="browser-page-close"
              role="button"
              aria-label="웹 페이지 닫기"
              onClick={(event) => {
                event.stopPropagation();
                void closePage(page);
              }}
            >
              <CloseIcon size={11} />
            </span>
          </button>
        ))}
        <button
          className="browser-page-add"
          title="새 웹 페이지"
          aria-label="새 웹 페이지"
          onClick={addPage}
        >
          <PlusIcon size={14} />
        </button>
      </div>
      <form
        className="browser-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          navigate('goto', address);
        }}
      >
        <button
          type="button"
          disabled={!active?.canGoBack}
          aria-label="뒤로"
          onClick={() => navigate('back')}
        >
          <BackIcon size={15} />
        </button>
        <button
          type="button"
          disabled={!active?.canGoForward}
          aria-label="앞으로"
          onClick={() => navigate('forward')}
        >
          <ForwardIcon size={15} />
        </button>
        <button
          type="button"
          aria-label={active?.loading === 'loading' ? '중지' : '새로고침'}
          onClick={() => navigate(active?.loading === 'loading' ? 'stop' : 'reload')}
        >
          {active?.loading === 'loading' ? <StopIcon size={13} /> : <RefreshIcon size={15} />}
        </button>
        <input
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          aria-label="주소"
          spellCheck={false}
          placeholder="URL 입력"
        />
      </form>
      {active?.error && <div className="browser-error">{active.error}</div>}
      <div ref={surfaceRef} className="browser-surface-anchor">
        {!state.enabled && <div className="browser-empty">설정에서 브라우저 접근을 켜 주세요.</div>}
        {state.enabled && !active && (
          <div className="browser-empty">브라우저 페이지를 준비하는 중…</div>
        )}
      </div>
    </div>
  );
};
