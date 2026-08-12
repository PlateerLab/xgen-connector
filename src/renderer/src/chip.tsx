import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChipApp } from './overlay/ChipApp';
import './styles.css';

// 컨트롤 창도 투명하게 — 버튼 주위의 사각형이 데스크톱을 가리면 안 된다.
document.documentElement.style.background = 'transparent';
document.body.style.background = 'transparent';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ChipApp />
  </React.StrictMode>,
);
