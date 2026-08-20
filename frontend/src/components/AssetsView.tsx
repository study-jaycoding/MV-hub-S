// Assets(구성) 뷰 — Higgsfield 자산 라이브러리 풍으로:
//  · 메이슨리(핀터레스트형) 그리드 + 리스트 토글, 크기 조절 슬라이더
//  · 영상 호버 자동재생 + 미디어 호버 오버레이(정보·미리보기·다운로드)
//  · 좌측 폴더 트리는 유지. 셀 휠클릭=정보, 클릭=미리보기.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Virtualizer, type VirtualizerHandle } from "virtua";
import { api } from "../api";
import { DRAG_TYPES } from "../lib/dragTypes";
import { computeGridColumns, navigateGrid } from "../lib/gridVirtualRows";
import { buildAssetRows, type AssetVirtualRow } from "../lib/assetVirtualRows";
import { useT } from "../lib/i18n";
import { computeMarquee, marqueeHits } from "../lib/marquee";
import { makeStore, saveString } from "../lib/storage";
import { loadManageWorkspaceScope } from "../lib/manageWorkspaceScope";
import { STORAGE_KEYS } from "../lib/storageKeys";
import { useFloatingPanel } from "../lib/useFloatingPanel";
import { addWindowMouseDrag, removeWindowMouseDrag } from "../lib/windowDrag";
import type { AssetComment, AssetNode, InfoTarget, PreviewTarget } from "../types";
import { AssetCell } from "./assets/AssetCell";
import { FolderIcon } from "./FolderIcon";
import { loadDisabledAssets, toggleDisabledAssets } from "../lib/deactivated";
import { AssetsCrumbBar } from "./assets/AssetsCrumbBar";
import { AssetsSidebar } from "./assets/AssetsSidebar";
import { MountManager } from "./assets/MountManager";
import { setSingleFileDrag, setZipDrag } from "./assets/exportDrag";
import {
  EMPTY_ASSET_META,
  INTERNAL_COMBINED_PROJECT,
  assetDragItemsForPath,
  assetPreviewTarget,
  toggleAssetDateSelection,
  type AssetSortDir,
  type AssetSortField,
  type AssetTypeFilter,
} from "./assets/assetsViewModel";
import { ASSET_COLOR_BY_KEY } from "./common/ColorFilterDots";
import { CommentPanel } from "./common/CommentPanel";
import { useAssetBroadcastSync } from "./assets/useAssetBroadcastSync";
import { useAssetCommentActions } from "./assets/useAssetCommentActions";
import { useAssetDropImport } from "./assets/useAssetDropImport";
import { useAssetFilterActions } from "./assets/useAssetFilterActions";
import { useAssetMetaActions } from "./assets/useAssetMetaActions";
import { useAssetProjectData } from "./assets/useAssetProjectData";
import { useAssetSelectionPersistence } from "./assets/useAssetSelectionPersistence";
import { useAssetViewData } from "./assets/useAssetViewData";
import { useAssetViewPersistence } from "./assets/useAssetViewPersistence";
import { useAssetViewerIdentity } from "./assets/useAssetViewerIdentity";
import { isAssetFolderHidden, visibleAssetTree } from "./assets/treeUtils";
import { useOutsideDragSelect } from "../lib/useOutsideDragSelect";

interface Props {
  onInfo: (t: InfoTarget) => void;
  onPreview: (t: PreviewTarget) => void;
}

