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

export const sessionStore = new SessionStore({
  stream: (req, onEvent) => xgen.chat.stream(req, onEvent),
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
