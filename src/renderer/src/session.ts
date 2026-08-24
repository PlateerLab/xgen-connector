/**
 * The renderer's single SessionStore instance + a React subscription hook.
 *
 * Kept separate from `session-store.ts` so the store class stays free of the
 * Electron bridge (window.xgen) and can be unit-tested under node. Only this
 * module touches the bridge.
 */
import { useSyncExternalStore } from 'react';
import { xgen } from './bridge';
import { SessionStore, type StoreSnapshot } from './session-store';
import { browserStateStore } from './browser-state';
import { teamsContextStore } from './teams-context';

export const sessionStore = new SessionStore({
  // 컨텍스트 봉투는 **바깥쪽이 브라우저**가 되도록 겹친다. 히스토리를 다시 읽을 때
  // 벗기는 순서(`session-store.ts`: browser → teams)와 짝이 맞아야 한다.
  stream: (req, onEvent) =>
    xgen.chat.stream(
      browserStateStore.contextualize(teamsContextStore.contextualize(req)),
      onEvent,
    ),
  historyTurns: (workflowId, interactionId, name) =>
    xgen.history.turns(workflowId, interactionId, name),
});

/** Subscribe a component to the whole session snapshot. */
export function useSessions(): StoreSnapshot {
  return useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.getSnapshot,
    sessionStore.getSnapshot,
  );
}
