import React from 'react';
import { createRoot } from 'react-dom/client';
import { OverlayApp } from './overlay/OverlayApp';
import './styles.css';

// The overlay window must be transparent so the avatar composites onto the
// desktop — never let the shared body background paint here.
document.documentElement.style.background = 'transparent';
document.body.style.background = 'transparent';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <OverlayApp />
  </React.StrictMode>,
);
