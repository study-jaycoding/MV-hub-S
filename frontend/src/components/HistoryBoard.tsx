// 구성탭 히스토리 트리 — 원본(루트)에서 우측으로 파생되는 가로 계층 그래프.
// 히스토리 패널의 '구성에서 보기'로 진입(focusId). 노드 = 결과물, 엣지 = 파생/재료 관계.
//   실선 = derived(재생성·가져오기) · 점선 = reference(@소스로 만듦)
//   메인 라인(원본→최신 파생)은 굵게 + 노드에 생성 순번(1,2,3…) 표시.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { loadJSON, saveJSON } from "../lib/storage";
import { STORAGE_KEYS } from "../lib/storageKeys";
import { useClickSeparation } from "../lib/useClickSeparation";
import { useCustomEvent } from "../lib/useCustomEvent";
import { useDebouncedCallback } from "../lib/useDebouncedCallback";
import { addWindowMouseDrag, removeWindowMouseDrag } from "../lib/windowDrag";
import { loadDisabledGen, loadDisabledFolders, DISABLED_EVENT } from "../lib/deactivated";
import { expandDisabledGenerationIds } from "../lib/generationDisplay";
import {
  HISTORY_BOARD_LAYOUT,
  buildHistoryLayout,
  expandHistoryDims,
  getHistoryCenter,
  traceAncestorHistoryEdges,
  traceConnectedHistoryLine,
  type HistoryView,
  type XY,
} from "../lib/historyGraphLayout";
import { HistoryBoardEdges } from "./history/HistoryBoardEdges";
import { HistoryBoardNode } from "./history/HistoryBoardNode";
import { HistoryRefNode } from "./history/HistoryRefNode";
import { useHistoryBoardShortcuts } from "./history/useHistoryBoardShortcuts";
import { useHistoryGraph } from "./history/useHistoryGraph";
import { useHistoryManualPositions } from "./history/useHistoryManualPositions";
import type { Generation, InfoTarget, PreviewTarget } from "../types";

// 비활성화(회색) 표시는 lib/deactivated 로 이동(생성/공유 라이브러리와 한 소스 공유).

// 카드별 카메라(zoom/pan) — 탭 이동 후 같은 카드의 히스토리로 재진입하면 보던 화면 그대로 복원.
const VIEW_KEY = STORAGE_KEYS.historyView;
const loadViews = (): Record<string, HistoryView> => {
  try {
    return loadJSON<Record<string, HistoryView>>(VIEW_KEY) || {};
  } catch {
    return {};
  }
};

