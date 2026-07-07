import React, { useState } from 'react';
import { xgen } from '../bridge';
import type { CurrentUser } from '../../../core/index';

export const Login: React.FC<{
  serverUrl: string;
  onLoggedIn: (u: CurrentUser) => void;
  onChangeServer: () => void;
}> = ({ serverUrl, onLoggedIn, onChangeServer }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!email || !password) return;
    setBusy(true);
    setError(null);
    try {
      const { user } = await xgen.auth.login(email, password);
      if (!user) throw new Error('로그인에 실패했습니다.');
      onLoggedIn(user);
    } catch (e) {
      setError(e instanceof Error ? e.message : '로그인에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center">
      <div className="card">
        <h1>로그인</h1>
        <p className="muted">
          {serverUrl}{' '}
          <button className="link" onClick={onChangeServer}>
            변경
          </button>
        </p>
        <label className="field">
          <span>이메일</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
          />
        </label>
        <label className="field">
          <span>비밀번호</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy} onClick={() => void submit()}>
          {busy ? '로그인 중…' : '로그인'}
        </button>
      </div>
    </div>
  );
};
