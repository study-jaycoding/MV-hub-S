const ICON = {
  viewBox: "0 0 24 24",
  width: 13,
  height: 13,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function ModelIcon() {
  return (
    <svg {...ICON} width={14} height={14}>
      <line x1="6" y1="20" x2="6" y2="13" />
      <line x1="12" y1="20" x2="12" y2="8" />
      <line x1="18" y1="20" x2="18" y2="4" />
    </svg>
  );
}

export function GemIcon() {
  return (
    <svg {...ICON}>
      <polygon points="12 3 19 9 12 21 5 9 12 3" />
    </svg>
  );
}

export function ClockIcon() {
  return (
    <svg {...ICON}>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15 14" />
    </svg>
  );
}

export function FrameIcon() {
  return (
    <svg {...ICON}>
      <rect x="3" y="6" width="18" height="12" rx="2" />
    </svg>
  );
}

// 파생본(히스토리) 아이콘 — git branch 스타일(원본에서 갈라진 가지)
export function BranchIcon() {
  return (
    <svg {...ICON} width={14} height={14}>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}
