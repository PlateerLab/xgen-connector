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

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const gen = ++genRef.current;
    const isStale = () => gen !== genRef.current;
    const base = serverUrl.replace(/\/+$/, '');
    const url = (u: string) => (/^https?:\/\//.test(u) ? u : `${base}${u.startsWith('/') ? '' : '/'}${u}`);

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
    };

    init().catch((e) => {
      if (!isStale()) console.error('[Live2DCanvas] init error:', e);
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

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
};

/** The registered AvatarRenderer: resolves the global default avatar, else placeholder. */
export const Live2DCanvas: React.FC<{ state: AvatarState }> = ({ state }) => {
  const [cfg, setCfg] = useState<AvatarConfig | null>(null);
  const [serverUrl, setServerUrl] = useState('');

  useEffect(() => {
    let alive = true;
    Promise.all([xgen.user.avatarConfig(), xgen.config.get()])
      .then(([c, conf]) => {
        if (!alive) return;
        setCfg(c);
        setServerUrl(conf.serverUrl || '');
      })
      .catch(() => alive && setCfg({ enabled: false, defaultAvatarId: null, avatars: [] }));
    // re-read when config (e.g. server URL) changes; avatar edits happen in 개인 설정
    const off = xgen.config.onChange((conf) => alive && setServerUrl(conf.serverUrl || ''));
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  const avatar =
    cfg && cfg.enabled
      ? cfg.avatars.find((a) => a.id === cfg.defaultAvatarId) ?? cfg.avatars[0] ?? null
      : null;

  if (avatar && serverUrl) {
    return <AvatarModel avatar={avatar} serverUrl={serverUrl} />;
  }
  // fallback: the branded placeholder (identical to the overlay's default)
  return (
    <div className={`ov-placeholder ${state.speaking ? 'speaking' : ''}`}>
      <div className="ov-orb">
        <XgenMark height={44} variant="color" />
      </div>
      <div className="ov-name">{state.workflowName || 'XGEN'}</div>
    </div>
  );
};
