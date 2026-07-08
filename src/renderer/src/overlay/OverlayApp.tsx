/**
 * OverlayApp — the floating avatar space (Geny-style).
 *
 * A transparent, frameless, always-on-top, click-through window. It floats the
 * avatar (an extension point via AvatarSlot) plus a live subtitle of the active
 * chat stream. When NO avatar renderer is registered it shows just the streaming
 * reply as a floating card ("아바타가 없으면 채팅만"). Mirrors geny-connector's
 * OverlayApp — WITHOUT TTS / STT / screen-capture.
 *
 * Click-through model: the OS window ignores the mouse everywhere; entering the
 * card flips click-through off (interactive), leaving flips it back on. The
 * top handle drags the window via the native bridge.
 */
import React, { useEffect, useRef, useState } from 'react';
import { xgen } from '../bridge';
import type { OverlayState } from '../../../preload/index';
import { AvatarSlot, hasAvatarRenderer, type AvatarState } from '../avatar/AvatarSlot';
import { XgenMark } from '../brand/Logo';
import { PanelLeftIcon } from '../brand/icons';

const EMPTY: OverlayState = { workflowId: '', workflowName: '', streamingText: '', speaking: false };

export function OverlayApp(): React.ReactElement {
  const [state, setState] = useState<OverlayState>(EMPTY);
  const dragging = useRef<{ x: number; y: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const hasAvatar = hasAvatarRenderer();

  useEffect(() => xgen.overlay.onState((s) => setState(s)), []);

  // Auto-scroll the reply as it streams.
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [state.streamingText]);

  // Click-through: interactive only while the pointer is over the card.
  const enterInteractive = () => xgen.overlay.setClickThrough(false);
  const leaveInteractive = () => {
    if (!dragging.current) xgen.overlay.setClickThrough(true);
  };

  const onHandleDown = (e: React.MouseEvent) => {
    dragging.current = { x: e.screenX, y: e.screenY };
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const dx = ev.screenX - dragging.current.x;
      const dy = ev.screenY - dragging.current.y;
      dragging.current = { x: ev.screenX, y: ev.screenY };
      xgen.overlay.moveBy(dx, dy);
    };
    const onUp = () => {
      dragging.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      leaveInteractive();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const avatarState: AvatarState = {
    workflowId: state.workflowId,
    workflowName: state.workflowName,
    streamingText: state.streamingText,
    speaking: state.speaking,
  };
  const title = state.workflowName || 'XGEN';
  const hasReply = !!state.streamingText.trim();

  return (
    <div className="overlay-root">
      <div className="ov-card" onMouseEnter={enterInteractive} onMouseLeave={leaveInteractive}>
        {/* Drag handle + controls */}
        <div className="ov-handle" onMouseDown={onHandleDown} title="드래그하여 이동">
          <span className="ov-brand">
            <XgenMark height={15} variant="color" />
            <span className="ov-title">{title}</span>
            {state.speaking && <span className="ov-live">● LIVE</span>}
          </span>
          <span className="ov-actions">
            <button
              className="ov-btn"
              title="채팅 창 열기"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => xgen.overlay.focusMain()}
            >
              <PanelLeftIcon size={14} />
            </button>
            <button
              className="ov-btn"
              title="아바타 닫기"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => xgen.overlay.hide()}
            >
              ✕
            </button>
          </span>
        </div>

        {/* Avatar stage (if a renderer is registered) */}
        {hasAvatar && (
          <div className="ov-avatar-stage">
            <AvatarSlot state={avatarState} />
          </div>
        )}

        {/* Live subtitle / reply — the "채팅만" fallback when no avatar */}
        <div className={`ov-body ${hasAvatar ? 'as-subtitle' : ''}`} ref={bodyRef}>
          {hasReply ? (
            <div className="ov-reply">
              {state.streamingText}
              {state.speaking && <span className="cursor" />}
            </div>
          ) : (
            <div className="ov-idle">
              {state.speaking ? (
                <span className="ov-dots">
                  <i /> <i /> <i />
                </span>
              ) : (
                <span>대화를 시작하면 여기에 표시됩니다.</span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
