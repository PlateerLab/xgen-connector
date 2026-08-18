import React, { useEffect, useState } from 'react';
import { xgen } from '../bridge';
import type { ConnectorConfig } from '../../../main/config';
import { HotkeyCapture } from './HotkeyCapture';
import { McpSettings } from './McpSettings';
import { SyncSettings } from './SyncSettings';
import { VoiceSettings } from './VoiceSettings';
import { MonitorIcon, ServerIcon, RefreshIcon, SpeakerIcon } from '../brand/icons';

type Theme = NonNullable<ConnectorConfig['theme']>;

// 비슷한 기능끼리 탭으로 묶는다 — 세로로만 길어지던 설정을 폭을 넓혀 분류한다.
type Tab = 'connection' | 'general' | 'avatar' | 'local' | 'storage' | 'updates';
const TABS: { id: Tab; label: string }[] = [
  { id: 'connection', label: '연결' },
  { id: 'general', label: '일반' },
  { id: 'avatar', label: '아바타' },
  { id: 'local', label: '로컬 도구' },
  { id: 'storage', label: '스토리지' },
  { id: 'updates', label: '업데이트' },
];

export const Settings: React.FC<{
  config: ConnectorConfig;
  onClose: () => void;
  onChanged: () => Promise<ConnectorConfig>;
}> = ({ config, onClose, onChanged }) => {
  const [tab, setTab] = useState<Tab>('connection');
  const [serverUrl, setServerUrl] = useState(config.serverUrl);
  const [allowPrivateCertificate, setAllowPrivateCertificate] = useState(config.allowPrivateCertificate ?? false);
  const [ssoEnabled, setSsoEnabled] = useState(config.ssoEnabled ?? false);
  const [ssoPath, setSsoPath] = useState(config.ssoPath ?? '/sso/signin');
  const [theme, setTheme] = useState<Theme>(config.theme ?? 'system');
  const [autoUpdate, setAutoUpdate] = useState(config.autoUpdate ?? true);
  const [updateServer, setUpdateServer] = useState<'github' | 'xgen'>(config.updateServer ?? 'github');
  const [overlay, setOverlay] = useState(config.avatarOverlay ?? false);
  const [subtitles, setSubtitles] = useState(config.subtitles !== false);
  const [charMs, setCharMs] = useState(config.subtitleCharMs ?? 50);
  const [subtitleSize, setSubtitleSize] = useState<'sm' | 'md' | 'lg'>(config.subtitleSize ?? 'sm');
  const [quickChat, setQuickChat] = useState(config.quickChat ?? false);
  const [hotkey, setHotkey] = useState('Control+Shift+/');
  const [autostart, setAutostart] = useState(false);
  const [autostartRefused, setAutostartRefused] = useState(false);
  const [linuxClickThrough, setLinuxClickThrough] = useState(config.linuxClickThrough ?? false);
  const isLinux = /linux/i.test(navigator.userAgent) && !/android/i.test(navigator.userAgent);

  // ── 로컬 셸 접근 (기본 ON) ──
  const ls = config.localShell ?? {};
  const [shellOn, setShellOn] = useState(ls.enabled !== false);
  const [shellCwd, setShellCwd] = useState(ls.cwd ?? '');
  const [shellTimeoutS, setShellTimeoutS] = useState(Math.round((ls.timeoutMs ?? 120_000) / 1000));
  const [shellBlocked, setShellBlocked] = useState((ls.blocked ?? []).join(', '));

  const [resetDone, setResetDone] = useState(false);
  const [confirmSettingsReset, setConfirmSettingsReset] = useState(false);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const [version, setVersion] = useState('');
  const [checking, setChecking] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showMcp, setShowMcp] = useState(false);
  const [showVoice, setShowVoice] = useState(false);
  const [showSync, setShowSync] = useState(false);

  // Any status message means the check is underway/done → drop the button spinner
  // (the message line then shows progress like "내려받는 중… 45%").
  useEffect(() => xgen.updater.onMessage((m) => {
    setUpdateMsg(m);
    if (!/^업데이트 확인 중/.test(m)) setChecking(false);
  }), []);
  useEffect(() => {
    xgen.quickChat.getHotkey().then(setHotkey).catch(() => undefined);
    xgen.appctl.getAutostart().then(setAutostart).catch(() => undefined);
    xgen.updater.getVersion().then(setVersion).catch(() => undefined);
  }, []);

  const changeHotkey = async (acc: string) => {
    const ok = await xgen.quickChat.setHotkey(acc);
    if (ok) setHotkey(acc);
    else xgen.quickChat.getHotkey().then(setHotkey).catch(() => undefined);
  };

  const apply = async (patch: Partial<ConnectorConfig>) => {
    await xgen.config.set(patch);
    await onChanged();
  };

  // 셸 설정은 여러 필드가 하나의 localShell 객체를 이룬다 — 저장 시점의 상태를
  // 통째로 쓰되, 방금 바꾼 필드는 override 로 즉시 반영한다.
  const commitShell = (over: Partial<{ enabled: boolean; cwd: string; timeoutS: number; blocked: string }> = {}) => {
    const enabled = over.enabled ?? shellOn;
    const cwd = (over.cwd ?? shellCwd).trim();
    const timeoutS = Math.max(1, Math.round(over.timeoutS ?? shellTimeoutS));
    const blocked = (over.blocked ?? shellBlocked)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    void apply({ localShell: { enabled, cwd: cwd || undefined, timeoutMs: timeoutS * 1000, blocked } });
  };

  // 서버 주소 변경은 세션 전환 — 첫 클릭에서 로그아웃 안내를 띄우고,
  // 두 번째 클릭(변경 및 로그아웃)에서 적용한다. 적용되면 main 이 세션을
  // 정리하고 authFailed 를 쏘아 로그인 화면으로 돌아간다.
  const [confirmServer, setConfirmServer] = useState(false);
  const saveServer = async () => {
    const next = serverUrl.trim().replace(/\/+$/, '');
    if (!next) return;
    const nextSsoPath = ssoPath.trim() || '/sso/signin';
    if (ssoEnabled && (!nextSsoPath.startsWith('/') || nextSsoPath.startsWith('//'))) return;
    const serverChanged = next !== (config.serverUrl ?? '');
    const optionsChanged =
      allowPrivateCertificate !== (config.allowPrivateCertificate ?? false) ||
      ssoEnabled !== (config.ssoEnabled ?? false) ||
      nextSsoPath !== (config.ssoPath ?? '/sso/signin');
    if (!serverChanged && !optionsChanged) {
      setConfirmServer(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      return;
    }
    if (serverChanged && !confirmServer) {
      setConfirmServer(true);
      return;
    }
    await apply({
      serverUrl: next,
      allowPrivateCertificate,
      ssoEnabled,
      ssoPath: nextSsoPath,
    });
    setConfirmServer(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  if (showMcp) return <McpSettings onClose={() => setShowMcp(false)} />;
  if (showVoice) return <VoiceSettings onClose={() => setShowVoice(false)} />;
  if (showSync) return <SyncSettings onClose={() => setShowSync(false)} />;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>설정</h2>
          <button className="link" onClick={onClose}>
            닫기
          </button>
        </div>

        <div className="settings-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`settings-tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="settings-panel">
          {/* ─── 연결 ─── */}
          {tab === 'connection' && (
            <>
              <label className="field">
                <span>서버 주소</span>
                <div className="row">
                  <input
                    className="grow"
                    value={serverUrl}
                    onChange={(e) => {
                      setServerUrl(e.target.value);
                      setConfirmServer(false);
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && void saveServer()}
                  />
                  <button
                    className={confirmServer ? 'danger' : 'secondary'}
                    onClick={() => void saveServer()}
                  >
                    {confirmServer ? '변경 및 로그아웃' : saved ? '저장됨' : '저장'}
                  </button>
                </div>
                {confirmServer && (
                  <span className="small notice-warn">
                    서버 주소를 변경하면 현재 세션이 종료되고 새 서버에 다시 로그인해야
                    합니다. 계속하려면 버튼을 한 번 더 누르세요.
                  </span>
                )}
              </label>

              <label className="setup-option settings-option">
                <input
                  type="checkbox"
                  checked={allowPrivateCertificate}
                  onChange={(e) => setAllowPrivateCertificate(e.target.checked)}
                />
                <span>
                  사설 인증서 허용
                  <small>설정한 서버의 사설 CA 신뢰 오류만 허용합니다.</small>
                </span>
              </label>
              <label className="setup-option settings-option">
                <input
                  type="checkbox"
                  checked={ssoEnabled}
                  onChange={(e) => setSsoEnabled(e.target.checked)}
                />
                <span>SSO 로그인 사용</span>
              </label>
              {ssoEnabled && (
                <label className="field setup-nested-field settings-sso-path">
                  <span>SSO PATH</span>
                  <input
                    value={ssoPath}
                    onChange={(e) => setSsoPath(e.target.value)}
                    placeholder="/sso/signin"
                  />
                </label>
              )}
              <p className="settings-hint">
                사설 인증서·SSO 를 바꾼 뒤에는 위 <b>저장</b> 버튼을 눌러 적용하세요.
              </p>
            </>
          )}

          {/* ─── 일반 ─── */}
          {tab === 'general' && (
            <>
              <div className="field-row">
                <span>테마</span>
                <div className="seg">
                  {(['system', 'light', 'dark'] as const).map((t) => (
                    <button
                      key={t}
                      className={theme === t ? 'active' : ''}
                      onClick={() => {
                        setTheme(t);
                        void apply({ theme: t });
                      }}
                    >
                      {t === 'system' ? '시스템' : t === 'light' ? '라이트' : '다크'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field-row">
                <span>빠른 채팅 (단축키)</span>
                <div className="row">
                  {quickChat && <HotkeyCapture value={hotkey} onCapture={(a) => void changeHotkey(a)} />}
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={quickChat}
                      onChange={(e) => {
                        setQuickChat(e.target.checked);
                        void xgen.quickChat.setEnabled(e.target.checked);
                        void onChanged();
                      }}
                    />
                    <span className="track" />
                  </label>
                </div>
              </div>

              <div className="field-row">
                <span>
                  로그인 시 시작
                  {autostartRefused && (
                    <span className="small notice-warn" style={{ marginLeft: 8 }}>
                      등록 불가 — AppImage 를 고정 경로에 두고 다시 시도하세요
                    </span>
                  )}
                </span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={autostart}
                    onChange={(e) => {
                      const wanted = e.target.checked;
                      void xgen.appctl.setAutostart(wanted).then((effective) => {
                        setAutostart(effective);
                        setAutostartRefused(wanted && !effective);
                      });
                    }}
                  />
                  <span className="track" />
                </label>
              </div>

              {isLinux && (
                <div className="field-row">
                  <span>
                    오버레이 클릭 통과 (Linux)
                    <span className="small muted" style={{ marginLeft: 8 }}>
                      켜면 오버레이가 마우스에 완전히 투명해집니다 (상호작용 불가)
                    </span>
                  </span>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={linuxClickThrough}
                      onChange={(e) => {
                        setLinuxClickThrough(e.target.checked);
                        void apply({ linuxClickThrough: e.target.checked });
                      }}
                    />
                    <span className="track" />
                  </label>
                </div>
              )}

              <div className="field-row">
                <span>창 위치 초기화</span>
                <button
                  className="secondary"
                  onClick={() => {
                    xgen.appctl.resetPositions();
                    setResetDone(true);
                    setTimeout(() => setResetDone(false), 1500);
                  }}
                >
                  {resetDone ? '완료' : '초기화'}
                </button>
              </div>
            </>
          )}

          {/* ─── 아바타·자막 ─── */}
          {tab === 'avatar' && (
            <>
              <div className="field-row">
                <span>아바타 오버레이 (플로팅)</span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={overlay}
                    onChange={(e) => {
                      setOverlay(e.target.checked);
                      void xgen.overlay.setEnabled(e.target.checked);
                      void onChanged();
                    }}
                  />
                  <span className="track" />
                </label>
              </div>

              <div className="field-row">
                <span>말풍선 자막</span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={subtitles}
                    onChange={(e) => {
                      setSubtitles(e.target.checked);
                      void apply({ subtitles: e.target.checked });
                    }}
                  />
                  <span className="track" />
                </label>
              </div>

              <div className="field-row">
                <span>
                  자막 출력 속도
                  <span className="small muted" style={{ marginLeft: 8 }}>
                    {charMs >= 80 ? '느림' : charMs <= 30 ? '빠름' : '보통'}
                  </span>
                </span>
                <div className="seg">
                  {([['느림', 90], ['보통', 50], ['빠름', 25]] as const).map(([label, ms]) => (
                    <button
                      key={ms}
                      className={charMs === ms ? 'active' : ''}
                      onClick={() => {
                        setCharMs(ms);
                        void apply({ subtitleCharMs: ms });
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field-row">
                <span>
                  자막 창 크기
                  <span className="small muted" style={{ marginLeft: 8 }}>
                    {subtitleSize === 'sm' ? '3줄' : subtitleSize === 'md' ? '4~5줄' : '6~7줄'}
                  </span>
                </span>
                <div className="seg">
                  {([['작음', 'sm'], ['중간', 'md'], ['큼', 'lg']] as const).map(([label, sz]) => (
                    <button
                      key={sz}
                      className={subtitleSize === sz ? 'active' : ''}
                      onClick={() => {
                        setSubtitleSize(sz);
                        void apply({ subtitleSize: sz });
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 음성 — 아바타가 말하고 듣는 통로라 아바타 탭에 둔다. */}
              <div className="tool-card">
                <div className="tool-card-main">
                  <span className="tool-card-icon"><SpeakerIcon size={18} /></span>
                  <div className="tool-card-text">
                    <div className="tool-card-title">음성 (STT/TTS)</div>
                    <div className="tool-card-desc">
                      마이크 음성 입력과 답변 음성 출력. 입·출력 장치와 음성 프로필을 관리합니다.
                    </div>
                  </div>
                  <button className="secondary" onClick={() => setShowVoice(true)}>
                    관리
                  </button>
                </div>
              </div>
            </>
          )}

          {/* ─── 로컬 도구 ─── */}
          {tab === 'local' && (
            <>
              <div className="tool-card">
                <div className="tool-card-main">
                  <span className="tool-card-icon"><MonitorIcon size={18} /></span>
                  <div className="tool-card-text">
                    <div className="tool-card-title">로컬 셸 접근</div>
                    <div className="tool-card-desc">
                      에이전트가 이 PC 의 셸(PowerShell/bash)로 명령을 실행할 수 있게 합니다.
                      앱 실행·파일 조작 등 "내 컴퓨터"를 직접 다루는 요청이 가능해집니다.
                    </div>
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={shellOn}
                      onChange={(e) => {
                        setShellOn(e.target.checked);
                        commitShell({ enabled: e.target.checked });
                      }}
                    />
                    <span className="track" />
                  </label>
                </div>

                {shellOn && (
                  <div className="tool-card-body">
                    <label className="field">
                      <span>기본 작업 폴더 <span className="small muted">(비우면 홈 디렉터리)</span></span>
                      <input
                        value={shellCwd}
                        placeholder="예: /home/me/projects 또는 C:\\Users\\me"
                        onChange={(e) => setShellCwd(e.target.value)}
                        onBlur={() => commitShell()}
                      />
                    </label>
                    <div className="field-row">
                      <span>명령 시간 제한 <span className="small muted">(초)</span></span>
                      <input
                        type="number"
                        min={1}
                        max={3600}
                        className="num-input"
                        value={shellTimeoutS}
                        onChange={(e) => setShellTimeoutS(Number(e.target.value) || 120)}
                        onBlur={() => commitShell()}
                      />
                    </div>
                    <label className="field">
                      <span>차단할 명령 <span className="small muted">(쉼표로 구분, 첫 단어 기준)</span></span>
                      <input
                        value={shellBlocked}
                        placeholder="예: rm, shutdown, format"
                        onChange={(e) => setShellBlocked(e.target.value)}
                        onBlur={() => commitShell()}
                      />
                    </label>
                    <p className="settings-hint warn">
                      ⚠ 이 도구는 로그인한 사용자 권한으로 명령을 실행합니다. 실행 내역은
                      채팅의 도구 로그에 남으며, 위 차단 목록은 편의를 위한 가드일 뿐
                      보안 경계가 아닙니다.
                    </p>
                  </div>
                )}
              </div>

              <div className="tool-card">
                <div className="tool-card-main">
                  <span className="tool-card-icon"><ServerIcon size={18} /></span>
                  <div className="tool-card-text">
                    <div className="tool-card-title">로컬 MCP</div>
                    <div className="tool-card-desc">
                      내 PC 에서 호스팅하는 MCP 서버의 도구를 에이전트에 연결합니다.
                    </div>
                  </div>
                  <button className="secondary" onClick={() => setShowMcp(true)}>
                    관리
                  </button>
                </div>
              </div>
            </>
          )}

          {/* ─── 스토리지 ─── */}
          {tab === 'storage' && (
            <>
              <div className="tool-card">
                <div className="tool-card-main">
                  <span className="tool-card-icon"><RefreshIcon size={18} /></span>
                  <div className="tool-card-text">
                    <div className="tool-card-title">워크스페이스 동기화</div>
                    <div className="tool-card-desc">
                      로컬 폴더와 에이전트 워크스페이스를 양방향으로 동기화합니다
                      (Drive 형). 페어링·경로·동기화 상태를 관리합니다.
                    </div>
                  </div>
                  <button className="secondary" onClick={() => setShowSync(true)}>
                    관리
                  </button>
                </div>
              </div>
            </>
          )}

          {/* ─── 업데이트 ─── */}
          {tab === 'updates' && (
            <>
              <div className="field-row">
                <span>
                  업데이트 서버
                  {updateServer === 'xgen' && (
                    <span className="small muted" style={{ marginLeft: 8 }}>
                      설정된 XGEN 서버의 다운로드 센터
                    </span>
                  )}
                </span>
                <div className="seg">
                  {(['github', 'xgen'] as const).map((source) => (
                    <button
                      key={source}
                      className={updateServer === source ? 'active' : ''}
                      onClick={() => {
                        setUpdateServer(source);
                        void apply({ updateServer: source });
                      }}
                    >
                      {source === 'github' ? 'GitHub' : 'XGEN'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field-row">
                <span>자동 업데이트</span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={autoUpdate}
                    onChange={(e) => {
                      setAutoUpdate(e.target.checked);
                      void xgen.updater.setEnabled(e.target.checked);
                    }}
                  />
                  <span className="track" />
                </label>
              </div>

              <div className="field-row">
                <span>
                  업데이트
                  {version && (
                    <span className="small muted" style={{ marginLeft: 8 }}>
                      v{version}
                    </span>
                  )}
                </span>
                <div className="row">
                  {updateMsg && <span className="small muted">{updateMsg}</span>}
                  <button
                    className="secondary"
                    disabled={checking}
                    onClick={() => {
                      setChecking(true);
                      setUpdateMsg(null);
                      void xgen.updater.check();
                      setTimeout(() => setChecking(false), 25000);
                    }}
                  >
                    {checking ? '확인 중…' : '업데이트 확인'}
                  </button>
                </div>
              </div>

              <div className="field-row">
                <span>
                  저장된 설정 초기화
                  {confirmSettingsReset && (
                    <span className="small notice-warn">
                      서버, SSO, 업데이트, MCP, 워크스페이스 설정과 저장된 로그인 정보가 모두 삭제됩니다.
                      앱은 설치본의 기본 설정으로 다시 시작됩니다.
                    </span>
                  )}
                </span>
                <div className="row">
                  {confirmSettingsReset && (
                    <button className="secondary" onClick={() => setConfirmSettingsReset(false)}>
                      취소
                    </button>
                  )}
                  <button
                    className={confirmSettingsReset ? 'danger' : 'secondary'}
                    onClick={() => {
                      if (!confirmSettingsReset) {
                        setConfirmSettingsReset(true);
                        return;
                      }
                      xgen.appctl.resetSettings();
                    }}
                  >
                    {confirmSettingsReset ? '초기화 및 재시작' : '초기화'}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
