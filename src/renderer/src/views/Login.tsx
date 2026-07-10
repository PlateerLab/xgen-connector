import React, { useEffect, useState } from 'react';
import { xgen } from '../bridge';
import type { CurrentUser } from '../../../core/index';
import { XgenWordmark } from '../brand/Logo';
import { EyeIcon, EyeOffIcon } from '../brand/icons';

export const Login: React.FC<{
  serverUrl: string;
  onLoggedIn: (u: CurrentUser) => void;
  onChangeServer: () => void;
}> = ({ serverUrl, onLoggedIn, onChangeServer }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Prefill the remembered email + auto-login checkbox (password is never echoed).
  useEffect(() => {
    xgen.auth
      .loginPrefill()
      .then((p) => {
        if (p.email) setEmail(p.email);
        setRemember(!!p.autoLogin);
      })
      .catch(() => undefined);
  }, []);

  const submit = async () => {
    if (!email || !password) {
      setError('이메일과 비밀번호를 입력하세요.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { user } = await xgen.auth.login(email, password, remember);
      if (!user) throw new Error('이메일 또는 비밀번호가 올바르지 않습니다.');
      onLoggedIn(user);
    } catch (e) {
      setError(e instanceof Error ? e.message : '로그인에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const host = serverUrl.replace(/^https?:\/\//, '');

  return (
    <div className="auth-shell">
      <div className="auth-bg" />
      <div className="card">
        <div className="card-brand">
          <XgenWordmark height={34} variant="color" title="XGEN" />
          <span className="sub">Agentic AI Platform</span>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="field">
            <span>이메일</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              autoComplete="email"
              autoFocus
            />
          </label>
          <label className="field">
            <span>비밀번호</span>
            <div className="pw-field">
              <input
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
              />
              <button
                type="button"
                className="pw-toggle"
                tabIndex={-1}
                onClick={() => setShowPw((v) => !v)}
                aria-label={showPw ? '비밀번호 숨기기' : '비밀번호 표시'}
              >
                {showPw ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </div>
          </label>

          <label className="remember">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            <span>자동 로그인</span>
          </label>

          {error && (
            <div className="alert-error" role="alert">
              <span aria-hidden>⚠️</span>
              <span>{error}</span>
            </div>
          )}

          <button type="submit" className="primary" disabled={busy}>
            {busy ? '로그인 중…' : '로그인'}
          </button>
        </form>

        <div className="auth-foot">
          <span className="server-pill">
            연결됨: <code>{host}</code>
          </span>
          <button className="link" onClick={onChangeServer}>
            서버 변경
          </button>
        </div>
      </div>
    </div>
  );
};
