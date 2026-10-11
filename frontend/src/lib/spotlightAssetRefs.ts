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
  // 내용 지문·크기(2026-09-28) — 원본이 옮겨져도 내용으로 다시 찾게 씬 레퍼런스까지 들고 간다.
  sha256?: string;
  bytes?: number;
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
    return list.filter(
      (item) => item && (item.type === "image" || item.type === "video" || item.type === "audio"),
    );
  } catch {
    return [];
  }
}

// 에셋 드래그 페이로드 — 에셋창이 dragstart 에 localStorage 로 넘긴 '전체 선택'을 우선 읽는다.
// 없으면 dataTransfer 폴백. **폴백일 때만** 한 건 드래그가 라이브 다중선택 안에 있으면 선택 전체로 복구한다(창 사이 드래그에서
//  커스텀 배열이 한 건만 넘어오는 브라우저가 있다). localStorage 로 온 것은 dragstart 가 그 순간의 선택으로 만든 완전한 값이다 —
//  그것을 저장된 선택(0.15초 늦게 적힌다)으로 다시 넓히면, 방금 고르기에서 뺀 파일이 같이 붙는다(Codex 검토).
export function readSpotlightAssetPayload(dataTransfer: DataTransfer): string {
  let drag = "";
  try {
    drag = loadString(STORAGE_KEYS.assetsDrag);
  } catch {
    /* ignore */
  }
  const fromStore = !!drag;
  if (!drag) drag = dataTransfer.getData(DRAG_TYPES.asset);
  try {
    const parsed = drag ? JSON.parse(drag) : [];
    const list = Array.isArray(parsed) ? parsed : [parsed];
    if (!fromStore && list.length <= 1) {
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

// 에셋 항목 → ChipRef 공통 필드(role/uid 는 호출측이 채움).
// thumb: 영상은 파일URL, 이미지는 썸네일, 오디오는 썸네일이 없어 빈 문자열(트레이가 A 플레이스홀더 표시).
export function spotlightAssetRefBase(item: SpotlightAssetDragItem): Omit<ChipRef, "role"> {
  const type = item.type === "video" ? "video" : item.type === "audio" ? "audio" : "image";
  return {
    file_path: `asset:${item.project}|${item.path}`,
    type,
    name: item.name,
    thumb:
      type === "video"
        ? api.assetFileUrl(item.project, item.path)
        : type === "audio"
          ? ""
          : api.assetThumbUrl(item.project, item.path, 256),
  };
}