const { nodeW: BOXW, nodeH: BOXH, gapX: GAPX, gapY: GAPY } = HISTORY_BOARD_LAYOUT;
// 원본 왼쪽에 확보할 레퍼런스 노드 lane 폭(노드 1칸 + 간격).
const REF_LANE = BOXW + GAPX;

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
  const { err, graph } = useHistoryGraph(focusId, reloadSignal);
  const [selected, setSelected] = useState<Set<string>>(new Set()); // 다중 선택(비교용)
  const [disabled, setDisabled] = useState<Set<string>>(loadDisabledGen); // 비활성화(회색) 표시(id 직접)
  const [disabledFolders, setDisabledFolders] = useState(loadDisabledFolders); // 폴더 단위 비활성
  const { manualPos, setManualPos } = useHistoryManualPositions(graph, arrangeSignal);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  // S 버튼 확인 플로팅(공유/해제 단일클릭 · 최종 더블클릭) — 보드 단위 1개만 열림.
  const [sConfirm, setSConfirm] = useState<{ id: string; kind: "share" | "final" } | null>(null);
  const sClick = useClickSeparation(220); // 단일(공유)/더블(최종) 분리
  // 노드에 넘기는 S 핸들러를 안정 참조로 고정(빈 deps useCallback, 최신 값은 ref 로 읽음) —
  // HistoryBoardNode(memo)가 마퀴 드래그(setSelected 매 프레임) 중 불필요하게 재렌더되지 않게.
  const cbRef = useRef({ sClick, canFinalize, onPublish, onUnpublish, onFinalize, onUnfinalize });
  cbRef.current = { sClick, canFinalize, onPublish, onUnpublish, onFinalize, onUnfinalize };
  const sConfirmRef = useRef(sConfirm);
  sConfirmRef.current = sConfirm;
  const onNodeSClick = useCallback((g: Generation) => {
    // 공유/해제=본인 것. 추가로 슈퍼바이저는 남의 '공유된' 카드를 해제할 수 있다(B안).
    const may = cbRef.current.canFinalize ? cbRef.current.canFinalize(g) : true;
    if (!g.is_mine && !(g.shared && may)) return;
    cbRef.current.sClick.onClick(() => {
      if (g.is_final) return; // 최종(골드)은 공유 잠금 — 해제는 더블클릭으로만
      setSConfirm({ id: g.id, kind: "share" });
    });
  }, []);
  const onNodeSDouble = useCallback((g: Generation) => {
    const { sClick, canFinalize, onPublish } = cbRef.current;
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
  }, []);
  const onNodeSConfirmYes = useCallback((g: Generation) => {
    const c = sConfirmRef.current;
    setSConfirm(null);
    if (!c) return;
    const { onFinalize, onUnfinalize, onPublish, onUnpublish } = cbRef.current;
    if (c.kind === "final") g.is_final ? onUnfinalize(g) : onFinalize(g);
    else g.shared ? onUnpublish(g) : onPublish(g);
  }, []);
  const onNodeSConfirmNo = useCallback(() => setSConfirm(null), []);

  // 진입(focusId)이 바뀌면 선택을 비운다 — 테두리(선택 표시)는 오직 수동 선택에만 켜지고,
  // 아무것도 선택 안 했을 땐 포커스 카드를 중심으로 한 '연결된 라인'만 굵게 표현한다.
  // (refetch 신호로 인한 갱신 땐 이 effect 가 안 돌아 선택 보존)
  useEffect(() => {
    setSelected(new Set());
  }, [focusId]);

  // 비활성화 상태는 lib/deactivated 가 영속·전파. 다른 화면(라이브러리·사이드바)에서 토글되면 여기도 갱신.
  useCustomEvent(DISABLED_EVENT, () => {
    setDisabled(loadDisabledGen());
    setDisabledFolders(loadDisabledFolders());
  });

  // id 직접 비활성 + 폴더 비활성을 합친 확장 집합 — 노드·엣지 모두 이걸로 회색 판정(엣지는 id만 있으므로).
  const disabledIds = useMemo(
    () => expandDisabledGenerationIds(graph?.nodes || [], disabled, disabledFolders),
    [graph, disabled, disabledFolders],
  );

  useHistoryBoardShortcuts({ focusId, selectedRef, setManualPos });

  // 선택 변화를 App에 통지(선택 노드의 Generation[] — 파생 부모 + 프롬프트 위 선택바용).
  useEffect(() => {
    const sel = (graph?.nodes || []).filter((g) => selected.has(g.id));
    onSelectionChange?.(sel);
  }, [selected, graph, onSelectionChange]);

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
  // ── pan/zoom 은 '명령형' — 휠/드래그/슬라이더가 React state 가 아니라 ref 를 바꾸고 캔버스
  //    transform 을 직접 갱신한다. 매 프레임 setState→전체 노드 재렌더하던 비용 제거(이 보드의 가장
  //    큰 상호작용 비용). 보고용 onStats 만 디바운스로 가끔 부른다.
  const zoomRef = useRef(1); // 휠 줌 (source of truth)
  const panPosRef = useRef({ x: 0, y: 0 }); // 화면 이동 (source of truth)
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  // 카드별 카메라 저장 — 현재 focusId 의 zoom/pan 을 localStorage 에. focusIdRef 로 stable.
  const focusIdRef = useRef(focusId);
  focusIdRef.current = focusId;
  const saveView = useCallback(() => {
    const fid = focusIdRef.current;
    if (!fid) return;
    try {
      const all = loadViews();
      all[fid] = { z: zoomRef.current, x: panPosRef.current.x, y: panPosRef.current.y };
      saveJSON(VIEW_KEY, all);
    } catch {
      /* localStorage 불가 무시 */
    }
  }, []);
  const { run: scheduleSaveView } = useDebouncedCallback(saveView, 250);

  const applyTransform = useCallback(() => {
    const c = canvasRef.current;
    if (c)
      c.style.transform = `translate(${panPosRef.current.x}px, ${panPosRef.current.y}px) scale(${
        zoomRef.current * scaleRef.current
      })`;
  }, []);
  // 매 렌더 후 transform 재적용 — 선택·그래프변경 등 다른 재렌더가 style 을 건드려도 ref 기준 복원.
  useLayoutEffect(applyTransform);

  // 줌%·이동여부·노드수를 App(→툴바)에 보고 — ref 기준. 휠은 디바운스, 드래그/슬라이더는 즉시.
  const statsRef = useRef("");
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const typeFilterRef = useRef(typeFilter);
  typeFilterRef.current = typeFilter;
  const onStatsRef = useRef(onStats);
  onStatsRef.current = onStats;
  const reportView = useCallback(() => {
    const g = graphRef.current;
    const count = g
      ? g.nodes.filter(
          (n) => typeFilterRef.current === "all" || n.assets[0]?.type === typeFilterRef.current,
        ).length
      : 0;
    const zoomPct = Math.round(zoomRef.current * 100);
    const viewMoved =
      zoomRef.current !== 1 || panPosRef.current.x !== 0 || panPosRef.current.y !== 0;
    const key = `${count}|${zoomPct}|${viewMoved}`;
    if (key === statsRef.current) return;
    statsRef.current = key;
    onStatsRef.current?.({ count, zoomPct, viewMoved });
  }, []);
  const { run: scheduleReport } = useDebouncedCallback(reportView, 120);
  // 그래프/타입필터 바뀌면 노드수 보고(즉시).
  useLayoutEffect(() => {
    reportView();
  }, [graph, typeFilter, reportView]);

  // ★카드별 카메라 복원 — 같은 카드의 히스토리로 재진입(언마운트 후 재마운트·focusId 전환)하면
  // 이전에 보던 zoom/pan 을 그대로 되살린다. 저장 없는 카드는 기본(zoom 1·pan 0).
  useLayoutEffect(() => {
    if (!focusId) return;
    const v = loadViews()[focusId];
    zoomRef.current = v ? v.z : 1;
    panPosRef.current = v ? { x: v.x, y: v.y } : { x: 0, y: 0 };
    applyTransform();
    reportView();
  }, [focusId, applyTransform, reportView]);

  // 언마운트(탭 이동 등) 시 현재 카메라를 마지막으로 저장 — 디바운스 저장이 아직 안 떴어도 보존.
  useEffect(() => {
    return () => saveView();
  }, [saveView]);

  // 상단 크기 슬라이더가 보드 줌을 직접 조절 — 줌을 v 로 맞추고 화면은 홈(pan 0)으로 정렬.
  // (휠 줌은 커서 기준 앵커링 유지, 슬라이더 줌은 중심/홈 기준 — 슬라이더로 pan 도 함께 리셋되는 효과.)
  useEffect(() => {
    if (!controlRef) return;
    controlRef.current = {
      zoomTo: (v: number) => {
        zoomRef.current = Math.min(2.5, Math.max(0.3, v));
        panPosRef.current = { x: 0, y: 0 }; // 슬라이더 줌은 홈으로 정렬
        applyTransform();
        reportView();
        saveView();
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
      const p = panPosRef.current;
      zoomRef.current = nz;
      panPosRef.current = { x: cx - (cx - p.x) * ratio, y: cy - (cy - p.y) * ratio };
      applyTransform(); // 즉시 반영(재렌더 없음)
      scheduleReport(); // 슬라이더 값은 휠 멈춘 뒤 갱신
      scheduleSaveView(); // 휠 멈춘 뒤 카메라 저장
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
    removeWindowMouseDrag(onDragMove, onDragUp);
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
    panPosRef.current = { x: p.px + (e.clientX - p.x), y: p.py + (e.clientY - p.y) };
    applyTransform(); // 드래그 중 즉시 반영(재렌더 없음)
  }, [applyTransform]);
  const onPanUpRef = useRef<() => void>(() => {});
  const onPanUp = useCallback(() => {
    panRef.current = null;
    scrollRef.current?.classList.remove("panning");
    removeWindowMouseDrag(onPanMove, onPanUp);
    reportView(); // 패닝 끝 — 이동여부 보고
    saveView(); // 패닝 끝 — 카메라 저장(재진입 시 복원)
  }, [onPanMove, reportView, saveView]);
  onPanUpRef.current = onPanUp; // onPanMove 안전장치가 부를 최신 cleanup

  const onBoardMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1) {
      // 미들 버튼 → 패닝 시작(이동 없이 클릭만이면 노드 onAuxClick 이 정보 팝업을 띄움)
      e.preventDefault();
      const cur = panPosRef.current;
      panRef.current = { x: e.clientX, y: e.clientY, px: cur.x, py: cur.y };
      // panning 클래스는 실제 이동(onPanMove) 시에만 — 정지 클릭은 노드 정보(auxclick)가 떠야 하므로.
      addWindowMouseDrag(onPanMove, onPanUp);
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
    addWindowMouseDrag(onDragMove, onDragUp);
  };

  // 하이라이트 '중심' — 수동 선택이 있으면 그것, 없으면 진입한 포커스 카드.
  //  → 아무것도 선택 안 해도 포커스를 중심으로 연결 라인이 굵게 보인다(테두리는 안 켜짐).
  const center = useMemo(() => getHistoryCenter(graph, selected, focusId), [selected, graph, focusId]);

  // ── 중심 카드의 '연결된 직계 라인'(조상↑ + 자손↓) 엣지·노드 하이라이트 ──
  const highlight = useMemo(() => traceConnectedHistoryLine(graph, center), [graph, center]);
  const hasCenter = center.length > 0;

  // ── 선택(수동) 카드의 '조상 경로'(선택→루트) — 직계 라인 위에 흰색으로 덧그릴 부분 ──
  //  포커스만 진입한 기본 상태에선 비어 있어 직계 라인이 액센트(테두리) 색으로만 보이고,
  //  사용자가 카드를 선택하면 그 카드에서 루트까지의 경로만 흰색으로 강조된다(자손은 액센트 유지).
  const whiteEdges = useMemo(() => traceAncestorHistoryEdges(graph, selected), [graph, selected]);

  // ── 계층 레이아웃: 열 = 최장경로 깊이(부모로부터), 행 = 부모 무게중심 정렬로 교차 최소화 ──
  const layout = useMemo(() => buildHistoryLayout(graph, HISTORY_BOARD_LAYOUT), [graph]);

  // (옛 '메인 라인=최신 파생 체인 항상 굵게'는 포커스를 안 지나가 혼란 → 제거.
  //  굵은 라인은 이제 center(선택/포커스) 기준 highlight 로만 그린다.)

  // ── 원본(root)의 입력 레퍼런스를 왼쪽 lane 에 노드로 표시(원본에 연결) ──
  // 데이터는 이미 graph 노드마다 references 로 들어와 있어 백엔드 변경 없이 렌더만 추가한다.
  const refRoots = useMemo(() => {
    if (!graph) return [] as { genId: string; refs: Generation["references"] }[];
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    return graph.root_ids
      .map((id) => ({ genId: id, refs: byId.get(id)?.references || [] }))
      .filter((r) => r.refs.length > 0);
  }, [graph]);
  // 레퍼런스 노드가 하나라도 있으면 전체 배치를 오른쪽으로 lane 만큼 밀어 원본 왼쪽에 자리를 만든다.
  const lane = refRoots.length ? REF_LANE : 0;

  // 자동 레이아웃 위치(레퍼런스 lane 반영) — ref 로 노출(드래그 시작점 계산), 최종 위치 = 수동 우선.
  const shiftedPos = useMemo(() => {
    const src = layout?.pos || {};
    if (!lane) return src as Record<string, XY>;
    const out: Record<string, XY> = {};
    for (const id in src) out[id] = { x: src[id].x + lane, y: src[id].y };
    return out;
  }, [layout, lane]);
  layoutPosRef.current = shiftedPos;
  const posOf = (id: string): XY => manualPos[id] || shiftedPos[id] || { x: 0, y: 0 };

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
    const base = expandHistoryDims(layout, manualPos, HISTORY_BOARD_LAYOUT);
    return { w: base.w + lane, h: base.h }; // 레퍼런스 lane 만큼 캔버스 폭 확장
  }, [layout, manualPos, lane]);

  if (!focusId) {
    return (
      <div className="linb-empty">
        <div className="linb-empty-card">
          <div className="linb-empty-title">히스토리 보기</div>
          카드의 히스토리 뱃지(⑂ / ↻)를 눌러 가계 패널을 연 뒤,
          <b> ‘히스토리 보기’</b>를 누르면 여기에 원본 → 파생 트리가 그려집니다.
        </div>
      </div>
    );
  }

  return (
    <div className="linb">
      {/* 범례/제목 바 제거(사용자 요청) — 줌·필터는 상단 LibraryToolbar 가 담당, 로딩은 토스트/툴바로 표시. */}
      {err && <div className="linb-err">{err}</div>}
      {/* 무음 절단 방지: 계보가 안전상한에 닿아 일부 노드가 생략됐으면 명시한다(가짜 '완전한 계보' 오인 차단). */}
      {graph?.truncated && (
        <div className="linb-err" style={{ background: "#3a2e0a", color: "#ffd24a" }}>
          계보가 커서 일부만 표시됩니다(상한 도달) — 보이지 않는 상위/하위 노드가 더 있을 수 있습니다.
        </div>
      )}
      <div className="linb-scroll" ref={scrollRef} onMouseDown={onBoardMouseDown}>
        {layout && (
          <div
            className={"linb-canvas" + (dragging ? " dragging" : "")}
            ref={canvasRef}
            style={{
              width: dims.w,
              height: dims.h,
              // transform 은 applyTransform(명령형)이 매 렌더 후 ref 기준으로 적용 — 여기 두면 state
              // 의존이 되살아나 휠/드래그마다 전체 재렌더된다(이번 최적화의 핵심).
              transformOrigin: "0 0",
            }}
          >
            <HistoryBoardEdges
              layout={layout}
              width={dims.w}
              height={dims.h}
              nodeW={BOXW}
              nodeH={BOXH}
              posOf={posOf}
              hasCenter={hasCenter}
              highlight={highlight}
              whiteEdges={whiteEdges}
              disabled={disabledIds}
            />
            {/* 원본 → 레퍼런스 노드 연결선(왼쪽 lane) */}
            {refRoots.length > 0 && (
              <svg
                className="linb-svg"
                width={dims.w}
                height={dims.h}
                viewBox={`0 0 ${dims.w} ${dims.h}`}
              >
                {refRoots.map(({ genId }) => {
                  const gp = posOf(genId);
                  const x1 = gp.x - REF_LANE + BOXW;
                  const y1 = gp.y + BOXH / 2;
                  const x2 = gp.x;
                  const y2 = gp.y + BOXH / 2;
                  const mx = (x1 + x2) / 2;
                  return (
                    <path
                      key={"refe:" + genId}
                      className="linb-edge refinput"
                      d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                    />
                  );
                })}
              </svg>
            )}
            {graph!.nodes.map((g) => {
              const p = posOf(g.id);
              if (!p) return null;
              const isRoot = graph!.root_ids.includes(g.id);
              const isSel = selected.has(g.id);
              const onLine = highlight.nodes.has(g.id);
              return (
                <HistoryBoardNode
                  key={g.id}
                  generation={g}
                  x={p.x}
                  y={p.y}
                  width={BOXW}
                  height={BOXH}
                  isRoot={isRoot}
                  isSelected={isSel}
                  onLine={onLine}
                  offLine={hasCenter && !onLine}
                  fill={fill}
                  disabled={disabledIds.has(g.id)}
                  typeFilter={typeFilter}
                  colorFilter={colorFilter}
                  tagFilter={tagFilter}
                  sharedOnly={sharedOnly}
                  commentOnly={commentOnly}
                  finalOnly={finalOnly}
                  sConfirm={sConfirm?.id === g.id ? sConfirm : null}
                  onSClick={onNodeSClick}
                  onSDouble={onNodeSDouble}
                  onSConfirmYes={onNodeSConfirmYes}
                  onSConfirmNo={onNodeSConfirmNo}
                  onPreview={onPreview}
                  onInfo={onInfo}
                  onRegenerate={onRegenerate}
                />
              );
            })}
            {/* 원본 왼쪽 레퍼런스 노드(순서대로 표시, 원본에 연결) */}
            {refRoots.map(({ genId, refs }) => {
              const gp = posOf(genId);
              return (
                <HistoryRefNode
                  key={"ref:" + genId}
                  refs={refs}
                  x={gp.x - REF_LANE}
                  y={gp.y}
                  width={BOXW}
                  height={BOXH}
                />
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

