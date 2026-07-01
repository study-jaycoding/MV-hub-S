// 모델 옵션 칩 라벨 → 아이콘. 텍스트 라벨이 길어 두 줄 되는 것을 피한다.
export function SpotlightOptionIcon({ name }: { name: string }) {
  const lower = name.toLowerCase();
  const props = {
    width: 13,
    height: 13,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (lower.includes("aspect") || lower.includes("ratio") || lower.includes("frame"))
    return (
      <svg {...props}>
        <rect x="3" y="5" width="18" height="14" rx="2" />
      </svg>
    );
  if (lower.includes("duration") || lower.includes("time") || lower.includes("length") || lower.includes("second"))
    return (
      <svg {...props}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
    );
  if (lower.includes("resolution") || lower.includes("quality") || lower.includes("size"))
    return (
      <svg {...props}>
        <path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" />
      </svg>
    );
  if (lower.includes("genre") || lower.includes("style") || lower.includes("preset"))
    return (
      <svg {...props}>
        <path d="M3 7l9-4 9 4-9 4-9-4z" />
        <path d="M3 12l9 4 9-4" />
      </svg>
    );
  if (lower.includes("bitrate") || lower.includes("bit_rate"))
    return (
      <svg {...props}>
        <path d="M3 17l5-5 4 4 8-8" />
        <path d="M16 4h5v5" />
      </svg>
    );
  if (lower.includes("fps") || lower.includes("motion") || lower.includes("frame_rate"))
    return (
      <svg {...props}>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M7 5v14M17 5v14" />
      </svg>
    );
  if (lower.includes("seed"))
    return (
      <svg {...props}>
        <rect x="4" y="4" width="16" height="16" rx="3" />
        <circle cx="9" cy="9" r="1" />
        <circle cx="15" cy="15" r="1" />
      </svg>
    );
  if (lower.includes("mode"))
    return (
      <svg {...props}>
        <circle cx="8" cy="8" r="2" />
        <circle cx="16" cy="16" r="2" />
        <path d="M8 10v8M16 6v8" />
      </svg>
    );
  if (lower.includes("audio") || lower.includes("sound") || lower.includes("voice"))
    return (
      <svg {...props}>
        <path d="M11 5L6 9H2v6h4l5 4V5z" />
        <path d="M15.5 8.5a5 5 0 0 1 0 7" />
        <path d="M18.5 6a9 9 0 0 1 0 12" />
      </svg>
    );
  return (
    <svg {...props}>
      <path d="M5 8h14M5 16h14" />
      <circle cx="10" cy="8" r="2.4" fill="currentColor" stroke="none" />
      <circle cx="15" cy="16" r="2.4" fill="currentColor" stroke="none" />
    </svg>
  );
}
