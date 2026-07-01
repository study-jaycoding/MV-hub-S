export type MediaFilter = "all" | "image" | "video" | "audio";

export const MEDIA_FILTER_OPTIONS: { v: MediaFilter; label: string }[] = [
  { v: "all", label: "전체" },
  { v: "image", label: "이미지" },
  { v: "video", label: "영상" },
  { v: "audio", label: "오디오" },
];
