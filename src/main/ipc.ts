/** IPC channel names shared by main and preload. */
export const CHANNELS = {
  configGet: 'config:get',
  configSet: 'config:set',
  configChanged: 'config:changed',

  authLogin: 'auth:login',
  authRestore: 'auth:restore',
  authAutoLogin: 'auth:autoLogin', // launch: sign in with saved credentials
  authLoginPrefill: 'auth:loginPrefill', // login form: remembered email + autoLogin flag
  authLogout: 'auth:logout',
  authStatus: 'auth:status',
  authFailed: 'auth:failed',

  userAvatarConfig: 'user:avatarConfig', // renderer → main → GET /api/admin/user preferences.avatar
  userSaveAvatarConfig: 'user:saveAvatarConfig', // overlay adjusts scale/position → PUT
  userSaveAvatarTransform: 'user:saveAvatarTransform', // per-avatar transform patch (read-modify-write)
  // 아바타 설정 뷰 (등록/이름/선택/삭제 + 스토어) — 전부 main 의 XgenClient 경유
  avatarUploadAsset: 'avatar:uploadAsset',
  avatarDeleteAsset: 'avatar:deleteAsset',
  avatarSetEnabled: 'avatar:setEnabled',
  avatarSelect: 'avatar:select',
  avatarRename: 'avatar:rename',
  avatarAdd: 'avatar:add',
  avatarRemove: 'avatar:remove',
  avatarStoreList: 'avatar:store:list',
  avatarStorePublish: 'avatar:store:publish',
  avatarStoreDownload: 'avatar:store:download',
  avatarStoreRate: 'avatar:store:rate',
  avatarStoreUnpublish: 'avatar:store:unpublish',
  avatarRefresh: 'avatar:refresh', // main → overlay (auth ready / config changed → refetch now)

  agentsList: 'agents:list',

  // Voice (STT/TTS) — renderer captures audio, main proxies to the backend
  // (secrets stay server-side). Audio crosses IPC as Uint8Array + mime.
  voiceConfig: 'voice:config', // GET /api/admin/user → preferences.stt/tts (hints)
  voiceTranscribe: 'voice:transcribe', // audio bytes → POST /api/audio/stt/transcribe → text
  voiceSpeak: 'voice:speak', // text → POST /api/audio/tts/speak → audio bytes

  historyTurns: 'history:turns',
  historyConversations: 'history:conversations',

  chatStart: 'chat:start',
  chatCancel: 'chat:cancel',
  chatEvent: 'chat:event',

  updaterCheck: 'updater:check',
  updaterGetEnabled: 'updater:getEnabled',
  updaterSetEnabled: 'updater:setEnabled',
  updaterMessage: 'updater:message',
  appVersion: 'app:version',

  // Floating avatar overlay (Geny-style)
  overlayGetEnabled: 'overlay:getEnabled',
  overlaySetEnabled: 'overlay:setEnabled',
  overlayPushState: 'overlay:pushState', // main-window → main → overlay
  overlayState: 'overlay:state', // main → overlay (broadcast)
  overlaySetIgnoreMouse: 'overlay:setIgnoreMouse', // overlay → main (click-through)
  overlayMoveBy: 'overlay:moveBy', // overlay → main (drag; DPI-safe setPosition)
  overlayResizeBy: 'overlay:resizeBy', // overlay → main (edge resize)
  overlayCommitBounds: 'overlay:commitBounds', // overlay → main (drag/resize END → persist now)
  overlayFocusMain: 'overlay:focusMain', // overlay → main (raise chat window)
  overlayOpenSettings: 'overlay:openSettings', // overlay → main (raise + open settings modal)
  overlayHide: 'overlay:hide', // overlay → main (close the space)

  // Window / app management (tray, autostart, reset, restart)
  openSettingsModal: 'app:openSettingsModal', // main → main-window (open settings modal)
  autostartGet: 'app:autostartGet',
  autostartSet: 'app:autostartSet',
  resetPositions: 'app:resetPositions',
  appRestart: 'app:restart',
  appQuit: 'app:quit',

  // Hotkeys
  quickChatSetHotkey: 'quickchat:setHotkey',
  hotkeyPause: 'hotkey:pause', // suspend global shortcuts while recording
  hotkeyResume: 'hotkey:resume',

  // Local MCP (connector-hosted MCP servers bridged to the user's agents)
  mcpGetEnabled: 'mcp:getEnabled',
  mcpSetEnabled: 'mcp:setEnabled',
  mcpListServers: 'mcp:listServers',
  mcpSaveServers: 'mcp:saveServers',
  mcpTestServer: 'mcp:testServer',
  mcpStatus: 'mcp:status',
  mcpStatusEvent: 'mcp:statusEvent',

  // Quick-chat (Spotlight-style input bar, global hotkey)
  quickChatGetEnabled: 'quickchat:getEnabled',
  quickChatSetEnabled: 'quickchat:setEnabled',
  quickChatGetHotkey: 'quickchat:getHotkey',
  quickChatSubmit: 'quickchat:submit', // quickchat window → main
  quickChatClose: 'quickchat:close', // quickchat window → main
  quickChatOpened: 'quickchat:opened', // main → quickchat (paint card)
  quickChatDismissed: 'quickchat:dismissed', // main → quickchat (hide card)
  quickSend: 'connector:quickSend', // main → main-window Chat (deliver message)

  openExternal: 'shell:openExternal',
} as const;
