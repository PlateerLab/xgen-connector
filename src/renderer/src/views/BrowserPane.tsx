import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  resolveBrowserAddress,
  type BrowserAddressSearchConfig,
  type BrowserPageInfo,
  type BrowserPopupDecision,
} from '../../../core/browser';
import { xgen } from '../bridge';
import { useBrowserState } from '../browser-state';
import {
  BackIcon,
  BrowserIcon,
  CloseIcon,
  ForwardIcon,
  PopupBlockedIcon,
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
  addressSearch?: BrowserAddressSearchConfig;
  onSurface: (pageId: string, rect: BrowserSurfaceRect | null) => void;
}> = ({ workflowId, workflowName, addressSearch, onSurface }) => {
  const state = useBrowserState();
  const pages = useMemo(
    () => state.pages.filter((page) => page.workflowId === workflowId && page.mode === 'shared'),
    [state.pages, workflowId],
  );
  const preferred = state.activeByWorkflow[workflowId];
  const active = pages.find((page) => page.pageId === preferred) ?? pages[0] ?? null;
  const [address, setAddress] = useState(active?.url ?? '');
  const [navigationError, setNavigationError] = useState('');
  const [popupExpanded, setPopupExpanded] = useState(false);
  const [popupBusy, setPopupBusy] = useState<BrowserPopupDecision | null>(null);
  const [popupError, setPopupError] = useState('');
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const popupRequests = useMemo(
    () => state.popupRequests.filter((request) => request.pageId === active?.pageId),
    [active?.pageId, state.popupRequests],
  );
  const popupRequest = popupRequests[0] ?? null;

  useEffect(() => {
    if (!state.enabled || pages.length) return;
    void xgen.browser.ensureShared(workflowId, workflowName);
  }, [state.enabled, pages.length, workflowId, workflowName]);

  useEffect(() => {
    setAddress(active?.url ?? '');
    setNavigationError('');
    setPopupExpanded(false);
    setPopupError('');
  }, [active?.pageId, active?.url]);

  useEffect(() => {
    if (popupRequest) return;
    setPopupExpanded(false);
    setPopupError('');
  }, [popupRequest]);

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
    async (action: 'goto' | 'back' | 'forward' | 'reload' | 'stop', url?: string) => {
      if (!active) return;
      setNavigationError('');
      try {
        await xgen.browser.navigate({ pageId: active.pageId, action, url });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setNavigationError(detail || '페이지를 열지 못했습니다.');
      }
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

  const resolvePopup = useCallback(
    async (decision: BrowserPopupDecision) => {
      if (!popupRequest || popupBusy) return;
      setPopupBusy(decision);
      setPopupError('');
      try {
        const handled = await xgen.browser.resolvePopup({
          requestId: popupRequest.requestId,
          decision,
        });
        if (!handled) setPopupError('팝업 요청이 만료되었거나 페이지가 변경되었습니다.');
        setPopupExpanded(false);
      } catch (error) {
        setPopupError(error instanceof Error ? error.message : String(error));
      } finally {
        setPopupBusy(null);
      }
    },
    [popupBusy, popupRequest],
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
          const target = resolveBrowserAddress(address, addressSearch);
          if (!target) {
            setNavigationError(
              addressSearch?.enabled
                ? '올바른 http/https 주소 또는 검색어를 입력해 주세요.'
                : '올바른 http/https 주소를 입력해 주세요. 주소창 검색은 설정에서 켤 수 있습니다.',
            );
            return;
          }
          void navigate('goto', target);
        }}
      >
        <button
          type="button"
          disabled={!active?.canGoBack}
          aria-label="뒤로"
          onClick={() => void navigate('back')}
        >
          <BackIcon size={15} />
        </button>
        <button
          type="button"
          disabled={!active?.canGoForward}
          aria-label="앞으로"
          onClick={() => void navigate('forward')}
        >
          <ForwardIcon size={15} />
        </button>
        <button
          type="button"
          aria-label={active?.loading === 'loading' ? '중지' : '새로고침'}
          onClick={() => void navigate(active?.loading === 'loading' ? 'stop' : 'reload')}
        >
          {active?.loading === 'loading' ? <StopIcon size={13} /> : <RefreshIcon size={15} />}
        </button>
        <input
          value={address}
          onChange={(event) => {
            setAddress(event.target.value);
            setNavigationError('');
          }}
          aria-label="주소"
          spellCheck={false}
          placeholder={addressSearch?.enabled ? 'URL 또는 검색어 입력' : 'URL 입력'}
        />
      </form>
      {popupRequest && (
        <div className="browser-popup-notice" role="alert">
          <button
            type="button"
            className="browser-popup-summary"
            aria-expanded={popupExpanded}
            onClick={() => setPopupExpanded((expanded) => !expanded)}
          >
            <PopupBlockedIcon size={15} />
            <span>
              <strong>{popupRequest.openerOrigin}</strong>에서 팝업을 차단했습니다.
              {popupRequests.length > 1 ? ` (${popupRequests.length}개)` : ''}
            </span>
            <span className="browser-popup-configure">{popupExpanded ? '닫기' : '설정'}</span>
          </button>
          {popupExpanded && (
            <div className="browser-popup-detail">
              <div className="browser-popup-target" title={popupRequest.targetDisplayUrl}>
                대상: {popupRequest.targetDisplayUrl}
              </div>
              <div className="browser-popup-actions">
                <button
                  type="button"
                  disabled={popupBusy !== null}
                  onClick={() => void resolvePopup('allow_always')}
                >
                  항상 허용
                </button>
                <button
                  type="button"
                  disabled={popupBusy !== null}
                  onClick={() => void resolvePopup('allow_session')}
                >
                  이번 세션만
                </button>
                <button
                  type="button"
                  disabled={popupBusy !== null}
                  onClick={() => void resolvePopup('block')}
                >
                  계속 차단
                </button>
              </div>
              {popupError && <div className="browser-popup-error">{popupError}</div>}
            </div>
          )}
        </div>
      )}
      {navigationError && <div className="browser-error">{navigationError}</div>}
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
