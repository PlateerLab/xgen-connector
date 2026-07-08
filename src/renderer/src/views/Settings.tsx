import React, { useEffect, useState } from 'react';
import { xgen } from '../bridge';
import type { ConnectorConfig } from '../../../main/config';
import { HotkeyCapture } from './HotkeyCapture';

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
  const [quickChat, setQuickChat] = useState(config.quickChat ?? false);
  const [hotkey, setHotkey] = useState('CommandOrControl+Shift+Enter');
  const [autostart, setAutostart] = useState(false);
  const [resetDone, setResetDone] = useState(false);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => xgen.updater.onMessage((m) => setUpdateMsg(m)), []);
  useEffect(() => {
    xgen.quickChat.getHotkey().then(setHotkey).catch(() => undefined);
    xgen.appctl.getAutostart().then(setAutostart).catch(() => undefined);
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

  const saveServer = async () => {
    await apply({ serverUrl: serverUrl.trim().replace(/\/+$/, '') });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

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
              onChange={(e) => setServerUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void saveServer()}
            />
            <button className="secondary" onClick={() => void saveServer()}>
              {saved ? '저장됨' : '저장'}
            </button>
          </div>
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
          <span>업데이트</span>
          <div className="row">
            {updateMsg && <span className="small muted">{updateMsg}</span>}
            <button className="secondary" onClick={() => void xgen.updater.check()}>
              업데이트 확인
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
