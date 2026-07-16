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
import { useLibraryPersistence } from "./useLibraryPersistence";

export function useLibraryFilters(LS: Store) {
  const [filters, setFilters] = useState<Filters>(() => {
    return LS.loadJSON<Filters>("filters") ?? { tab: "my" };
  });
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
    genQuery, selectionResetKey,
  };
}
