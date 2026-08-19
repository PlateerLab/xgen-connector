/** IPC channel names shared by main and preload. */
export const CHANNELS = {
  configGet: 'config:get',
  configSet: 'config:set',
  configChanged: 'config:changed',

  authLogin: 'auth:login',
  authSsoLogin: 'auth:ssoLogin',
  authSsoComplete: 'auth:ssoComplete',
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
  // 잠금은 **main 이 소유한다** — 아바타 창과 컨트롤 창이 서로 다르게 알고
  // 있으면 안 된다. 두 창 모두 여기서 상태를 받고, 토글도 여기로 보낸다.
  overlaySetLocked: 'overlay:setLocked', // chip/overlay → main (잠금 토글)
  overlayGetLocked: 'overlay:getLocked', // 창 → main (첫 렌더용 초기값)
  overlayLocked: 'overlay:locked', // main → 두 창 (broadcast)
  overlayChipSize: 'overlay:chipSize', // chip → main (실측 크기)
  overlayChipInset: 'overlay:chipInset', // main → overlay (자막을 들어 올릴 높이)

  // 화면 캡처 — 채팅을 보낼 때 지금 화면을 함께 보낸다.
  captureListSources: 'capture:listSources', // 설정 화면의 대상 선택
  captureScreen: 'capture:screen', // 한 장 찍기
  captureAccessStatus: 'capture:accessStatus', // macOS 화면 기록 권한 상태

  // Window / app management (tray, autostart, reset, restart)
  openSettingsModal: 'app:openSettingsModal', // main → main-window (open settings modal)
  autostartGet: 'app:autostartGet',
  autostartSet: 'app:autostartSet',
  resetPositions: 'app:resetPositions',
  resetSettings: 'app:resetSettings',
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
  mcpTestProgressEvent: 'mcp:testProgress',
  mcpRefresh: 'mcp:refresh',
  mcpRuntimeLogs: 'mcp:runtimeLogs',
  mcpClearRuntimeLogs: 'mcp:clearRuntimeLogs',
  mcpRuntimeLogEvent: 'mcp:runtimeLogEvent',
  mcpAuthorize: 'mcp:authorize',
  mcpOauthStatus: 'mcp:oauthStatus',
  mcpClearOauth: 'mcp:clearOauth',
  mcpRenameSecrets: 'mcp:renameSecrets',
  diagText: 'diag:text',
  diagCopy: 'diag:copy',
  workspaceStatus: 'workspace:status',
  workspaceStatusEvent: 'workspace:statusEvent',
  workspaceAttach: 'workspace:attach',
  workspaceDetach: 'workspace:detach',
  workspaceOpen: 'workspace:open',
  workspaceRoot: 'workspace:root',
  workspaceSetRoot: 'workspace:setRoot',
  workspaceSetEnabled: 'workspace:setEnabled',
  workspaceRemount: 'workspace:remount',
  workspaceRefresh: 'workspace:refresh',
  /** 연결된 에이전트 목록만 서버에서 다시 읽는다 (파일 캐시는 건드리지 않는다). */
  workspaceRefreshAgents: 'workspace:refresh-agents',
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

  // Workspace 동기화 (에이전트 workflow ↔ 로컬 폴더 Drive형 동기화)

  // 로그인 시크릿 저장 상태 (키체인/암호화 저장 불가 표면화)
  secureStorageStatus: 'secure:storageStatus',
} as const;
