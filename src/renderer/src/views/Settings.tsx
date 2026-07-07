import React, { useEffect, useState } from 'react';
import { xgen } from '../bridge';
import type { ConnectorConfig } from '../../../main/config';

export const Settings: React.FC<{
  config: ConnectorConfig;
  onClose: () => void;
  onChanged: () => Promise<ConnectorConfig>;
}> = ({ config, onClose, onChanged }) => {
  const [serverUrl, setServerUrl] = useState(config.serverUrl);
  const [theme, setTheme] = useState(config.theme ?? 'system');
  const [autoUpdate, setAutoUpdate] = useState(config.autoUpdate ?? true);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);

  useEffect(() => xgen.updater.onMessage((m) => setUpdateMsg(m)), []);

  const apply = async (patch: Partial<ConnectorConfig>) => {
    await xgen.config.set(patch);
    await onChanged();
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
            <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} />
            <button
              className="secondary"
              onClick={() => void apply({ serverUrl: serverUrl.trim().replace(/\/+$/, '') })}
            >
              저장
            </button>
          </div>
        </label>

        <label className="field">
          <span>테마</span>
          <select
            value={theme}
            onChange={(e) => {
              const t = e.target.value as NonNullable<ConnectorConfig['theme']>;
              setTheme(t);
              void apply({ theme: t });
            }}
          >
            <option value="system">시스템</option>
            <option value="light">라이트</option>
            <option value="dark">다크</option>
          </select>
        </label>

        <label className="field-row">
          <span>자동 업데이트</span>
          <input
            type="checkbox"
            checked={autoUpdate}
            onChange={(e) => {
              setAutoUpdate(e.target.checked);
              void xgen.updater.setEnabled(e.target.checked);
            }}
          />
        </label>

        <div className="row">
          <button className="secondary" onClick={() => void xgen.updater.check()}>
            업데이트 확인
          </button>
          {updateMsg && <span className="small muted">{updateMsg}</span>}
        </div>
      </div>
    </div>
  );
};
