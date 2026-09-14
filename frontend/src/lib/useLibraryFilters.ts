// 라이브러리 필터/뷰 상태(전부 localStorage 백업) + 파생 쿼리를 App.tsx 에서 추출.
//  · 흩어진 필터/뷰 프리퍼런스(타입·색·태그·공유·최종·회색·무장태그/폴더·레이아웃·크기 등)를 한곳에 모은다.
//  · genQuery(서버 쿼리) / selectionResetKey(필터 변경 시 선택 초기화 키) 파생값도 여기서 계산.
//  · 저장은 기존 useLibraryPersistence(effect 방식) 를 그대로 내부 호출 — setter 래핑 아님(동작 보존).
// 개별 state/setter 를 그대로 반환(객체 병합 안 함) — Set 함수형 업데이트·부분 갱신 동작을 원본과 동일하게 유지.
import { useMemo, useState } from "react";
import type { Store } from "./storage";
import type { Filters, GenQuery } from "../types";
import type { MediaFilter } from "./mediaTypes";
import { buildGenerationQuery } from "./appGenerationQuery";
import {
  FILTERS_FORMAT_KEY,
  FILTERS_KEY,
  LEGACY_FILTERS_KEY,
  useLibraryPersistence,
} from "./useLibraryPersistence";

export interface WorkspaceChip {
  id: string;
  name: string;
}

type StoredFilters = Filters & { [FILTERS_FORMAT_KEY]?: string };

/** 저장값의 워크스페이스 선택을 **깨끗한 배열 하나**로 모은다.
 *  옛 단수(`workspace_id`)와 새 배열이 섞여 있어도 합치고, 빈 문자열·중복은 버린다
 *  (`loadJSON` 은 JSON 파싱만 하고 모양은 확인하지 않는다 — 손상값이 그대로 들어온다). */
function collectWorkspaceIds(stored: StoredFilters): string[] {
  const ids = new Set<string>();
  const raw = Array.isArray(stored.workspace_ids) ? stored.workspace_ids : [];
  for (const id of [...raw, stored.workspace_id]) {
    if (typeof id === "string" && id.trim()) ids.add(id);
  }
  return [...ids];
}

/** 저장된 filters 를 읽어 되살린다 — 형식별 일회성 이사를 포함한다.
 *
 *  형식 0(표식 없음): 가시성 분리(2026-08-21) 잔재 청소. 예전엔 워크스페이스 전환이
 *    `workspace_id` 필터를 자동 주입했다. 등록 침에 없는 값은 그 잔재이므로 버린다.
 *  형식 1: 단일 선택 시절. 청소 없이 배열로 옮긴다.
 *  형식 2: 지금 형식(배열).
 *
 *  ★새 키(FILTERS_KEY)가 있으면 옛 키는 아예 안 본다. 옛 릴리스는 옛 키만 쓰므로 두 버전이
 *   서로의 저장값을 망가뜨리지 않는다 — 대신 **두 버전의 선택이 실시간으로 같아지지는 않는다**.
 */
export function restoreFilters(LS: Store): Filters {
  const fresh = LS.loadJSON<StoredFilters>(FILTERS_KEY);
  const raw: StoredFilters = fresh ?? LS.loadJSON<StoredFilters>(LEGACY_FILTERS_KEY) ?? { tab: "my" };
  const { [FILTERS_FORMAT_KEY]: format, ...stored } = raw;
  if (!fresh && !format && stored.workspace_id) {
    const chips = LS.loadJSON<WorkspaceChip[]>("workspaceChips") ?? [];
    if (!chips.some((chip) => chip && chip.id === stored.workspace_id)) {
      delete stored.workspace_id;
    }
  }
  const workspaceIds = collectWorkspaceIds(stored as StoredFilters);
  delete stored.workspace_id;
  return { ...stored, ...(workspaceIds.length ? { workspace_ids: workspaceIds } : { workspace_ids: undefined }) };
}

