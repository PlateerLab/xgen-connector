import { resolve } from 'path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    // keytar (native), ws + the MCP SDK (spawns stdio children / ESM) must stay
    // external so they resolve from node_modules at runtime.
    build: { rollupOptions: { external: ['keytar', 'ws', '@modelcontextprotocol/sdk'] } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
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
