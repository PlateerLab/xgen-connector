/**
 * Live2DCanvas — the connector overlay's real avatar renderer, registered into
 * the AvatarSlot seam. Ported from Geny's Live2DCanvas/SpineCanvas (pixi v7 +
 * pixi-live2d-display/cubism4 + spine-pixi-v7), stripped to idle-only.
 *
 * XGEN model (vs Geny): the avatar is the user's GLOBAL default from 개인 설정
 * (preferences.avatar.defaultAvatarId) — NOT chosen per session. This component
 * fetches that config itself, resolves the capability asset URLs against the
 * configured server URL, and renders the model. When no avatar is configured /
 * enabled it falls back to the branded placeholder (identical to the overlay's
 * default), so registering this renderer never regresses the empty state.
 */
import React, { useEffect, useRef, useState } from 'react';
import { xgen } from '../bridge';
import { XgenMark } from '../brand/Logo';
import type { AvatarState } from './AvatarSlot';
import type { AvatarConfig, AvatarDescriptor } from '../../../core/preferences';

const CUBISM_CORE_SRC = './live2dcubismcore.min.js';
let _spineAliasSeq = 0;

function ensureCubismCore(): Promise<void> {
  const win = window as unknown as { Live2DCubismCore?: unknown };
  if (win.Live2DCubismCore) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector('script[src*="live2dcubismcore"]');
    if (existing) {
      const poll = () => (win.Live2DCubismCore ? resolve() : setTimeout(poll, 50));
      poll();
      return;
    }
    const s = document.createElement('script');
    s.src = CUBISM_CORE_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load Live2D Cubism Core'));
    document.head.appendChild(s);
  });
}

/** The actual pixi renderer for one resolved avatar. */
const AvatarModel: React.FC<{ avatar: AvatarDescriptor; serverUrl: string }> = ({ avatar, serverUrl }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const genRef = useRef(0);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [err, setErr] = useState('');

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const gen = ++genRef.current;
    const isStale = () => gen !== genRef.current;
    setPhase('loading');
    setErr('');
    // Route every asset through the main-process proxy scheme (no CORS/CSP);
    // relative moc3/textures/atlas siblings resolve against the same scheme.
    const url = (u: string) => {
      if (/^xgenavatar:/.test(u)) return u;
      let path = u;
      if (/^https?:\/\//.test(u)) {
        const p = new URL(u);
        path = p.pathname + p.search;
      }
      if (!path.startsWith('/')) path = `/${path}`;
      return `xgenavatar://a${path}`;
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let app: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let display: any = null;
    let ro: ResizeObserver | null = null;

    const init = async () => {
      const PIXI = await import('pixi.js');
      if (isStale()) return;
      app = new PIXI.Application({
        width: container.clientWidth || 300,
        height: container.clientHeight || 400,
        backgroundAlpha: 0,
        antialias: true,
        autoDensity: true,
        resolution: Math.min(2, Math.max(1, window.devicePixelRatio || 1)),
      });
      app.ticker.maxFPS = 30;
      const canvas = app.view as HTMLCanvasElement;
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.display = 'block';
      container.appendChild(canvas);

      const fit = (w: number, h: number) => {
        const b = Math.min(app.screen.width / w, app.screen.height / h);
        display.scale.set(b * (avatar.scale || (avatar.runtime === 'spine' ? 0.7 : 0.85)));
        display.x = app.screen.width / 2 + (avatar.position?.x || 0);
        display.y = app.screen.height / 2 + (avatar.position?.y || 0);
      };

      if (avatar.runtime === 'spine') {
        const { Spine } = await import('@esotericsoftware/spine-pixi-v7');
        if (isStale()) return;
        const seq = ++_spineAliasSeq;
        const skel = `xgen-avatar:${seq}:skel`;
        const atlas = `xgen-avatar:${seq}:atlas`;
        PIXI.Assets.add({ alias: skel, src: url(avatar.modelUrl) });
        PIXI.Assets.add({ alias: atlas, src: url(avatar.atlasUrl || '') });
        await PIXI.Assets.load([skel, atlas]);
        if (isStale()) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const spine: any = (Spine as any).from({ skeleton: skel, atlas });
        display = spine;
        fit(spine.skeleton?.data?.width || 600, spine.skeleton?.data?.height || 800);
        app.stage.addChild(spine);
        const anims: Array<{ name: string }> = spine.skeleton?.data?.animations || [];
        const pick =
          anims.find((a) => a.name === avatar.idleMotionGroupName) ||
          anims.find((a) => /idle/i.test(a.name)) ||
          anims[0];
        if (pick) spine.state.setAnimation(0, pick.name, true);
      } else {
        await ensureCubismCore();
        if (isStale()) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const l2d: any = await import('pixi-live2d-display/cubism4');
        if (isStale()) return;
        l2d.Live2DModel.registerTicker(PIXI.Ticker);
        const idle = avatar.idleMotionGroupName || 'Idle';
        const model = await l2d.Live2DModel.from(url(avatar.modelUrl), {
          autoHitTest: false,
          autoFocus: false,
          idleMotionGroup: idle,
        });
        if (isStale()) {
          model.destroy?.();
          return;
        }
        display = model;
        model.anchor.set(0.5, 0.5);
        fit(model.width || 600, model.height || 600);
        app.stage.addChild(model);
        try {
          await model.motion(idle, undefined, l2d.MotionPriority?.IDLE ?? 1);
        } catch {
          /* idle optional */
        }
      }

      ro = new ResizeObserver(() => {
        if (isStale() || !app || !display) return;
        app.renderer.resize(container.clientWidth || 300, container.clientHeight || 400);
        if (avatar.runtime === 'spine') fit(display.skeleton?.data?.width || 600, display.skeleton?.data?.height || 800);
        else fit(display.width || 600, display.height || 600);
      });
      ro.observe(container);
      if (!isStale()) setPhase('ready');
    };

    init().catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Live2DCanvas] init error:', e);
      if (!isStale()) {
        setPhase('error');
        setErr(msg);
      }
    });

    return () => {
      genRef.current++;
      try {
        ro?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        if (display && app) app.stage?.removeChild(display);
        display?.destroy?.({ children: true });
      } catch {
        /* ignore */
      }
      try {
        app?.destroy(true, { children: true });
      } catch {
        /* ignore */
      }
      if (container) container.innerHTML = '';
    };
  }, [avatar, serverUrl]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      {phase !== 'ready' && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 8,
            textAlign: 'center',
            fontSize: 10,
            color: phase === 'error' ? '#fecaca' : 'rgba(255,255,255,0.75)',
            background: 'rgba(0,0,0,0.55)',
            padding: '3px 6px',
            borderRadius: 6,
            margin: '0 8px',
            wordBreak: 'break-all',
          }}
        >
          {phase === 'error' ? `모델 로드 실패: ${err}` : '아바타 로딩 중…'}
        </div>
      )}
    </div>
  );
};

