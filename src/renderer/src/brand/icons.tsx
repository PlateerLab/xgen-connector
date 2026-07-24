/** Minimal inline icon set (stroke = currentColor), Lucide-style, no deps. */
import React from 'react';

type P = { size?: number; className?: string };
const base = (size: number): React.SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
});

export const EyeIcon: React.FC<P> = ({ size = 18, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
export const EyeOffIcon: React.FC<P> = ({ size = 18, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a13 13 0 0 1-1.67 2.68" />
    <path d="M6.61 6.61A13 13 0 0 0 1 12s4 7 11 7a9 9 0 0 0 5.39-1.61" />
    <line x1="2" y1="2" x2="22" y2="22" />
  </svg>
);
export const SendIcon: React.FC<P> = ({ size = 18, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M22 2 11 13" />
    <path d="M22 2 15 22l-4-9-9-4 20-7Z" />
  </svg>
);
export const SettingsIcon: React.FC<P> = ({ size = 18, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
export const RefreshIcon: React.FC<P> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    <path d="M3 21v-5h5" />
  </svg>
);
export const PlusIcon: React.FC<P> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </svg>
);
export const StopIcon: React.FC<P> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className} fill="currentColor" stroke="none">
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
);
export const ChatIcon: React.FC<P> = ({ size = 40, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
  </svg>
);
export const LogoutIcon: React.FC<P> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5" />
    <path d="M21 12H9" />
  </svg>
);
export const DocIcon: React.FC<P> = ({ size = 12, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
    <path d="M14 2v6h6" />
  </svg>
);
export const ServerIcon: React.FC<P> = ({ size = 14, className }) => (
  <svg {...base(size)} className={className}>
    <rect x="2" y="2" width="20" height="8" rx="2" />
    <rect x="2" y="14" width="20" height="8" rx="2" />
    <line x1="6" y1="6" x2="6.01" y2="6" />
    <line x1="6" y1="18" x2="6.01" y2="18" />
  </svg>
);
export const PanelLeftIcon: React.FC<P> = ({ size = 18, className }) => (
  <svg {...base(size)} className={className}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M9 3v18" />
  </svg>
);
export const HistoryIcon: React.FC<P> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M3 3v5h5" />
    <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
    <path d="M12 7v5l4 2" />
  </svg>
);
/** 아바타 설정 (사이드바 헤더) — 사람 실루엣 원형. */
export const AvatarIcon: React.FC<P> = ({ size = 18, className }) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="10" r="3" />
    <path d="M6.2 18.9a6.5 6.5 0 0 1 11.6 0" />
  </svg>
);
export const BackIcon: React.FC<P> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <path d="m12 19-7-7 7-7" />
    <path d="M19 12H5" />
  </svg>
);
export const PencilIcon: React.FC<P> = ({ size = 14, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
  </svg>
);
export const TrashIcon: React.FC<P> = ({ size = 14, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);
export const UploadIcon: React.FC<P> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);
export const MicIcon: React.FC<P> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" y1="19" x2="12" y2="22" />
  </svg>
);
export const SpeakerIcon: React.FC<P> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
  </svg>
);
export const SpeakerOffIcon: React.FC<P> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <line x1="23" y1="9" x2="17" y2="15" />
    <line x1="17" y1="9" x2="23" y2="15" />
  </svg>
);
export const BotIcon: React.FC<P> = ({ size = 18, className }) => (
  <svg {...base(size)} className={className}>
    <rect x="4" y="8" width="16" height="12" rx="3" />
    <path d="M12 4v4" />
    <circle cx="12" cy="4" r="1" />
    <path d="M9 13h.01" />
    <path d="M15 13h.01" />
    <path d="M2 14v2" />
    <path d="M22 14v2" />
  </svg>
);
