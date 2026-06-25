// Assets(구성) 뷰 — Higgsfield 자산 라이브러리 풍으로:
//  · 메이슨리(핀터레스트형) 그리드 + 리스트 토글, 크기 조절 슬라이더
//  · 영상 호버 자동재생 + 미디어 호버 오버레이(정보·미리보기·다운로드)
//  · 좌측 폴더 트리는 유지. 셀 휠클릭=정보, 클릭=미리보기.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { buildCommentTree } from "../lib/commentTree";
import { flashMsg } from "../lib/flash";
import { fmtWhen } from "../lib/format";
import { useT } from "../lib/i18n";
import { computeMarquee, marqueeHits } from "../lib/marquee";
import { makeStore } from "../lib/storage";
import { useFloatingPanel } from "../lib/useFloatingPanel";
import type { AssetComment, AssetMeta, AssetNode, InfoTarget, PreviewTarget } from "../types";
import { AssetCell } from "./assets/AssetCell";
import { loadDisabledAssets, toggleDisabledAssets, DISABLED_EVENT } from "../lib/deactivated";
import { FolderTree } from "./assets/FolderTree";
import { MountManager } from "./assets/MountManager";
import { setSingleFileDrag, setZipDrag } from "./assets/exportDrag";
import { findFolder, flattenFiles } from "./assets/treeUtils";

const EMPTY_META: AssetMeta = {
  is_source: false,
  source_name: null,
  tags: [],
  comment: null,
  color: null,
  comment_count: 0,
  has_unread: false,
};

// 파일 mtime(epoch 초) → 로컬 날짜 그룹 키 + 표시 라벨("June 11, 2026"). 생성탭과 동일 포맷.
function dayInfoFromMtime(mtime?: number | null): { key: string; label: string } {
  if (!mtime) return { key: "none", label: "날짜 없음" };
  const d = new Date(mtime * 1000);
  if (isNaN(d.getTime())) return { key: "none", label: "날짜 없음" };
  const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  const label = d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return { key, label };
}

const ASSET_COLORS: Record<string, string> = {
  r: "#ff453a", // 선명한 빨강
  g: "#34c759", // 선명한 초록
  b: "#0a84ff", // 선명한 파랑
};

interface Props {
  onInfo: (t: InfoTarget) => void;
  onPreview: (t: PreviewTarget) => void;
}

