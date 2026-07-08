/** IPC channel names shared by main and preload. */
export const CHANNELS = {
  configGet: 'config:get',
  configSet: 'config:set',
  configChanged: 'config:changed',

  authLogin: 'auth:login',
  authRestore: 'auth:restore',
  authLogout: 'auth:logout',
  authStatus: 'auth:status',
  authFailed: 'auth:failed',

  agentsList: 'agents:list',

  historyTurns: 'history:turns',
  historyConversations: 'history:conversations',

  chatStart: 'chat:start',
  chatCancel: 'chat:cancel',
  chatEvent: 'chat:event',

  updaterCheck: 'updater:check',
  updaterGetEnabled: 'updater:getEnabled',
  updaterSetEnabled: 'updater:setEnabled',
  updaterMessage: 'updater:message',

  // Floating avatar overlay (Geny-style)
  overlayGetEnabled: 'overlay:getEnabled',
  overlaySetEnabled: 'overlay:setEnabled',
  overlayPushState: 'overlay:pushState', // main-window → main → overlay
  overlayState: 'overlay:state', // main → overlay (broadcast)
  overlaySetIgnoreMouse: 'overlay:setIgnoreMouse', // overlay → main (click-through)
  overlayMoveBy: 'overlay:moveBy', // overlay → main (drag)
  overlayFocusMain: 'overlay:focusMain', // overlay → main (raise chat window)
  overlayHide: 'overlay:hide', // overlay → main (close the space)

  openExternal: 'shell:openExternal',
} as const;