export function useLibraryFilters(LS: Store) {
  // 워크스페이스 침(옵트인 필터) 등록 목록 — 전역태그 블록에 표시, 클릭하면 workspace_id 필터 무장.
  const [workspaceChips, setWorkspaceChips] = useState<WorkspaceChip[]>(
    () => LS.loadJSON<WorkspaceChip[]>("workspaceChips") ?? [],
  );
  const [filters, setFilters] = useState<Filters>(() => restoreFilters(LS));
  const [typeFilter, setTypeFilter] = useState<MediaFilter>(
    () => (LS.get("typeFilter", "all") as MediaFilter) || "all",
  ); // 전체/이미지/영상/음성
  const [scale, setScale] = useState(() => Number(LS.get("scale", "1")) || 1); // 카드 크기 배율
  const [fill, setFill] = useState(() => LS.get("fill", "1") !== "0"); // cover ↔ contain
  const [layout, setLayout] = useState<"grid" | "list">(() =>
    LS.get("layout", "grid") === "list" ? "list" : "grid",
  );
  const [showFilters, setShowFilters] = useState(() => LS.get("showFilters", "1") !== "0");
  const [groupByDate, setGroupByDate] = useState(() => LS.get("groupByDate", "0") === "1");
  const [colorFilter, setColorFilter] = useState<Set<string>>(() => LS.loadSet("colorFilter"));
  const [sharedOnly, setSharedOnly] = useState(() => LS.get("sharedOnly", "0") === "1");
  const [tagFilter, setTagFilter] = useState<Set<string>>(() => LS.loadSet("tagFilter"));
  const [tagPanelOpen, setTagPanelOpen] = useState(false);
  const [commentOnly, setCommentOnly] = useState(() => LS.get("commentOnly", "0") === "1"); // 미확인 코멘트만
  const [finalOnly, setFinalOnly] = useState(() => LS.get("finalOnly", "0") === "1"); // 최종(골드)만
  const [grayOn, setGrayOn] = useState(() => LS.get("grayOn", "0") === "1"); // 비활성(회색) 숨김
  const [armedAutoTags, setArmedAutoTags] = useState<Set<string>>(() => LS.loadSet("armedAutoTags"));
  const [armedFolder, setArmedFolder] = useState<{ projectId: string; path: string } | null>(
    () => LS.loadJSON<{ projectId: string; path: string }>("armedFolder") ?? null,
  );

  const patch = (p: Partial<Filters>) => setFilters((f) => ({ ...f, ...p }));

  // 흩어진 필터 상태(filters + 인스턴트 필터)를 서버 쿼리 하나로 합친다(서버가 전량 거름 → 무한스크롤).
  const genQuery = useMemo<GenQuery>(
    () =>
      buildGenerationQuery({
        filters,
        typeFilter,
        colorFilter,
        tagFilter,
        armedAutoTags,
        sharedOnly,
        commentOnly,
        finalOnly,
      }),
    [filters, typeFilter, colorFilter, tagFilter, armedAutoTags, sharedOnly, commentOnly, finalOnly],
  );
  // 필터가 바뀌면 선택을 초기화하기 위한 키(무한스크롤 누적/선택 상태 리셋 근거).
  const selectionResetKey = useMemo(
    () =>
      JSON.stringify({
        colorFilter: [...colorFilter].sort(),
        commentOnly,
        finalOnly,
        legacyColor: filters.color,
        search: filters.search,
        workspaceIds: [...(filters.workspace_ids ?? [])].sort(),
        shareDir: filters.share_dir,
        sharedOnly,
        tag: filters.tag,
        tagFilter: [...tagFilter].sort(),
        typeFilter,
      }),
    [
      colorFilter,
      commentOnly,
      finalOnly,
      filters.color,
      filters.search,
      filters.workspace_ids,
      filters.share_dir,
      filters.tag,
      sharedOnly,
      tagFilter,
      typeFilter,
    ],
  );

  useLibraryPersistence({
    armedAutoTags,
    armedFolder,
    colorFilter,
    workspaceChips,
    commentOnly,
    fill,
    filters,
    finalOnly,
    grayOn,
    groupByDate,
    layout,
    scale,
    sharedOnly,
    showFilters,
    store: LS,
    tagFilter,
    typeFilter,
  });

  return {
    filters, setFilters, patch,
    typeFilter, setTypeFilter,
    scale, setScale,
    fill, setFill,
    layout, setLayout,
    showFilters, setShowFilters,
    groupByDate, setGroupByDate,
    colorFilter, setColorFilter,
    sharedOnly, setSharedOnly,
    tagFilter, setTagFilter,
    tagPanelOpen, setTagPanelOpen,
    commentOnly, setCommentOnly,
    finalOnly, setFinalOnly,
    grayOn, setGrayOn,
    armedAutoTags, setArmedAutoTags,
    armedFolder, setArmedFolder,
    workspaceChips, setWorkspaceChips,
    genQuery, selectionResetKey,
  };
}