export function AssetsView({ onInfo, onPreview }: Props) {
  const t = useT();
  // 내 신원(로그인 계정 creator_uid, 단독이면 'me') — 코멘트 '내 것' 판별용. 독립 창이라 자체 조회.
  const [myId, setMyId] = useState("me");
  useEffect(() => {
    // 독립 창이라 자체 조회. ★재시도: 로그인 직후 run-agent 로 팝업이 바로 열리면 me() 프록시가 아직
    // 정착 안 돼 실패할 수 있는데, 그때 'me'로 굳으면 내 코멘트를 '남의 것'으로 오판한다 → 몇 번 재시도.
    let cancelled = false;
    const fetchId = (tries: number) => {
      api
        .me()
        .then((a) => {
          if (!cancelled) setMyId(a?.creator_uid || "me");
        })
        .catch(() => {
          if (!cancelled && tries > 0) setTimeout(() => fetchId(tries - 1), 1500);
        });
    };
    fetchId(3);
    return () => {
      cancelled = true;
    };
  }, []);
  const [projects, setProjects] = useState<string[]>([]);
  const [project, setProject] = useState<string>("");
  const [tree, setTree] = useState<AssetNode[]>([]);
  // 마지막으로 보던 상태를 기억(localStorage) → 다음에 열 때 그대로 복원
  const [dir, setDir] = useState<string>(() => LS.get("dir", ""));
  // 타입별 필터(이미지/영상/오디오) — 클릭하면 프로젝트 전체에서 그 타입만
  const [typeFilter, setTypeFilter] = useState<"image" | "video" | "audio" | null>(
    () => {
      const t = LS.get("typeFilter", "");
      return t === "image" || t === "video" || t === "audio" ? t : null;
    },
  );
  // 좌측 폴더 트리에서 펼쳐둔 폴더 경로(마지막 구조 복원)
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const r = LS.get("expanded", "");
      return r ? new Set<string>(JSON.parse(r)) : new Set<string>();
    } catch {
      return new Set<string>();
    }
  });
  // 저장된 값이 있으면 시드 완료로 간주(처음 한 번만 최상위 폴더 자동 펼침)
  const expandedSeeded = useRef(LS.get("expanded", "") !== "");
  const toggleDir = useCallback((path: string) => {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });
  }, []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(() => Number(LS.get("scale", "1")) || 1);
  const [layout, setLayout] = useState<"grid" | "list">(() =>
    LS.get("layout", "grid") === "list" ? "list" : "grid",
  );
  // 그리드에서 파일 날짜별로 구분(섹션 헤더) — 그리드 버튼을 한 번 더 누르면 토글
  const [groupByDate, setGroupByDate] = useState(() => LS.get("groupByDate", "0") === "1");
  // 그리드 썸네일 맞춤: cover=꽉 채움(크롭) / contain=전체 보임(블랙바)
  const [fit, setFit] = useState<"cover" | "contain">(() =>
    LS.get("fit", "cover") === "contain" ? "contain" : "cover",
  );
  const [meta, setMeta] = useState<Record<string, AssetMeta>>({});
  const metaRef = useRef(meta);
  metaRef.current = meta;
  const [tagEditPath, setTagEditPath] = useState<string | null>(null); // 인라인 태그 입력 중인 파일
  // 아래 검색/필터들도 마지막 상태로 복원 → 다음에 열 때 보던 화면 그대로
  const [query, setQuery] = useState(() => LS.get("query", "")); // 검색어 (#로 시작하면 태그 검색)
  // 좌측 필터: 컬러(다중)·소스만·태그
  const [activeColors, setActiveColors] = useState<Set<string>>(() => {
    try {
      const r = LS.get("colors", "");
      return r ? new Set<string>(JSON.parse(r)) : new Set<string>();
    } catch {
      return new Set<string>();
    }
  });
  const [sourceOnly, setSourceOnly] = useState(() => LS.get("sourceOnly", "0") === "1");
  // 회색(비활성) — 에셋은 path 기준. grayOn=ON 이면 비활성 카드 숨김(다른 dot 과 반대).
  const [disabledAssets, setDisabledAssets] = useState<Set<string>>(loadDisabledAssets);
  const [grayOn, setGrayOn] = useState(() => LS.get("grayOn", "0") === "1");
  // C 필터: 새(미확인) 코멘트가 있는 파일만 보기
  const [commentOnly, setCommentOnly] = useState(() => LS.get("commentOnly", "0") === "1");
  // 태그 필터(다중 — Shift/Ctrl+클릭으로 중복 선택, 합집합). 구버전 단일 키에서 마이그레이션.
  const [activeTags, setActiveTags] = useState<Set<string>>(() => {
    try {
      const r = LS.get("activeTags", "");
      if (r) return new Set<string>(JSON.parse(r));
      const old = LS.get("activeTag", "");
      return old ? new Set<string>([old]) : new Set<string>();
    } catch {
      return new Set<string>();
    }
  });
  // 그리드/리스트 스크롤 위치(보던 위치) — 폴더·레이아웃·검색별로 복원. 스크롤 컨테이너는 gridRef 재사용.
  const scrollKey = `${project}|${dir}|${layout}|${query}|${typeFilter ?? ""}`;
  const [tagPanelOpen, setTagPanelOpen] = useState(false);
  // 태그창 위치·크기를 마지막 상태로 기억(localStorage)
  const {
    pos: tagPanelPos,
    setPos: setTagPanelPos,
    size: tagPanelSize,
    dragRef: tagDragRef,
    panelRef: tagPanelRef,
  } = useFloatingPanel(LS, "tagPos", "tagSize", tagPanelOpen);

  // 코멘트 창(공유 스레드) + 내 코멘트 알림 끄기 옵션
  const [muteOwn, setMuteOwn] = useState(() => LS.get("muteOwn", "1") !== "0");
  const muteOwnRef = useRef(muteOwn);
  muteOwnRef.current = muteOwn;
  const [commentPath, setCommentPath] = useState<string | null>(null);
  const [comments, setComments] = useState<AssetComment[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [replyingId, setReplyingId] = useState<string | null>(null);
  const {
    pos: cmtPos,
    setPos: setCmtPos,
    size: cmtSize,
    dragRef: cmtDragRef,
    panelRef: cmtPanelRef,
  } = useFloatingPanel(LS, "cmtPos", "cmtSize", !!commentPath);

  // 등록 폴더(마운트) 관리 창
  const [mountOpen, setMountOpen] = useState(false);

  // 프로젝트(폴더 + 등록된 마운트) 목록 로드 — 마운트 등록/해제 후에도 재호출.
  const reloadProjects = useCallback((keepCurrent = false) => {
    api
      .assetProjects()
      .then((info) => {
        setProjects(info.projects);
        setProject((cur) => {
          if (keepCurrent && cur && info.projects.includes(cur)) return cur;
          const saved = LS.get("project", "");
          return saved && info.projects.includes(saved) ? saved : info.default;
        });
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    reloadProjects();
  }, [reloadProjects]);

  // 프로젝트별 파일 메타데이터 로드
  useEffect(() => {
    if (!project) return;
    api.assetMeta(project).then(setMeta).catch(() => setMeta({}));
  }, [project]);

  // 폴더 트리는 프로젝트별로 로드(여기서 dir 을 비우지 않음 → 복원된 폴더 유지)
  useEffect(() => {
    if (!project) return;
    setLoading(true);
    api
      .assetTree(project)
      .then((t) => {
        setTree(t.children);
        // 처음 한 번: 최상위 폴더들을 펼친 상태로 시드
        if (!expandedSeeded.current) {
          expandedSeeded.current = true;
          setExpanded(new Set(t.children.filter((n) => n.type === "dir").map((n) => n.path)));
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [project]);

  // 상태 변화를 저장
  useEffect(() => {
    if (project) LS.set("project", project);
  }, [project]);
  useEffect(() => LS.set("dir", dir), [dir]);
  // 현재 프로젝트/폴더를 메인 창(생성 파트 @/# 피커)에 실시간 전달 — 그 폴더 소스로 스코프.
  // 분리창이라 storage 이벤트도 메인에 전달되지만, BroadcastChannel 로 즉시성 보강.
  const assetBcRef = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    if (!("BroadcastChannel" in window)) return;
    const bc = new BroadcastChannel("ch-assets");
    assetBcRef.current = bc;
    // 메인 창의 계정 전환/로그아웃 → 이 팝업의 옛 계정 상태(프로젝트·선택·드래그)를 버리고 재로드.
    bc.onmessage = (e) => {
      if (e.data && e.data.type === "session-reset") window.location.reload();
    };
    return () => bc.close();
  }, []);
  useEffect(() => {
    assetBcRef.current?.postMessage({ project, dir });
  }, [project, dir]);
  useEffect(() => LS.set("typeFilter", typeFilter || ""), [typeFilter]);
  useEffect(() => {
    if (!expandedSeeded.current) return; // 시드 전엔 저장 보류
    LS.set("expanded", JSON.stringify([...expanded]));
  }, [expanded]);
  useEffect(() => LS.set("scale", String(scale)), [scale]);
  useEffect(() => LS.set("layout", layout), [layout]);
  useEffect(() => LS.set("groupByDate", groupByDate ? "1" : "0"), [groupByDate]);
  useEffect(() => LS.set("fit", fit), [fit]);
  // 검색/필터도 저장 → 보던 화면 그대로 복원
  useEffect(() => LS.set("query", query), [query]);
  useEffect(() => LS.set("colors", JSON.stringify([...activeColors])), [activeColors]);
  useEffect(() => LS.set("grayOn", grayOn ? "1" : "0"), [grayOn]);
  // 비활성(회색) 집합은 lib/deactivated 가 영속·전파. 다른 화면에서 토글돼도 갱신.
  useEffect(() => {
    const h = () => setDisabledAssets(loadDisabledAssets());
    window.addEventListener(DISABLED_EVENT, h);
    return () => window.removeEventListener(DISABLED_EVENT, h);
  }, []);
  useEffect(() => LS.set("sourceOnly", sourceOnly ? "1" : "0"), [sourceOnly]);
  useEffect(() => LS.set("commentOnly", commentOnly ? "1" : "0"), [commentOnly]);
  useEffect(() => LS.set("activeTags", JSON.stringify([...activeTags])), [activeTags]);

  // 스크롤 위치(보던 위치) 저장 — 폴더/레이아웃/검색 조합별. 스크롤 멈춤 후 150ms 저장(throttle).
  const scrollSaveTimer = useRef<number | null>(null);
  const onContentScroll = useCallback(() => {
    if (scrollSaveTimer.current) return;
    scrollSaveTimer.current = window.setTimeout(() => {
      scrollSaveTimer.current = null;
      const el = gridRef.current;
      if (el) LS.set("scroll", JSON.stringify({ key: scrollKey, top: el.scrollTop }));
    }, 150);
  }, [scrollKey]);

  // 검색·메타 필터(프로젝트 전체 대상). 타입(이미지/영상/오디오)은 여기 포함하지 않는다 —
  // 타입은 폴더 브라우징과 결합하는 '모드'라 폴더 선택을 유지한 채 후처리로만 거른다.
  const searchActive =
    query.trim().length > 0 ||
    activeColors.size > 0 ||
    sourceOnly ||
    commentOnly ||
    activeTags.size > 0;

  // 새(미확인) 코멘트가 있는 파일이 하나라도 있나 → C 버튼 자동 알림.
  const hasAnyUnread = useMemo(
    () => Object.values(meta).some((m) => m?.has_unread),
    [meta],
  );

  // 프로젝트 전체 타입별 개수(좌측 타입 필터 배지)
  const typeCounts = useMemo(() => {
    const c = { image: 0, video: 0, audio: 0 };
    for (const f of flattenFiles(tree)) {
      if (f.type === "image" || f.type === "video" || f.type === "audio") c[f.type]++;
    }
    return c;
  }, [tree]);

  const files = useMemo(() => {
    const q = query.trim();
    let result: AssetNode[];
    if (searchActive) {
      // 검색·메타 필터는 프로젝트 전체 대상
      result = flattenFiles(tree);
      if (q.startsWith("#")) {
        const tag = q.slice(1).toLowerCase();
        if (tag)
          result = result.filter((f) =>
            (meta[f.path]?.tags || []).some((t) => t.toLowerCase().includes(tag)),
          );
      } else if (q) {
        const nq = q.toLowerCase();
        result = result.filter((f) => f.name.toLowerCase().includes(nq));
      }
      if (activeColors.size)
        result = result.filter((f) => {
          const c = meta[f.path]?.color;
          return c ? activeColors.has(c) : false;
        });
      if (sourceOnly) result = result.filter((f) => meta[f.path]?.is_source);
      if (commentOnly) result = result.filter((f) => meta[f.path]?.has_unread);
      if (activeTags.size)
        // 선택한 태그 중 하나라도 가진 파일(합집합) — 컬러 다중필터와 동일한 OR 의미
        result = result.filter((f) =>
          (meta[f.path]?.tags || []).some((t) => activeTags.has(t)),
        );
    } else {
      // 폴더 클릭 → 그 폴더 안의 모든 파일(하위 폴더 포함, 재귀)
      const children = dir ? findFolder(tree, dir) : tree;
      result = flattenFiles(children);
    }
    // 타입 모드(이미지/영상/오디오)는 폴더·검색 결과 위에 결합 — 그 타입만 남긴다.
    if (typeFilter) result = result.filter((f) => f.type === typeFilter);
    // 회색 버튼 ON → 비활성(회색) 카드 제외(숨김). 색 dot 과 반대 방향.
    if (grayOn) result = result.filter((f) => !disabledAssets.has(f.path));
    // 날짜별 구분 모드: 폴더 순(알파벳) 대신 파일 날짜 내림차순으로 정렬 → 같은 날짜가 연속.
    if (groupByDate)
      result = [...result].sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
    return result;
  }, [tree, dir, query, meta, searchActive, activeColors, sourceOnly, commentOnly, activeTags, typeFilter, groupByDate, grayOn, disabledAssets]);

  // 날짜별 그룹(인덱스 기준) — 헤더 체크박스가 그 날짜의 모든 파일을 한 번에 선택.
  const dateGroups = useMemo(() => {
    const m = new Map<string, { label: string; idxs: number[] }>();
    files.forEach((f, i) => {
      const { key, label } = dayInfoFromMtime(f.mtime);
      let e = m.get(key);
      if (!e) {
        e = { label, idxs: [] };
        m.set(key, e);
      }
      e.idxs.push(i);
    });
    return m;
  }, [files]);

  // 콘텐츠가 렌더된 뒤 보던 스크롤 위치 복원(같은 폴더/레이아웃/검색일 때만). 고정 높이라 이미지 로드 무관.
  // files.length 에만 의존 → 태그/소스/컬러 등 메타 편집(개수 불변)으로는 스크롤이 튀지 않음.
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    try {
      const r = LS.get("scroll", "");
      const s = r ? JSON.parse(r) : null;
      el.scrollTop = s && s.key === scrollKey ? s.top || 0 : 0;
    } catch {
      el.scrollTop = 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey, files.length]);

  // 프로젝트의 모든 태그(중복 제거·정렬) — T 패널용
  const allTags = useMemo(() => {
    const s = new Set<string>();
    for (const m of Object.values(meta)) m.tags.forEach((t) => s.add(t));
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [meta]);

  // 코멘트 트리(부모 → 답글) — 계산은 공용 유틸, 변수명은 기존 그대로 받아 렌더 코드 무변경.
  const {
    byParent: cmtByParent,
    byId: cmtById,
    roots: cmtRoots,
    descendantsOf,
  } = useMemo(() => buildCommentTree(comments), [comments]);

  const breadcrumb = dir ? dir.split("/") : [];

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

  // 폴더/프로젝트/검색/필터 바뀌면 선택 초기화(날짜 그룹 토글도 정렬이 바뀌므로 포함)
  useEffect(() => {
    setSelected(new Set());
    setFocusIdx(-1);
  }, [dir, project, query, activeColors, sourceOnly, commentOnly, activeTags, typeFilter, groupByDate]);

  // files 가 (메타 편집 등 위 필터 deps 외 이유로) 재정렬/재필터되면 인덱스 기반 선택이 다른 파일을
  // 가리킨다 → path 로 재매핑해 '같은 파일'이 선택된 상태를 유지하고, 필터로 빠진 파일은 선택 해제한다.
  // (안 그러면 stale 인덱스로 ch.assets.selection 에 엉뚱한 파일이 쓰여 잘못된 레퍼런스가 삽입됨.)
  // 필터 변경 시엔 위 리셋이 먼저 빈 집합으로 만들므로 여기선 no-op.
  const selFilesRef = useRef(files);
  useEffect(() => {
    const prev = selFilesRef.current;
    selFilesRef.current = files;
    if (prev === files) return;
    setSelected((sel) => {
      if (!sel.size) return sel;
      const paths = new Set<string>();
      sel.forEach((i) => {
        const p = prev[i]?.path;
        if (p) paths.add(p);
      });
      const next = new Set<number>();
      files.forEach((f, i) => {
        if (paths.has(f.path)) next.add(i);
      });
      return next;
    });
  }, [files]);

  // 선택이 바뀔 때마다 '라이브 선택 전체'를 같은 오리진 공유 localStorage 로 — 본창 프롬프트 드롭이
  // 드래그 시점 selection 캡처가 어긋나도(크로스윈도우 dataTransfer 한 건만 전달 등) 이 값으로 다중을
  // 복구한다. 이미지/영상만(레퍼런스 대상).
  useEffect(() => {
    try {
      const items = [...selected]
        .sort((a, b) => a - b)
        .map((i) => files[i])
        .filter((f) => f && (f.type === "image" || f.type === "video"))
        .map((f) => ({ project, path: f.path, name: f.name, type: f.type }));
      localStorage.setItem("ch.assets.selection", JSON.stringify(items));
    } catch {
      /* localStorage 불가 시 무시(드래그 페이로드 폴백) */
    }
  }, [selected, files, project]);

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
    window.removeEventListener("mousemove", onDragMove);
    window.removeEventListener("mouseup", onDragUp);
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
    window.removeEventListener("mousemove", onDragMove);
    window.removeEventListener("mouseup", onDragUp);
    setMarquee(null);

    const proj = projectRef.current;
    const sel = [...selectedRef.current]
      .map((i) => filesRef.current[i]?.path)
      .filter(Boolean) as string[];
    const multi = sel.length > 1 && sel.includes(path);
    if (multi) {
      setZipDrag(dt, proj, sel);
    } else {
      const name =
        filesRef.current.find((f) => f.path === path)?.name || path.split("/").pop() || path;
      setSingleFileDrag(dt, proj, path, name);
    }
    // 본창 프롬프트 레퍼런스 트레이로 드래그(같은 오리진 팝업↔본창)에서 읽을 커스텀 타입.
    // 다중선택에 포함되면 선택 전체를(그리드 순서 보존), 아니면 그 파일 하나만 배열로 싣는다 →
    // 트레이가 한 번에 여러 개를 번호순으로 추가한다.
    const idxs = multi
      ? [...selectedRef.current].sort((a, b) => a - b)
      : [filesRef.current.findIndex((f) => f.path === path)];
    const items = idxs
      .map((i) => filesRef.current[i])
      .filter(Boolean)
      .map((f) => ({ project: proj, path: f.path, name: f.name, type: f.type }));
    const payload = JSON.stringify(items);
    // dataTransfer 커스텀 타입은 '드롭 허용 플래그'로만 둔다 — 일부 브라우저가 팝업↔본창
    // 크로스윈도우 드래그에서 커스텀 배열을 한 건만 전달하는 문제가 있어, 전체 선택은 같은 오리진이
    // 공유하는 localStorage 로 넘긴다(본창 드롭이 이 키를 우선 읽는다). dragstart 마다 덮어써 항상 최신.
    dt.setData("application/x-ch-asset", payload);
    try {
      localStorage.setItem("ch.assets.drag", payload);
    } catch {
      /* localStorage 불가 시 dataTransfer 폴백 */
    }
  }, [onDragMove, onDragUp]);

  // ── 외부 파일 가져오기(드롭 업로드) → 현재 폴더로 ──
  const [dropActive, setDropActive] = useState(false);
  const [importing, setImporting] = useState(false);
  const dropDepth = useRef(0); // dragenter/leave 가 자식 위에서도 발생 → 깊이 카운트로 정확히 판정
  const hasFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.types).includes("Files"); // 내부 카드 드래그(DownloadURL) 와 구분

  const importFiles = async (incoming: File[]) => {
    if (!project || !incoming.length) return;
    setImporting(true);
    try {
      const res = await api.uploadAssets(project, dir, incoming);
      // 새 파일 반영 — 트리 + 메타 재로드
      const t = await api.assetTree(project);
      setTree(t.children);
      const m = await api.assetMeta(project);
      setMeta(m);
      if (res.skipped.length)
        alert(
          `${res.saved.length}개 추가됨.\n미디어가 아니어서 제외: ${res.skipped.join(", ")}`,
        );
    } catch (e) {
      alert(`가져오기 실패: ${e}`);
    } finally {
      setImporting(false);
    }
  };

  const onZoneDragEnter = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dropDepth.current++;
    setDropActive(true);
  };
  const onZoneDragOver = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // drop 허용
    e.dataTransfer.dropEffect = "copy";
  };
  const onZoneDragLeave = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    dropDepth.current--;
    if (dropDepth.current <= 0) {
      dropDepth.current = 0;
      setDropActive(false);
    }
  };
  const onZoneDrop = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dropDepth.current = 0;
    setDropActive(false);
    const incoming = Array.from(e.dataTransfer.files);
    if (incoming.length) importFiles(incoming);
  };

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
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", onDragUp);
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
      // 오디오는 미리보기 창이 없음(호버 재생만) — 더블클릭/Enter 시 무시
      if (f.type !== "image" && f.type !== "video") return;
      // 현재 목록의 이미지·영상만 모아 함께 넘긴다 → 풀스크린에서 ←/→ 로 이전·다음 이동(생성 파트와 동일).
      const media = filesRef.current.filter((x) => x.type === "image" || x.type === "video");
      const items = media.map((x) => ({
        url: api.assetFileUrl(project, x.path),
        type: x.type as "image" | "video",
        name: x.name,
      }));
      const index = media.findIndex((x) => x.path === f.path);
      onPreview({ url: api.assetFileUrl(project, f.path), type: f.type, name: f.name, items, index });
    },
    [project, onPreview],
  );

  const onGridDblClick = (e: React.MouseEvent) => {
    const cellEl = (e.target as HTMLElement).closest(".asset-cell") as HTMLElement | null;
    if (!cellEl) return;
    const f = filesRef.current[Number(cellEl.dataset.idx)];
    if (f) openPreview(f);
  };

  // 방향키 이웃 셀(레이아웃 무관, 화면 좌표 기반 최근접)
  const neighbor = (cur: number, key: string): number | null => {
    const grid = gridRef.current;
    if (!grid) return null;
    const cells = Array.from(grid.querySelectorAll(".asset-cell")) as HTMLElement[];
    const curEl = cells.find((c) => Number(c.dataset.idx) === cur);
    if (!curEl) return cells.length ? Number(cells[0].dataset.idx) : null;
    const cr = curEl.getBoundingClientRect();
    const cx = (cr.left + cr.right) / 2, cy = (cr.top + cr.bottom) / 2;
    let best: number | null = null, bestScore = Infinity;
    for (const el of cells) {
      const idx = Number(el.dataset.idx);
      if (idx === cur) continue;
      const r = el.getBoundingClientRect();
      const x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
      const dx = x - cx, dy = y - cy;
      let ok = false, primary = 0, secondary = 0;
      if (key === "ArrowRight") { ok = dx > 1; primary = dx; secondary = Math.abs(dy); }
      else if (key === "ArrowLeft") { ok = dx < -1; primary = -dx; secondary = Math.abs(dy); }
      else if (key === "ArrowDown") { ok = dy > 1; primary = dy; secondary = Math.abs(dx); }
      else if (key === "ArrowUp") { ok = dy < -1; primary = -dy; secondary = Math.abs(dx); }
      if (!ok) continue;
      const score = primary + secondary * 2;
      if (score < bestScore) { bestScore = score; best = idx; }
    }
    return best;
  };

  const onGridKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return; // 인라인 입력 중엔 단축키 무시
    if (!filesRef.current.length) return;
    if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      const cur = focusIdx < 0 ? 0 : focusIdx;
      const nxt = focusIdx < 0 ? 0 : neighbor(cur, e.key);
      if (nxt == null) return;
      setFocusIdx(nxt);
      if (e.shiftKey) setSelected((prev) => new Set([...prev, cur, nxt]));
      else setSelected(new Set([nxt]));
      requestAnimationFrame(() =>
        gridRef.current
          ?.querySelector(`.asset-cell[data-idx="${nxt}"]`)
          ?.scrollIntoView({ block: "nearest" }),
      );
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
      else if (k === "r") { e.preventDefault(); colorAssets(paths, ASSET_COLORS.r); }
      else if (k === "g") { e.preventDefault(); colorAssets(paths, ASSET_COLORS.g); }
      else if (k === "b") { e.preventDefault(); colorAssets(paths, ASSET_COLORS.b); }
      else if (k === "d") { e.preventDefault(); toggleDisabledAssets(paths); } // 비활성(회색) 토글
    }
  };

  // ── 메타 작업(선택 파일 대상): s=소스 #=태그 c=코멘트 r/g/b=컬러 ──
  const selPaths = () =>
    [...selected].map((i) => filesRef.current[i]?.path).filter(Boolean) as string[];
  const patchMeta = (paths: string[], partial: Partial<AssetMeta>) =>
    setMeta((prev) => {
      const n = { ...prev };
      for (const p of paths) n[p] = { ...(n[p] || EMPTY_META), ...partial };
      return n;
    });
  const reconcile = () =>
    api.assetMeta(project).then(setMeta).catch(() => {});
  // 메타 변경(컬러/태그/소스) 실패 핸들러 — 서버 상태로 되돌리고(self-heal) 실패를 명시적으로 알린다.
  // 예전엔 .catch(reconcile)만 있어 화면은 곧 정정됐지만 '왜 되돌아갔는지' 통지가 없어 거짓처럼 보였다.
  const metaFail = () => {
    reconcile();
    flashMsg("변경 적용 실패 — 서버 상태로 되돌렸습니다");
  };

  const colorAssets = (paths: string[], color: string) => {
    // 이미 모두 그 색이면 해제(토글) — r 준 뒤 r 다시 누르면 컬러 제거
    const allSame = paths.every((p) => metaRef.current[p]?.color === color);
    const next = allSame ? null : color;
    patchMeta(paths, { color: next });
    Promise.all(paths.map((p) => api.setAssetColor(project, p, next))).catch(metaFail);
  };
  // 소스는 파일 이름으로 자동 등록(확장자 제외) — 프롬프트 없음.
  const fileBaseName = (p: string) => {
    const node = filesRef.current.find((f) => f.path === p);
    const n = node?.name || p.split("/").pop() || p;
    return n.replace(/\.[^.]+$/, "");
  };
  const sourceAssets = (paths: string[]) => {
    const named = paths.map((p) => ({ p, name: fileBaseName(p) }));
    setMeta((prev) => {
      const n = { ...prev };
      for (const { p, name } of named)
        n[p] = { ...(n[p] || EMPTY_META), is_source: true, source_name: name };
      return n;
    });
    Promise.all(named.map(({ p, name }) => api.setAssetSource(project, p, name, true))).catch(metaFail);
  };
  const toggleSource = (path: string) => {
    if (metaRef.current[path]?.is_source) {
      patchMeta([path], { is_source: false, source_name: null });
      api.setAssetSource(project, path, null, false).catch(metaFail);
    } else {
      sourceAssets([path]);
    }
  };
  // 태그 추가: 키보드 # → 포커스 카드에 인라인 입력 → Enter 커밋.
  // 다중선택 상태면 선택된 카드 모두에 적용.
  // # 버튼 태그 목록에서 ✕ 로 개별 태그 제거(해당 카드만)
  const removeAssetTag = (path: string, tag: string) => {
    setMeta((prev) => {
      const n = { ...prev };
      const cur = n[path] || EMPTY_META;
      n[path] = { ...cur, tags: cur.tags.filter((t) => t !== tag) };
      return n;
    });
    const next = (metaRef.current[path]?.tags || []).filter((t) => t !== tag);
    api.setAssetTags(project, path, next).catch(metaFail);
  };
  // 태그 에디터(칩 추가/×해제) — 이 카드의 태그를 정확히 next 로 교체(낙관 반영 + 영속).
  const setAssetTagsReplace = (path: string, next: string[]) => {
    setMeta((prev) => ({ ...prev, [path]: { ...(prev[path] || EMPTY_META), tags: next } }));
    api.setAssetTags(project, path, next).catch(metaFail);
  };
  // 다중선택 태그 일괄 추가 — 편집 카드(path)는 onTagsReplace 가 처리, 나머지 선택 카드에 union 추가.
  const bulkTagAdd = (path: string, names: string[]) => {
    const others = selPaths().filter((p) => p !== path);
    if (!others.length) return;
    // metaRef 를 동기로 갱신 + api 페이로드를 그 next 에서 뽑는다(stale 병합으로 옛 목록 저장 방지).
    const next = { ...metaRef.current };
    for (const p of others) {
      const cur = next[p] || EMPTY_META;
      next[p] = { ...cur, tags: Array.from(new Set([...cur.tags, ...names])) };
    }
    metaRef.current = next;
    setMeta(next);
    Promise.allSettled(others.map((p) => api.setAssetTags(project, p, next[p].tags))).catch(metaFail);
  };
  // 다중선택 일반 태그 일괄 삭제 — 편집 카드(path)는 onTagsReplace 가 처리, 나머지 선택 카드에서 제거(공통이면 사라짐).
  const bulkTagRemove = (path: string, names: string[]) => {
    const others = selPaths().filter((p) => p !== path);
    if (!others.length) return;
    const drop = new Set(names);
    const next = { ...metaRef.current };
    for (const p of others) {
      const cur = next[p] || EMPTY_META;
      next[p] = { ...cur, tags: cur.tags.filter((t) => !drop.has(t)) };
    }
    metaRef.current = next;
    setMeta(next);
    Promise.allSettled(others.map((p) => api.setAssetTags(project, p, next[p].tags))).catch(metaFail);
  };

  // T 패널: 토글(닫으면 태그 필터도 해제 — S 처럼). 바깥 클릭으로 닫히지 않음.
  const toggleTagPanel = () => {
    if (tagPanelOpen) {
      setTagPanelOpen(false);
      setActiveTags(new Set());
    } else {
      setTagPanelOpen(true);
    }
  };
  // T 패널 드래그(헤더로 이동)
  const onTagDrag = useCallback((e: MouseEvent) => {
    const d = tagDragRef.current;
    if (!d) return;
    setTagPanelPos({ x: e.clientX - d.dx, y: e.clientY - d.dy });
  }, []);
  const onTagDragUp = useCallback(() => {
    tagDragRef.current = null;
    window.removeEventListener("mousemove", onTagDrag);
    window.removeEventListener("mouseup", onTagDragUp);
  }, [onTagDrag]);
  const onTagHeadDown = (e: React.MouseEvent) => {
    const pos = tagPanelPos || { x: 180, y: 150 };
    tagDragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    window.addEventListener("mousemove", onTagDrag);
    window.addEventListener("mouseup", onTagDragUp);
  };

  // 좌측 필터: 컬러 토글
  const toggleColor = (c: string) =>
    setActiveColors((prev) => {
      const n = new Set(prev);
      if (n.has(c)) n.delete(c);
      else n.add(c);
      return n;
    });

  // T 패널: 태그를 모든 파일에서 완전 삭제 — 확인창 없이 바로. metaRef 동기 갱신 + payload 를 그
  // next 에서 뽑아(stale 방지) 확실히 지운다.
  const deleteTag = (tag: string) => {
    const affected = Object.entries(metaRef.current)
      .filter(([, m]) => m.tags.includes(tag))
      .map(([p]) => p);
    if (!affected.length) return;
    const next = { ...metaRef.current };
    for (const p of affected) next[p] = { ...next[p], tags: next[p].tags.filter((t) => t !== tag) };
    metaRef.current = next;
    setMeta(next);
    Promise.all(affected.map((p) => api.setAssetTags(project, p, next[p].tags))).catch(metaFail);
    if (activeTags.has(tag))
      setActiveTags((prev) => {
        const n = new Set(prev);
        n.delete(tag);
        return n;
      });
  };

  // 코멘트 창 열기: 스레드 로드 + 읽음 처리(미확인 C 끔) + 메타 갱신
  const openComments = (path: string) => {
    setCommentPath(path);
    api
      .assetComments(project, path)
      .then(setComments)
      .catch(() => setComments([]));
    api
      .markCommentsRead(project, path)
      .then(reconcile)
      .catch(() => {});
  };
  const refreshComments = () => {
    if (!commentPath) return Promise.resolve();
    return api.assetComments(project, commentPath).then(setComments);
  };
  const sendComment = (text: string, parentId?: string | null) => {
    const t = text.trim();
    if (!commentPath || !t) return;
    setReplyingId(null);
    // 전송 시 읽음 처리하지 않음. 작성 시점의 '내 알림 끄기' 상태를 이 코멘트에 캡처(코멘트별).
    api
      .addAssetComment(project, commentPath, t, parentId, muteOwnRef.current)
      .then(refreshComments)
      .then(reconcile)
      // 실패를 삼키면 사용자는 코멘트를 남겼다고 오인 → 명시적으로 알린다.
      .catch(() => flashMsg("코멘트 전송 실패 — 다시 시도하세요"));
  };
  const editComment = (id: string, text: string) => {
    const t = text.trim();
    if (!t) return;
    setEditingId(null);
    api.editAssetComment(id, t).then(refreshComments).catch((e) => alert(String(e)));
  };
  const delComment = (id: string) => {
    if (!window.confirm("이 코멘트를 삭제할까요?")) return;
    api
      .deleteAssetComment(id)
      .then(refreshComments)
      .then(reconcile)
      .catch((e) => alert(String(e)));
  };
  // '내 알림 끄기'는 코멘트 작성 시점에 캡처되는 기본값(전역 필터 아님).
  // 기존 코멘트에 소급 적용되지 않으므로 메타 재로드 불필요 — 다음 작성에만 영향.
  const toggleMuteOwn = () => {
    const nv = !muteOwn;
    setMuteOwn(nv);
    LS.set("muteOwn", nv ? "1" : "0");
  };
  // 코멘트 창 드래그(헤더)
  const onCmtDrag = useCallback((e: MouseEvent) => {
    const d = cmtDragRef.current;
    if (!d) return;
    setCmtPos({ x: e.clientX - d.dx, y: e.clientY - d.dy });
  }, []);
  const onCmtDragUp = useCallback(() => {
    cmtDragRef.current = null;
    window.removeEventListener("mousemove", onCmtDrag);
    window.removeEventListener("mouseup", onCmtDragUp);
  }, [onCmtDrag]);
  const onCmtHeadDown = (e: React.MouseEvent) => {
    const pos = cmtPos || { x: 240, y: 160 };
    cmtDragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    window.addEventListener("mousemove", onCmtDrag);
    window.addEventListener("mouseup", onCmtDragUp);
  };

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
  const cellOnTagCancel = useCallback(() => setTagEditPath(null), []);

  // 그리드/리스트가 공유하는 셀 목록(중복 제거). layout 한 값으로 둘 중 하나만 렌더된다.
  // 다중선택 태그 편집 활성(편집 카드가 선택에 포함 + 2개 이상) — 선택된 비포커스 카드에 스트립 표시.
  const tagEditingMulti = tagEditPath != null && selected.size > 1 && selPaths().includes(tagEditPath);
  const cellEls = files.map((f, i) => (
    <AssetCell
      key={f.path}
      project={project}
      node={f}
      idx={i}
      layout={layout}
      scale={scale}
      fit={fit}
      selected={selected.has(i)}
      focused={focusIdx === i}
      deactivated={disabledAssets.has(f.path)}
      selectedCount={selected.has(i) && selected.size > 1 ? selected.size : 1}
      tagEditing={tagEditingMulti}
      meta={meta[f.path] || EMPTY_META}
      editingTag={tagEditPath === f.path}
      onS={cellOnS}
      onC={cellOnC}
      onTagsReplace={cellOnTagsReplace}
      onBulkTagAdd={cellOnBulkTagAdd}
      onBulkTagRemove={cellOnBulkTagRemove}
      onTagCancel={cellOnTagCancel}
      onInfo={onInfo}
      onExportDrag={exportDrag}
    />
  ));
  const marqueeEl = marquee && (
    <div
      className="assets-marquee"
      style={{ left: marquee.l, top: marquee.t, width: marquee.w, height: marquee.h }}
    />
  );

  // 날짜 헤더 체크박스 — 그 날짜의 모든 파일(인덱스)을 한 번에 선택/해제.
  const toggleDate = (idxs: number[], allSel: boolean) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (allSel) idxs.forEach((i) => n.delete(i));
      else idxs.forEach((i) => n.add(i));
      return n;
    });

  // 그리드·리스트 공용: 날짜 구분 모드면 날짜가 바뀔 때마다 섹션 헤더를 끼워넣는다(아니면 셀 그대로).
  const buildGridCells = (): React.ReactNode[] => {
    if (!groupByDate) return cellEls;
    const out: React.ReactNode[] = [];
    let lastDay: string | null = null;
    files.forEach((f, i) => {
      const { key, label } = dayInfoFromMtime(f.mtime);
      if (key !== lastDay) {
        lastDay = key;
        const idxs = dateGroups.get(key)?.idxs ?? [];
        const allSel = idxs.length > 0 && idxs.every((x) => selected.has(x));
        out.push(
          <label className="gen-date-header" key={"h-" + key}>
            <input
              type="checkbox"
              checked={allSel}
              onChange={() => toggleDate(idxs, allSel)}
            />
            <span className="gen-date-label">{label}</span>
            <span className="gen-date-count">{idxs.length}</span>
          </label>,
        );
      }
      out.push(cellEls[i]);
    });
    return out;
  };


  // 코멘트 한 줄. 내 코멘트는 수정/삭제(단 남이 답글 달면 잠김). isReply 면 1단 들여쓰기.
  const renderRow = (c: AssetComment, isReply: boolean, replyToName: string | null) => {
    const mine = c.author === myId;
    const lockedByReply = (cmtByParent[c.id] || []).some((ch) => ch.author !== myId);
    return (
      <div key={c.id} className={"cmt-item" + (isReply ? " reply" : "")}>
        <div className="cmt-meta">
          <span className="cmt-author">{c.author_name || "팀원"}</span>
          {replyToName && <span className="cmt-replyto">↳ {replyToName}</span>}
          <span className="cmt-when">{fmtWhen(c.created_at)}</span>
          <div className="cmt-acts">
            <button onClick={() => { setReplyingId(c.id); setEditingId(null); }}>답글</button>
            {mine && !lockedByReply && (
              <>
                <button onClick={() => { setEditingId(c.id); setReplyingId(null); }}>수정</button>
                <button onClick={() => delComment(c.id)}>삭제</button>
              </>
            )}
            {mine && lockedByReply && <span className="cmt-lock" title="답글이 달려 수정·삭제 불가">🔒</span>}
          </div>
        </div>

        {editingId === c.id ? (
          <form
            className="cmt-mini"
            onSubmit={(e) => {
              e.preventDefault();
              const el = e.currentTarget.elements.namedItem("e") as HTMLInputElement;
              editComment(c.id, el.value);
            }}
          >
            <input name="e" defaultValue={c.text} autoFocus
              onKeyDown={(e) => { if (e.key === "Escape") setEditingId(null); }} />
            <button type="submit">저장</button>
          </form>
        ) : (
          <div className="cmt-text">{c.text}</div>
        )}

        {replyingId === c.id && (
          <form
            className="cmt-mini"
            onSubmit={(e) => {
              e.preventDefault();
              const el = e.currentTarget.elements.namedItem("r") as HTMLInputElement;
              sendComment(el.value, c.id);
              el.value = "";
            }}
          >
            <input name="r" placeholder="답글 작성 ⏎" autoFocus
              onKeyDown={(e) => { if (e.key === "Escape") setReplyingId(null); }} />
            <button type="submit">답글</button>
          </form>
        )}
      </div>
    );
  };

  // 루트 + 그 아래 평탄화된 답글(1단 들여쓰기). 깊은 답글은 ↳@대상 표시.
  const renderThread = (root: AssetComment) => (
    <div key={root.id} className="cmt-group">
      {renderRow(root, false, null)}
      {descendantsOf(root.id).map((d) => {
        const parent = d.parent_id ? cmtById[d.parent_id] : undefined;
        const toName =
          parent && d.parent_id !== root.id ? `${parent.author_name || "팀원"}` : null;
        return renderRow(d, true, toName);
      })}
    </div>
  );

  return (
    <div className="assets-view">
      <div className="assets-view-head">
        <button
          className="assets-title"
          title={t("폴더 등록")}
          onClick={() => setMountOpen(true)}
        >
          <span className="assets-thumb sm" /> Assets
        </button>
        <select
          className="assets-project"
          value={project}
          onChange={(e) => {
            setProject(e.target.value);
            setDir(""); // 사용자가 프로젝트를 바꾸면 루트로
          }}
        >
          {projects.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <span className="muted">{t("MV 라이브러리")}</span>
      </div>

      {mountOpen && (
        <MountManager
          onClose={() => setMountOpen(false)}
          onChanged={() => reloadProjects(true)}
        />
      )}

      <div className="assets-body">
        <aside className="assets-tree">
          <div className="assets-search">
            <span className="as-icon">⌕</span>
            <input
              value={query}
              placeholder="Search · Tag"
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button className="as-clear" title="지우기" onClick={() => setQuery("")}>
                ✕
              </button>
            )}
          </div>
          {/* 타입별 필터(전체/이미지/영상/오디오) — 토글식 */}
          <div className="type-filter">
            {/* All — 타입 필터 해제(모든 미디어). 폴더·검색은 그대로 유지 */}
            <div
              className={"type-row type-all" + (!typeFilter ? " active" : "")}
              onClick={() => setTypeFilter(null)}
            >
              <span className="type-icon">▦</span>
              <span className="type-label">All</span>
              <span className="type-count">
                {typeCounts.image + typeCounts.video + typeCounts.audio || "-"}
              </span>
            </div>
            {(
              [
                ["image", "🖼", "Image"],
                ["video", "🎬", "Video"],
                ["audio", "🎵", "Audio"],
              ] as const
            ).map(([t, icon, label]) => (
              <div
                key={t}
                className={
                  "type-row" +
                  (typeFilter === t ? " active" : "") +
                  (typeCounts[t] === 0 ? " zero" : "")
                }
                onClick={() => {
                  if (typeCounts[t] === 0) return; // 없는 타입은 필터 불가
                  // 폴더·검색을 유지한 채 타입만 토글 → 현재 폴더에서 그 타입만 검색
                  setTypeFilter((cur) => (cur === t ? null : t));
                }}
              >
                <span className="type-icon">{icon}</span>
                <span className="type-label">{label}</span>
                <span className="type-count">{typeCounts[t] > 0 ? typeCounts[t] : "-"}</span>
              </div>
            ))}
          </div>
          <div
            className={"tree-row root" + (dir === "" && !searchActive ? " active" : "")}
            onClick={() => {
              setQuery(""); // 루트로 이동(검색은 해제, 타입 모드는 유지)
              setDir("");
            }}
          >
            <span className="tree-name">🗂 {project || "…"}</span>
          </div>
          {loading ? (
            <div className="assets-loading">로딩…</div>
          ) : (
            <FolderTree
              nodes={tree}
              current={searchActive ? "" : dir}
              onSelect={(p) => { setQuery(""); setDir(p); }}
              expanded={expanded}
              onToggle={toggleDir}
              typeFilter={typeFilter}
            />
          )}
        </aside>

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
          <div className="assets-crumb">
            {tagPanelOpen && (
              <div
                className="tag-panel"
                ref={tagPanelRef}
                style={{
                  left: (tagPanelPos || { x: 180, y: 150 }).x,
                  top: (tagPanelPos || { x: 180, y: 150 }).y,
                  width: tagPanelSize?.w,
                  height: tagPanelSize?.h,
                }}
              >
                <div className="tag-panel-head" onMouseDown={onTagHeadDown}>
                  <span>
                    등록된 태그 <span className="muted">({allTags.length})</span>
                  </span>
                  {activeTags.size > 0 && (
                    <button
                      className="tag-panel-clear"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => setActiveTags(new Set())}
                    >
                      필터 해제
                    </button>
                  )}
                </div>
                <div className="tag-panel-list">
                  {allTags.length === 0 && (
                    <div className="tag-panel-empty">등록된 태그가 없습니다.</div>
                  )}
                  {allTags.map((t) => (
                    <span key={t} className={"tag-pill" + (activeTags.has(t) ? " on" : "")}>
                      <button
                        className="tag-pill-name"
                        title="클릭=이 태그만 · Shift/Ctrl+클릭=다중 선택"
                        onClick={(e) =>
                          setActiveTags((prev) => {
                            const additive = e.shiftKey || e.ctrlKey || e.metaKey;
                            const n = new Set(prev);
                            if (additive) {
                              // 중복 선택: 토글
                              if (n.has(t)) n.delete(t);
                              else n.add(t);
                              return n;
                            }
                            // 일반 클릭: 그 태그만(이미 단독 선택이면 해제)
                            if (n.has(t) && n.size === 1) return new Set();
                            return new Set([t]);
                          })
                        }
                      >
                        #{t}
                      </button>
                      <button
                        className="tag-pill-x"
                        title="이 태그를 모든 파일에서 삭제"
                        onClick={() => deleteTag(t)}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {searchActive ? (
              <span className="crumb-search">
                {activeTags.size
                  ? [...activeTags].map((t) => `#${t}`).join(" ")
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
                {breadcrumb.map((seg, i) => (
                  <span key={i}>
                    <span className="crumb-sep">/</span>
                    <button onClick={() => setDir(breadcrumb.slice(0, i + 1).join("/"))}>
                      {seg}
                    </button>
                  </span>
                ))}
              </>
            )}
            <span className="crumb-count">
              {typeFilter === "image"
                ? t("이미지")
                : typeFilter === "video"
                  ? t("영상")
                  : typeFilter === "audio"
                    ? t("오디오")
                    : t("전체")}{" "}
              · {files.length}{t("개")}
            </span>

            <div className="assets-tools">
              {/* 필터: 컬러 dot · S(소스만) · T(태그 패널) — 슬라이더 왼쪽 */}
              <div className="assets-filters">
                {/* 회색 dot — 맨 앞(r 좌측). 다른 dot 과 반대: ON 이면 비활성(회색) 카드를 숨김. */}
                <button
                  className={"af-dot af-dot-gray" + (grayOn ? " on" : "")}
                  title="비활성화(회색)된 카드만 숨기기 (다른 dot 과 반대)"
                  onClick={() => setGrayOn((v) => !v)}
                />
                {(["r", "g", "b"] as const).map((k) => {
                  const c = ASSET_COLORS[k];
                  const on = activeColors.has(c);
                  return (
                    <button
                      key={k}
                      className={"af-dot" + (on ? " on" : "")}
                      style={{
                        background: c,
                        // 미선택은 약하게(어둡게+탈색), 선택은 강하게+글로우 → 차이가 또렷
                        filter: on ? "brightness(1.2) saturate(1.25)" : "brightness(0.45) saturate(0.7)",
                        opacity: on ? 1 : 0.85,
                        borderColor: on ? "#fff" : "rgba(0,0,0,0.4)",
                        boxShadow: on ? `0 0 0 2px ${c}, 0 0 11px ${c}` : "none",
                      }}
                      title={`${k.toUpperCase()} 컬러만 보기`}
                      onClick={() => toggleColor(c)}
                    />
                  );
                })}
                <button
                  className={"af-btn" + (sourceOnly ? " on" : "")}
                  title="소스로 등록된 것만 보기"
                  onClick={() => setSourceOnly((v) => !v)}
                >
                  S
                </button>
                <button
                  className={"af-btn" + (tagPanelOpen || activeTags.size ? " on" : "")}
                  title="등록된 태그 보기/선택/삭제 (T 다시 누르면 닫힘+필터 해제)"
                  onClick={toggleTagPanel}
                >
                  T
                </button>
                <button
                  className={
                    "af-btn af-c" +
                    (commentOnly ? " on" : "") +
                    (hasAnyUnread && !commentOnly ? " alert" : "")
                  }
                  title={
                    hasAnyUnread
                      ? "새 코멘트가 있는 파일만 보기 (미확인 코멘트 있음)"
                      : "새 코멘트가 있는 파일만 보기"
                  }
                  onClick={() => setCommentOnly((v) => !v)}
                >
                  C
                </button>
              </div>

              <button
                className={"fit-toggle" + (fit === "contain" ? " on" : "")}
                title={
                  fit === "cover"
                    ? "꽉 채우기(크롭) — 클릭 시 전체 보기"
                    : "전체 보기(블랙바) — 클릭 시 꽉 채우기"
                }
                onClick={() => setFit((f) => (f === "cover" ? "contain" : "cover"))}
              >
                {fit === "cover" ? "▣" : "▢"}
              </button>
              <div className="size-slider" title="크기">
                <input
                  type="range"
                  min={0.6}
                  max={1.8}
                  step={0.05}
                  value={scale}
                  onChange={(e) => setScale(Number(e.target.value))}
                />
              </div>
              <div className="layout-toggle">
                <button
                  className={
                    (layout === "list" ? "on" : "") +
                    (layout === "list" && groupByDate ? " grouped" : "")
                  }
                  onClick={() =>
                    layout === "list" ? setGroupByDate((v) => !v) : setLayout("list")
                  }
                  title={
                    layout === "list"
                      ? groupByDate
                        ? t("날짜 구분 끄기 (한 번 더)")
                        : t("리스트")
                      : t("리스트")
                  }
                >
                  <ListIcon />
                </button>
                <button
                  className={
                    (layout === "grid" ? "on" : "") +
                    (layout === "grid" && groupByDate ? " grouped" : "")
                  }
                  onClick={() =>
                    layout === "grid" ? setGroupByDate((v) => !v) : setLayout("grid")
                  }
                  title={
                    layout === "grid"
                      ? groupByDate
                        ? t("날짜 구분 끄기 (한 번 더)")
                        : t("그리드")
                      : t("그리드")
                  }
                >
                  <GridIcon />
                </button>
              </div>
            </div>
          </div>

          {commentPath && (
            <div
              className="cmt-panel"
              ref={cmtPanelRef}
              style={{
                left: (cmtPos || { x: 240, y: 160 }).x,
                top: (cmtPos || { x: 240, y: 160 }).y,
                width: cmtSize?.w,
                height: cmtSize?.h,
              }}
            >
              <div className="cmt-head" onMouseDown={onCmtHeadDown}>
                <span className="cmt-title">
                  💬 코멘트 <span className="muted">({comments.length})</span>
                </span>
                <span className="cmt-file">{commentPath.split("/").pop()}</span>
                <button
                  className="cmt-x"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => setCommentPath(null)}
                >
                  ✕
                </button>
              </div>

              <div className="cmt-thread">
                {comments.length === 0 && (
                  <div className="cmt-empty">아직 코멘트가 없습니다.</div>
                )}
                {cmtRoots.map((root) => renderThread(root))}
              </div>

              <form
                className="cmt-input"
                onSubmit={(e) => {
                  e.preventDefault();
                  const el = e.currentTarget.elements.namedItem("c") as HTMLInputElement;
                  sendComment(el.value);
                  el.value = "";
                }}
              >
                <input name="c" autoComplete="off" placeholder="코멘트 작성 ⏎" autoFocus />
                <button type="submit">전송</button>
              </form>

              <label className="cmt-opt">
                <input type="checkbox" checked={muteOwn} onChange={toggleMuteOwn} />
                내가 작성한 코멘트 알림 끄기
              </label>
            </div>
          )}

          {error && <div className="error" style={{ padding: 12 }}>{error}</div>}

          {files.length === 0 && !loading ? (
            <div className="assets-empty">{t("이 폴더에 미디어가 없습니다.")}</div>
          ) : layout === "list" ? (
            <div className="assets-list" onScroll={onContentScroll} {...gridHandlers}>
              {buildGridCells()}
              {marqueeEl}
            </div>
          ) : (
            <div
              className={"assets-masonry" + (fit === "contain" ? " fit-contain" : "")}
              onScroll={onContentScroll}
              style={{
                gridTemplateColumns: `repeat(auto-fill, minmax(${Math.round(180 * scale)}px, 1fr))`,
              }}
              {...gridHandlers}
            >
              {buildGridCells()}
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

const TOGGLE_ICON = {
  viewBox: "0 0 24 24",
  width: 15,
  height: 15,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};
function ListIcon() {
  return (
    <svg {...TOGGLE_ICON}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="9" y1="4" x2="9" y2="20" />
    </svg>
  );
}
function GridIcon() {
  return (
    <svg {...TOGGLE_ICON}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}
