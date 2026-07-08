/**
 * App — top-level router for the connector.
 *
 * Flow (mirrors geny-connector's control window, self-contained since XGEN has
 * no server-served connector page):
 *   1. ServerSetup  — enter/confirm the XGEN gateway base URL.
 *   2. Login        — email + password.
 *   3. Workspace    — agent list (sidebar) + chat view; settings modal.
 * On launch it tries to restore a saved session (keychain token) and skips
 * straight to the workspace when valid.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { xgen } from './bridge';
import type { CurrentUser } from '../../core/index';
import type { ConnectorConfig } from '../../main/config';
import { ServerSetup } from './views/ServerSetup';
import { Login } from './views/Login';
import { Workspace } from './views/Workspace';
import { XgenMark } from './brand/Logo';

type Stage = 'loading' | 'server' | 'login' | 'workspace';

export const App: React.FC = () => {
  const [stage, setStage] = useState<Stage>('loading');
  const [config, setConfig] = useState<ConnectorConfig | null>(null);
  const [user, setUser] = useState<CurrentUser | null>(null);

  const refreshConfig = useCallback(async () => {
    const c = await xgen.config.get();
    setConfig(c);
    return c;
  }, []);

  // Apply the theme preference to <html data-theme>. 'system' clears the
  // override so the OS `prefers-color-scheme` decides (see styles.css).
  useEffect(() => {
    const root = document.documentElement;
    const theme = config?.theme ?? 'system';
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }, [config?.theme]);

  useEffect(() => {
    (async () => {
      const c = await refreshConfig();
      if (!c.serverUrl) {
        setStage('server');
        return;
      }
      const { user } = await xgen.auth.restore();
      if (user) {
        setUser(user);
        setStage('workspace');
      } else {
        setStage('login');
      }
    })();
    const off = xgen.auth.onAuthFailed(() => {
      setUser(null);
      setStage('login');
    });
    return off;
  }, [refreshConfig]);

  const handleServerSaved = useCallback(async () => {
    await refreshConfig();
    setStage('login');
  }, [refreshConfig]);

  const handleLoggedIn = useCallback((u: CurrentUser) => {
    setUser(u);
    setStage('workspace');
  }, []);

  const handleLogout = useCallback(async () => {
    await xgen.auth.logout();
    setUser(null);
    setStage('login');
  }, []);

  if (stage === 'loading') {
    return (
      <div className="center">
        <XgenMark height={40} variant="color" />
        <span className="muted small">불러오는 중…</span>
      </div>
    );
  }
  if (stage === 'server' || !config?.serverUrl) {
    return <ServerSetup initialUrl={config?.serverUrl ?? ''} onSaved={handleServerSaved} />;
  }
  if (stage === 'login') {
    return (
      <Login
        serverUrl={config.serverUrl}
        onLoggedIn={handleLoggedIn}
        onChangeServer={() => setStage('server')}
      />
    );
  }
  return <Workspace user={user!} config={config} onLogout={handleLogout} onConfigChange={refreshConfig} />;
};
