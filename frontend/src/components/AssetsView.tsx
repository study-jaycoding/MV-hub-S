// Assets(구성) 뷰 — Higgsfield 자산 라이브러리 풍으로:
//  · 메이슨리(핀터레스트형) 그리드 + 리스트 토글, 크기 조절 슬라이더
//  · 영상 호버 자동재생 + 미디어 호버 오버레이(정보·미리보기·다운로드)
//  · 좌측 폴더 트리는 유지. 셀 휠클릭=정보, 클릭=미리보기.
import { isKeyHandled } from "../lib/keyHandled";
import { activationKeyOwned, backgroundKeysBlocked, isTypingTarget, useLooseKeys } from "../lib/keyGate";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { Virtualizer, type VirtualizerHandle } from "virtua";
import { api } from "../api";
import { DRAG_TYPES } from "../lib/dragTypes";
import { computeGridColumns, navigateGrid } from "../lib/gridVirtualRows";
import { buildAssetRows, type AssetVirtualRow } from "../lib/assetVirtualRows";
import { useT } from "../lib/i18n";
import { computeMarquee, marqueeHits } from "../lib/marquee";
import { makeStore, saveString } from "../lib/storage";
import { usePlaceView } from "../lib/usePlaceView";
import { PLACE_VIEWS_KEY, parsePlaceViews } from "../lib/placeViews";
import { loadManageWorkspaceScope } from "../lib/manageWorkspaceScope";
import { STORAGE_KEYS } from "../lib/storageKeys";
import { flashMsg } from "../lib/flash";
import { useFloatingPanel } from "../lib/useFloatingPanel";
import { addWindowMouseDrag, dragLost, removeWindowMouseDrag } from "../lib/windowDrag";
import type { AssetComment, AssetNode, InfoTarget, PreviewTarget } from "../types";
import { AssetCell } from "./assets/AssetCell";
import { FolderIcon } from "./FolderIcon";
import { SidebarEdgeToggle } from "./common/SidebarEdgeToggle";
import { loadDisabledAssets, toggleDisabledAssets } from "../lib/deactivated";
import { AssetsCrumbBar } from "./assets/AssetsCrumbBar";
import { AssetsSidebar } from "./assets/AssetsSidebar";
import { AssetFolderGrid } from "./assets/AssetFolderGrid";
import { AssetFolderTabs } from "./assets/AssetFolderTabs";
import { assetFolderGroups } from "./assets/assetFolderGroups";
import { useAssetFolderTabs, type AssetFolderLayout } from "./assets/useAssetFolderTabs";
import { MountManager } from "./assets/MountManager";
import { nativeDragBrowserSupported, setSingleFileDrag, startNativeAssetDrag } from "./assets/exportDrag";
import {
  EMPTY_ASSET_META,
  INTERNAL_COMBINED_PROJECT,
  assetDragItemsForPath,
  assetPreviewTarget,
  copyAssetFiles,
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
import { LocalImportCards } from "./assets/LocalImportCards";
import { useAssetFilterActions } from "./assets/useAssetFilterActions";
import { ASSET_META_NOT_READY, useAssetMetaActions } from "./assets/useAssetMetaActions";
import { useAssetProjectData } from "./assets/useAssetProjectData";
import { useAssetSelectionPersistence } from "./assets/useAssetSelectionPersistence";
import { useAssetViewData } from "./assets/useAssetViewData";
import { useAssetViewPersistence } from "./assets/useAssetViewPersistence";
import { useAssetViewerIdentity } from "./assets/useAssetViewerIdentity";
import { ResolveProjectBrowser } from "./assets/ResolveProjectBrowser";
import { assetFolderLabel, isAssetFolderHidden, visibleAssetTree } from "./assets/treeUtils";
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
      if (event.key !== STORAGE_KEYS.workspaceContext && event.key !== null) return;
      setWorkspaceId(loadManageWorkspaceScope().workspaceId);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  // 마지막으로 보던 상태를 기억(localStorage) → 다음에 열 때 그대로 복원
  const [dir, setDir] = useState<string>(() => LS.get("dir", ""));
  const gridRef = useRef<HTMLDivElement>(null);
  const pendingTabScroll = useRef<number | null>(null);
  const [folderModePath, setFolderModePath] = useState<string | undefined>(() => LS.get("folderModePath", "") || undefined);
  useEffect(() => LS.set("folderModePath", folderModePath ?? ""), [folderModePath]);
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
  // 왼쪽 폴더 트리 여닫기(Jay 2026-10-26 — 워크스페이스 사이드바와 같은 끝선 손잡이). 이 창만의 기억, 처음엔 열림.
  const [treeOpen, setTreeOpen] = useState(() => LS.get("treeOpen", "1") !== "0");
  useEffect(() => LS.set("treeOpen", treeOpen ? "1" : "0"), [treeOpen]);
  const canLeaveCommentRef = useRef<() => boolean>(() => true); // 아래 canLeaveComment — 코멘트 창보다 먼저 만드는 훅이 쓴다(Jay 결정 5A)
  const {
    error,
    loading,
    meta,
    metaReady,
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
  } = useAssetProjectData({ onTreeLoaded: seedInitialExpandedDirs, workspaceId, canLeaveProject: () => canLeaveCommentRef.current() });
  const displayTree = useMemo(() => visibleAssetTree(project, tree), [project, tree]);
  useEffect(() => {
    if (isAssetFolderHidden(project, dir)) {
      setDir(dir.replace(/\\/g, "/").toLowerCase().startsWith("@davinci/") ? "@davinci" : "");
    }
  }, [dir, project]);
  const toggleDir = useCallback((path: string) => {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });
  }, []);
  const place = JSON.stringify([myId, workspaceId ?? "", project,
    dir.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "")]);
  const fileView = usePlaceView(LS, place, {
    layout: LS.get("layout", "grid") === "list" ? "list" : "grid",
    group: LS.get("groupByDate", "0") === "1",
    scale: Number(LS.get("scale", "1")) || 1,
    fill: LS.get("fit", "cover") !== "contain",
    ...(LS.get("folderMode", "1") === "0" ? { folders: false } : {}),
  });
  const folderView = usePlaceView(FOLDER_LS, place, {
    layout: ["list", "table"].includes(LS.get("folderLayout", "grid")) ? "list" : "grid",
    group: LS.get("folderLayout", "grid") === "table",
    scale: Number(LS.get("folderScale", "1")) || 1,
    fill: LS.get("folderFit", "cover") !== "contain",
  });
  const { layout, setLayout, groupByDate, setGroupByDate, scale, setScale, folders: folderMode, setFolders: setFolderMode } = fileView;
  const { scale: folderScale, setScale: setFolderScale } = folderView;
  const fit = fileView.fill ? "cover" : "contain";
  const folderFit = folderView.fill ? "cover" : "contain";
  const setFit = (action: SetStateAction<"cover" | "contain">) => fileView.setFill((fill) =>
    (typeof action === "function" ? action(fill ? "cover" : "contain") : action) === "cover");
  const setFolderFit = (action: SetStateAction<"cover" | "contain">) => folderView.setFill((fill) =>
    (typeof action === "function" ? action(fill ? "cover" : "contain") : action) === "cover");
  const folderLayout: AssetFolderLayout = folderView.layout === "grid" ? "grid" : folderView.groupByDate ? "table" : "list";
  const setFolderLayout = (action: SetStateAction<AssetFolderLayout>) => {
    const next = typeof action === "function" ? action(folderLayout) : action;
    folderView.setLayout(next === "grid" ? "grid" : "list");
    folderView.setGroupByDate(next === "table");
  };
  const [lastViewed, setLastViewed] = useState(() => LS.get("lastViewed", ""));
  useEffect(() => LS.set("folderMode", folderMode ? "1" : "0"), [folderMode]);
  useEffect(() => LS.set("folderScale", String(folderScale)), [folderScale]);
  useEffect(() => LS.set("folderLayout", folderLayout), [folderLayout]);
  useEffect(() => LS.set("folderFit", folderFit), [folderFit]);
  useEffect(() => LS.set("lastViewed", lastViewed), [lastViewed]);
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
  // 폴더가 바뀌면 열려 있던 태그 입력을 닫는다(그리기 전에 — 조작 규칙 45). 경로만 들고 있어, 새 폴더에 같은 경로의 파일이 있으면 그
  //  파일에 입력이 저절로 열린다(코멘트 패널을 닫는 것과 같은 까닭 — useAssetCommentActions).
  useLayoutEffect(() => {
    setTagEditPath(null);
  }, [project]);
  // 태그 입력은 이 폴더의 메타를 받은 뒤에만 연다 — 편집기는 열 때의 태그를 사본으로 쥐므로, 메타가 오기 전에 열면 빈 칩으로 시작해
  //  다음 Enter 가 기존 태그를 지운 목록을 저장한다(Codex 코드 리뷰).
  const metaReadyRef = useRef(metaReady);
  metaReadyRef.current = metaReady;
  const startTagEdit = useCallback((path: string) => {
    if (metaReadyRef.current) setTagEditPath(path);
    else flashMsg(ASSET_META_NOT_READY);
  }, []);
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
  const isResolveLibraryRoot = dir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase() === "@davinci";

  const folderTabs = useAssetFolderTabs({
    scope: `${myId}\u0000${workspaceId ?? ""}\u0000${project}`,
    read: () => ({ dir, query, typeFilter, activeColors, activeTags, sourceOnly, commentOnly, grayOn,
      sortField, sortDir, scale, fit, layout, folderScale, folderFit, folderLayout, groupByDate, folderMode, folderModePath, scrollTop: gridRef.current?.scrollTop ?? 0 }),
    canLeave: () => canLeaveCommentRef.current(),
    apply: (view) => {
      pendingTabScroll.current = view.scrollTop;
      setDir(view.dir); setQuery(view.query); setTypeFilter(view.typeFilter);
      setActiveColors(view.activeColors); setActiveTags(view.activeTags);
      setSourceOnly(view.sourceOnly); setCommentOnly(view.commentOnly); setGrayOn(view.grayOn);
      setSortField(view.sortField); setSortDir(view.sortDir);
      setFolderModePath(view.folderModePath);
      setCommentPath(null); setTagEditPath(null); setTagPanelOpen(false);
      setSelected(new Set()); setFocusIdx(-1);
    },
  });
  const scrollKey = `${place}|${folderMode}|${folderModePath ?? ""}|${folderMode ? folderLayout : layout}|${query}|${typeFilter ?? ""}|${sortField}|${sortDir}`;

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

  const folderGroups = useMemo(() => assetFolderGroups(displayTree, dir, files, project), [displayTree, dir, files, project]);
  const canShowFolders = folderGroups.groups.length > 0 && !isResolveLibraryRoot;
  const rememberedFolderMode = parsePlaceViews(LS.loadJSON(PLACE_VIEWS_KEY))[place]?.folders;
  // 혼합 폴더의 기본은 전체지만, 사용자가 누른 폴더 보기는 현재 경로에서 우선한다.
  const showFolders = folderMode && canShowFolders
    && (!folderGroups.hasDirectFiles || rememberedFolderMode === true
      || folderModePath === `${project}|${dir}`);
  // 트리가 온 뒤 첫 실제 보기를 기억한다. 암묵 폴더 보기를 비워두면 다른 폴더의
  // '전체'를 다시 물려받고, 트리 도착 전에 true를 적으면 혼합 폴더의 기본이 바뀐다.
  useEffect(() => {
    if (project && !loading && canShowFolders && rememberedFolderMode === undefined) setFolderMode(showFolders);
  }, [project, loading, canShowFolders, rememberedFolderMode, showFolders, setFolderMode]);
  const visibleGroups = searchActive || typeFilter || grayOn
    ? folderGroups.groups.filter((group) => group.files.length > 0) : folderGroups.groups;

  // 콘텐츠가 렌더된 뒤 보던 스크롤 위치 복원(같은 폴더/레이아웃/검색일 때만). 고정 높이라 이미지 로드 무관.
  // files.length 에만 의존 → 태그/소스/컬러 등 메타 편집(개수 불변)으로는 스크롤이 튀지 않음.
  //  **화면이 바뀌었을 때(scrollKey)와 그 화면의 파일이 처음 도착했을 때만** 맞춘다 — 같은 화면에서 파일 수만 바뀐 것(비활성 숨기기·자동 새로
  //  고침)에 저장된 자리로 되돌리면, 방금 스크롤한 것(저장은 150ms 뒤다)이 옛 자리로 튄다.
  //  격자가 내려갔다 다시 그려지면(빈 폴더를 거쳐 돌아옴) 새 격자는 맨 위다 — 그때는 다시 맞춘다.
  const scrollRestored = useRef({ key: "", filled: false });
  useEffect(() => {
    const el = gridRef.current;
    if (!el) {
      scrollRestored.current = { key: "", filled: false };
      pendingTabScroll.current = null;
      return;
    }
    if (pendingTabScroll.current === null && scrollRestored.current.key === scrollKey && scrollRestored.current.filled) return;
    scrollRestored.current = { key: scrollKey, filled: files.length > 0 };
    const s = LS.loadJSON<{ key: string; top: number }>("scroll");
    el.scrollTop = pendingTabScroll.current ?? (s && s.key === scrollKey ? s.top || 0 : 0);
    pendingTabScroll.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey, folderTabs.active, files.length]);

  // scrollKey 가 바뀌면(폴더·레이아웃·검색·정렬 변경) 아직 안 터진 스크롤 저장 타이머를 취소한다.
  // 안 그러면 옛 클로저 타이머가 150ms 뒤 '옛 key + 변경 후 위치'를 저장해 복원이 어긋난다.
  useEffect(() => {
    return () => {
      if (scrollSaveTimer.current) {
        clearTimeout(scrollSaveTimer.current);
        scrollSaveTimer.current = null;
      }
    };
  }, [scrollKey, folderTabs.active]);

  // ── 선택 시스템(클릭/마퀴/키보드) ──
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [focusIdx, setFocusIdx] = useState(-1);
  const [marquee, setMarquee] = useState<{ l: number; t: number; w: number; h: number } | null>(null);
  // 누른 순간의 선택·기준·누른 칸은 번호가 아니라 **파일 경로**로 든다(조작 규칙 45): 누르고 있는 사이 목록이 바뀌면(누른 채 d 로 숨김·
  //  자동 새로 고침) 번호는 다른 파일을 가리킨다. 쓸 때마다 지금 목록의 번호로 바꾼다(indexOfPath).
  const dragRef = useRef<{
    x: number; y: number; basePaths: Set<string>; additive: boolean; range: boolean;
    anchorPath: string | null; moved: boolean; cellPath: string | null; onCell: boolean;
    hitPaths?: string[]; // 끌어 고른(마퀴) 마지막 결과 — 끝낼 때 초점을 여기에 맞춘다
    applied?: boolean; // 누를 때 이미 골랐다 — 뗄 때 다시 고르지 않는다(Ctrl 이 두 번 뒤집히지 않게)
    madePaths?: string[]; // 누름이 만든 선택 — 그사이 사용자가 바꿨으면 놓친 끝에서 되돌리지 않는다(Codex 검토 2)
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
  }, [scale, isList, files.length, showFolders]);
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
    // → 빈 공간에서 시작한 드래그만 러버밴드 선택. moved=true 라 mouseup 시 클릭선택도 안 함.
    if (d.onCell) return;
    const grid = gridRef.current;
    if (!grid) return;
    const { rect, b } = computeMarquee(grid, d, e);
    setMarquee(rect);
    const live = filesRef.current;
    const base = d.additive || d.range ? live.flatMap((file, idx) => (d.basePaths.has(file.path) ? [idx] : [])) : [];
    const hits = marqueeHits<number>(grid, ".asset-cell", b, base, (el) => Number(el.dataset.idx));
    d.hitPaths = [...hits].map((idx) => live[idx]?.path).filter((path): path is string => !!path);
    setSelected(hits);
  }, []);

  // 누른 파일 고르기 — 고르지 않은 파일은 누를 때(onGridMouseDown), 이미 고른 파일은 움직이지 않고 뗄 때(onDragUp) 부른다. 만든 선택을 돌려준다.
  const pickCell = useCallback((d: NonNullable<typeof dragRef.current>): Set<number> | undefined => {
    const cellIdx = indexOfPath(filesRef.current, d.cellPath);
    const anchor = indexOfPath(filesRef.current, d.anchorPath);
    if (cellIdx < 0) return; // 누른 파일이 그사이 목록에서 사라졌다 — 그 자리에 온 다른 파일을 고르지 않는다
    if (d.range && anchor >= 0) {
      // Shift-클릭 = 앵커~클릭 사이 전부 선택(앵커 유지 → 연속 Shift-클릭으로 범위 조정).
      const lo = Math.min(anchor, cellIdx), hi = Math.max(anchor, cellIdx);
      const r = new Set<number>();
      for (let i = lo; i <= hi; i++) r.add(i);
      setSelected(r);
      return r;
    }
    if (d.additive) {
      setFocusIdx(cellIdx);
      const n = new Set(selectedRef.current);
      if (n.has(cellIdx)) n.delete(cellIdx);
      else n.add(cellIdx);
      setSelected(n);
      return n;
    }
    setFocusIdx(cellIdx);
    const one = new Set([cellIdx]);
    setSelected(one);
    return one;
  }, []);

  const onDragUp = useCallback((e?: Event) => {
    const d = dragRef.current;
    dragRef.current = null;
    removeWindowMouseDrag(onDragMove, onDragUp);
    setMarquee(null);
    // 놓친 끌기(창을 떠남·단추를 뗀 채 온 움직임 — lib/windowDrag)는 정리만 한다 — 누른 채 Alt+Tab 한 것이 클릭으로 확정되지 않게
    if (!d) return;
    // 끌어 고른 뒤의 초점은 고른 것 중 목록의 마지막 파일이다(컷 카드·라이브러리 격자와 같은 규칙 — 조작 규칙 45). 그대로 두면 초점이
    //  끌기 전에 누른 파일에 남아, Enter 가 고르지 않은 그 파일을 열고 Shift 클릭이 거기서 범위를 잡았다. 아무것도 안 걸렸으면 초점도 없다.
    //  놓친 끌기(창을 떠남)에서도 맞춘다 — 선택은 끄는 동안 이미 바뀌어 있다. 번호는 **지금 목록**에서 다시 찾는다.
    if (d.hitPaths) {
      const picked = new Set(d.hitPaths);
      setFocusIdx(filesRef.current.reduce((last, file, idx) => (picked.has(file.path) ? idx : last), -1));
    }
    if (dragLost(e)) {
      // 놓친 끝·Esc 는 클릭이 아니다 — 누를 때 고른 것을 누르기 전으로 되돌린다(번호는 지금 목록에서 다시 찾는다). 지금 선택이 그 누름이
      //  만든 것 그대로일 때만 — 누르는 사이 Ctrl+A·방향키로 바꾼 선택은 덮지 않는다(Codex 검토 2 R1).
      const now = new Set([...selectedRef.current].map((idx) => filesRef.current[idx]?.path));
      if (d.applied && d.madePaths && d.madePaths.length === now.size && d.madePaths.every((path) => now.has(path))) {
        setSelected(new Set(filesRef.current.flatMap((file, idx) => (d.basePaths.has(file.path) ? [idx] : []))));
        setFocusIdx(indexOfPath(filesRef.current, d.anchorPath));
      }
      return;
    }
    if (!d.moved) {
      // 드래그 없이 클릭만 → 선택 처리(누를 때 이미 고른 파일은 그대로)
      if (d.onCell) {
        if (!d.applied) pickCell(d);
      } else if (!d.additive && !d.range) {
        // 빈 공간 클릭 → 선택 + 포커스 링 모두 해제(생성탭과 동일)
        setFocusIdx(-1);
        setSelected(new Set());
      }
    }
  }, [onDragMove, pickCell]);

  // 최신 선택/프로젝트를 ref 로 — exportDrag 를 안정 참조로 유지(React.memo 동작 보존).
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const projectRef = useRef(project);
  projectRef.current = project;

  // 네이티브 파일 드래그(OS/외부로 내보내기) 시작:
  //  · 진행 중이던 선택 드래그(마퀴)만 정리(선택 상태는 유지)
  //  · 고른 카드에서 시작하면 선택 전체를 Windows 원본 파일 목록으로 전달한다.
  const [nativeDragAvailable, setNativeDragAvailable] = useState(false);
  const cancelNativeDragRef = useRef<(() => void) | null>(null);
  useEffect(() => () => {
    cancelNativeDragRef.current?.();
    cancelNativeDragRef.current = null;
  }, []);
  useEffect(() => {
    if (!nativeDragBrowserSupported()) return;
    let alive = true;
    void api.nativeAssetDragCapabilities()
      .then((result) => { if (alive) setNativeDragAvailable(result.supported); })
      .catch(() => { /* old/non-local hubs keep internal HTML dragging */ });
    return () => { alive = false; };
  }, []);

  const exportDrag = useCallback((path: string, event: React.DragEvent) => {
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
    if (nativeDragAvailable) {
      const cancel = startNativeAssetDrag(event, proj, items);
      if (cancel) cancelNativeDragRef.current = cancel;
      return;
    }
    const dt = event.dataTransfer;
    if (multi) {
      flashMsg("이 허브에서는 앱 내부 다중 드래그만 지원합니다. 외부 첨부는 원본 복사(📋) 후 붙여넣기를 사용해주세요.");
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
  }, [onDragMove, onDragUp, nativeDragAvailable]);

  // 복사: 선택한 원본 미디어(이미지·영상·오디오) 파일들을 OS 클립보드(파일 목록)에 올린다 → 대화창에서
  //  Ctrl+V 로 한 번에. (브라우저 클립보드는 이미지 1장 한계 → 로컬 백엔드가 CF_HDROP 을 채운다.
  //  단건이면 그 파일 하나, 다중선택이면 선택 전체를 올린다 — assetDragItemsForPath 가 선택-인지 처리.)
  const copyFilesToClipboard = useCallback(
    (path: string) =>
      copyAssetFiles(
        { project: projectRef.current, files: filesRef.current, selected: selectedRef.current, path },
        api.clipboardCopyFiles,
      ),
    [],
  );

  const onAssetsImported = useCallback((targetProject: string) => refreshProjectData(targetProject, true), [refreshProjectData]);
  const {
    dropActive,
    importing,
    localImports,
    onZoneDragEnter,
    onZoneDragLeave,
    onZoneDragOver,
    onZoneDrop,
  } = useAssetDropImport({
    dir,
    project,
    onImported: onAssetsImported,
  });
  const visibleLocalImports = localImports.filter(item => item.project === project && item.dir === dir);

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
    const pathAt = (idx: number) => filesRef.current[idx]?.path ?? null;
    dragRef.current = {
      x: e.clientX,
      y: e.clientY,
      basePaths: new Set([...selected].map(pathAt).filter((path): path is string => path !== null)),
      additive: e.ctrlKey || e.metaKey, // Ctrl/Cmd = 개별 토글
      range: e.shiftKey, // Shift = 앵커~클릭 범위 선택
      anchorPath: pathAt(focusIdx), // mousedown 시점 앵커 캡처(stale 클로저 회피)
      moved: false,
      cellPath: pathAt(cellIdx),
      onCell: cellIdx >= 0,
    };
    addWindowMouseDrag(onDragMove, onDragUp);
    // 고르지 않은 파일은 누르는 순간 고른다 — 뗄 때만 고르면 빠르게 이어 누르는 동안 손이 움직여(5px 문턱·파일의 브라우저 끌기) 클릭이
    //  버려졌다(Jay 10-22). 이미 고른 파일은 뗄 때 정한다 — 누를 때 줄이면 여러 장 끌어 내보내기가 깨진다.
    if (cellIdx >= 0 && !selected.has(cellIdx)) {
      dragRef.current.applied = true;
      const made = pickCell(dragRef.current);
      dragRef.current.madePaths = made ? [...made].map(pathAt).filter((path): path is string => path !== null) : [];
    }
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
      if (target) { setLastViewed(`${project}|${f.path}`); onPreview(target); }
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

  // 격자의 키 — 격자에 초점이 있을 때(onKeyDown)와 초점 잃은 키(useLooseKeys, 아래)가 같이 쓴다. 그래서 원래 이벤트를 받는다(워크스페이스 격자와 같다).
  const onGridKey = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target)) return; // 인라인 입력 중엔 단축키 무시
    if (backgroundKeysBlocked()) return; // 위에 뜬 창·메뉴의 키(lib/keyGate)
    if (activationKeyOwned(e)) return; // Tab 으로 찾아간 카드 단추(S·T·C)의 Enter·Space 는 그 단추를 누르는 키
    if (!filesRef.current.length) return;
    // 길게 눌러 반복된 keydown — 반복이 뜻인 것은 방향키(이동)뿐이다. 나머지(Space 선택·s·r/g/b·d·Enter·#·c)는 토글·열기라 반복마다
    //  뒤집힌다: 기본 동작(Space 의 스크롤)만 막고 다시 하지 않는다(조작 규칙 38).
    if (e.repeat && !e.key.startsWith("Arrow")) {
      if (e.key === " ") e.preventDefault();
      return;
    }
    if (e.altKey && e.key.startsWith("Arrow")) return; // Alt+←/→ 는 브라우저의 뒤로/앞으로(생성물·컷 격자와 같다 — 56회차)
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
      if (isKeyHandled(e)) return; // 위에 떠 있던 창이 이미 쓴 Esc
      onDragUp(e); // Esc는 끌기만 취소한다. 선택과 뒤늦은 mouseup의 클릭 판정을 분리한다.
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
        startTagEdit(filesRef.current[focusIdx]?.path || paths[0]); // 포커스 카드에서 인라인 입력
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
    restoreEpoch,
  } = useAssetMetaActions({
    project,
    filesRef,
    metaRef,
    selected,
    activeTags,
    setMeta,
    setActiveTags,
    reloadMeta,
    ready: metaReady,
  });

  const { selectActiveTag, toggleColor, toggleTagPanel } = useAssetFilterActions({
    setActiveColors,
    setActiveTags,
    setTagPanelOpen,
    tagPanelOpen,
  });

  // 코멘트 창에 보내지 않은 글이 있으면 다른 파일·프로젝트로 가기 전에 묻는다(Jay 결정 5A) — 창은 파일마다 다시 그려져, 묻지 않고
  //  옮기면 쓰던 글이 사라졌다(65회차 실측). 창 닫기·새로 고침은 6A(holdUnload)가 묻는다.
  const commentUnsentRef = useRef(false);
  const onCommentUnsent = useCallback((unsent: boolean) => { commentUnsentRef.current = unsent; }, []);
  const canLeaveComment = () => !commentUnsentRef.current || window.confirm(
    t("보내지 않은 코멘트가 있습니다 — '{name}' 에 쓰던 글이 사라집니다. 버리고 옮길까요?").replace("{name}", commentPath?.split("/").pop() || ""),
  );
  canLeaveCommentRef.current = canLeaveComment; // 프로젝트 목록 조회(위 useAssetProjectData)가 저절로 옮기기 전에도 같은 물음
  const { openComments, refreshComments, sendComment, editComment, delComment } = useAssetCommentActions({
    project,
    commentPath,
    setCommentPath,
    setComments,
    reconcile,
    canLeaveComment,
  });
  useAssetBroadcastSync({
    project,
    refreshProjectData: async (...args) => { await refreshProjectData(...args); },
    refreshTree: async (...args) => { await reloadTree(...args); },
    reloadProjects,
    refreshComments,
  });
  // 격자 밖(사이드바 여백·툴바 줄)에서 시작한 드래그도 선택으로 — 생성 탭과 같은 규칙.
  useOutsideDragSelect(".assets-grid-wrap", (e) => {
    e.preventDefault(); // 글자 선택·네이티브 드래그 방지(격자 안 경로는 자체 처리)
    onGridMouseDown(e as unknown as React.MouseEvent);
  }, !showFolders);

  const enterFolder = useCallback((path: string) => {
    if (!canLeaveCommentRef.current()) return;
    setCommentPath(null); setTagEditPath(null); setQuery(""); setDir(path);
  }, []);

  useEffect(() => {
    const onBackspace = (e: KeyboardEvent) => {
      if (e.key !== "Backspace" || e.defaultPrevented || isKeyHandled(e)
        || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat || e.isComposing
        || isTypingTarget(e.target) || backgroundKeysBlocked() || !dir) return;
      e.preventDefault();
      enterFolder(dir.replace(/\\/g, "/").split("/").filter(Boolean).slice(0, -1).join("/"));
    };
    // 폴더 카드가 사라져 초점이 BODY에 남거나 빈 폴더여도 같은 이동 키를 받는다.
    window.addEventListener("keydown", onBackspace);
    return () => window.removeEventListener("keydown", onBackspace);
  }, [dir, enterFolder]);

  // 초점 잃은 키(BODY·툴바 단추)도 파일 격자가 받는다(Jay 10-22 — 워크스페이스·공유처럼). 받은 키는 '처리됨'으로 표시되므로 거르는 것이 중요하다:
  //  같은 ref 를 폴더 보기(AssetFolderGrid — 자기 키 처리)도 쓰므로 파일 격자일 때만, Backspace 는 위의 window 처리(상위 폴더로) 몫이라 뺀다.
  useLooseKeys(gridRef, onGridKey, (e) => assetGridTakesKey(e) && !!gridRef.current?.classList.contains("assets-virtual"));

  const gridHandlers = {
    ref: gridRef,
    tabIndex: 0,
    onMouseDown: onGridMouseDown,
    onAuxClick: onGridAux,
    onDoubleClick: onGridDblClick,
    onKeyDown: (e: React.KeyboardEvent) => onGridKey(e.nativeEvent),
  };

  // 셀에 넘기는 핸들러를 안정 참조로 고정(React.memo 가 변화 없는 셀을 건너뛰게).
  // ref 로 항상 최신 클로저를 가리켜 stale selection/meta(특히 다중선택 태그)를 방지.
  const cellOpsRef = useRef({ toggleSource, openComments, setAssetTagsReplace, bulkTagAdd, bulkTagRemove, removeAssetTag });
  cellOpsRef.current = { toggleSource, openComments, setAssetTagsReplace, bulkTagAdd, bulkTagRemove, removeAssetTag };
  const cellOnS = useCallback((p: string) => cellOpsRef.current.toggleSource(p), []);
  const cellOnT = startTagEdit; // 카드 T 클릭 = 인라인 태그 편집(키보드 #와 동일)
  const cellOnC = useCallback((p: string) => cellOpsRef.current.openComments(p), []);
  const cellOnTagsReplace = useCallback(
    (p: string, tags: string[], previous: string[]) => cellOpsRef.current.setAssetTagsReplace(p, tags, previous),
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
  //  초점이 **갈 곳을 잃었을 때만**(BODY) 돌려받는다 — 태그 입력을 다른 입력칸(검색 등)을 눌러 끝냈으면 그 초점을 둔다. 무조건 가져오면
  //  검색칸에 치려던 글자가 격자로 가 r·g·b 가 고른 파일의 색을 바꾼다(Codex 검토 — 생성물 격자 ThumbnailGrid 와 같은 구분).
  const cellOnTagCancel = useCallback(() => {
    setTagEditPath(null);
    requestAnimationFrame(() => {
      const lost = !document.activeElement || document.activeElement === document.body;
      if (lost) gridRef.current?.focus({ preventScroll: true });
    });
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
        folderLabel={assetFolderLabel(f.path, dir)}
        idx={idx}
        layout={layout}
        scale={scale}
        fit={fit}
        selected={selected.has(idx)}
        focused={focusIdx === idx}
        lastViewed={lastViewed === `${project}|${f.path}`}
        deactivated={disabledAssets.has(f.path)}
        selectedCount={selected.has(idx) && selected.size > 1 ? selected.size : 1}
        tagEditing={tagEditingMulti}
        meta={meta[f.path] || EMPTY_ASSET_META}
        editingTag={tagEditPath === f.path}
        tagResetSignal={tagEditPath === f.path ? restoreEpoch : undefined} // 편집 중인 칸에만 — 다른 칸은 다시 그리지 않는다
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
          {/* 경로 첫 자리 = 프로젝트 선택 드롭다운(사이드바에서 이동, Jay 요청) */}
          <select
            className={
              "assets-project"
              + (project === INTERNAL_COMBINED_PROJECT ? " internal" : "")
              + (linkedProjects.has(project) ? " linked" : "")
            }
            value={project}
            onChange={(e) => {
              if (!canLeaveComment()) return; // 머무르면 선택 상자는 지금 프로젝트로 돌아간다(제어되는 값)
              setProject(e.target.value);
              setDir(""); // 사용자가 프로젝트를 바꾸면 루트로
            }}
          >
            {projects.map((p) => (
              <option
                key={p}
                value={p}
                className={
                  p === INTERNAL_COMBINED_PROJECT
                    ? "internal"
                    : linkedProjects.has(p)
                      ? "linked"
                      : undefined
                }
              >
                {p}
              </option>
            ))}
            {/* 목록에 없는 지금 프로젝트(다른 팀 목록이 왔는데 쓰던 코멘트 때문에 머물렀다 — Jay 결정 5A) — 상자가 엉뚱한 이름을 보이지 않고,
                새 목록의 프로젝트를 고르면 바뀌게 그대로 둔다(Codex 5A 재검토) */}
            {project && !projects.includes(project) && <option value={project}>{project}</option>}
          </select>
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
            breadcrumb.map((segment, index) => (
              <span key={index}>
                <span className="crumb-sep">/</span>
                <button onClick={() => setDir(breadcrumb.slice(0, index + 1).join("/"))}>
                  {segment}
                </button>
              </span>
            ))
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
        {treeOpen && <AssetsSidebar
          project={project}
          typeFilter={typeFilter}
          dir={dir}
          meta={meta}
          sourceOnly={sourceOnly}
          onRoot={() => enterFolder("")}
          loading={loading}
          tree={displayTree}
          expanded={expanded}
          onToggleDir={toggleDir}
          onSelectDir={enterFolder}
          onOpenTab={folderTabs.open}
        />}

        <main
          className="assets-grid-wrap"
          onDragEnter={isResolveLibraryRoot ? undefined : onZoneDragEnter}
          onDragOver={isResolveLibraryRoot ? undefined : onZoneDragOver}
          onDragLeave={isResolveLibraryRoot ? undefined : onZoneDragLeave}
          onDrop={isResolveLibraryRoot ? undefined : onZoneDrop}
        >
          <SidebarEdgeToggle open={treeOpen} onToggle={() => setTreeOpen((v) => !v)}
            title={treeOpen ? t("폴더 사이드바 닫기") : t("폴더 사이드바 열기")} />
          {!isResolveLibraryRoot && dropActive && (
            <div className="assets-dropzone">
              <div className="assets-dropzone-card">
                <span className="adz-icon">⤓</span>
                <span className="adz-title">현재 폴더로 가져오기</span>
                <span className="adz-sub">{dir ? `${project} / ${dir}` : project || "…"}</span>
              </div>
            </div>
          )}
          {!isResolveLibraryRoot && importing && <div className="assets-importing">가져오는 중…</div>}
          {!isResolveLibraryRoot && <AssetsCrumbBar
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
            folderMode={showFolders}
            canShowFolders={canShowFolders}
            onFolderModeChange={(value) => { setFolderMode(value); setFolderModePath(`${project}|${dir}`); setSelected(new Set()); setFocusIdx(-1); }}
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
            fit={showFolders ? folderFit : fit}
            onToggleFit={() => (showFolders ? setFolderFit : setFit)((f) => (f === "cover" ? "contain" : "cover"))}
            scale={showFolders ? folderScale : scale}
            onScale={showFolders ? setFolderScale : setScale}
            layout={showFolders ? (folderLayout === "table" ? "list" : folderLayout) : layout}
            groupByDate={showFolders ? folderLayout === "table" : groupByDate}
            onSelectLayout={showFolders ? setFolderLayout : setLayout}
            onToggleGroupByDate={() => showFolders
              ? setFolderLayout((value) => value === "list" ? "table" : value === "table" ? "list" : value)
              : setGroupByDate((v) => !v)}
            sortField={sortField}
            sortDir={sortDir}
            onSortField={setSortField}
            onSortDir={setSortDir}
          />}

          <AssetFolderTabs tabs={folderTabs.tabs} active={folderTabs.active} project={project}
            onSelect={folderTabs.select} onClose={folderTabs.close} onReorder={folderTabs.reorder} />

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
              onUnsentChange={onCommentUnsent}
              onSend={sendComment}
              onEdit={editComment}
              onDelete={delComment}
            />
          )}

          {error && <div className="error" style={{ padding: 12 }}>{error}</div>}
          <LocalImportCards items={visibleLocalImports} onPreview={onPreview} />

          {isResolveLibraryRoot && !loading ? (
            <ResolveProjectBrowser key={`${project}\u0000${dir}`} project={project} dir={dir} />
          ) : showFolders ? (
            <AssetFolderGrid key={`${project}|${dir}`} project={project} groups={visibleGroups}
              directFiles={folderGroups.directFiles}
              scale={folderScale} fit={folderFit} layout={folderLayout} lastViewedPath={lastViewed.startsWith(`${project}|`) ? lastViewed.slice(project.length + 1) : undefined} scrollRef={gridRef} onScroll={onContentScroll}
              onEnter={enterFolder} onOpenTab={folderTabs.open} onPreview={openPreview} />
          ) : files.length === 0 && !loading ? (
            isResolveLibraryRoot || visibleLocalImports.length ? null : (
              <div className="assets-empty">{t("이 폴더에 미디어가 없습니다.")}</div>
            )
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

/** 그 경로의 파일이 지금 목록의 몇 번째인가(없으면 -1). */
/** 파일 격자가 초점 잃은 키로 받는 키 — Backspace 는 창의 '상위 폴더로' 처리 몫이다(폴더 보기 AssetFolderGrid 도 같은 규칙). */
const assetGridTakesKey = (e: KeyboardEvent) => e.key !== "Backspace";

const indexOfPath = (files: AssetNode[], path: string | null) =>
  path === null ? -1 : files.findIndex((file) => file.path === path);

// 마지막으로 보던 Assets 상태 영속화(프로젝트·폴더·크기·레이아웃)
const LS = makeStore("ch.assets.");
const FOLDER_LS = makeStore("ch.assets.folder.");
