/**
 * ChipApp — 잠긴 아바타의 컨트롤 창.
 *
 * 왜 별도 창인가:
 *
 *   잠긴 아바타는 클릭을 데스크톱으로 흘려보내야 한다 (그게 잠금의 뜻이다).
 *   그러려면 아바타 창이 입력 통과여야 하고, **입력이 통과하는 창은 자기
 *   잠금 해제 버튼을 담을 수 없다.**
 *
 *   예전에는 한 창 안에서 hover 로 입력을 되살렸다. 그 방식은 무너진다 —
 *   리눅스에서는 통과 창에 이벤트가 아예 안 오고, darwin/win32 에서도
 *   forward 되는 것은 이동 이벤트뿐이라 hover 감지와 클릭 사이의 IPC 왕복에서
 *   클릭이 사라진다. 사용자에게는 "버튼이 보이는데 눌리지 않는다" 가 된다.
 *
 *   그래서 컨트롤을 자기 창에 둔다. 이 창은 언제나 인터랙티브다 — 플랫폼
 *   분기도, hover 곡예도, 놓치는 클릭도 없다.
 *
 * 이 창은 아바타 창 바닥 가운데를 따라다닌다 (위치는 main 이 정한다).
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { xgen } from '../bridge';
import { LockIcon, VoiceButtons, useVoiceControls } from './ActionBar';

export function ChipApp(): React.ReactElement {
  const voice = useVoiceControls();
  const barRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  // 창을 내용에 맞춘다. 버튼 수가 STT/TTS 가용성에 따라 달라지므로 고정 크기로
  // 두면 잘리거나(작을 때), 투명 영역이 클릭을 먹는다(클 때).
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const report = (): void => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        xgen.overlay.reportChipSize(Math.ceil(r.width), Math.ceil(r.height));
      }
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [voice.sttAvailable, voice.ttsAvailable]);

  // 잠금이 풀리면 main 이 이 창을 숨긴다 — 여기서는 아무것도 하지 않는다.
  // (상태를 두 곳에서 들면 어긋난다.)
  const unlock = useCallback(() => xgen.overlay.setLocked(false), []);

  // 컨트롤 바를 끌면 아바타가 따라 움직인다. 잠긴 상태에서도 위치는 바꿀 수
  // 있어야 한다 — 아바타가 가리는 곳에 있을 때 잠금을 풀었다 다시 잠그게
  // 만들 이유가 없다.
  const onDrag = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return; // 버튼 클릭은 드래그가 아니다
    e.preventDefault();
    dragging.current = true;
    const move = (ev: MouseEvent): void => {
      if (!dragging.current) return;
      xgen.overlay.moveBy(ev.movementX, ev.movementY);
    };
    const up = (): void => {
      dragging.current = false;
      xgen.overlay.commitBounds();
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, []);

  useEffect(() => {
    // 이 창은 항상 잠금 상태에서만 보인다 — 그래도 main 이 상태를 바꾸면
    // 버튼 아이콘이 즉시 따라야 한다 (닫히기 전 한 프레임).
    return xgen.overlay.onLocked(() => undefined);
  }, []);

  return (
    <div className="ov-chipwin">
      <div className="ov-lockchip" ref={barRef} onMouseDown={onDrag} title="드래그하여 이동">
        <VoiceButtons voice={voice} />
        <button className="ov-icon-btn" onClick={unlock} title="잠금 해제 — 아바타 이동·크기 조절">
          <LockIcon open={false} />
        </button>
      </div>
    </div>
  );
}