function selectedFrom(cfg: AvatarConfig | null): AvatarDescriptor | null {
  if (!cfg || !cfg.enabled) return null;
  return cfg.avatars.find((a) => a.id === cfg.defaultAvatarId) ?? cfg.avatars[0] ?? null;
}

/** The registered AvatarRenderer: resolves the user's GLOBAL default avatar
 *  (개인 설정) and renders it, else the branded placeholder.
 *
 *  The avatar config is set only in 개인 설정 (web), so we POLL it (+ react to
 *  config changes) rather than fetch once: this reliably picks up login that
 *  happens after mount, a newly-selected avatar, and adjusted scale/position —
 *  and only re-renders (reloads the model) when the resolved avatar/serverUrl
 *  actually change (signature compare), so polling never causes flicker. */
export const Live2DCanvas: React.FC<{ state: AvatarState }> = ({ state }) => {
  const [avatar, setAvatar] = useState<AvatarDescriptor | null>(null);
  const [serverUrl, setServerUrl] = useState('');
  const [diag, setDiag] = useState('init');
  const sigRef = useRef('');

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        if (!xgen.user || typeof xgen.user.avatarConfig !== 'function') {
          if (alive) setDiag('no user.avatarConfig (구버전 접속기 — 업데이트 필요)');
          return;
        }
        const [cfg, conf] = await Promise.all([xgen.user.avatarConfig(), xgen.config.get()]);
        if (!alive) return;
        const su = conf.serverUrl || '';
        const a = selectedFrom(cfg);
        setDiag(
          `en=${cfg?.enabled} n=${cfg?.avatars?.length ?? 0} def=${cfg?.defaultAvatarId ? 'y' : 'n'} srv=${su ? 'y' : 'n'} → ${a ? 'avatar' : 'none'}`,
        );
        const sig = `${su}|${a ? JSON.stringify([a.id, a.modelUrl, a.atlasUrl, a.runtime, a.scale, a.position]) : 'none'}`;
        if (sig === sigRef.current) return; // nothing changed → no reload
        sigRef.current = sig;
        setServerUrl(su);
        setAvatar(a);
      } catch (e) {
        console.error('[Live2DCanvas] avatar config fetch failed:', e);
        if (alive) setDiag(`err: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    void refresh();
    const iv = setInterval(() => void refresh(), 15000);
    const off = xgen.config.onChange(() => void refresh());
    return () => {
      alive = false;
      clearInterval(iv);
      off?.();
    };
  }, []);

  if (avatar && serverUrl) {
    return <AvatarModel avatar={avatar} serverUrl={serverUrl} />;
  }
  // fallback: the branded placeholder (identical to the overlay's default) + a
  // small diagnostic line so a screenshot pinpoints why no avatar is shown.
  return (
    <div className={`ov-placeholder ${state.speaking ? 'speaking' : ''}`}>
      <div className="ov-orb">
        <XgenMark height={44} variant="color" />
      </div>
      <div className="ov-name">{state.workflowName || 'XGEN'}</div>
      <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.75)', background: 'rgba(0,0,0,0.55)', padding: '2px 6px', borderRadius: 6, maxWidth: 260, textAlign: 'center', wordBreak: 'break-all' }}>
        avatar: {diag}
      </div>
    </div>
  );
};
