import React, { useState } from 'react';
import { xgen } from '../bridge';
import { XgenWordmark } from '../brand/Logo';
import { ServerIcon } from '../brand/icons';

/** First-run / change-server screen: set the XGEN gateway base URL. */
export const ServerSetup: React.FC<{ initialUrl: string; onSaved: () => void }> = ({
  initialUrl,
  onSaved,
}) => {
  const [url, setUrl] = useState(initialUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const trimmed = url.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(trimmed)) {
      setError('http:// 또는 https:// 로 시작하는 주소를 입력하세요.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await xgen.config.set({ serverUrl: trimmed });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-bg" />
      <div className="card">
        <div className="card-brand">
          <XgenWordmark height={34} variant="color" title="XGEN" />
          <span className="sub">Agentic AI Platform</span>
        </div>
        <h1>서버 연결</h1>
        <p className="muted small">접속할 XGEN 서버(게이트웨이) 주소를 입력하세요.</p>
        <label className="field">
          <span>서버 주소</span>
          <input
            type="url"
            placeholder="https://xgen.example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void save()}
            autoFocus
          />
        </label>
        {error && (
          <div className="alert-error" role="alert">
            <span aria-hidden>⚠️</span>
            <span>{error}</span>
          </div>
        )}
        <button className="primary" disabled={busy} onClick={() => void save()}>
          <ServerIcon size={15} />
          {busy ? '확인 중…' : '계속'}
        </button>
      </div>
    </div>
  );
};
