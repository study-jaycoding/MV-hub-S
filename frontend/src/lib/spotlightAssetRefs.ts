import { api } from "../api";
import { postAssetsUpdated } from "./assetBroadcast";
import { DRAG_TYPES } from "./dragTypes";
import { referenceMediaTypeFromFile, type ReferenceMediaType } from "./media";
import type { ChipRef } from "./promptEditor";
import { loadJSON, loadString } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";

export type SpotlightAssetDragItem = {
  project: string;
  path: string;
  name: string;
  type: string;
  reused?: boolean;
};

export function readSpotlightAssetCtx(): { project: string; dir: string } {
  try {
    return {
      project: loadString(STORAGE_KEYS.assetsProject),
      dir: loadString(STORAGE_KEYS.assetsDir),
    };
  } catch {
    return { project: "", dir: "" };
  }
}

export function referenceDropTypeFromFile(file: File): ReferenceMediaType | null {
  return referenceMediaTypeFromFile(file);
}

export function notifySpotlightAssetsChanged(items: SpotlightAssetDragItem[]): void {
  if (!items.length) return;
  const projects = [...new Set(items.map((item) => item.project).filter(Boolean))];
  postAssetsUpdated(projects);
}

export function parseSpotlightAssetItems(raw: string): SpotlightAssetDragItem[] {
  try {
    const parsed = JSON.parse(raw);
    const list = (Array.isArray(parsed) ? parsed : [parsed]) as SpotlightAssetDragItem[];
    return list.filter((item) => item && (item.type === "image" || item.type === "video"));
  } catch {
    return [];
  }
}

// 에셋 드래그 페이로드 — 에셋창이 dragstart 에 localStorage 로 넘긴 '전체 선택'을 우선 읽는다.
// 없으면 dataTransfer 폴백. 한 건 드래그가 라이브 다중선택 안에 있으면 선택 전체로 복구한다.
export function readSpotlightAssetPayload(dataTransfer: DataTransfer): string {
  let drag = "";
  try {
    drag = loadString(STORAGE_KEYS.assetsDrag);
  } catch {
    /* ignore */
  }
  if (!drag) drag = dataTransfer.getData(DRAG_TYPES.asset);
  try {
    const parsed = drag ? JSON.parse(drag) : [];
    const list = Array.isArray(parsed) ? parsed : [parsed];
    if (list.length <= 1) {
      const selection = loadJSON<SpotlightAssetDragItem[]>(STORAGE_KEYS.assetsSelection) || [];
      const dragged = list[0]?.path;
      if (
        Array.isArray(selection) &&
        selection.length > 1 &&
        (!dragged || selection.some((item) => item.path === dragged))
      ) {
        return JSON.stringify(selection);
      }
    }
  } catch {
    /* 파싱 실패 시 원래 페이로드 사용 */
  }
  return drag;
}

// 에셋 항목 → ChipRef 공통 필드(role/uid 는 호출측이 채움). thumb: 영상은 파일URL, 이미지는 썸네일.
export function spotlightAssetRefBase(item: SpotlightAssetDragItem): Omit<ChipRef, "role"> {
  const isVideo = item.type === "video";
  return {
    file_path: `asset:${item.project}|${item.path}`,
    type: isVideo ? "video" : "image",
    name: item.name,
    thumb: isVideo
      ? api.assetFileUrl(item.project, item.path)
      : api.assetThumbUrl(item.project, item.path, 256),
  };
}
