import { resolve } from 'path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    // keytar (native), ws + the MCP SDK (spawns stdio children / ESM) must stay
    // external so they resolve from node_modules at runtime.
    // bufferutil/utf-8-validate: ws 의 optional native 가속 — ws 가 번들되면
    // rollup 이 lazy require 를 깨진 스텁으로 인라인해 첫 WS 프레임에서
    // `bufferUtil.mask is not a function` 이 터진다 (geny-connector 0.19.3
    // 실사고). ws 가 external 인 지금도 방어적으로 명시한다.
    // electron-updater/chokidar/picomatch 는 externalizeDepsPlugin 이 처리하지만
    // 명시해 회귀를 차단한다.
    build: {
      rollupOptions: {
        external: [
          'keytar',
          'ws',
          'bufferutil',
          'utf-8-validate',
          '@modelcontextprotocol/sdk',
          'electron-updater',
          'chokidar',
          'picomatch',
        ],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          sso: resolve('src/preload/sso.ts'),
        },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          overlay: resolve('src/renderer/overlay.html'),
          quickchat: resolve('src/renderer/quickchat.html'),
        },
      },
    },
    plugins: [react()],
  },
});