export function AssetsView({ onInfo, onPreview }: Props) {
  const t = useT();
  // 내 신원(로그인 계정 creator_uid, 단독이면 'me') — 코멘트 '내 것' 판별용. 독립 창이라 자체 조회.
  const myId = useAssetViewerIdentity();
  // 선택 워크스페이스 — 프로젝트 유래 폴더를 생성 탭과 같은 범위로 좁힌다(수동 등록 폴더는 무관).
  // 분리 창이라 메인 창의 상태를 직접 못 받는다. 관리 창과 같은 방식으로 저장된 필터를 읽고
  // storage 이벤트로 따라간다(메인에서 팀을 바꾸면 이 창도 즉시 반영).
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(
    () => loadManageWorkspaceScope().workspaceId,
  );
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEYS.libraryFilters && event.key !== null) return;
      setWorkspaceId(loadManageWorkspaceScope().workspaceId);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  // 마지막으로 보던 상태를 기억(localStorage) → 다음에 열 때 그대로 복원
  const [dir, setDir] = useState<string>(() => LS.get("dir", ""));
  // 타입별 필터(이미지/영상/오디오) — 클릭하면 프로젝트 전체에서 그 타입만
  const [typeFilter, setTypeFilter] = useState<AssetTypeFilter>(
    () => {
      const t = LS.get("typeFilter", "");
      return t === "image" || t === "video" || t === "audio" ? t : null;
    },
  );
  // 좌측 폴더 트리에서 펼쳐둔 폴더 경로(마지막 구조 복원)
  const [expanded, setExpanded] = useState<Set<string>>(() => LS.loadSet("expanded"));
  // 저장된 값이 있으면 시드 완료로 간주(처음 한 번만 최상위 폴더 자동 펼침)
  const expandedSeeded = useRef(LS.get("expanded", "") !== "");
  const seedInitialExpandedDirs = useCallback((children: AssetNode[]) => {
    if (expandedSeeded.current) return;
    expandedSeeded.current = true;
    setExpanded(new Set(children.filter((node) => node.type === "dir").map((node) => node.path)));
  }, []);
  const {
    error,
    loading,
    meta,
    project,
    projects,
    linkedProjects,
    refreshProjectData,
    reloadMeta,
    reloadProjects,
    reloadTree,
    setMeta,
    setProject,
    tree,
  } = useAssetProjectData({ onTreeLoaded: seedInitialExpandedDirs, workspaceId });
  const displayTree = useMemo(() => visibleAssetTree(project, tree), [project, tree]);
  useEffect(() => {
    if (isAssetFolderHidden(project, dir)) setDir("");
  }, [dir, project]);
  const toggleDir = useCallback((path: string) => {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });
  }, []);
  // 생성탭과 동일 범위(0.7~1.7)로 clamp — 예전에 저장된 0.6 이하 값이면 카드가 생성탭보다 작게 떠서 겹침.
  const [scale, setScale] = useState(() =>
    Math.min(1.7, Math.max(0.7, Number(LS.get("scale", "1")) || 1)),
  );
  const [layout, setLayout] = useState<"grid" | "list">(() =>
    LS.get("layout", "grid") === "list" ? "list" : "grid",
  );
  // 그리드에서 파일 날짜별로 구분(섹션 헤더) — 그리드 버튼을 한 번 더 누르면 토글
  const [groupByDate, setGroupByDate] = useState(() => LS.get("groupByDate", "0") === "1");
  // 그리드 썸네일 맞춤: cover=꽉 채움(크롭) / contain=전체 보임(블랙바)
  const [fit, setFit] = useState<"cover" | "contain">(() =>
    LS.get("fit", "cover") === "contain" ? "contain" : "cover",
  );
  // 정렬 기준·방향(정렬 버튼) — 기본은 날짜 내림차순(최신 먼저), 마지막 선택 복원.
  const [sortField, setSortField] = useState<AssetSortField>(() => {
    const v = LS.get("sortField", "date");
    return v === "name" || v === "type" ? v : "date";
  });
  const [sortDir, setSortDir] = useState<AssetSortDir>(() =>
    LS.get("sortDir", "desc") === "asc" ? "asc" : "desc",
  );
  const metaRef = useRef(meta);
  metaRef.current = meta;
  const [tagEditPath, setTagEditPath] = useState<string | null>(null); // 인라인 태그 입력 중인 파일
  // 아래 검색/필터들도 마지막 상태로 복원 → 다음에 열 때 보던 화면 그대로
  const [query, setQuery] = useState(() => LS.get("query", "")); // 검색어 (#로 시작하면 태그 검색)
  // 좌측 필터: 컬러(다중)·소스만·태그
  const [activeColors, setActiveColors] = useState<Set<string>>(() => LS.loadSet("colors"));
  const [sourceOnly, setSourceOnly] = useState(() => LS.get("sourceOnly", "0") === "1");
  // 회색(비활성) — 에셋은 path 기준. grayOn=ON 이면 비활성 카드 숨김(다른 dot 과 반대).
  const [disabledAssets, setDisabledAssets] = useState<Set<string>>(loadDisabledAssets);
  const [grayOn, setGrayOn] = useState(() => LS.get("grayOn", "0") === "1");
  // C 필터: 새(미확인) 코멘트가 있는 파일만 보기
  const [commentOnly, setCommentOnly] = useState(() => LS.get("commentOnly", "0") === "1");
  // 태그 필터(다중 — Shift/Ctrl+클릭으로 중복 선택, 합집합). 구버전 단일 키에서 마이그레이션.
  const [activeTags, setActiveTags] = useState<Set<string>>(() => {
    const current = LS.loadSet("activeTags");
    if (current.size > 0) return current;
    const old = LS.get("activeTag", "");
    return old ? new Set<string>([old]) : current;
  });
  // 그리드/리스트 스크롤 위치(보던 위치) — 폴더·레이아웃·검색별로 복원. 스크롤 컨테이너는 gridRef 재사용.
  const scrollKey = `${project}|${dir}|${layout}|${query}|${typeFilter ?? ""}|${sortField}|${sortDir}`;
  const [tagPanelOpen, setTagPanelOpen] = useState(false);
  // 태그창 위치·크기를 마지막 상태로 기억(localStorage)
  const {
    pos: tagPanelPos,
    size: tagPanelSize,
    panelRef: tagPanelRef,
    onHeadMouseDown: onTagHeadDown,
  } = useFloatingPanel(LS, "tagPos", "tagSize", tagPanelOpen);

  // 코멘트 창(공유 스레드 + 내 비공개 — 비공개 작성·같이 보기는 CommentPanel 이 자체 관리)
  const [commentPath, setCommentPath] = useState<string | null>(null);
  const [comments, setComments] = useState<AssetComment[]>([]);
  const {
    pos: cmtPos,
    size: cmtSize,
    panelRef: cmtPanelRef,
    onHeadMouseDown: onCmtHeadDown,
  } = useFloatingPanel(LS, "cmtPos", "cmtSize", !!commentPath);

  // 등록 폴더(마운트) 관리 창
  const [mountOpen, setMountOpen] = useState(false);

  useAssetViewPersistence({
    activeColors,
    activeTags,
    commentOnly,
    dir,
    expanded,
    expandedSeeded,
    fit,
    grayOn,
    groupByDate,
    layout,
    project,
    query,
    scale,
    setDisabledAssets,
    sortDir,
    sortField,
    sourceOnly,
    store: LS,
    typeFilter,
  });

  // 스크롤 위치(보던 위치) 저장 — 폴더/레이아웃/검색 조합별. 스크롤 멈춤 후 150ms 저장(throttle).
  const scrollSaveTimer = useRef<number | null>(null);
  const onContentScroll = useCallback(() => {
    if (scrollSaveTimer.current) return;
    scrollSaveTimer.current = window.setTimeout(() => {
      scrollSaveTimer.current = null;
      const el = gridRef.current;
      if (el) LS.setJSON("scroll", { key: scrollKey, top: el.scrollTop });
    }, 150);
  }, [scrollKey]);

  const { allTags, breadcrumb, files, hasAnyUnread, searchActive } =
    useAssetViewData({
      activeColors,
      activeTags,
      commentOnly,
      dir,
      disabledAssets,
      grayOn,
      groupByDate,
      meta,
      query,
      sortDir,
      sortField,
      sourceOnly,
      tree: displayTree,
      typeFilter,
    });

  // 콘텐츠가 렌더된 뒤 보던 스크롤 위치 복원(같은 폴더/레이아웃/검색일 때만). 고정 높이라 이미지 로드 무관.
  // files.length 에만 의존 → 태그/소스/컬러 등 메타 편집(개수 불변)으로는 스크롤이 튀지 않음.
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const s = LS.loadJSON<{ key: string; top: number }>("scroll");
    el.scrollTop = s && s.key === scrollKey ? s.top || 0 : 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey, files.length]);

  // scrollKey 가 바뀌면(폴더·레이아웃·검색·정렬 변경) 아직 안 터진 스크롤 저장 타이머를 취소한다.
  // 안 그러면 옛 클로저 타이머가 150ms 뒤 '옛 key + 변경 후 위치'를 저장해 복원이 어긋난다.
  useEffect(() => {
    return () => {
      if (scrollSaveTimer.current) {
        clearTimeout(scrollSaveTimer.current);
        scrollSaveTimer.current = null;
      }
    };
  }, [scrollKey]);

  // ── 선택 시스템(클릭/마퀴/키보드) ──
  const gridRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [focusIdx, setFocusIdx] = useState(-1);
  const [marquee, setMarquee] = useState<{ l: number; t: number; w: number; h: number } | null>(null);
  const dragRef = useRef<{
    x: number; y: number; base: Set<number>; additive: boolean; range: boolean;
    anchor: number; moved: boolean; cellIdx: number;
  } | null>(null);
  const filesRef = useRef(files);
  filesRef.current = files;

  // ── 가상 스크롤(virtua) — 화면에 보이는 셀만 마운트(메모리). 생성 그리드와 동일 패턴. ──
  const isList = layout === "list";
  const vRef = useRef<VirtualizerHandle>(null);
  const [columns, setColumns] = useState(1);
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el || isList) {
      setColumns(1);
      return;
    }
    const measure = () => setColumns(computeGridColumns(el, Math.round(180 * scale), 12)); // gap 12 = .asset-vrow-grid
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scale, isList, files.length]);
  const rowModel = useMemo(
    () => buildAssetRows(files, isList ? 1 : columns, groupByDate),
    [files, isList, columns, groupByDate],
  );

  useAssetSelectionPersistence({
    activeColors,
    activeTags,
    commentOnly,
    dir,
    files,
    groupByDate,
    project,
    query,
    selected,
    setFocusIdx,
    setSelected,
    sortDir,
    sortField,
    sourceOnly,
    typeFilter,
  });

  const onDragMove = useCallback((e: MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
    d.moved = true;
    // 카드 위에서 시작한 드래그는 마퀴를 만들지 않고 현재 선택을 그대로 유지(이동 기능 없음).
    // → 빈 공간에서 시작한 드래그(cellIdx<0)만 러버밴드 선택. moved=true 라 mouseup 시 클릭선택도 안 함.
    if (d.cellIdx >= 0) return;
    const grid = gridRef.current;
    if (!grid) return;
    const { rect, b } = computeMarquee(grid, d, e);
    setMarquee(rect);
    const base = d.additive || d.range ? d.base : [];
    setSelected(marqueeHits<number>(grid, ".asset-cell", b, base, (el) => Number(el.dataset.idx)));
  }, []);

  const onDragUp = useCallback(() => {
    const d = dragRef.current;
    dragRef.current = null;
    removeWindowMouseDrag(onDragMove, onDragUp);
    setMarquee(null);
    if (!d) return;
    if (!d.moved) {
      // 드래그 없이 클릭만 → 선택 처리
      if (d.cellIdx >= 0) {
        if (d.range && d.anchor >= 0) {
          // Shift-클릭 = 앵커~클릭 사이 전부 선택(앵커 유지 → 연속 Shift-클릭으로 범위 조정).
          const lo = Math.min(d.anchor, d.cellIdx), hi = Math.max(d.anchor, d.cellIdx);
          const r = new Set<number>();
          for (let i = lo; i <= hi; i++) r.add(i);
          setSelected(r);
        } else if (d.additive) {
          setFocusIdx(d.cellIdx);
          setSelected((prev) => {
            const n = new Set(prev);
            if (n.has(d.cellIdx)) n.delete(d.cellIdx);
            else n.add(d.cellIdx);
            return n;
          });
        } else {
          setFocusIdx(d.cellIdx);
          setSelected(new Set([d.cellIdx]));
        }
      } else if (!d.additive && !d.range) {
        // 빈 공간 클릭 → 선택 + 포커스 링 모두 해제(생성탭과 동일)
        setFocusIdx(-1);
        setSelected(new Set());
      }
    }
  }, [onDragMove]);

  // 최신 선택/프로젝트를 ref 로 — exportDrag 를 안정 참조로 유지(React.memo 동작 보존).
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const projectRef = useRef(project);
  projectRef.current = project;

  // 네이티브 파일 드래그(OS/외부로 내보내기) 시작:
  //  · 진행 중이던 선택 드래그(마퀴)만 정리(선택 상태는 유지)
  //  · 드래그한 카드가 다중선택에 포함되면 선택 전체를 zip 으로, 아니면 그 파일 하나만 원본으로
  const exportDrag = useCallback((path: string, dt: DataTransfer) => {
    dragRef.current = null;
    removeWindowMouseDrag(onDragMove, onDragUp);
    setMarquee(null);

    const proj = projectRef.current;
    const { items, multi } = assetDragItemsForPath({
      project: proj,
      files: filesRef.current,
      selected: selectedRef.current,
      path,
    });
    if (multi) {
      setZipDrag(dt, proj, items.map((item) => item.path));
    } else {
      const file = filesRef.current.find((f) => f.path === path);
      const name = file?.name || path.split("/").pop() || path;
      // ★단일 이미지는 dataTransfer 를 건드리지 않는다 — img 가 draggable 이라 크롬이 '네이티브
      //  이미지 드래그'로 로컬 이미지를 직접 실어 외부 웹앱(클로드 대화창)이 파일로 받는다. 여기서
      //  DownloadURL/html 을 setData 하면 그 네이티브 이미지가 깨져 대화창이 아무것도 못 받는다.
      //  (아래 커스텀 타입 DRAG_TYPES.asset 은 내부 캔버스/트레이 감지용 '플래그'라 native 와 공존.)
      //  영상·오디오는 네이티브 이미지가 없으므로 기존대로 DownloadURL/URL 을 심는다.
      if (file?.type !== "image") setSingleFileDrag(dt, proj, path, name);
    }
    // 본창 프롬프트 레퍼런스 트레이로 드래그(같은 오리진 팝업↔본창)에서 읽을 커스텀 타입.
    // 다중선택에 포함되면 선택 전체를(그리드 순서 보존), 아니면 그 파일 하나만 배열로 싣는다 →
    // 트레이가 한 번에 여러 개를 번호순으로 추가한다.
    const payload = JSON.stringify(items);
    // dataTransfer 커스텀 타입은 '드롭 허용 플래그'로만 둔다 — 일부 브라우저가 팝업↔본창
    // 크로스윈도우 드래그에서 커스텀 배열을 한 건만 전달하는 문제가 있어, 전체 선택은 같은 오리진이
    // 공유하는 localStorage 로 넘긴다(본창 드롭이 이 키를 우선 읽는다). dragstart 마다 덮어써 항상 최신.
    dt.setData(DRAG_TYPES.asset, payload);
    try {
      saveString(STORAGE_KEYS.assetsDrag, payload);
    } catch {
      /* localStorage 불가 시 dataTransfer 폴백 */
    }
  }, [onDragMove, onDragUp]);

  // 복사: 선택한 원본 미디어(이미지·영상·오디오) 파일들을 OS 클립보드(파일 목록)에 올린다 → 대화창에서
  //  Ctrl+V 로 한 번에. (브라우저 클립보드는 이미지 1장 한계 → 로컬 백엔드가 CF_HDROP 을 채운다.
  //  단건이면 그 파일 하나, 다중선택이면 선택 전체를 올린다 — assetDragItemsForPath 가 선택-인지 처리.)
  const copyFilesToClipboard = useCallback(async (path: string) => {
    const proj = projectRef.current;
    const { items } = assetDragItemsForPath({
      project: proj,
      files: filesRef.current,
      selected: selectedRef.current,
      path,
    });
    const paths = items.map((it) => it.path); // 미디어 최종 판별은 백엔드(허용 확장자)에서
    if (paths.length === 0) throw new Error("복사할 파일이 없습니다");
    await api.clipboardCopyFiles(proj, paths);
  }, []);

  const {
    dropActive,
    importing,
    onZoneDragEnter,
    onZoneDragLeave,
    onZoneDragOver,
    onZoneDrop,
  } = useAssetDropImport({
    dir,
    project,
    onImported: refreshProjectData,
  });

  const onGridMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault(); // 미들클릭 자동스크롤 방지(정보는 auxclick 에서)
      return;
    }
    if (e.button !== 0) return;
    // 오버레이 버튼·날짜 헤더(label/체크박스) 위에서는 마퀴 시작 안 함
    if ((e.target as HTMLElement).closest("button, label, input")) return;
    gridRef.current?.focus();
    const cellEl = (e.target as HTMLElement).closest(".asset-cell") as HTMLElement | null;
    const cellIdx = cellEl ? Number(cellEl.dataset.idx) : -1;
    dragRef.current = {
      x: e.clientX,
      y: e.clientY,
      base: new Set(selected),
      additive: e.ctrlKey || e.metaKey, // Ctrl/Cmd = 개별 토글
      range: e.shiftKey, // Shift = 앵커~클릭 범위 선택
      anchor: focusIdx, // mousedown 시점 앵커 캡처(stale 클로저 회피)
      moved: false,
      cellIdx,
    };
    addWindowMouseDrag(onDragMove, onDragUp);
  };

  const onGridAux = (e: React.MouseEvent) => {
    if (e.button !== 1) return; // 미들클릭 = 파일 정보
    const cellEl = (e.target as HTMLElement).closest(".asset-cell") as HTMLElement | null;
    if (!cellEl) return;
    e.preventDefault();
    const f = filesRef.current[Number(cellEl.dataset.idx)];
    if (f) onInfo({ kind: "file", project, node: f, x: e.clientX, y: e.clientY });
  };

  const openPreview = useCallback(
    (f: AssetNode) => {
      const target = assetPreviewTarget(project, filesRef.current, f);
      if (target) onPreview(target);
    },
    [project, onPreview],
  );

  const onGridDblClick = (e: React.MouseEvent) => {
    // 버튼(S·T·C 등)·입력 위 더블클릭은 그 요소의 몫 — 클릭 2번이 미리보기로 승격되면 안 된다.
    if ((e.target as HTMLElement).closest("button, input, a, [contenteditable]")) return;
    const cellEl = (e.target as HTMLElement).closest(".asset-cell") as HTMLElement | null;
    if (!cellEl) return;
    const f = filesRef.current[Number(cellEl.dataset.idx)];
    if (f) openPreview(f);
  };

  const onGridKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return; // 인라인 입력 중엔 단축키 무시
    if (!filesRef.current.length) return;
    if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      const cur = focusIdx < 0 ? 0 : focusIdx;
      const nxt =
        focusIdx < 0
          ? 0
          : navigateGrid({ navGrid: rowModel.navGrid, posByGen: rowModel.posByIdx }, cur, e.key);
      if (nxt == null) return;
      setFocusIdx(nxt);
      if (e.shiftKey) setSelected((prev) => new Set([...prev, cur, nxt]));
      else setSelected(new Set([nxt]));
      // 가상 스크롤: 대상 셀의 행으로 스크롤(예전 scrollIntoView 는 오프스크린이면 DOM 이 없어 무효).
      const pos = rowModel.posByIdx[nxt];
      if (pos) vRef.current?.scrollToIndex(rowModel.rowIndexOfNavRow[pos.navRow], { align: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const f = filesRef.current[focusIdx];
      if (f) openPreview(f);
    } else if (e.key === "Escape") {
      setSelected(new Set());
    } else if (e.key === " ") {
      e.preventDefault();
      if (focusIdx >= 0)
        setSelected((prev) => {
          const s = new Set(prev);
          if (s.has(focusIdx)) s.delete(focusIdx);
          else s.add(focusIdx);
          return s;
        });
    } else if ((e.key === "a" || e.key === "A") && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      setSelected(new Set(filesRef.current.map((_, i) => i)));
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      const paths = selPaths();
      if (!paths.length) return;
      const k = e.key.toLowerCase();
      if (k === "s") { e.preventDefault(); sourceAssets(paths); }
      else if (e.key === "#") {
        e.preventDefault();
        setTagEditPath(filesRef.current[focusIdx]?.path || paths[0]); // 포커스 카드에서 인라인 입력
      }
      else if (k === "c") { e.preventDefault(); openComments(filesRef.current[focusIdx]?.path || paths[0]); }
      else if (ASSET_COLOR_BY_KEY[k]) { e.preventDefault(); colorAssets(paths, ASSET_COLOR_BY_KEY[k]); }
      else if (k === "d") { e.preventDefault(); toggleDisabledAssets(paths); } // 비활성(회색) 토글
    }
  };

  // ── 메타 작업(선택 파일 대상): s=소스 #=태그 c=코멘트 r/g/b=컬러 ──
  const {
    selPaths,
    reconcile,
    colorAssets,
    sourceAssets,
    toggleSource,
    removeAssetTag,
    setAssetTagsReplace,
    bulkTagAdd,
    bulkTagRemove,
    deleteTag,
  } = useAssetMetaActions({
    project,
    filesRef,
    metaRef,
    selected,
    activeTags,
    setMeta,
    setActiveTags,
    reloadMeta,
  });

  const { selectActiveTag, toggleColor, toggleTagPanel } = useAssetFilterActions({
    setActiveColors,
    setActiveTags,
    setTagPanelOpen,
    tagPanelOpen,
  });

  const { openComments, refreshComments, sendComment, editComment, delComment } = useAssetCommentActions({
    project,
    commentPath,
    setCommentPath,
    setComments,
    reconcile,
  });
  useAssetBroadcastSync({
    project,
    refreshProjectData,
    refreshTree: reloadTree,
    reloadProjects,
    refreshComments,
  });
  // 격자 밖(사이드바 여백·툴바 줄)에서 시작한 드래그도 선택으로 — 생성 탭과 같은 규칙.
  useOutsideDragSelect(".assets-grid-wrap", (e) => {
    e.preventDefault(); // 글자 선택·네이티브 드래그 방지(격자 안 경로는 자체 처리)
    onGridMouseDown(e as unknown as React.MouseEvent);
  });

  const gridHandlers = {
    ref: gridRef,
    tabIndex: 0,
    onMouseDown: onGridMouseDown,
    onAuxClick: onGridAux,
    onDoubleClick: onGridDblClick,
    onKeyDown: onGridKeyDown,
  };

  // 셀에 넘기는 핸들러를 안정 참조로 고정(React.memo 가 변화 없는 셀을 건너뛰게).
  // ref 로 항상 최신 클로저를 가리켜 stale selection/meta(특히 다중선택 태그)를 방지.
  const cellOpsRef = useRef({ toggleSource, openComments, setAssetTagsReplace, bulkTagAdd, bulkTagRemove, removeAssetTag });
  cellOpsRef.current = { toggleSource, openComments, setAssetTagsReplace, bulkTagAdd, bulkTagRemove, removeAssetTag };
  const cellOnS = useCallback((p: string) => cellOpsRef.current.toggleSource(p), []);
  const cellOnT = useCallback((p: string) => setTagEditPath(p), []); // 카드 T 클릭 = 인라인 태그 편집(키보드 #와 동일)
  const cellOnC = useCallback((p: string) => cellOpsRef.current.openComments(p), []);
  const cellOnTagsReplace = useCallback(
    (p: string, tags: string[]) => cellOpsRef.current.setAssetTagsReplace(p, tags),
    [],
  );
  const cellOnBulkTagAdd = useCallback(
    (p: string, names: string[]) => cellOpsRef.current.bulkTagAdd(p, names),
    [],
  );
  const cellOnBulkTagRemove = useCallback(
    (p: string, names: string[]) => cellOpsRef.current.bulkTagRemove(p, names),
    [],
  );
  // 태그모드 종료 시 그리드로 포커스 복원 — 안 그러면 사라진 input 에 포커스가 남아 바로 이어지는
  // r/g/b(컬러)·s 등 단축키가 그리드 keydown 에 안 들어간다(재선택해야 먹던 버그).
  const cellOnTagCancel = useCallback(() => {
    setTagEditPath(null);
    requestAnimationFrame(() => gridRef.current?.focus({ preventScroll: true }));
  }, []);

  // 그리드/리스트가 공유하는 셀 목록(중복 제거). layout 한 값으로 둘 중 하나만 렌더된다.
  // 다중선택 태그 편집 활성(편집 카드가 선택에 포함 + 2개 이상) — 선택된 비포커스 카드에 스트립 표시.
  const tagEditingMulti = tagEditPath != null && selected.size > 1 && selPaths().includes(tagEditPath);
  // 카드 셀은 virtua 가 렌더하는 '보이는 행' 안에서만 생성한다(오프스크린은 마운트 안 됨=메모리 절감).
  const renderAssetCell = (idx: number) => {
    const f = files[idx];
    if (!f) return null;
    return (
      <AssetCell
        key={f.path}
        project={project}
        node={f}
        idx={idx}
        layout={layout}
        scale={scale}
        fit={fit}
        selected={selected.has(idx)}
        focused={focusIdx === idx}
        deactivated={disabledAssets.has(f.path)}
        selectedCount={selected.has(idx) && selected.size > 1 ? selected.size : 1}
        tagEditing={tagEditingMulti}
        meta={meta[f.path] || EMPTY_ASSET_META}
        editingTag={tagEditPath === f.path}
        onS={cellOnS}
        onT={cellOnT}
        onC={cellOnC}
        onTagsReplace={cellOnTagsReplace}
        onBulkTagAdd={cellOnBulkTagAdd}
        onBulkTagRemove={cellOnBulkTagRemove}
        onTagCancel={cellOnTagCancel}
        onInfo={onInfo}
        onExportDrag={exportDrag}
        onCopyFiles={copyFilesToClipboard}
      />
    );
  };
  const marqueeEl = marquee && (
    <div
      className="assets-marquee"
      style={{ left: marquee.l, top: marquee.t, width: marquee.w, height: marquee.h }}
    />
  );

  // 날짜 헤더 체크박스 — 그 날짜의 모든 파일(인덱스)을 한 번에 선택/해제.
  const toggleDate = (idxs: number[], allSel: boolean) =>
    setSelected((prev) => toggleAssetDateSelection(prev, idxs, allSel));
  const renderDateHeader = (dayKey: string, label: string) => {
    const idxs = rowModel.dateGroups.get(dayKey)?.idxs ?? [];
    const allSel = idxs.length > 0 && idxs.every((idx) => selected.has(idx));
    return (
      <label className="gen-date-header" key={"h-" + dayKey}>
        <input type="checkbox" checked={allSel} onChange={() => toggleDate(idxs, allSel)} />
        <span className="gen-date-label">{label}</span>
        <span className="gen-date-count">{idxs.length}</span>
      </label>
    );
  };
  const renderVirtualRow = (row: AssetVirtualRow) => {
    if (row.type === "header") return renderDateHeader(row.dayKey, row.label);
    return (
      <div
        key={row.key}
        className={isList ? "asset-vrow-list" : "asset-vrow-grid"}
        style={isList ? undefined : { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {row.idxs.map(renderAssetCell)}
      </div>
    );
  };
  // 태그 인라인 편집 중인 셀의 행은 스크롤 밖이어도 마운트 유지(포커스·입력 보존) — 생성 그리드와 동일.
  const keepMounted = useMemo(() => {
    if (!tagEditPath) return undefined;
    const idx = files.findIndex((f) => f.path === tagEditPath);
    const navRow = idx >= 0 ? rowModel.posByIdx[idx]?.navRow : undefined;
    const rowIdx = navRow == null ? undefined : rowModel.rowIndexOfNavRow[navRow];
    return rowIdx == null ? undefined : [rowIdx];
  }, [tagEditPath, files, rowModel]);

  return (
    <div className="assets-view">
      <div className="assets-view-head">
        <button
          className="assets-title"
          title={t("폴더 등록")}
          onClick={() => setMountOpen(true)}
        >
          <FolderIcon width={20} height={16} /> Assets
        </button>
        {/* 하단 crumb 바에서 올라온 경로 정보 — 타입 슬라이더와 자리 교환(Jay 요청).
            프로젝트 선택은 사이드바(폴더 트리 위)로, 건수는 하단 슬라이더 옆으로 이동.
            색 규칙은 프로젝트 select 와 동일: PM 연결=라임 · 직접 등록=흰색 · 합본=회색. */}
        <div
          className={
            "assets-head-crumb"
            + (project === INTERNAL_COMBINED_PROJECT
              ? " internal"
              : linkedProjects.has(project)
                ? " linked"
                : "")
          }
        >
          {searchActive ? (
            <span className="crumb-search">
              {activeTags.size
                ? [...activeTags].map((tag) => `#${tag}`).join(" ")
                : sourceOnly
                  ? "소스"
                  : activeColors.size
                    ? "컬러"
                    : query.trim().startsWith("#")
                      ? "태그"
                      : "이름"}{" "}
              필터{query.trim() && !query.trim().startsWith("#") ? `: ${query.trim()}` : ""}
            </span>
          ) : (
            <>
              <button onClick={() => setDir("")}>{project}</button>
              {breadcrumb.map((segment, index) => (
                <span key={index}>
                  <span className="crumb-sep">/</span>
                  <button onClick={() => setDir(breadcrumb.slice(0, index + 1).join("/"))}>
                    {segment}
                  </button>
                </span>
              ))}
            </>
          )}
        </div>
        {/* 현재 선택 폴더(및 하위) 안에서 파일명 검색 — 폴더 미선택이면 프로젝트 전체. 우측 상단 배치 */}
        <div className="assets-search" title="선택한 폴더 안에서 파일명 검색 (#로 시작하면 태그)">
          <span className="as-icon">⌕</span>
          <input
            value={query}
            placeholder="Search"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button className="as-clear" title={t("지우기")} onClick={() => setQuery("")}>
              ✕
            </button>
          )}
        </div>
      </div>

      {mountOpen && (
        <MountManager
          onClose={() => setMountOpen(false)}
          onChanged={() => reloadProjects(true)}
          workspaceId={workspaceId}
        />
      )}

      <div className="assets-body">
        <AssetsSidebar
          project={project}
          projects={projects}
          linkedProjects={linkedProjects}
          onProjectChange={(p) => {
            setProject(p);
            setDir(""); // 사용자가 프로젝트를 바꾸면 루트로
          }}
          typeFilter={typeFilter}
          dir={dir}
          meta={meta}
          sourceOnly={sourceOnly}
          onRoot={() => {
            setQuery("");
            setDir("");
          }}
          loading={loading}
          tree={displayTree}
          expanded={expanded}
          onToggleDir={toggleDir}
          onSelectDir={(p) => {
            setQuery("");
            setDir(p);
          }}
        />

        <main
          className="assets-grid-wrap"
          onDragEnter={onZoneDragEnter}
          onDragOver={onZoneDragOver}
          onDragLeave={onZoneDragLeave}
          onDrop={onZoneDrop}
        >
          {dropActive && (
            <div className="assets-dropzone">
              <div className="assets-dropzone-card">
                <span className="adz-icon">⤓</span>
                <span className="adz-title">현재 폴더로 가져오기</span>
                <span className="adz-sub">{dir ? `${project} / ${dir}` : project || "…"}</span>
              </div>
            </div>
          )}
          {importing && <div className="assets-importing">가져오는 중…</div>}
          <AssetsCrumbBar
            tagPanelOpen={tagPanelOpen}
            allTags={allTags}
            activeTags={activeTags}
            tagPanelRef={tagPanelRef}
            tagPanelPos={tagPanelPos}
            tagPanelSize={tagPanelSize}
            onTagHeadMouseDown={onTagHeadDown}
            onClearTags={() => setActiveTags(new Set())}
            onSelectTag={selectActiveTag}
            onDeleteTag={deleteTag}
            sourceOnly={sourceOnly}
            activeColors={activeColors}
            typeFilter={typeFilter}
            onTypeFilterChange={setTypeFilter}
            fileCount={files.length}
            onToggleColor={toggleColor}
            grayOn={grayOn}
            onToggleGray={() => setGrayOn((v) => !v)}
            onToggleSourceOnly={() => {
              const next = !sourceOnly;
              setSourceOnly(next);
              if (next) setDir(""); // 소스 필터 켜면 루트로 → 프로젝트 전체 소스 표시(생성탭 @피커와 동일 범위)
            }}
            tagFilterActive={tagPanelOpen || activeTags.size > 0}
            onToggleTagPanel={toggleTagPanel}
            commentOnly={commentOnly}
            hasAnyUnread={hasAnyUnread}
            onToggleCommentOnly={() => setCommentOnly((v) => !v)}
            fit={fit}
            onToggleFit={() => setFit((f) => (f === "cover" ? "contain" : "cover"))}
            scale={scale}
            onScale={setScale}
            layout={layout}
            groupByDate={groupByDate}
            onSelectLayout={setLayout}
            onToggleGroupByDate={() => setGroupByDate((v) => !v)}
            sortField={sortField}
            sortDir={sortDir}
            onSortField={setSortField}
            onSortDir={setSortDir}
          />

          {commentPath && (
            <CommentPanel
              key={commentPath}
              comments={comments}
              label={commentPath.split("/").pop() || ""}
              myId={myId}
              panelRef={cmtPanelRef}
              pos={cmtPos}
              size={cmtSize}
              onHeadMouseDown={onCmtHeadDown}
              onClose={() => setCommentPath(null)}
              onSend={sendComment}
              onEdit={editComment}
              onDelete={delComment}
            />
          )}

          {error && <div className="error" style={{ padding: 12 }}>{error}</div>}

          {files.length === 0 && !loading ? (
            <div className="assets-empty">{t("이 폴더에 미디어가 없습니다.")}</div>
          ) : (
            <div
              className={
                (isList ? "assets-list" : "assets-masonry") +
                " assets-virtual" +
                (!isList && fit === "contain" ? " fit-contain" : "")
              }
              onScroll={onContentScroll}
              {...gridHandlers}
            >
              <div className="asset-grid-head" />
              <Virtualizer
                ref={vRef}
                scrollRef={gridRef}
                data={rowModel.rows}
                bufferSize={400}
                startMargin={isList ? 10 : 14}
                keepMounted={keepMounted}
              >
                {(row: AssetVirtualRow) => renderVirtualRow(row)}
              </Virtualizer>
              <div className="asset-grid-tail" />
              {marqueeEl}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

// 마지막으로 보던 Assets 상태 영속화(프로젝트·폴더·크기·레이아웃)
const LS = makeStore("ch.assets.");
