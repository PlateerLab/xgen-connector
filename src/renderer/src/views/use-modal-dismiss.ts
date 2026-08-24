/**
 * 모달을 닫는 두 가지 방법을 한 곳에 모은다.
 *
 * 바깥 클릭은 이미 각 모달이 `<div className="modal-backdrop" onClick={onClose}>`
 * 로 처리하고 있었다(실측 확인). 빠져 있던 것은 **Esc** 다 — 키보드로 열고
 * 마우스로만 닫아야 하는 상태였다.
 *
 * 왜 훅인가 (래퍼 컴포넌트가 아니라):
 *   모달이 12곳에 흩어져 있고 각자 다른 레이아웃·클래스를 쓴다. 래퍼로 감싸면
 *   전부 뜯어야 하고 회귀 위험이 커진다. 훅은 한 줄만 추가하면 되고 마크업을
 *   건드리지 않는다.
 *
 * 리스너는 **capture 단계**에 건다. 모달 안의 입력창들이 자기 Esc 를 먼저
 * 처리하고 `stopPropagation` 하는 경우가 있어(답장 배너 취소 등), bubble 로
 * 걸면 그런 모달만 조용히 안 닫힌다.
 *
 * 여러 모달이 겹쳐 열려 있으면 **가장 나중에 열린 것 하나만** 닫는다. 전부
 * 닫아 버리면 "확인창을 취소했더니 뒤에 있던 설정창까지 사라지는" 일이 된다.
 */
import { useEffect, useRef } from 'react';

/** 열려 있는 모달들의 닫기 함수 — 마지막(맨 위)이 Esc 의 대상이다. */
const stack: Array<() => void> = [];

let wired = false;

function ensureListener(): void {
  if (wired) return;
  wired = true;
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || stack.length === 0) return;
      // IME 조합 중의 Esc 는 조합 취소다 — 모달을 닫으면 안 된다.
      if (e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      stack[stack.length - 1]?.();
    },
    true,
  );
}

/**
 * Esc 로 이 모달을 닫는다.
 *
 * `enabled` 를 false 로 주면 등록하지 않는다 — 조건부로 열리는 모달이
 * 닫혀 있는 동안 스택을 차지하지 않게 한다.
 */
export function useModalDismiss(onClose: () => void, enabled = true): void {
  // 콜백은 ref 로 들고 다닌다. 부모가 매 렌더 새 함수를 만들어도 스택 등록은
  // 한 번뿐이고, 호출 시점에는 항상 최신 것이 불린다 (클로저로 잡으면 첫
  // onClose 에 굳어 버려 나중 상태를 못 본다).
  const latest = useRef(onClose);
  latest.current = onClose;

  useEffect(() => {
    if (!enabled) return;
    ensureListener();
    const entry = (): void => latest.current();
    stack.push(entry);
    return () => {
      const i = stack.lastIndexOf(entry);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [enabled]);
}
