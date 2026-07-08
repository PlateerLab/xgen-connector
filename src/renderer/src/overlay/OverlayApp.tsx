/**
 * OverlayApp — the floating avatar space (Geny-style, faithful port of Geny's
 * /overlay page, WITHOUT TTS / STT / screen-capture).
 *
 * A transparent, frameless, always-on-top window that floats an AVATAR (an
 * extension point via AvatarSlot; a branded placeholder until one is registered)
 * with a visual-novel SPEECH BUBBLE that types out what the agent is saying.
 *
 * Lock model (default LOCKED):
 *   • Locked   → the OS window is click-through (setClickThrough(true)); only the
 *     small lock chip is interactive (hover re-enables input). The avatar can't
 *     be moved/resized — clicks pass through to the desktop behind.
 *   • Unlocked → the whole window captures input; a dashed resize frame (8
 *     edge/corner handles + "크기 조절") appears, and dragging the bar moves the
 *     window. Only lock + delete buttons live on the bar ("삭제 버튼만").
 *
 * Drag uses movementX/movementY → moveBy, and main uses setPosition (not
 * setBounds) so the window never grows on fractional-DPI displays (150% scaling).
 */
import React, { useEffect, useRef, useState } from 'react';
import { xgen } from '../bridge';
import type { OverlayState } from '../../../preload/index';
import { AvatarSlot, hasAvatarRenderer, type AvatarState } from '../avatar/AvatarSlot';
import { XgenMark } from '../brand/Logo';

const EMPTY: OverlayState = { workflowId: '', workflowName: '', streamingText: '', speaking: false };
const SUBTITLE_DISMISS_MS = 4000;

function LockIcon({ open }: { open: boolean }): React.ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d={open ? 'M7 11V7a5 5 0 0 1 9.9-1' : 'M7 11V7a5 5 0 0 1 10 0v4'} />
    </svg>
  );
}
function GripIcon(): React.ReactElement {
  return (
    <svg width="13" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      {[6, 12, 18].map((cy) => (
        <g key={cy}>
          <circle cx="9" cy={cy} r="1.7" />
          <circle cx="15" cy={cy} r="1.7" />
        </g>
      ))}
    </svg>
  );
}
function TrashIcon(): React.ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

// Speech bubble — types out the streaming reply; auto-hides after it settles.
function Subtitle({ text, speaking }: { text: string; speaking: boolean }): React.ReactElement | null {
  const [visible, setVisible] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const full = text.trim();

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [text]);

  useEffect(() => {
    if (!full) {
      setVisible(false);
      return;
    }
    setVisible(true);
    if (timer.current) clearTimeout(timer.current);
    if (!speaking) timer.current = setTimeout(() => setVisible(false), SUBTITLE_DISMISS_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [full, speaking]);

  if (!full) return null;
  return (
    <div className="ov-subtitle-wrap">
      <div className={`ov-subtitle ${visible ? 'show' : ''}`} ref={bodyRef}>
        {text}
        {speaking && <span className="cursor" />}
      </div>
    </div>
  );
}

const RESIZE_HANDLES: { edge: string; className: string }[] = [
  { edge: 'n', className: 'ov-rh n' },
  { edge: 's', className: 'ov-rh s' },
  { edge: 'w', className: 'ov-rh w' },
  { edge: 'e', className: 'ov-rh e' },
  { edge: 'nw', className: 'ov-rh nw' },
  { edge: 'ne', className: 'ov-rh ne' },
  { edge: 'sw', className: 'ov-rh sw' },
  { edge: 'se', className: 'ov-rh se' },
];

function ResizeFrame(): React.ReactElement {
  const start = (edge: string) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* optional */
    }
    const onMove = (ev: PointerEvent) => xgen.overlay.resizeBy(edge, ev.movementX, ev.movementY);
    const onUp = (ev: PointerEvent) => {
      try {
        el.releasePointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  return (
    <div className="ov-resize-frame">
      <div className="ov-resize-label">크기 조절</div>
      {RESIZE_HANDLES.map((h) => (
        <div key={h.edge} className={h.className} onPointerDown={start(h.edge)} />
      ))}
    </div>
  );
}

export function OverlayApp(): React.ReactElement {
  const [state, setState] = useState<OverlayState>(EMPTY);
  const [locked, setLocked] = useState(true);
  const [subtitles, setSubtitles] = useState(true);
  const dragging = useRef(false);
  const hasAvatar = hasAvatarRenderer();

  useEffect(() => xgen.overlay.onState((s) => setState(s)), []);

  useEffect(() => {
    xgen.config.get().then((c) => setSubtitles(c.subtitles !== false));
    return xgen.config.onChange((c) => setSubtitles(c.subtitles !== false));
  }, []);

  // Apply the lock state to the OS window: locked → click-through, unlocked →
  // the whole window captures input (so it can be dragged / resized).
  useEffect(() => {
    xgen.overlay.setClickThrough(locked);
  }, [locked]);

  // While locked, hovering the control re-enables input so it's clickable.
  const onBarEnter = () => {
    if (locked) xgen.overlay.setClickThrough(false);
  };
  const onBarLeave = () => {
    if (locked && !dragging.current) xgen.overlay.setClickThrough(true);
  };
  const onDrag = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    dragging.current = true;
    const onMove = (ev: MouseEvent) => xgen.overlay.moveBy(ev.movementX, ev.movementY);
    const onUp = () => {
      dragging.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      onBarLeave();
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
  const name = state.workflowName || 'XGEN';

  return (
    <div className="ov-root">
      <div className="ov-stage">
        {hasAvatar ? (
          <AvatarSlot state={avatarState} />
        ) : (
          <div className={`ov-placeholder ${state.speaking ? 'speaking' : ''}`}>
            <div className="ov-orb">
              <XgenMark height={44} variant="color" />
            </div>
            <div className="ov-name">{name}</div>
          </div>
        )}
        {subtitles && <Subtitle text={state.streamingText} speaking={state.speaking} />}
      </div>

      {!locked && <ResizeFrame />}

      {locked ? (
        <div className="ov-lockchip" onMouseEnter={onBarEnter} onMouseLeave={onBarLeave} onMouseDown={onDrag} title="드래그하여 이동">
          <button className="ov-icon-btn" onClick={() => setLocked(false)} title="잠금 해제">
            <LockIcon open={false} />
          </button>
        </div>
      ) : (
        <div className="ov-bar" onMouseEnter={onBarEnter} onMouseLeave={onBarLeave} onMouseDown={onDrag}>
          <span className="ov-grip" title="드래그하여 이동">
            <GripIcon />
          </span>
          <button className="ov-icon-btn" onClick={() => setLocked(true)} title="잠금">
            <LockIcon open />
          </button>
          <button className="ov-icon-btn danger" onClick={() => xgen.overlay.hide()} title="삭제">
            <TrashIcon />
          </button>
        </div>
      )}
    </div>
  );
}
