// 구성탭 히스토리 트리 — 원본(루트)에서 우측으로 파생되는 가로 계층 그래프.
// 히스토리 패널의 '구성에서 보기'로 진입(focusId). 노드 = 결과물, 엣지 = 파생/재료 관계.
//   실선 = derived(재생성·가져오기) · 점선 = reference(@소스로 만듦)
//   메인 라인(원본→최신 파생)은 굵게 + 노드에 생성 순번(1,2,3…) 표시.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { download, downloadName } from "../lib/download";
import { thumbOf } from "../lib/media";
import { useClickSeparation } from "../lib/useClickSeparation";
import { matchShortcut } from "../lib/shortcuts";
import { MediaThumbnail } from "./MediaThumbnail";
import type { Generation, HistoryGraph, InfoTarget, PreviewTarget } from "../types";

const edgeKey = (parent: string, child: string) => parent + ">" + child;

// 비활성화(회색) 표시 — 시각 전용(로컬). gen id 기준 전역 영속(어느 트리에서 봐도 동일).
// 옛 키(ch.lineage.*)에서 1회 폴백 읽기 — 리네임 전 저장값 보존.
const DIS_KEY = "ch.history.disabled";
const DIS_KEY_OLD = "ch.lineage.disabled";
const loadDisabled = (): Set<string> => {
  try {
    const raw = localStorage.getItem(DIS_KEY) ?? localStorage.getItem(DIS_KEY_OLD) ?? "[]";
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
};

// 수동 위치(드래그로 옮긴 카드) — gen id 기준 전역 영속. 없으면 자동 레이아웃 위치 사용.
const POS_KEY = "ch.history.pos";
const POS_KEY_OLD = "ch.lineage.pos";
type XY = { x: number; y: number };
const loadPos = (): Record<string, XY> => {
  try {
    const raw = localStorage.getItem(POS_KEY) ?? localStorage.getItem(POS_KEY_OLD) ?? "{}";
    return JSON.parse(raw) as Record<string, XY>;
  } catch {
    return {};
  }
};

const BOXW = 124;
const BOXH = 124;
const GAPX = 78; // 열(세대) 간격
const GAPY = 26; // 행 간격
const PAD = 28;

interface Pos {
  col: number;
  row: number;
  x: number;
  y: number;
}

export function HistoryBoard({
  focusId,
  reloadSignal,
  arrangeSignal,
  onPreview,
  onInfo,
  onRegenerate,
  onPublish,
  onUnpublish,
  onFinalize,
  onUnfinalize,
  canFinalize,
  onSelectionChange,
  onStats,
  controlRef,
  fill = true,
  scale = 1,
  typeFilter = "all",
  colorFilter,
  tagFilter,
  sharedOnly = false,
  commentOnly = false,
  finalOnly = false,
}: {
  focusId: string | null;
  reloadSignal?: number; // 값이 바뀌면 트리 refetch(생성·재생·동기화 반영) — 선택은 보존
  arrangeSignal?: number; // 값이 바뀌면(='구성에서 보기' 진입) 이 트리의 수동 위치를 비워 자동 정렬(미니 트리와 동일 배치)
  onPreview: (t: PreviewTarget) => void;
  onInfo: (t: InfoTarget) => void; // 휠클릭 정보 팝업(그리드와 동일)
  onRegenerate: (g: Generation) => void;
  onPublish: (g: Generation) => void;
  onUnpublish: (g: Generation) => void;
  onFinalize: (g: Generation) => void; // v02 CMS: 최종(골드) 지정 — S 더블클릭
  onUnfinalize: (g: Generation) => void; // 최종 해제
  canFinalize?: (g: Generation) => boolean; // 최종 가능 판정(supervisor/PM 또는 미배정 본인)
  // 선택 노드(Generation[])를 App에 통지 — 생성 시 부모(파생) + 프롬프트 위 선택바 렌더용.
  onSelectionChange?: (gens: Generation[]) => void;
  // 노드 수(현재 타입필터 기준)·화면 줌%·이동여부를 App→LibraryToolbar 로 올려보낸다(값 변할 때만).
  onStats?: (s: { count: number; zoomPct: number; viewMoved: boolean }) => void;
  // 크기 슬라이더가 보드 줌을 직접 제어 — 슬라이더 onChange 가 controlRef.current.zoomTo(v) 호출.
  controlRef?: { current: { zoomTo: (v: number) => void } | null };
  // 라이브러리 툴바(이미지1)와 동일한 표시/필터 — 보드 노드에 적용:
  fill?: boolean; // false=전체보기(블랙바, contain), true=꽉채우기(cover)
  scale?: number; // 보드 전체 확대 배율(툴바 크기 슬라이더)
  typeFilter?: "all" | "image" | "video" | "audio";
  colorFilter?: Set<string>; // 매칭 안 되는 노드는 흐리게(dim) — 그래프 구조는 유지
  tagFilter?: Set<string>;
  sharedOnly?: boolean;
  commentOnly?: boolean;
  finalOnly?: boolean;
}) {
  const [graph, setGraph] = useState<HistoryGraph | null>(null);
  const [, setLoading] = useState(false); // 로딩 표시 바 제거 — 상태만 유지(요청 진행 추적)
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set()); // 다중 선택(비교용)
  const [disabled, setDisabled] = useState<Set<string>>(loadDisabled); // 비활성화(회색) 표시
  const [manualPos, setManualPos] = useState<Record<string, XY>>(loadPos); // 드래그로 옮긴 위치
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  // S 버튼 확인 플로팅(공유/해제 단일클릭 · 최종 더블클릭) — 보드 단위 1개만 열림.
  const [sConfirm, setSConfirm] = useState<{ id: string; kind: "share" | "final" } | null>(null);
  const sClick = useClickSeparation(220); // 단일(공유)/더블(최종) 분리
  const onNodeSClick = (g: Generation) => {
    if (!g.is_mine) return; // 공유/해제는 본인 것만
    sClick.onClick(() => {
      if (g.is_final) return; // 최종(골드)은 공유 잠금 — 해제는 더블클릭으로만
      setSConfirm({ id: g.id, kind: "share" });
    });
  };
  const onNodeSDouble = (g: Generation) =>
    sClick.onDouble(() => {
      const may = canFinalize ? canFinalize(g) : true;
      if (!may) {
        if (g.is_mine && !g.shared && !g.is_final) onPublish(g); // 권한 없으면 공유만
        return;
      }
      // 최종 지정/해제는 공유(S 활성) 상태에서만. 비활성이면 더블클릭은 공유만 켠다.
      if (g.shared || g.is_final) setSConfirm({ id: g.id, kind: "final" });
      else onPublish(g);
    });
  const onNodeSConfirmYes = (g: Generation) => {
    const c = sConfirm;
    setSConfirm(null);
    if (!c) return;
    if (c.kind === "final") g.is_final ? onUnfinalize(g) : onFinalize(g);
    else g.shared ? onUnpublish(g) : onPublish(g);
  };

  useEffect(() => {
    localStorage.setItem(POS_KEY, JSON.stringify(manualPos));
  }, [manualPos]);

  // 진입(focusId)이 바뀌면 선택을 비운다 — 테두리(선택 표시)는 오직 수동 선택에만 켜지고,
  // 아무것도 선택 안 했을 땐 포커스 카드를 중심으로 한 '연결된 라인'만 굵게 표현한다.
  // (refetch 신호로 인한 갱신 땐 이 effect 가 안 돌아 선택 보존)
  useEffect(() => {
    setSelected(new Set());
  }, [focusId]);

  // 비활성화 상태 영속(새로고침해도 유지)
  useEffect(() => {
    localStorage.setItem(DIS_KEY, JSON.stringify([...disabled]));
  }, [disabled]);

  // 단축키 d — 선택한 노드의 비활성화(회색) 토글. 입력 중엔 무시. 구성탭(focusId) 볼 때만.
  useEffect(() => {
    if (!focusId) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (matchShortcut(e, "boardDisable")) {
        // 비활성화(회색) 토글 — 선택 필요
        const ids = [...selectedRef.current];
        if (!ids.length) return;
        e.preventDefault();
        setDisabled((prev) => {
          const next = new Set(prev);
          const allOff = ids.every((id) => next.has(id));
          ids.forEach((id) => (allOff ? next.delete(id) : next.add(id))); // 전부 꺼져있으면 켜기, 아니면 끄기
          return next;
        });
      } else if (matchShortcut(e, "boardArrange")) {
        // 자동 정렬 — 선택 카드의 수동 위치를 지워 기본 레이아웃(같은 레벨=세로, 연결=우측)으로 복귀.
        // 선택이 없으면 전체를 자동 정렬.
        e.preventDefault();
        setManualPos((prev) => {
          const ids = [...selectedRef.current];
          if (!ids.length) return {};
          const next = { ...prev };
          ids.forEach((id) => delete next[id]);
          return next;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusId]);

  // 선택 변화를 App에 통지(선택 노드의 Generation[] — 파생 부모 + 프롬프트 위 선택바용).
  useEffect(() => {
    const sel = (graph?.nodes || []).filter((g) => selected.has(g.id));
    onSelectionChange?.(sel);
  }, [selected, graph, onSelectionChange]);

  // 트리 로드/갱신: focusId 또는 reloadSignal 변화 시. 기존 그래프 있으면 로딩 표시 안 함(깜박 방지).
  useEffect(() => {
    if (!focusId) {
      setGraph(null);
      return;
    }
    let alive = true;
    setGraph((g) => {
      if (!g) setLoading(true);
      return g;
    });
    setErr(null);
    api
      .historyTree(focusId)
      .then((g) => alive && setGraph(g))
      .catch((e) => alive && setErr(String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [focusId, reloadSignal]);

  // '구성에서 보기' 진입(arrangeSignal 변화) 시: 이 트리 노드들의 수동 위치를 한 번 비워 자동 정렬한다
  // → 히스토리 패널의 미니 트리와 동일한 깔끔한 배치로 보이게(다른 트리의 수동 배치는 보존).
  const pendingArrangeRef = useRef(false);
  const arrangeInitRef = useRef(true);
  useEffect(() => {
    if (arrangeInitRef.current) {
      arrangeInitRef.current = false; // 마운트 시엔 무시(명시적 진입에만 정렬)
      return;
    }
    pendingArrangeRef.current = true;
  }, [arrangeSignal]);
  useEffect(() => {
    if (!graph || !pendingArrangeRef.current) return;
    pendingArrangeRef.current = false;
    const ids = new Set(graph.nodes.map((n) => n.id));
    setManualPos((prev) => {
      let changed = false;
      const next: Record<string, XY> = {};
      for (const id in prev) {
        if (ids.has(id)) {
          changed = true; // 이 트리 노드는 자동 레이아웃으로 되돌림
          continue;
        }
        next[id] = prev[id];
      }
      return changed ? next : prev;
    });
  }, [graph]);

  // 그래프 갱신(삭제·refetch) 후 더는 존재하지 않는 선택 id 정리 — 선택바 잔여(유령 선택) 방지.
  useEffect(() => {
    if (!graph) return;
    const ids = new Set(graph.nodes.map((n) => n.id));
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [graph]);

  // ── 선택: 라이브러리(my work) 그리드와 동일 ──
  //   노드 클릭 = 그것만 단일 선택 · Ctrl/Shift+클릭 = 토글 누적
  //   빈 배경 드래그 = 마퀴(사각형) 복수 선택 · 빈 배경 클릭 = 선택 해제
  const canvasRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const layoutPosRef = useRef<Record<string, XY>>({}); // 최신 자동 레이아웃 위치(드래그 시작점 계산용)
  const [marquee, setMarquee] = useState<{ l: number; t: number; w: number; h: number } | null>(null);
  const [dragging, setDragging] = useState(false); // 위치 드래그 중(전환 끄기 — 끌 때 즉시 따라오게)
  const [zoom, setZoom] = useState(1); // 마우스 휠 확대/축소
  const [pan, setPan] = useState({ x: 0, y: 0 }); // 화면 이동(translate) — 사방 자유 이동
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  // 캔버스 transform 은 scale(zoom * scale) 이므로 좌표 환산엔 둘을 곱한 총배율을 써야 한다.
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const panStateRef = useRef(pan);
  panStateRef.current = pan;

  // 노드 수(현재 타입필터 기준)·줌%·이동여부를 App(→LibraryToolbar)에 보고 — 값이 실제로 바뀔 때만
  // (pan 드래그 중엔 viewMoved 가 이미 true 라 재호출 안 됨 → 불필요한 App 리렌더 방지).
  const statsRef = useRef("");
  // useLayoutEffect — 줌 변경 시 페인트 전에 슬라이더 값(boardStats.zoomPct)을 갱신해 떨림 방지.
  useLayoutEffect(() => {
    if (!onStats) return;
    const count = graph
      ? graph.nodes.filter(
          (g) => typeFilter === "all" || g.assets[0]?.type === typeFilter,
        ).length
      : 0;
    const zoomPct = Math.round(zoom * 100);
    const viewMoved = zoom !== 1 || pan.x !== 0 || pan.y !== 0;
    const key = `${count}|${zoomPct}|${viewMoved}`;
    if (key === statsRef.current) return;
    statsRef.current = key;
    onStats({ count, zoomPct, viewMoved });
  }, [graph, typeFilter, zoom, pan, onStats]);

  // 상단 크기 슬라이더가 보드 줌을 직접 조절 — 줌을 v 로 맞추고 화면은 홈(pan 0)으로 정렬.
  // (휠 줌은 커서 기준 앵커링 유지, 슬라이더 줌은 중심/홈 기준 — 슬라이더로 pan 도 함께 리셋되는 효과.)
  useEffect(() => {
    if (!controlRef) return;
    controlRef.current = {
      zoomTo: (v: number) => {
        setZoom(Math.min(2.5, Math.max(0.3, v)));
        setPan({ x: 0, y: 0 });
      },
    };
    return () => {
      controlRef.current = null;
    };
  }, [controlRef]);

  // 마우스 휠 = 확대/축소(커서 위치 기준). translate+scale 로 커서 아래 지점 고정.
  // React onWheel 은 passive 라 네이티브로 등록(preventDefault).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left, cy = e.clientY - rect.top; // 컨테이너 기준 커서
      const prev = zoomRef.current;
      const nz = Math.min(2.5, Math.max(0.3, prev * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      if (nz === prev) return;
      const ratio = nz / prev;
      setZoom(nz);
      setPan((p) => ({ x: cx - (cx - p.x) * ratio, y: cy - (cy - p.y) * ratio }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  const dragRef = useRef<{
    x: number; y: number; base: Set<string>; additive: boolean; moved: boolean;
    nodeId: string | null; origins: Record<string, XY>; // 이동 대상(들)의 시작 위치
  } | null>(null);

  // 드래그 종료(cleanup) 핸들러를 ref 로 노출 — onDragMove 의 안전장치(버튼 뗌 감지)에서 호출.
  const dragEndRef = useRef<() => void>(() => {});

  const onDragMove = useCallback((e: MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    // 안전장치: 버튼을 이미 뗐는데 mouseup 을 놓쳤다면(네이티브 드래그 가로챔 등) 여기서 종료.
    // — 이게 없으면 버튼 안 눌렀는데도 카드가 커서를 계속 따라다님(드래그 멈춤 안 됨).
    if (e.buttons === 0) {
      dragEndRef.current();
      return;
    }
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
    d.moved = true;
    const z = zoomRef.current * scaleRef.current; // 총배율(휠 zoom × 툴바 scale)로 환산
    if (d.nodeId) {
      // 노드에서 시작한 드래그 = 위치 이동(보드). 화면 이동량을 줌으로 나눠 로컬 좌표로.
      const dx = (e.clientX - d.x) / z, dy = (e.clientY - d.y) / z;
      setManualPos((prev) => {
        const next = { ...prev };
        for (const tid in d.origins) {
          // 클램프 없음 — 사방(음수 포함) 무한 이동
          next[tid] = { x: d.origins[tid].x + dx, y: d.origins[tid].y + dy };
        }
        return next;
      });
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cr = canvas.getBoundingClientRect();
    const x0 = Math.min(d.x, e.clientX), y0 = Math.min(d.y, e.clientY);
    const x1 = Math.max(d.x, e.clientX), y1 = Math.max(d.y, e.clientY);
    // 마퀴 박스는 캔버스(스케일됨) 자식이므로 로컬 좌표(/줌)로 그린다.
    setMarquee({ l: (x0 - cr.left) / z, t: (y0 - cr.top) / z, w: (x1 - x0) / z, h: (y1 - y0) / z });
    const hit = new Set<string>(d.additive ? d.base : []);
    canvas.querySelectorAll(".linb-node").forEach((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.right >= x0 && r.left <= x1 && r.bottom >= y0 && r.top <= y1) {
        const id = (el as HTMLElement).dataset.id;
        if (id) hit.add(id);
      }
    });
    setSelected(hit);
  }, []);

  const onDragUp = useCallback(() => {
    const d = dragRef.current;
    dragRef.current = null;
    window.removeEventListener("mousemove", onDragMove);
    window.removeEventListener("mouseup", onDragUp);
    setMarquee(null);
    setDragging(false);
    if (!d || d.moved) return; // 드래그로 마퀴 적용됨 → 끝
    // 드래그 없이 클릭만 →
    if (d.nodeId) {
      if (d.additive) {
        const n = new Set(d.base);
        n.has(d.nodeId) ? n.delete(d.nodeId) : n.add(d.nodeId);
        setSelected(n);
      } else {
        setSelected(new Set([d.nodeId]));
      }
    } else if (!d.additive) {
      setSelected(new Set()); // 빈 배경 클릭 → 해제
    }
  }, [onDragMove]);
  dragEndRef.current = onDragUp; // onDragMove 안전장치가 부를 최신 cleanup

  // 휠클릭(미들 버튼) 드래그 = 화면 이동(패닝, translate). 사방 무한 이동. 손모양 커서.
  const panRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const onPanMove = useCallback((e: MouseEvent) => {
    const p = panRef.current;
    if (!p) return;
    // 안전장치: 미들버튼(4)이 더는 안 눌렸으면 패닝 종료 — mouseup 누락 시 화면이 계속 끌려가는 것 방지.
    if ((e.buttons & 4) === 0) {
      onPanUpRef.current();
      return;
    }
    // 실제 이동이 시작될 때만 패닝 모드(손모양·상호작용 잠금) — 클릭만이면 노드 정보(auxclick) 보존.
    scrollRef.current?.classList.add("panning");
    setPan({ x: p.px + (e.clientX - p.x), y: p.py + (e.clientY - p.y) });
  }, []);
  const onPanUpRef = useRef<() => void>(() => {});
  const onPanUp = useCallback(() => {
    panRef.current = null;
    scrollRef.current?.classList.remove("panning");
    window.removeEventListener("mousemove", onPanMove);
    window.removeEventListener("mouseup", onPanUp);
  }, [onPanMove]);
  onPanUpRef.current = onPanUp; // onPanMove 안전장치가 부를 최신 cleanup

  const onBoardMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1) {
      // 미들 버튼 → 패닝 시작(이동 없이 클릭만이면 노드 onAuxClick 이 정보 팝업을 띄움)
      e.preventDefault();
      const cur = panStateRef.current;
      panRef.current = { x: e.clientX, y: e.clientY, px: cur.x, py: cur.y };
      // panning 클래스는 실제 이동(onPanMove) 시에만 — 정지 클릭은 노드 정보(auxclick)가 떠야 하므로.
      window.addEventListener("mousemove", onPanMove);
      window.addEventListener("mouseup", onPanUp);
      return;
    }
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input, label")) return;
    // 네이티브 텍스트 선택·이미지 드래그를 막는다 — 이것들이 끼면 mouseup 이 dragend 로 바뀌어
    // 우리 드래그가 안 끝나고 카드가 커서를 계속 따라다님(오버레이 드래그 핸들은 stopPropagation 이라 영향 없음).
    e.preventDefault();
    const nodeEl = (e.target as HTMLElement).closest(".linb-node") as HTMLElement | null;
    const id = nodeEl?.dataset.id ?? null;
    // 이동 대상: 잡은 노드가 선택에 포함되면 선택된 전부, 아니면 그 노드만.
    const targetIds = id ? (selected.has(id) ? [...selected] : [id]) : [];
    const origins: Record<string, XY> = {};
    for (const tid of targetIds) {
      origins[tid] = manualPos[tid] || layoutPosRef.current[tid] || { x: 0, y: 0 };
    }
    dragRef.current = {
      x: e.clientX,
      y: e.clientY,
      base: new Set(selected),
      additive: e.shiftKey || e.ctrlKey || e.metaKey,
      moved: false,
      nodeId: id,
      origins,
    };
    if (id) setDragging(true); // 노드 잡음 → 전환 끄기(즉시 따라오게)
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", onDragUp);
  };

  // 하이라이트 '중심' — 수동 선택이 있으면 그것, 없으면 진입한 포커스 카드.
  //  → 아무것도 선택 안 해도 포커스를 중심으로 연결 라인이 굵게 보인다(테두리는 안 켜짐).
  const center = useMemo<string[]>(() => {
    if (selected.size) return [...selected];
    if (graph && focusId && graph.nodes.some((n) => n.id === focusId)) return [focusId];
    return [];
  }, [selected, graph, focusId]);

  // ── 중심 카드의 '연결된 직계 라인'(조상↑ + 자손↓) 엣지·노드 하이라이트 ──
  const highlight = useMemo(() => {
    const edges = new Set<string>();
    const nodes = new Set<string>();
    if (!graph || !center.length) return { edges, nodes };
    const inEdges: Record<string, { p: string; c: string }[]> = {};
    const outEdges: Record<string, { p: string; c: string }[]> = {};
    for (const e of graph.edges) {
      (inEdges[e.child_gen_id] ||= []).push({ p: e.parent_gen_id, c: e.child_gen_id });
      (outEdges[e.parent_gen_id] ||= []).push({ p: e.parent_gen_id, c: e.child_gen_id });
    }
    center.forEach((id) => nodes.add(id));
    // 위로(조상): 부모 엣지를 따라 루트까지
    let stack = [...center];
    const seenUp = new Set<string>();
    while (stack.length) {
      const id = stack.pop()!;
      if (seenUp.has(id)) continue;
      seenUp.add(id);
      for (const e of inEdges[id] || []) {
        edges.add(edgeKey(e.p, e.c));
        nodes.add(e.p);
        stack.push(e.p);
      }
    }
    // 아래로(자손): 자식 엣지를 따라 끝까지
    stack = [...center];
    const seenDown = new Set<string>();
    while (stack.length) {
      const id = stack.pop()!;
      if (seenDown.has(id)) continue;
      seenDown.add(id);
      for (const e of outEdges[id] || []) {
        edges.add(edgeKey(e.p, e.c));
        nodes.add(e.c);
        stack.push(e.c);
      }
    }
    return { edges, nodes };
  }, [graph, center]);
  const hasCenter = center.length > 0;

  // ── 선택(수동) 카드의 '조상 경로'(선택→루트) — 직계 라인 위에 흰색으로 덧그릴 부분 ──
  //  포커스만 진입한 기본 상태에선 비어 있어 직계 라인이 액센트(테두리) 색으로만 보이고,
  //  사용자가 카드를 선택하면 그 카드에서 루트까지의 경로만 흰색으로 강조된다(자손은 액센트 유지).
  const whiteEdges = useMemo(() => {
    const edges = new Set<string>();
    if (!graph || !selected.size) return edges;
    const inEdges: Record<string, { p: string; c: string }[]> = {};
    for (const e of graph.edges) {
      (inEdges[e.child_gen_id] ||= []).push({ p: e.parent_gen_id, c: e.child_gen_id });
    }
    const stack = [...selected];
    const seen = new Set<string>();
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const e of inEdges[id] || []) {
        edges.add(edgeKey(e.p, e.c));
        stack.push(e.p);
      }
    }
    return edges;
  }, [graph, selected]);

  // ── 계층 레이아웃: 열 = 최장경로 깊이(부모로부터), 행 = 부모 무게중심 정렬로 교차 최소화 ──
  const layout = useMemo(() => {
    if (!graph || !graph.nodes.length) return null;
    const byId: Record<string, Generation> = {};
    graph.nodes.forEach((n) => (byId[n.id] = n));
    const parentsOf: Record<string, string[]> = {};
    const childrenOf: Record<string, string[]> = {};
    for (const e of graph.edges) {
      if (!byId[e.parent_gen_id] || !byId[e.child_gen_id]) continue;
      (childrenOf[e.parent_gen_id] ||= []).push(e.child_gen_id);
      (parentsOf[e.child_gen_id] ||= []).push(e.parent_gen_id);
    }
    // 깊이(최장경로) — 부모 없으면 0
    const depthMemo: Record<string, number> = {};
    const depthOf = (id: string, guard: Set<string> = new Set()): number => {
      if (id in depthMemo) return depthMemo[id];
      const ps = parentsOf[id] || [];
      if (!ps.length || guard.has(id)) return (depthMemo[id] = 0);
      guard.add(id);
      const d = 1 + Math.max(...ps.map((p) => depthOf(p, guard)));
      guard.delete(id);
      return (depthMemo[id] = d);
    };
    const ts = (id: string) => byId[id]?.sort_ts || 0;
    const maxCol = Math.max(0, ...graph.nodes.map((n) => depthOf(n.id)));
    const columns: string[][] = Array.from({ length: maxCol + 1 }, () => []);
    graph.nodes.forEach((n) => columns[depthOf(n.id)].push(n.id));

    const pos: Record<string, Pos> = {};
    columns.forEach((colIds, c) => {
      const bary = (id: string) => {
        const prs = (parentsOf[id] || [])
          .map((p) => pos[p]?.row)
          .filter((r): r is number => r != null);
        return prs.length ? prs.reduce((s, r) => s + r, 0) / prs.length : ts(id) / 1e9;
      };
      if (c === 0) colIds.sort((a, b) => ts(a) - ts(b));
      else colIds.sort((a, b) => bary(a) - bary(b) || ts(a) - ts(b));
      colIds.forEach((id, row) => {
        pos[id] = {
          col: c,
          row,
          x: PAD + c * (BOXW + GAPX),
          y: PAD + row * (BOXH + GAPY),
        };
      });
    });

    const maxRows = Math.max(1, ...columns.map((c) => c.length));
    const width = PAD * 2 + (maxCol + 1) * BOXW + maxCol * GAPX;
    const height = PAD * 2 + maxRows * BOXH + (maxRows - 1) * GAPY;
    return { byId, pos, width, height, edges: graph.edges };
  }, [graph]);

  // (옛 '메인 라인=최신 파생 체인 항상 굵게'는 포커스를 안 지나가 혼란 → 제거.
  //  굵은 라인은 이제 center(선택/포커스) 기준 highlight 로만 그린다.)

  // 자동 레이아웃 위치를 ref 로 노출(드래그 시작점 계산), 최종 위치 = 수동 우선.
  layoutPosRef.current = layout?.pos || {};
  const posOf = (id: string): XY => manualPos[id] || layout?.pos[id] || { x: 0, y: 0 };

  // 새로 생성된 카드 배치: 부모(선택 카드)가 수동 위치면 그 '우측'에 붙인다(부모를 옮겨도 자식이 따라옴).
  // 부모가 자동 위치면 자동 레이아웃이 이미 우측 세대에 두므로 손대지 않는다.
  const prevIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!graph) {
      prevIdsRef.current = new Set();
      return;
    }
    const prev = prevIdsRef.current;
    const newOnes = graph.nodes.filter((n) => !prev.has(n.id));
    prevIdsRef.current = new Set(graph.nodes.map((n) => n.id));
    if (!prev.size || !newOnes.length) return; // 첫 로드/변동 없음 → 자동 배치에 맡김
    const parentOf: Record<string, string> = {};
    for (const e of graph.edges)
      if (e.relation === "derived") parentOf[e.child_gen_id] = e.parent_gen_id;
    setManualPos((mp) => {
      const next = { ...mp };
      const cnt: Record<string, number> = {};
      let changed = false;
      for (const n of newOnes) {
        const pid = parentOf[n.id];
        const ppos = pid ? next[pid] : null; // 부모가 수동 위치일 때만
        if (!ppos) continue;
        const k = cnt[pid] || 0;
        cnt[pid] = k + 1;
        next[n.id] = { x: ppos.x + BOXW + GAPX, y: ppos.y + k * (BOXH + GAPY) };
        changed = true;
      }
      return changed ? next : mp;
    });
  }, [graph]);
  // 캔버스 크기 — 수동으로 옮긴 카드까지 포함해 스크롤 범위 확장.
  const dims = useMemo(() => {
    if (!layout) return { w: 0, h: 0 };
    let w = layout.width, h = layout.height;
    for (const id in manualPos) {
      const p = manualPos[id];
      w = Math.max(w, p.x + BOXW + PAD);
      h = Math.max(h, p.y + BOXH + PAD);
    }
    return { w, h };
  }, [layout, manualPos]);

  if (!focusId) {
    return (
      <div className="linb-empty">
        <div className="linb-empty-card">
          <div className="linb-empty-title">히스토리 보기</div>
          카드의 히스토리 뱃지(⑂ / ↻)를 눌러 가계 패널을 연 뒤,
          <b> ‘구성에서 보기’</b>를 누르면 여기에 원본 → 파생 트리가 그려집니다.
        </div>
      </div>
    );
  }

  return (
    <div className="linb">
      {/* 범례/제목 바 제거(사용자 요청) — 줌·필터는 상단 LibraryToolbar 가 담당, 로딩은 토스트/툴바로 표시. */}
      {err && <div className="linb-err">{err}</div>}
      <div className="linb-scroll" ref={scrollRef} onMouseDown={onBoardMouseDown}>
        {layout && (
          <div
            className={"linb-canvas" + (dragging ? " dragging" : "")}
            ref={canvasRef}
            style={{
              width: dims.w,
              height: dims.h,
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom * scale})`,
              transformOrigin: "0 0",
            }}
          >
            <svg
              className="linb-svg"
              width={dims.w}
              height={dims.h}
              viewBox={`0 0 ${dims.w} ${dims.h}`}
            >
              {/* 1차: 일반 엣지(선택 시 흐리게) */}
              {layout.edges.map((e, i) => {
                const p = posOf(e.parent_gen_id);
                const c = posOf(e.child_gen_id);
                if (!p || !c) return null;
                const x1 = p.x + BOXW;
                const y1 = p.y + BOXH / 2;
                const x2 = c.x;
                const y2 = c.y + BOXH / 2;
                const mx = (x1 + x2) / 2;
                const dim = hasCenter && !highlight.edges.has(edgeKey(e.parent_gen_id, e.child_gen_id));
                const edgeOff = disabled.has(e.parent_gen_id) || disabled.has(e.child_gen_id);
                return (
                  <path
                    key={i}
                    d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                    className={
                      "linb-edge " +
                      (e.relation === "reference" ? "ref" : "der") +
                      (dim ? " dim" : "") +
                      (edgeOff ? " disabled" : "")
                    }
                  />
                );
              })}
              {/* 2차: 중심(포커스/선택) 카드의 직계 라인을 '테두리 색(라임)'으로 굵게 덧그림.
                  포커스만 진입한 기본 상태는 여기까지(흰색 아님). */}
              {layout.edges
                .filter((e) => highlight.edges.has(edgeKey(e.parent_gen_id, e.child_gen_id)))
                .map((e, i) => {
                  const p = posOf(e.parent_gen_id);
                  const c = posOf(e.child_gen_id);
                  if (!p || !c) return null;
                  const x1 = p.x + BOXW;
                  const y1 = p.y + BOXH / 2;
                  const x2 = c.x;
                  const y2 = c.y + BOXH / 2;
                  const mx = (x1 + x2) / 2;
                  const edgeOff = disabled.has(e.parent_gen_id) || disabled.has(e.child_gen_id);
                  return (
                    <path
                      key={"main" + i}
                      d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                      className={"linb-edge main" + (edgeOff ? " disabled" : "")}
                    />
                  );
                })}
              {/* 3차: 카드를 선택하면 그 카드 → 루트(조상 경로)만 흰색으로 맨 위에 덧그림. */}
              {layout.edges
                .filter((e) => whiteEdges.has(edgeKey(e.parent_gen_id, e.child_gen_id)))
                .map((e, i) => {
                  const p = posOf(e.parent_gen_id);
                  const c = posOf(e.child_gen_id);
                  if (!p || !c) return null;
                  const x1 = p.x + BOXW;
                  const y1 = p.y + BOXH / 2;
                  const x2 = c.x;
                  const y2 = c.y + BOXH / 2;
                  const mx = (x1 + x2) / 2;
                  const edgeOff = disabled.has(e.parent_gen_id) || disabled.has(e.child_gen_id);
                  return (
                    <path
                      key={"hl" + i}
                      d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                      className={"linb-edge hl" + (edgeOff ? " disabled" : "")}
                    />
                  );
                })}
            </svg>
            {graph!.nodes.map((g) => {
              const p = posOf(g.id);
              if (!p) return null;
              const thumb = thumbOf(g);
              const a = g.assets[0];
              const isRoot = graph!.root_ids.includes(g.id);
              const isSel = selected.has(g.id);
              const onLine = highlight.nodes.has(g.id); // 중심(선택/포커스)의 직계 라인 위
              const offLine = hasCenter && !onLine; // 직계 라인 밖 → 조금 더 작게
              return (
                <div
                  key={g.id}
                  data-id={g.id}
                  className={
                    "linb-node" +
                    (isRoot ? " root" : "") +
                    // 직계 라인 위 노드는 '테두리 색(라임)'으로 체인 표시(이미지2). 선택·루트는 각자 강조 유지.
                    (onLine && !isSel && !isRoot ? " mainline" : "") +
                    // 테두리(선택 표시)는 수동 선택에만 흰/굵게.
                    (isSel ? " sel" : "") +
                    (g.is_final ? " final" : "") +
                    // 하단 컬러바(컬러 또는 최종)가 있으면 캡션을 그 위로 올림
                    (g.color || g.is_final ? " has-cbar" : "") +
                    (disabled.has(g.id) ? " disabled" : "") +
                    // 계보로만 보이는(공유 안 됐고 내 것도 아닌) 노드 — 작고 투명하게(공유물과 구분)
                    (!g.shared && !g.is_mine ? " unshared" : "") +
                    // 선택/포커스의 직계 라인 밖 노드는 조금 더 작게(라인 집중)
                    (offLine ? " offline" : "") +
                    // 툴바 fill: false=전체보기(블랙바·contain)
                    (fill ? "" : " fit-contain") +
                    // 툴바 필터 매칭 안 되는 노드는 흐리게(dim) — 그래프 구조는 유지
                    ((typeFilter !== "all" && a?.type !== typeFilter) ||
                    (!!colorFilter && colorFilter.size > 0 && !(g.color && colorFilter.has(g.color))) ||
                    (!!tagFilter && tagFilter.size > 0 && !g.tags.some((t) => tagFilter.has(t))) ||
                    (sharedOnly && !g.shared) ||
                    (commentOnly && g.comment_count === 0) ||
                    (finalOnly && !g.is_final)
                      ? " dimmed"
                      : "")
                  }
                  style={{ left: p.x, top: p.y, width: BOXW, height: BOXH }}
                  title={`${g.prompt.slice(0, 80)}\n클릭=선택 · 드래그=위치 이동(다중선택 시 함께) · 배경 드래그=복수 선택 · 더블클릭=미리보기 · 휠클릭=정보 · d=비활성 · l=자동 정렬`}
                  onMouseEnter={(e) => {
                    const v = e.currentTarget.querySelector("video") as HTMLVideoElement | null;
                    if (v) v.play().catch(() => {});
                  }}
                  onMouseLeave={(e) => {
                    const v = e.currentTarget.querySelector("video") as HTMLVideoElement | null;
                    if (v) {
                      v.pause();
                      v.currentTime = 0;
                    }
                  }}
                  onDoubleClick={() =>
                    a &&
                    onPreview({ url: a.file_path, type: a.type, name: g.prompt.slice(0, 50), genId: g.id })
                  }
                  onAuxClick={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      onInfo({ kind: "generation", gen: g, x: e.clientX, y: e.clientY });
                    }
                  }}
                  onMouseDown={(e) => e.button === 1 && e.preventDefault()}
                >
                  <MediaThumbnail
                    thumb={thumb}
                    isVideo={a?.type === "video"}
                    src={a?.file_path}
                    fallback={<span className={"linb-ph status-" + g.status}>{g.status}</span>}
                  />
                  {a?.type === "video" && <span className="linb-vid">▶</span>}
                  {isRoot && <span className="linb-tag root-tag">원본</span>}
                  {/* 생성 순번 숫자 뱃지 제거 — 그래프 연결로 히스토리를 확인할 수 있어 불필요. */}
                  {/* 상시 배지 — 메인 라이브러리 card-sf 와 동형: 공유=라임 S, 최종=골드 ★(우상단
                      정적 별 대신 S 자리에서 ★ 로 바뀜). 호버하면 오버레이 S/★ 버튼이 대신한다. */}
                  {(g.shared || g.is_final) && (
                    <span
                      className={"linb-sf" + (g.is_final ? " final" : " shared")}
                      title={g.is_final ? "최종(골드)" : "팀 공유됨"}
                    >
                      {g.is_final ? "★" : "S"}
                    </span>
                  )}
                  <span className="linb-cap">{g.prompt.slice(0, 22) || "(제목 없음)"}</span>
                  {/* 하단 컬러바 — 카드와 동일. 최종이면 골드 + 빛 흐름, 그 외엔 r/g/b 컬러. */}
                  {(g.color || g.is_final) && (
                    <span
                      className={"linb-colorbar" + (g.is_final ? " final" : "")}
                      style={g.is_final ? undefined : { background: g.color || undefined }}
                    />
                  )}

                  {/* 호버 오버레이 액션(그리드 카드와 동일): 재사용 드래그·정보·다운로드·재생성·공유 */}
                  <div className="linb-ov" onMouseDown={(e) => e.stopPropagation()}>
                    <div className="linb-ov-top">
                      {/* S(공유/최종) — 그리드 카드와 동일하게 좌상단 원래 위치로 */}
                      {g.status === "done" && (
                        <button
                          className={
                            "linb-ov-btn" +
                            (g.shared ? " on" : "") +
                            (g.is_final ? " final" : "")
                          }
                          title={
                            g.is_final
                              ? "최종(골드) · 더블클릭=최종 해제"
                              : g.shared
                                ? "팀 공유됨 · 클릭=공유 해제 · 더블클릭=최종 지정"
                                : "팀에 공유 (클릭) · 공유 후 더블클릭=최종 지정"
                          }
                          onClick={(e) => {
                            e.stopPropagation();
                            onNodeSClick(g);
                          }}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            onNodeSDouble(g);
                          }}
                        >
                          {g.is_final ? "★" : "S"}
                        </button>
                      )}
                      <button
                        className="linb-ov-btn"
                        style={{ marginLeft: "auto" }} // 정보는 항상 우상단(S 유무 무관)
                        title="정보"
                        onClick={(e) =>
                          onInfo({ kind: "generation", gen: g, x: e.clientX, y: e.clientY })
                        }
                      >
                        ⓘ
                      </button>
                    </div>
                    {/* 좌상단 드래그 그립(S 버튼 밑) — 끌어서 프롬프트에 레퍼런스로 추가(누적) */}
                    <span
                      className="linb-ov-btn linb-ov-drag linb-ov-grip"
                      draggable
                      title="프롬프트로 끌어 레퍼런스로 추가(여러 개 끌면 누적)"
                      onDragStart={(e) => {
                        e.dataTransfer.setData("application/x-ch-gen", g.id);
                        e.dataTransfer.effectAllowed = "copy";
                      }}
                    >
                      ⠿
                    </span>
                    <div className="linb-ov-bot">
                      {a && (
                        <button
                          className="linb-ov-btn"
                          title="다운로드"
                          onClick={() => download(a.file_path, downloadName(g, a.type))}
                        >
                          ⤓
                        </button>
                      )}
                      <button
                        className="linb-ov-btn"
                        title="레퍼런스로 사용 — 이 생성물을 @레퍼런스로 추가 (끌어내리면 프롬프트 재사용)"
                        onClick={(e) => {
                          e.stopPropagation();
                          window.dispatchEvent(
                            new CustomEvent("ch:add-reference", { detail: g.id }),
                          );
                        }}
                      >
                        @
                      </button>
                      <button
                        className="linb-ov-btn"
                        title="재생성 — 이 결과물에서 파생본 만들기"
                        onClick={() => onRegenerate(g)}
                      >
                        ↻
                      </button>
                    </div>
                  </div>
                  {sConfirm?.id === g.id && (
                    <div
                      className="sconfirm"
                      onClick={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
                    >
                      <span className="cs-final-q">
                        {sConfirm.kind === "final"
                          ? g.is_final
                            ? "최종 지정을 해제할까요?"
                            : "최종(골드)으로 지정할까요?"
                          : g.shared
                            ? "공유 해제 할까요?"
                            : "공유 하시겠습니까?"}
                      </span>
                      <div className="cs-final-actions">
                        <button className="cs-final-yes" onClick={() => onNodeSConfirmYes(g)}>
                          Yes
                        </button>
                        <button className="cs-final-no" onClick={() => setSConfirm(null)}>
                          No
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {marquee && (
              <div
                className="linb-marquee"
                style={{ left: marquee.l, top: marquee.t, width: marquee.w, height: marquee.h }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

