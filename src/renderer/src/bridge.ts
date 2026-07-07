/** Typed handle to the preload bridge exposed as `window.xgen`. */
import type { XgenBridge } from '../../preload/index';

declare global {
  interface Window {
    xgen: XgenBridge;
  }
}

export const xgen = window.xgen;
