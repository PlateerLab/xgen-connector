import React, { useEffect, useState } from 'react';
import { xgen } from '../bridge';
import type { ConnectorConfig } from '../../../main/config';
import { HotkeyCapture } from './HotkeyCapture';
import { McpSettings } from './McpSettings';

type Theme = NonNullable<ConnectorConfig['theme']>;

export const Settings: React.FC<{
  config: ConnectorConfig;
  onClose: () => void;
  onChanged: () => Promise<ConnectorConfig>;
}> = ({ config, onClose, onChanged }) => {
  const [serverUrl, setServerUrl] = useState(config.serverUrl);
  const [theme, setTheme] = useState<Theme>(config.theme ?? 'system');
  const [autoUpdate, setAutoUpdate] = useState(config.autoUpdate ?? true);
  const [overlay, setOverlay] = useState(config.avatarOverlay ?? false);
  const [subtitles, setSubtitles] = useState(config.subtitles !== false);
  const [charMs, setCharMs] = useState(config.subtitleCharMs ?? 50);
  const [subtitleSize, setSubtitleSize] = useState<'sm' | 'md' | 'lg'>(config.subtitleSize ?? 'sm');
  const [quickChat, setQuickChat] = useState(config.quickChat ?? false);
  const [hotkey, setHotkey] = useState('Control+Shift+/');
  const [autostart, setAutostart] = useState(false);
  const [resetDone, setResetDone] = useState(false);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const [version, setVersion] = useState('');
  const [checking, setChecking] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showMcp, setShowMcp] = useState(false);

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

  // 서버 주소 변경은 세션 전환 — 첫 클릭에서 로그아웃 안내를 띄우고,
  // 두 번째 클릭(변경 및 로그아웃)에서 적용한다. 적용되면 main 이 세션을
  // 정리하고 authFailed 를 쏘아 로그인 화면으로 돌아간다.
  const [confirmServer, setConfirmServer] = useState(false);
  const saveServer = async () => {
    const next = serverUrl.trim().replace(/\/+$/, '');
    if (!next) return;
    if (next === (config.serverUrl ?? '')) {
      setConfirmServer(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      return;
    }
    if (!confirmServer) {
      setConfirmServer(true);
      return;
    }
    await apply({ serverUrl: next });
  };

  if (showMcp) return <McpSettings onClose={() => setShowMcp(false)} />;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>설정</h2>
          <button className="link" onClick={onClose}>
            닫기
          </button>
        </div>

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
          <span>로컬 MCP (내 PC 도구 연결)</span>
          <button className="secondary" onClick={() => setShowMcp(true)}>
            관리
          </button>
        </div>

        <div className="field-row">
          <span>로그인 시 시작</span>
          <label className="switch">
            <input
              type="checkbox"
              checked={autostart}
              onChange={(e) => {
                setAutostart(e.target.checked);
                void xgen.appctl.setAutostart(e.target.checked);
              }}
            />
            <span className="track" />
          </label>
        </div>

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
                // Safety: never leave the spinner stuck if no message arrives.
                setTimeout(() => setChecking(false), 25000);
              }}
            >
              {checking ? '확인 중…' : '업데이트 확인'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
