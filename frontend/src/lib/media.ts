// 공용 미디어 헬퍼 — History 보드/패널/미니트리에 동일하게 복붙돼 있던 thumbOf 를 통합.
import { api } from "../api";
import type { Generation } from "../types";

// 생성본의 대표 썸네일 URL(없으면 null). 로컬 /media·공유받은 원격 URL 모두 리사이즈 썸네일로 변환.
export function thumbOf(g: Generation, size = 256): string | null {
  const a = g.assets[0];
  const raw = a?.thumbnail_path || (a?.type !== "video" ? a?.file_path : null) || null;
  if (!raw) return null;
  return api.thumbOrRaw(raw, size);
}
