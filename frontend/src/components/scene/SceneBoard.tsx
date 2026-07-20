// Canvas 씬 보드 — 계보 탭과 동일한 조작감:
//   · 좌드래그(배경)=마퀴 복수선택 · 미들버튼 드래그=화면이동(팬) · 휠=줌
//   · 카드 좌드래그=이동(선택된 것 함께) · 클릭=단일선택(Ctrl/Shift=토글) · 배경클릭=해제
//   · Delete=선택 삭제(생성물 있으면 휴지통, 빈 카드면 그냥 제거)
// 기능: 에셋 드롭 레퍼런스 카드(S2) · n키 빈 카드+연결선(S3) · 포트 수동 연결/해제(S4).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { api } from "../../api";
import { APP_EVENTS, dispatchAppEvent } from "../../lib/appEvents";
import { downloadName, downloadOne } from "../../lib/download";
import { DRAG_TYPES } from "../../lib/dragTypes";
import { toggleDisabledGen } from "../../lib/deactivated";
import { matchShortcut } from "../../lib/shortcuts";
import { KEY_COLORS } from "../../lib/appConstants";
import {
  parseSpotlightAssetItems,
  readSpotlightAssetPayload,
  spotlightAssetRefBase,
} from "../../lib/spotlightAssetRefs";
import {
  sceneRefFingerprint,
  uid,
  variantIds,
  type Scene,
  type SceneCard,
  type SceneEdge,
  type SceneRef,
} from "../../lib/scenes";
import { classifyEdges, computeBridgeEdges, edgePathXY, fanOffset } from "../../lib/sceneEdges";
import { useSceneGenData } from "../../lib/useSceneGenData";
import type { Generation, InfoTarget, PreviewItem, PreviewTarget, Project } from "../../types";
import { HistoryBoardNode } from "../history/HistoryBoardNode";
import { TagEditor } from "../TagEditor";
import { MediaThumbnail } from "../MediaThumbnail";
import { thumbOf } from "../../lib/media";
import { BoardSelectionActionBar } from "../app/SelectionActionBar";
import { useClickSeparation } from "../../lib/useClickSeparation";

const CARD_W = 152;
const CARD_H = 130;

interface Props {
  scene: Scene;
  onChange: (patch: Partial<Scene>) => void;
  // 씬의 생성 카드 1개만 선택되면 그 카드(id+연결된 레퍼런스)를 하단 프롬프트에 바인딩하도록 App 에 알림.
  onBindingChange?: (binding: { cardId: string; refs: SceneRef[] } | null) => void;
  // 마지막으로 본 화면(확대/이동)을 기억 — 팬/줌을 멈출 때 저장. 재렌더 없이 localStorage 에만 조용히.
  onCameraChange?: (camera: { z: number; x: number; y: number }) => void;
  // 생성 결과 카드 = 히스토리 카드(HistoryBoardNode). 히스토리와 동일한 액션을 그대로 위임.
  onPreview?: (t: PreviewTarget) => void;
  onInfo?: (t: InfoTarget) => void;
  onRegenerate?: (g: Generation) => void;
  onPublish?: (g: Generation) => void;
  onUnpublish?: (g: Generation) => void;
  onFinalize?: (g: Generation) => void;
  onUnfinalize?: (g: Generation) => void;
  canFinalize?: (g: Generation) => boolean;
  // 다중 결과 팝업의 액션바(라이브러리와 동일) — 선택 변형들에 대해 위임.
  projects?: Project[];
  onVariantShare?: (sel: Generation[]) => void;
  onVariantDownload?: (sel: Generation[]) => void;
  onVariantCompare?: (sel: Generation[]) => void;
  onVariantAssign?: (sel: Generation[], projectId: string | null) => void;
  onVariantCreateAssign?: (sel: Generation[], name: string) => void;
  onVariantDelete?: (sel: Generation[]) => Promise<string[]>; // 삭제 성공 id 반환
  // 캔버스에서 선택된 '결과 카드'들의 Generation 을 App 에 올려 프롬프트 위 선택바를 띄운다.
  onSelectionGens?: (gens: Generation[]) => void;
  // 선택바의 '삭제'가 부를 명령형 핸들 — 선택된 결과 카드를 캔버스에서 제거(+안전 휴지통).
  actionRef?: MutableRefObject<{ deleteSelected: () => void } | null>;
  grayOn?: boolean; // 상단 토글 — 켜면 비활성(회색) 카드를 캔버스에서 숨김
  // 라이브러리/계보와 동일한 필터 — 결과 카드(HistoryBoardNode)에 dim 처리로 그대로 적용.
  typeFilter?: "all" | "image" | "video" | "audio";
  colorFilter?: Set<string>;
  tagFilter?: Set<string>;
  sharedOnly?: boolean;
  commentOnly?: boolean;
  finalOnly?: boolean;
  // 태그 편집(라이브러리와 공용 — 태그는 생성물 레코드에 저장되어 뷰 간 자동 공유).
  onSetTags?: (g: Generation, tags: string[]) => void;
  onSetAutoTags?: (g: Generation, names: string[]) => void;
  autoTagOptions?: string[]; // 내 전역(auto) 태그 목록 — TagEditor 의 # 전역 picker
}

export function SceneBoard({
  scene,
  onChange,
  onBindingChange,
  onCameraChange,
  onPreview,
  onInfo,
  onRegenerate,
  onPublish,
  onUnpublish,
  onFinalize,
  onUnfinalize,
  canFinalize,
  projects,
  onVariantShare,
  onVariantDownload,
  onVariantCompare,
  onVariantAssign,
  onVariantCreateAssign,
  onVariantDelete,
  onSelectionGens,
  actionRef,
  grayOn,
  typeFilter = "all",
  colorFilter,
  tagFilter,
  sharedOnly = false,
  commentOnly = false,
  finalOnly = false,
  onSetTags,
  onSetAutoTags,
  autoTagOptions,
}: Props) {
  const [cards, setCards] = useState<SceneCard[]>(scene.cards);
  const [edges, setEdges] = useState<SceneEdge[]>(scene.edges);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [marquee, setMarquee] = useState<{ l: number; t: number; w: number; h: number } | null>(null);
  const [tempWire, setTempWire] = useState<{ fromId: string; x2: number; y2: number } | null>(null);
  // genId→실제 생성물 바인딩·폴링·계보(refParents)·비활성/삭제 상태는 useSceneGenData 훅으로 추출(동작 보존).
  //  각 생성물이 '레퍼런스로 쓴' 부모 gen id(refParents)는 수동 연결선 색(레퍼런스 점선 vs 계보 실선) 판정 근거.
  const { genData, setGenData, genDataRef, missingIds, disabledIds, refParents } = useSceneGenData(cards);
  const [cardMenu, setCardMenu] = useState<string | null>(null); // 변형(결과) 팝업이 열린 카드 id
  const [tagEditCardId, setTagEditCardId] = useState<string | null>(null); // 태그 편집 팝업이 열린 카드 id(같은 생성물이 여러 카드여도 하나만)
  const [popupSel, setPopupSel] = useState<Set<string>>(new Set()); // 팝업 내 다중선택(gid)
  const [popupMarq, setPopupMarq] = useState<{ l: number; t: number; w: number; h: number } | null>(null);
  const varGridRef = useRef<HTMLDivElement>(null);
  useEffect(() => setPopupSel(new Set()), [cardMenu]); // 팝업 열림/카드 전환 시 선택 초기화
  // 팝업이 '모달 레이어'인지·그 선택을 전역 keydown 에서 읽기 위한 ref(빈-deps 핸들러용).
  const cardMenuRef = useRef(cardMenu);
  cardMenuRef.current = cardMenu;
  const popupSelRef = useRef(popupSel);
  popupSelRef.current = popupSel;
  // 가위(연결 자르기) — 후디니식: Y 를 누르고 있는 동안만 활성. 좌드래그로 궤적을 그리고 지나간
  // 연결선을 빨갛게 표시(예고)했다가, 마우스를 떼면 그 선들을 실제로 끊는다.
  const [cutHeld, setCutHeld] = useState(false); // Y 키를 누르고 있는 중
  const [cutStroke, setCutStroke] = useState<{ x: number; y: number }[] | null>(null); // 드래그 궤적(캔버스 좌표)
  const [edgesToCut, setEdgesToCut] = useState<Set<string>>(new Set()); // 끊을 예정(빨강) 연결 id
  // 씬 전환 = 선택 해제. 같은 씬이라도 외부(생성 결과 바인딩·프롬프트 순서변경)에서 cards/edges 가
  // 바뀌면 반영하되 선택은 유지 — 카드 드래그 중엔 persist 안 하므로 prop 이 안 바뀌어 방해받지 않는다.
  const sceneIdRef = useRef(scene.id);
  useEffect(() => {
    if (sceneIdRef.current !== scene.id) {
      sceneIdRef.current = scene.id;
      setSelected(new Set());
    }
    setCards(scene.cards);
    setEdges(scene.edges);
  }, [scene.id, scene.cards, scene.edges]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(scene.camera?.z ?? 1);
  const panRef = useRef({ x: scene.camera?.x ?? 0, y: scene.camera?.y ?? 0 });
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onCameraChangeRef = useRef(onCameraChange);
  onCameraChangeRef.current = onCameraChange;
  const camSaveTimer = useRef<number | undefined>(undefined);
  // 현재 팬/줌을 저장(마지막 본 화면 기억). 화면 갱신 없이 localStorage 에만 → 편집 재렌더 유발 안 함.
  const persistCamera = () =>
    onCameraChangeRef.current?.({ z: zoomRef.current, x: panRef.current.x, y: panRef.current.y });
  const cardEls = useRef<Record<string, HTMLDivElement | null>>({});
  const heightsRef = useRef<Record<string, number>>({});
  const [, bumpHeights] = useState(0);

  const applyTransform = useCallback(() => {
    const c = canvasRef.current;
    if (c)
      c.style.transform = `translate(${panRef.current.x}px, ${panRef.current.y}px) scale(${zoomRef.current})`;
  }, []);
  useLayoutEffect(applyTransform);
  // 씬을 열 때(전환/첫 진입)만 저장된 카메라를 복원 — 마지막으로 본 화면. scene.camera 를 deps 에서
  // 뺀 이유: 같은 씬에서 카드 편집으로 scene 이 재로드돼도 라이브 카메라를 되돌리지 않기 위함.
  useEffect(() => {
    // 이전 씬에서 예약된 줌 저장 타이머가 남아 있으면 취소 — 전환 후 엉뚱한 씬에 쓰거나 낭비되지 않게.
    if (camSaveTimer.current) {
      clearTimeout(camSaveTimer.current);
      camSaveTimer.current = undefined;
    }
    zoomRef.current = scene.camera?.z ?? 1;
    panRef.current = { x: scene.camera?.x ?? 0, y: scene.camera?.y ?? 0 };
    applyTransform();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene.id, applyTransform]);

  // 카드 실제 높이 측정 → 연결선 끝점(세로 중앙)을 정확히. offsetHeight 는 scale 영향 없는 레이아웃 높이.
  // 카드 구성(개수·레퍼런스 수)이 바뀔 때만 측정 — 단순 위치 이동(드래그)엔 재측정하지 않는다.
  const structSig = cards.map((c) => c.id + ":" + c.kind + ":" + (c.refs?.length || 0)).join("|");
  useLayoutEffect(() => {
    let changed = false;
    const next: Record<string, number> = {};
    for (const c of cardsRef.current) {
      const el = cardEls.current[c.id];
      const h = el?.offsetHeight || heightsRef.current[c.id];
      if (h) next[c.id] = h;
      if (h && h !== heightsRef.current[c.id]) changed = true;
    }
    if (changed) {
      heightsRef.current = next;
      bumpHeights((n) => n + 1);
    }
  }, [structSig]);

  const persist = (nextCards: SceneCard[], nextEdges: SceneEdge[]) =>
    onChangeRef.current({ cards: nextCards, edges: nextEdges });

  // ── 선택된 단일 생성 카드를 하단 프롬프트에 바인딩(App 에 통지) ──
  // 카드 이동(위치 변경)만으론 다시 안 쏘도록 cardId+레퍼런스 지문으로 변화만 감지.
  const onBindingRef = useRef(onBindingChange);
  onBindingRef.current = onBindingChange;
  const lastEmitRef = useRef<string>("");
  useEffect(() => {
    const ids = [...selected];
    let payload: { cardId: string; refs: SceneRef[] } | null = null;
    if (ids.length === 1) {
      const c = cards.find((cc) => cc.id === ids[0]);
      if (c && c.kind === "generation") payload = { cardId: c.id, refs: c.refs || [] };
    }
    const sig = payload ? payload.cardId + "|" + sceneRefFingerprint(payload.refs) : "";
    if (sig === lastEmitRef.current) return;
    lastEmitRef.current = sig;
    onBindingRef.current?.(payload);
  }, [selected, cards]);
  useEffect(() => () => onBindingRef.current?.(null), []); // 언마운트(탭·씬 이탈) → 바인딩 해제

  // 태그 적용 — App 핸들러(서버 저장 + 라이브러리 목록 + facet 갱신)에 위임하고, 씬 genData 도 낙관적으로 패치.
  //  · 태그는 생성물 레코드에 저장되므로 내 작업/팀 작업/캔버스가 자동으로 같은 값을 공유한다(공용).
  const applyCardTags = (g: Generation, tags: string[]) => {
    setGenData((prev) => (prev[g.id] ? { ...prev, [g.id]: { ...prev[g.id], tags } } : prev));
    onSetTags?.(g, tags);
  };
  const applyCardAutoTags = (g: Generation, names: string[]) => {
    setGenData((prev) => (prev[g.id] ? { ...prev, [g.id]: { ...prev[g.id], auto_tags: names } } : prev));
    onSetAutoTags?.(g, names);
  };

  // ── 생성 결과 카드의 S(공유/최종) 확인 로직 — 히스토리 보드와 동일(단일클릭=공유, 더블=최종) ──
  const [sConfirm, setSConfirm] = useState<{ id: string; kind: "share" | "final" } | null>(null);
  const sClick = useClickSeparation(220);
  const cbRef = useRef({ sClick, canFinalize, onPublish, onUnpublish, onFinalize, onUnfinalize });
  cbRef.current = { sClick, canFinalize, onPublish, onUnpublish, onFinalize, onUnfinalize };
  const sConfirmRef = useRef(sConfirm);
  sConfirmRef.current = sConfirm;
  const onNodeSClick = useCallback((g: Generation) => {
    if (!g.is_mine) return; // 공유/해제는 본인 것만
    cbRef.current.sClick.onClick(() => {
      if (g.is_final) return; // 최종은 공유 잠금 — 해제는 더블클릭으로만
      setSConfirm({ id: g.id, kind: "share" });
    });
  }, []);
  const onNodeSDouble = useCallback((g: Generation) => {
    const { sClick, canFinalize, onPublish } = cbRef.current;
    sClick.onDouble(() => {
      const may = canFinalize ? canFinalize(g) : true;
      if (!may) {
        if (g.is_mine && !g.shared && !g.is_final) onPublish?.(g);
        return;
      }
      if (g.shared || g.is_final) setSConfirm({ id: g.id, kind: "final" });
      else onPublish?.(g);
    });
  }, []);
  const onNodeSConfirmYes = useCallback((g: Generation) => {
    const c = sConfirmRef.current;
    setSConfirm(null);
    if (!c) return;
    const { onFinalize, onUnfinalize, onPublish, onUnpublish } = cbRef.current;
    // 씬은 자체 genData 캐시를 쓰므로 App 핸들러(서버 반영)만으론 카드가 즉시 안 바뀐다.
    // → 낙관적으로 로컬 캐시를 먼저 뒤집어 즉시 반영하고, 잠시 뒤 서버값으로 재확정한다.
    const patch = (p: Partial<Generation>) =>
      setGenData((prev) => (prev[g.id] ? { ...prev, [g.id]: { ...prev[g.id], ...p } } : prev));
    let act: ((g: Generation) => void) | undefined;
    if (c.kind === "final") {
      if (g.is_final) {
        patch({ is_final: false });
        act = onUnfinalize;
      } else {
        patch({ is_final: true, shared: true }); // 최종 지정은 공유도 함께
        act = onFinalize;
      }
    } else {
      if (g.shared) {
        patch({ shared: false });
        act = onUnpublish;
      } else {
        patch({ shared: true });
        act = onPublish;
      }
    }
    // App 핸들러(서버 쓰기)가 끝난 뒤 재조회해 서버 확정값으로 맞춘다 — 고정 지연이면 느린 네트워크에서
    // 쓰기 전 옛 값을 덮어써 카드가 되돌아갈 수 있어, 반드시 핸들러 완료 후에 조회한다.
    Promise.resolve(act?.(g)).finally(() => {
      void api
        .getGeneration(g.id)
        .then((fresh) => fresh && setGenData((prev) => ({ ...prev, [g.id]: fresh })))
        .catch(() => {});
    });
  }, []);
  const onNodeSConfirmNo = useCallback(() => setSConfirm(null), []);

  // ── S5 토대: 생성 카드는 자신에게 연결된 레퍼런스 카드들의 레퍼런스를 순서대로 모아 보유한다. ──
  // (연결/해제 시에만 재계산 — 이후 프롬프트에서 순서를 바꾸면 card.refs 를 직접 갱신한다)
  // 연결된 레퍼런스 카드들이 제공하는 "목표 레퍼런스 집합"(엣지 순서대로).
  const gatherTarget = (genId: string, cs: SceneCard[], es: SceneEdge[]): SceneRef[] => {
    const out: SceneRef[] = [];
    for (const e of es) {
      if (e.to !== genId) continue;
      const src = cs.find((c) => c.id === e.from);
      if (src?.kind === "reference" && src.refs) out.push(...src.refs);
    }
    return out;
  };
  // 기존 refs(프롬프트에서 재정렬됐을 수 있음)의 순서를 보존하며, 새 연결은 뒤에 붙이고 끊긴 건 뺀다.
  // ★@·드래그로 넣은 '생성물 참조'(source_gen_id 있음)는 레퍼런스 카드가 관리하지 않으므로,
  //   엣지 조작(연결/해제)으로 지워지면 안 된다 — target 에 없어도 그대로 보존한다(참조 유실·색 뒤집힘 방지).
  const reconcileRefs = (existing: SceneRef[], target: SceneRef[]): SceneRef[] => {
    const key = (r: SceneRef) => r.file_path + "#" + (r.source_gen_id || "");
    const pool = [...target];
    const result: SceneRef[] = [];
    for (const r of existing) {
      const i = pool.findIndex((t) => key(t) === key(r));
      if (i >= 0) result.push(pool.splice(i, 1)[0]); // 연결된 레퍼런스 카드가 제공하는 참조 — 유지
      else if (r.source_gen_id) result.push(r); // @·드래그로 넣은 생성물 참조 — 엣지와 무관하게 보존
      // 그 외(연결이 끊긴 레퍼런스 카드 참조)만 제거
    }
    result.push(...pool);
    return result;
  };
  const withGenRefs = (cs: SceneCard[], es: SceneEdge[]): SceneCard[] =>
    cs.map((c) =>
      c.kind === "generation"
        ? { ...c, refs: reconcileRefs(c.refs || [], gatherTarget(c.id, cs, es)) }
        : c,
    );

  const toCanvas = (clientX: number, clientY: number) => {
    const r = scrollRef.current!.getBoundingClientRect();
    return {
      x: (clientX - r.left - panRef.current.x) / zoomRef.current,
      y: (clientY - r.top - panRef.current.y) / zoomRef.current,
    };
  };

  // 드래그 리스너 등록/정리를 한곳에서 — 드래그 중 언마운트(씬 전환·삭제)돼도 누수 없게 unmount 에서 정리.
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const beginDrag = useCallback(
    (move: (e: MouseEvent) => void, up: (e: MouseEvent) => void) => {
      const teardown = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", onUp);
        dragCleanupRef.current = null;
      };
      const onUp = (ev: MouseEvent) => {
        teardown();
        up(ev);
      };
      dragCleanupRef.current = teardown;
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", onUp);
    },
    [],
  );
  useEffect(() => () => dragCleanupRef.current?.(), []);

  // ── 에셋 드롭 → 레퍼런스 카드 ──
  const hasAssetDrag = (dt: DataTransfer) => Array.from(dt.types).includes(DRAG_TYPES.asset);
  const onDragOver = (e: React.DragEvent) => {
    if (hasAssetDrag(e.dataTransfer)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  };
  const onDrop = (e: React.DragEvent) => {
    if (!hasAssetDrag(e.dataTransfer)) return;
    e.preventDefault();
    const items = parseSpotlightAssetItems(readSpotlightAssetPayload(e.dataTransfer));
    if (!items.length) return;
    const refs: SceneRef[] = items.map((it) => {
      const b = spotlightAssetRefBase(it);
      return { file_path: b.file_path, type: b.type, name: b.name, thumb: b.thumb };
    });
    const p = toCanvas(e.clientX, e.clientY);
    const card: SceneCard = { id: uid(), kind: "reference", x: p.x - CARD_W / 2, y: p.y - CARD_H / 2, refs };
    const next = [...cardsRef.current, card];
    setCards(next);
    setSelected(new Set([card.id]));
    persist(next, edgesRef.current);
  };

  // ── S4: 출력 포트 드래그 → 입력 포트에 놓으면 연결 · 엣지 클릭으로 해제 ──
  const addEdge = (from: string, to: string) => {
    if (from === to) return;
    if (edgesRef.current.some((e) => e.from === from && e.to === to)) return;
    const ne = [...edgesRef.current, { id: uid(), from, to }];
    const nc = withGenRefs(cardsRef.current, ne);
    setEdges(ne);
    setCards(nc);
    persist(nc, ne);
  };
  const removeEdge = (id: string) => removeEdges([id]);
  // 여러 연결을 한 번에 끊기(가위 드래그) — 실제로 사라지는 게 있을 때만 반영/저장.
  const removeEdges = (ids: string[]) => {
    if (!ids.length) return;
    const idset = new Set(ids);
    const ne = edgesRef.current.filter((e) => !idset.has(e.id));
    if (ne.length === edgesRef.current.length) return;
    const nc = withGenRefs(cardsRef.current, ne);
    setEdges(ne);
    setCards(nc);
    persist(nc, ne);
  };
  const onOutPortDown = (e: React.MouseEvent, cardId: string) => {
    e.stopPropagation();
    e.preventDefault();
    const p0 = toCanvas(e.clientX, e.clientY);
    setTempWire({ fromId: cardId, x2: p0.x, y2: p0.y });
    const move = (ev: MouseEvent) => {
      const p = toCanvas(ev.clientX, ev.clientY);
      setTempWire({ fromId: cardId, x2: p.x, y2: p.y });
    };
    const up = (ev: MouseEvent) => {
      setTempWire(null);
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const cardEl = el?.closest(".scene-port.in")?.closest(".scene-card") as HTMLElement | null;
      const toId = cardEl?.dataset.id;
      if (toId) addEdge(cardId, toId);
    };
    beginDrag(move, up);
  };

  // ── 색/비활성은 '대상 gid 배열'만 받는 command — 캔버스/팝업 두 레이어가 같은 로직 재사용 ──
  // 색 지정/해제(라이브러리와 같은 토글: 전부 같은 색이면 해제). 로드된 결과만 대상.
  const applyColorToGids = (gids: string[], color: string) => {
    const ids = gids.filter((id) => !!genDataRef.current[id]);
    if (!ids.length) return;
    const gens = ids.map((id) => genDataRef.current[id]);
    const next = gens.every((g) => g.color === color) ? null : color;
    setGenData((prev) => {
      const nx = { ...prev };
      for (const id of ids) if (nx[id]) nx[id] = { ...nx[id], color: next };
      return nx;
    });
    for (const id of ids)
      api.setColor(id, next).catch((err) => console.warn("[scene] 색 적용 실패", id, err));
  };
  // 레이어별 '선택 → 대상 gid' 변환.
  const canvasSelGids = () =>
    [...selectedRef.current]
      .map((id) => cardsRef.current.find((c) => c.id === id)?.genId)
      .filter((x): x is string => !!x);
  const setSelColor = (color: string) => applyColorToGids(canvasSelGids(), color);

  // 팝업/재생성에서 특정 변형을 카드의 '대표(현재 표시)'로 바꾼다.
  const setCardVariant = (cardId: string, gid: string) => {
    const nc = cardsRef.current.map((c) => (c.id === cardId ? { ...c, genId: gid } : c));
    setCards(nc);
    persist(nc, edgesRef.current);
  };
  // 삭제 성공한 변형 id 를 카드의 genIds/genId 에서 정리(대표가 지워졌으면 남은 것/없으면 빈 카드).
  const pruneVariants = (cardId: string, removed: Set<string>) => {
    if (!removed.size) return;
    const nc = cardsRef.current.map((c) => {
      if (c.id !== cardId) return c;
      const genIds = variantIds(c).filter((id) => !removed.has(id));
      const genId = c.genId && !removed.has(c.genId) ? c.genId : genIds[0] ?? null;
      return { ...c, genIds, genId, status: genIds.length ? c.status : ("empty" as const) };
    });
    setCards(nc);
    persist(nc, edgesRef.current);
  };

  // 팝업 그리드 배경 드래그 = 마퀴 복수선택(썸네일 위에서 시작하면 클릭/더블클릭에 양보).
  const onVarGridMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".scene-varpop-item")) return;
    const grid = varGridRef.current;
    if (!grid) return;
    e.preventDefault();
    const additive = e.ctrlKey || e.shiftKey || e.metaKey;
    const base = additive ? new Set(popupSel) : new Set<string>();
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;
    const move = (ev: MouseEvent) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      moved = true;
      const gr = grid.getBoundingClientRect();
      const x0 = Math.min(startX, ev.clientX);
      const y0 = Math.min(startY, ev.clientY);
      const x1 = Math.max(startX, ev.clientX);
      const y1 = Math.max(startY, ev.clientY);
      setPopupMarq({ l: x0 - gr.left + grid.scrollLeft, t: y0 - gr.top + grid.scrollTop, w: x1 - x0, h: y1 - y0 });
      const hit = new Set(base);
      grid.querySelectorAll(".scene-varpop-item").forEach((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.right >= x0 && r.left <= x1 && r.bottom >= y0 && r.top <= y1) {
          const gid = (el as HTMLElement).dataset.gid;
          if (gid) hit.add(gid);
        }
      });
      setPopupSel(hit);
    };
    const up = () => {
      setPopupMarq(null);
      if (!moved && !additive) setPopupSel(new Set()); // 빈 곳 클릭 = 선택 해제
    };
    beginDrag(move, up);
  };

  // ── 카드 삭제(선택) — 내 것·미공유·비최종 변형만 휴지통, 공유/최종/남의 것은 라이브러리에 보존 ──
  const deleteCards = (ids: string[]) => {
    if (!ids.length) return;
    const idset = new Set(ids);
    const gd = genDataRef.current;
    // 삭제 안 되는 다른 카드가 아직 쓰는 결과는 제외(중복/legacy 대비).
    const survivors = new Set(
      cardsRef.current
        .filter((c) => !idset.has(c.id) && c.kind === "generation")
        .flatMap((c) => variantIds(c)),
    );
    const toTrash = cardsRef.current
      .filter((c) => idset.has(c.id) && c.kind === "generation")
      .flatMap((c) => variantIds(c))
      .filter((gid) => !survivors.has(gid))
      .filter((gid) => {
        const g = gd[gid];
        return !!g && g.is_mine && !g.shared && !g.is_final; // 지워도 안전한 것만
      });
    const nextEdges = edgesRef.current.filter((e) => !idset.has(e.from) && !idset.has(e.to));
    const nextCards = withGenRefs(
      cardsRef.current.filter((c) => !idset.has(c.id)),
      nextEdges,
    );
    setCards(nextCards);
    setEdges(nextEdges);
    setSelected(new Set());
    setCardMenu((m) => (m && idset.has(m) ? null : m)); // 삭제된 카드의 팝업은 닫는다
    persist(nextCards, nextEdges);
    for (const gid of toTrash)
      api.deleteGeneration(gid).catch((err) => console.warn("[scene] 생성물 휴지통 이동 실패", gid, err));
  };

  // ── 캔버스 선택 → App 선택바(프롬프트 위 topSlot)로 결과 카드들 올리기 + 삭제 명령형 핸들 ──
  const selResultCardIds = () =>
    [...selectedRef.current].filter((id) => {
      const c = cardsRef.current.find((cc) => cc.id === id);
      return !!c && c.kind === "generation" && !!c.genId && !!genDataRef.current[c.genId]?.assets?.[0];
    });
  const onSelGensRef = useRef(onSelectionGens);
  onSelGensRef.current = onSelectionGens;
  const lastSelSigRef = useRef<string>("");
  useEffect(() => {
    // 변형 팝업이 열려 있으면(그 자체 액션바가 있으니) 캔버스 선택바는 숨긴다 — 선택 자체는 유지.
    const gens = cardMenu
      ? []
      : [...selected]
          .map((id) => cards.find((c) => c.id === id))
          .filter(
            (c): c is SceneCard =>
              !!c && c.kind === "generation" && !!c.genId && !!genData[c.genId]?.assets?.[0],
          )
          .map((c) => genData[c.genId!]!);
    const sig = gens.map((g) => g.id).join(",");
    if (sig === lastSelSigRef.current) return;
    lastSelSigRef.current = sig;
    onSelGensRef.current?.(gens);
  }, [selected, cards, genData, cardMenu]);
  useEffect(() => () => onSelGensRef.current?.([]), []); // 언마운트 → 선택바 비우기
  if (actionRef) actionRef.current = { deleteSelected: () => deleteCards(selResultCardIds()) };

  // ── 키보드: n=빈 카드 연결 · Delete/Backspace=삭제 ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      )
        return;
      if (e.key === "Escape") {
        if (cardMenuRef.current) setCardMenu(null); // 팝업 열려 있으면 닫기
        return;
      }
      // ── 팝업(모달 레이어)이 열려 있으면: 팝업 선택(popupSel) 대상만 처리하고 캔버스 키는 완전 차단 ──
      if (cardMenuRef.current) {
        const pids = [...popupSelRef.current];
        if (matchShortcut(e, "colorRed")) {
          e.preventDefault();
          applyColorToGids(pids, KEY_COLORS.r);
        } else if (matchShortcut(e, "colorGreen")) {
          e.preventDefault();
          applyColorToGids(pids, KEY_COLORS.g);
        } else if (matchShortcut(e, "colorBlue")) {
          e.preventDefault();
          applyColorToGids(pids, KEY_COLORS.b);
        } else if (matchShortcut(e, "boardDisable")) {
          if (pids.length) {
            e.preventDefault();
            toggleDisabledGen(pids);
          }
        }
        return; // n/y/Delete 등 캔버스 명령은 팝업 중 무시
      }
      const sel = selectedRef.current;
      // d: 선택 카드 비활성(회색) 토글 — 계보/라이브러리와 같은 소스. 카드 대표 genId 기준.
      if (matchShortcut(e, "boardDisable")) {
        const gids = [...sel]
          .map((id) => cardsRef.current.find((c) => c.id === id)?.genId)
          .filter((x): x is string => !!x);
        if (gids.length) {
          e.preventDefault();
          toggleDisabledGen(gids);
        }
        return;
      }
      // r/g/b: 선택 카드 색 지정(계보/라이브러리와 동일)
      if (matchShortcut(e, "colorRed")) {
        e.preventDefault();
        setSelColor(KEY_COLORS.r);
        return;
      }
      if (matchShortcut(e, "colorGreen")) {
        e.preventDefault();
        setSelColor(KEY_COLORS.g);
        return;
      }
      if (matchShortcut(e, "colorBlue")) {
        e.preventDefault();
        setSelColor(KEY_COLORS.b);
        return;
      }
      // #: 선택된 생성 카드의 태그 편집 팝업 열기(라이브러리와 동일 — 팝업 안에서 # 한 번 더로 전역태그).
      if (onSetTags && matchShortcut(e, "tag")) {
        const target = [...sel]
          .map((id) => cardsRef.current.find((c) => c.id === id))
          .find((c) => !!c && c.kind === "generation" && !!c.genId && !!genDataRef.current[c.genId]);
        if (target) {
          e.preventDefault();
          setTagEditCardId(target.id);
        }
        return;
      }
      if (e.key === "y" || e.key === "Y") {
        if (!e.repeat) setCutHeld(true); // 누르고 있는 동안만 가위 — 반복 keydown 무시
        return;
      }
      if (e.key === "n" || e.key === "N") {
        if (sel.size !== 1) return; // 단일 선택일 때만
        const sid = [...sel][0];
        const src = cardsRef.current.find((c) => c.id === sid);
        if (!src) return;
        e.preventDefault();
        const empty: SceneCard = {
          id: uid(),
          kind: "generation",
          x: src.x + CARD_W + 64,
          y: src.y,
          status: "empty",
          refs: [],
          genId: null,
        };
        const edge: SceneEdge = { id: uid(), from: sid, to: empty.id };
        const nextEdges = [...edgesRef.current, edge];
        const nextCards = withGenRefs([...cardsRef.current, empty], nextEdges);
        setCards(nextCards);
        setEdges(nextEdges);
        setSelected(new Set([empty.id]));
        persist(nextCards, nextEdges);
      } else if (e.key === "Delete") {
        if (!sel.size) return;
        e.preventDefault();
        deleteCards([...sel]);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "y" || e.key === "Y") setCutHeld(false); // Y 떼면 가위 종료
    };
    const onBlur = () => setCutHeld(false); // 포커스 잃으면(alt-tab 등) 가위 상태 고착 방지
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 마우스: 미들=팬 · 카드=이동/선택 · 배경=마퀴 복수선택 ──
  const onMouseDown = (e: React.MouseEvent) => {
    // 미들 버튼 → 화면 이동
    if (e.button === 1) {
      e.preventDefault();
      const ox = panRef.current.x;
      const oy = panRef.current.y;
      const sx = e.clientX;
      const sy = e.clientY;
      const move = (ev: MouseEvent) => {
        panRef.current = { x: ox + (ev.clientX - sx), y: oy + (ev.clientY - sy) };
        applyTransform();
      };
      const up = () => {
        scrollRef.current?.classList.remove("panning");
        persistCamera(); // 팬 끝 → 마지막 본 화면 저장
      };
      scrollRef.current?.classList.add("panning");
      beginDrag(move, up);
      return;
    }
    // 가위(Y 누른 채) → 좌드래그로 궤적을 그리고 지나간 선을 빨갛게 예고, 손 떼면 실제 절단.
    if (cutHeld && e.button === 0) {
      e.preventDefault();
      const pts: { x: number; y: number }[] = [];
      const marked = new Set<string>();
      const sample = (cx: number, cy: number) => {
        pts.push(toCanvas(cx, cy));
        setCutStroke([...pts]);
        for (const el of document.elementsFromPoint(cx, cy)) {
          const id = (el as HTMLElement).dataset?.edge;
          if (id) marked.add(id);
        }
        setEdgesToCut(new Set(marked));
      };
      sample(e.clientX, e.clientY);
      const move = (ev: MouseEvent) => sample(ev.clientX, ev.clientY);
      const up = () => {
        if (marked.size) removeEdges([...marked]); // 손 떼는 순간 절단
        setCutStroke(null);
        setEdgesToCut(new Set());
      };
      beginDrag(move, up);
      return;
    }
    if (e.button !== 0) return;
    const cardEl = (e.target as HTMLElement).closest(".scene-card") as HTMLElement | null;
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;

    if (cardEl) {
      const id = cardEl.dataset.id!;
      // 이동 대상: 잡은 카드가 선택에 포함되면 선택 전부, 아니면 그 카드만.
      const sel = selectedRef.current;
      const targetIds = sel.has(id) ? [...sel] : [id];
      const origins: Record<string, { x: number; y: number }> = {};
      for (const tid of targetIds) {
        const c = cardsRef.current.find((cc) => cc.id === tid);
        if (c) origins[tid] = { x: c.x, y: c.y };
      }
      const move = (ev: MouseEvent) => {
        if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
        moved = true;
        const z = zoomRef.current;
        const dx = (ev.clientX - startX) / z;
        const dy = (ev.clientY - startY) / z;
        setCards((prev) =>
          prev.map((c) => (origins[c.id] ? { ...c, x: origins[c.id].x + dx, y: origins[c.id].y + dy } : c)),
        );
      };
      const up = () => {
        if (moved) {
          persist(cardsRef.current, edgesRef.current);
        } else {
          setSelected((prev) => {
            if (additive) {
              const n = new Set(prev);
              n.has(id) ? n.delete(id) : n.add(id);
              return n;
            }
            return new Set([id]);
          });
        }
      };
      beginDrag(move, up);
    } else {
      // 배경 → 마퀴 복수선택
      const base = additive ? new Set(selectedRef.current) : new Set<string>();
      const move = (ev: MouseEvent) => {
        if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
        moved = true;
        const r = scrollRef.current!.getBoundingClientRect();
        const x0 = Math.min(startX, ev.clientX);
        const y0 = Math.min(startY, ev.clientY);
        const x1 = Math.max(startX, ev.clientX);
        const y1 = Math.max(startY, ev.clientY);
        setMarquee({ l: x0 - r.left, t: y0 - r.top, w: x1 - x0, h: y1 - y0 });
        const hit = new Set(base);
        canvasRef.current?.querySelectorAll(".scene-card").forEach((el) => {
          const cr = (el as HTMLElement).getBoundingClientRect();
          if (cr.right >= x0 && cr.left <= x1 && cr.bottom >= y0 && cr.top <= y1) {
            const cid = (el as HTMLElement).dataset.id;
            if (cid) hit.add(cid);
          }
        });
        setSelected(hit);
      };
      const up = () => {
        setMarquee(null);
        if (!moved && !additive) setSelected(new Set()); // 배경 클릭 → 해제
      };
      beginDrag(move, up);
    }
  };

  // 휠 줌(커서 기준)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // 팝업 위에서는 보드 줌 대신 팝업이 스크롤되게 — 줌/preventDefault 를 건너뛴다.
      if ((e.target as HTMLElement)?.closest?.(".scene-varpop-backdrop")) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const cx = e.clientX - r.left;
      const cy = e.clientY - r.top;
      const prev = zoomRef.current;
      const nz = Math.min(2.5, Math.max(0.3, prev * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      if (nz === prev) return;
      const ratio = nz / prev;
      const p = panRef.current;
      zoomRef.current = nz;
      panRef.current = { x: cx - (cx - p.x) * ratio, y: cy - (cy - p.y) * ratio };
      applyTransform();
      // 줌이 멈추면(연속 휠 종료) 마지막 본 화면 저장 — 디바운스.
      if (camSaveTimer.current) clearTimeout(camSaveTimer.current);
      camSaveTimer.current = window.setTimeout(persistCamera, 400);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyTransform]);
  useEffect(() => () => { if (camSaveTimer.current) clearTimeout(camSaveTimer.current); }, []);

  // 엣지 계산·렌더에서 카드를 id 로 매우 자주 조회한다(E×C). 선형 find 대신 Map(O(1))로 —
  // cards 가 바뀔 때만(드래그 등) 1회 재구성. 드래그 중 렌더 비용을 크게 줄인다.
  const cardsById = useMemo(() => new Map(cards.map((c) => [c.id, c] as const)), [cards]);
  const cardById = (id: string) => cardsById.get(id);
  // grayOn: 비활성(회색) 카드 숨김 — 그 카드와 연결선을 렌더에서 제외(상태는 유지).
  const hiddenIds = new Set(
    grayOn
      ? cards
          .filter((c) => c.kind === "generation" && c.genId && disabledIds.has(c.genId))
          .map((c) => c.id)
      : [],
  );
  const visibleCards = hiddenIds.size ? cards.filter((c) => !hiddenIds.has(c.id)) : cards;
  // 숨긴(회색) 카드가 중간에 있어도 앞뒤 흐름이 끊긴 것처럼 보이지 않게 — 숨김 노드를 건너뛰어
  // 보이는 '앞 카드 → 뒤 카드'로 회색 점선 우회선을 만든다(중간에 뭔가 숨겨져 있다는 표시).
  const bridgeEdges = computeBridgeEdges(cards, edges, hiddenIds);
  const heightOf = (c: SceneCard) =>
    c.kind === "generation" ? CARD_H : heightsRef.current[c.id] || CARD_H;
  const edgePath = (from: SceneCard, to: SceneCard) => {
    const x1 = from.x + CARD_W;
    const y1 = from.y + heightOf(from) / 2;
    const x2 = to.x;
    const y2 = to.y + heightOf(to) / 2;
    const mx = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
  };
  // 연결 종류 판정 — 카드 종류가 아니라 실제 데이터 기준.
  //  · refCardEdgeIds: 레퍼런스 카드 → 생성(파란 점선)
  //  · genRefEdgeIds : 생성물을 레퍼런스로 사용 → 초록 점선. 두 근거를 OR:
  //      (1) 씬 로컬 refs 에 소스의 source_gen_id 가 들어있거나(@·드래그로 넣은 경우),
  //      (2) 백엔드 history: 타깃이 소스를 레퍼런스 부모(materials)로 실제 사용(수동 연결도 잡힘).
  //  · 그 외 생성→생성은 '단순 계보 연결'(초록 실선).
  const { refCardEdgeIds, genRefEdgeIds } = classifyEdges(edges, cardsById, refParents);
  // 한 포트에 연결이 여러 개면 세로로 펼쳐(fan-out) 끝점이 겹치지 않게 — 선마다 자기 색 점을 갖게 한다.
  // (연결이 1개면 오프셋 0 → 포트 정중앙. 흔한 경우는 그대로.)
  // ★실제로 렌더되는(보이는·유효한) 연결만으로 계산 — 숨긴 형제 연결이 보이는 단일선을 밀지 않게.
  const visibleEdges = edges.filter(
    (e) => !hiddenIds.has(e.from) && !hiddenIds.has(e.to) && cardById(e.from) && cardById(e.to),
  );
  const outEdges = new Map<string, SceneEdge[]>();
  const inEdges = new Map<string, SceneEdge[]>();
  for (const e of visibleEdges) {
    const o = outEdges.get(e.from);
    if (o) o.push(e);
    else outEdges.set(e.from, [e]);
    const i = inEdges.get(e.to);
    if (i) i.push(e);
    else inEdges.set(e.to, [e]);
  }
  const yOf = (id: string) => cardById(id)?.y ?? 0; // 교차 최소화: 상대 카드 y 순으로 펼침
  for (const [, list] of outEdges) list.sort((p, q) => yOf(p.to) - yOf(q.to));
  for (const [, list] of inEdges) list.sort((p, q) => yOf(p.from) - yOf(q.from));
  const FAN = 13;
  const edgeEnds = (e: SceneEdge, a: SceneCard, b: SceneCard) => ({
    x1: a.x + CARD_W,
    y1: a.y + heightOf(a) / 2 + fanOffset(outEdges.get(a.id), e.id, FAN),
    x2: b.x,
    y2: b.y + heightOf(b) / 2 + fanOffset(inEdges.get(b.id), e.id, FAN),
  });

  return (
    <div
      className={"scene-board" + (cutHeld ? " cutting" : "")}
      ref={scrollRef}
      onMouseDown={onMouseDown}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="scene-canvas" ref={canvasRef} style={{ transformOrigin: "0 0" }}>
        <svg
          className="scene-edges"
          style={{ position: "absolute", top: 0, left: 0, overflow: "visible", pointerEvents: "none" }}
        >
          {visibleEdges.map((e) => {
            const a = cardById(e.from);
            const b = cardById(e.to);
            if (!a || !b) return null;
            const cls =
              "scene-edge" +
              (refCardEdgeIds.has(e.id) ? " ref" : genRefEdgeIds.has(e.id) ? " refg" : "") + // 레퍼런스카드=파란 점선, 생성물-레퍼런스=초록 점선, 계보=초록 실선
              (selected.has(e.from) || selected.has(e.to) ? " onsel" : "") + // 선택 카드에 닿은 선 강조
              (edgesToCut.has(e.id) ? " cut" : ""); // 가위가 지나간 선 = 빨강 예고
            const { x1, y1, x2, y2 } = edgeEnds(e, a, b);
            const d = edgePathXY(x1, y1, x2, y2);
            return (
              <g key={e.id}>
                <path
                  className="scene-edge-hit"
                  data-edge={e.id}
                  d={d}
                  onClick={() => removeEdge(e.id)}
                />
                <path className={cls} d={d} />
              </g>
            );
          })}
          {/* 숨긴 중간 카드 우회선 — 회색 점선. 연결은 유지되지만 중간에 숨겨진 게 있다는 표시 */}
          {bridgeEdges.map((be) => {
            const a = cardById(be.from);
            const b = cardById(be.to);
            if (!a || !b) return null;
            return <path key={be.id} className="scene-edge bridge" d={edgePath(a, b)} />;
          })}
          {/* 가위 드래그 궤적 */}
          {cutStroke && cutStroke.length > 1 && (
            <polyline
              className="scene-cut-stroke"
              points={cutStroke.map((p) => `${p.x},${p.y}`).join(" ")}
            />
          )}
          {tempWire &&
            (() => {
              const a = cardById(tempWire.fromId);
              if (!a) return null;
              const x1 = a.x + CARD_W;
              const y1 = a.y + heightOf(a) / 2;
              const mx = (x1 + tempWire.x2) / 2;
              const d = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${tempWire.y2}, ${tempWire.x2} ${tempWire.y2}`;
              return (
                <path
                  className={"scene-edge temp" + (a.kind === "generation" ? " temp-gen" : "")}
                  d={d}
                />
              );
            })()}
        </svg>

        {visibleCards.map((card) => {
          const sel = selected.has(card.id);
          const isRef = card.kind === "reference";
          const g = !isRef && card.genId ? genData[card.genId] : null; // 바인딩된 실제 생성물
          const showNode = !!g && String(g.status) === "done"; // 완료 → 히스토리 카드로 표시
          return (
            <div
              key={card.id}
              ref={(el) => {
                cardEls.current[card.id] = el;
              }}
              className={
                "scene-card " +
                (isRef ? "scene-card-ref" : "scene-card-gen") +
                (sel ? " sel" : "") +
                (showNode ? " has-node" : "") // 완료 결과가 있으면 히스토리 노드가 카드 뼈대를 대체
              }
              data-id={card.id}
              style={{ left: card.x, top: card.y, width: CARD_W, ...(isRef ? {} : { height: CARD_H }) }}
            >
              {isRef ? (
                <>
                  {/* 내부 래퍼만 클리핑(둥근 모서리) — 포트는 이 밖이라 잡기 영역이 안 잘린다 */}
                  <div className="scene-card-inner">
                    <div className="scene-card-hd">레퍼런스 {card.refs?.length ?? 0}</div>
                    <div className="scene-card-body">
                      {(card.refs || []).map((r, i) => (
                        <div className="scene-refthumb" key={i} title={r.name || `레퍼런스 ${i + 1}`}>
                          {r.thumb ? (
                            <img src={r.thumb} alt="" draggable={false} />
                          ) : (
                            <span className="scene-refthumb-ph" />
                          )}
                          <span className="scene-refnum">{i + 1}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <span
                    className="scene-port out"
                    onMouseDown={(e) => onOutPortDown(e, card.id)}
                    title="드래그해 생성 카드에 연결"
                  />
                </>
              ) : (
                <>
                  {showNode && g ? (
                    // 완료 결과 → 히스토리 카드(HistoryBoardNode) 그대로 — 캡션·오버레이(S/ⓘ/⠿/⤓/@/↻) 전부.
                    <HistoryBoardNode
                      generation={g}
                      x={0}
                      y={0}
                      width={CARD_W}
                      height={CARD_H}
                      isRoot={false}
                      isSelected={sel}
                      onLine={false}
                      offLine={false}
                      fill
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
                      onPreview={onPreview || (() => {})}
                      onInfo={onInfo || (() => {})}
                      onRegenerate={onRegenerate || (() => {})}
                    />
                  ) : (
                    <div className="scene-card-inner">
                      {card.genId ? (
                        missingIds.has(card.genId) ? (
                          // 외부에서 삭제(휴지통)된 생성물 — 무한 'Generating' 대신 명시.
                          <div className="scene-card-genbody">삭제됨</div>
                        ) : String(g?.status) === "failed" || String(g?.status) === "error" ? (
                          <div className="scene-card-genbody">생성 실패</div>
                        ) : (
                          // 생성중 — 라이브러리(My Work)와 동일한 웨이브 아이콘 + 'Generating'.
                          // status 클래스로 색도 동일하게(running=앰버, pending=회색).
                          <div className={"scene-card-genbody status-" + String(g?.status || card.status || "pending")}>
                            <span className="gen-generating">
                              <span className="gen-wave" aria-hidden>
                                <span className="gen-wave-bar" />
                                <span className="gen-wave-bar" />
                                <span className="gen-wave-bar" />
                                <span className="gen-wave-bar" />
                                <span className="gen-wave-bar" />
                              </span>
                              <span className="gen-generating-label">Generating</span>
                            </span>
                          </div>
                        )
                      ) : (
                        <div className="scene-card-genbody">New</div>
                      )}
                    </div>
                  )}
                  {/* 다중 결과 배지 — 이 카드에서 만든 결과가 2개 이상이면. 클릭=팝업으로 모아보기 */}
                  {variantIds(card).length > 1 && (
                    <button
                      className="scene-multi-badge"
                      title={`이 카드의 생성 결과 ${variantIds(card).length}개 모두 보기`}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        setCardMenu(card.id);
                      }}
                    >
                      ▤ {variantIds(card).length}
                    </button>
                  )}
                  <span className="scene-port in" title="레퍼런스 연결 입력" />
                  <span
                    className="scene-port out"
                    onMouseDown={(e) => onOutPortDown(e, card.id)}
                    title="드래그해 다른 생성 카드에 연결"
                  />
                  {g && card.id === tagEditCardId && onSetTags && (
                    <div className="scene-tagpop" onMouseDown={(e) => e.stopPropagation()}>
                      <TagEditor
                        tags={g.tags}
                        onChange={(next) => applyCardTags(g, next)}
                        global={
                          onSetAutoTags
                            ? {
                                all: autoTagOptions ?? [],
                                assigned: g.auto_tags ?? [],
                                onChange: (next) => applyCardAutoTags(g, next),
                              }
                            : null
                        }
                        onClose={() => setTagEditCardId(null)}
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}

        {/* 연결선 끝점 색 점 — 포트 중앙에 얹혀 각 선과 같은 색(파랑=레퍼런스, 초록=계보).
            선마다 자기 끝점에 찍혀, 한 카드에 두 종류 연결이 섞여도 색이 정확히 일치한다. */}
        <svg
          className="scene-edge-dots"
          style={{ position: "absolute", top: 0, left: 0, overflow: "visible", pointerEvents: "none", zIndex: 9 }}
        >
          {visibleEdges.map((e) => {
            const a = cardById(e.from);
            const b = cardById(e.to);
            if (!a || !b) return null;
            const cls = "scene-dot" + (refCardEdgeIds.has(e.id) ? " ref" : "");
            const { x1, y1, x2, y2 } = edgeEnds(e, a, b);
            return (
              <g key={e.id}>
                <circle className={cls} cx={x1} cy={y1} r={5.5} />
                <circle className={cls} cx={x2} cy={y2} r={5.5} />
              </g>
            );
          })}
        </svg>
      </div>

      {marquee && (
        <div
          className="scene-marquee"
          style={{ left: marquee.l, top: marquee.t, width: marquee.w, height: marquee.h }}
        />
      )}

      {cutHeld && (
        <div className="scene-cut-hint">✂ 연결 자르기 — 드래그로 선을 지나가고 손을 떼면 끊깁니다</div>
      )}

      {/* 다중 결과 팝업 — 라이브러리 그리드처럼 다중선택→액션바(다운로드/비교/담기/공유/삭제),
          ★대표 지정, 더블클릭 크게보기(방향키). .scene-board 직계(줌/팬 밖). 배경클릭/Esc 닫기. */}
      {cardMenu &&
        (() => {
          const c = cards.find((x) => x.id === cardMenu);
          if (!c) return null;
          const ids = variantIds(c);
          // asset 있는(미리보기 가능) 변형만 방향키 목록으로 — pending/실패 섞임 방지.
          const previewItems: PreviewItem[] = [];
          for (const id of ids) {
            const a = genData[id]?.assets?.[0];
            if (a)
              previewItems.push({
                url: a.file_path,
                type: a.type,
                name: genData[id]?.prompt?.slice(0, 50) || "결과",
                genId: id,
              });
          }
          const openPreviewAt = (gid: string) => {
            const index = previewItems.findIndex((it) => it.genId === gid);
            if (index < 0) return;
            onPreview?.({ ...previewItems[index], items: previewItems, index });
          };
          const selected = ids.map((id) => genData[id]).filter((g): g is Generation => !!g && popupSel.has(g.id));
          const closeAndTrash = async () => {
            const done = await onVariantDelete?.(selected);
            if (done && done.length) {
              const removed = new Set(done);
              pruneVariants(c.id, removed);
              setPopupSel((prev) => new Set([...prev].filter((id) => !removed.has(id))));
              // 남은 변형 판정은 최신 카드 기준(삭제 대기 중 뒤에서 append 됐을 수 있어 렌더 스냅샷 대신).
              const latest = cardsRef.current.find((x) => x.id === c.id) || c;
              if (variantIds(latest).filter((id) => !removed.has(id)).length === 0) setCardMenu(null);
            }
          };
          const toggleSel = (gid: string, additive: boolean) =>
            setPopupSel((prev) => {
              if (!additive) return new Set([gid]);
              const n = new Set(prev);
              n.has(gid) ? n.delete(gid) : n.add(gid);
              return n;
            });
          return (
            <div
              className="scene-varpop-backdrop"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => setCardMenu(null)}
            >
              <div
                className="scene-varpop-wrap"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="scene-varpop">
                  <div className="scene-varpop-hd">
                    <span>생성 결과 {ids.length}개</span>
                    <button className="scene-varpop-x" title="닫기" onClick={() => setCardMenu(null)}>
                      ×
                    </button>
                  </div>
                  <div className="scene-varpop-grid" ref={varGridRef} onMouseDown={onVarGridMouseDown}>
                    {ids.map((gid) => {
                      const gg = genData[gid];
                      const a = gg?.assets?.[0];
                      const isVideo = a?.type === "video"; // 영상: img 로는 못 그려 썸네일이 비었었음
                      const rep = gid === c.genId; // 대표
                      const on = popupSel.has(gid); // 선택
                      const off = disabledIds.has(gid); // 비활성(회색)
                      return (
                        <div
                          key={gid}
                          data-gid={gid}
                          className={
                            "scene-varpop-item" +
                            (rep ? " rep" : "") +
                            (on ? " on" : "") +
                            (off ? " off" : "")
                          }
                          title={gg?.prompt || ""}
                          onMouseDown={(e) => {
                            if (e.button === 1) e.preventDefault(); // 휠클릭 자동스크롤 방지
                          }}
                          onAuxClick={(e) => {
                            // 휠(중간)클릭 = 정보(계보·메인 라이브러리 카드와 동일)
                            if (e.button === 1 && gg) {
                              e.preventDefault();
                              onInfo?.({ kind: "generation", gen: gg, x: e.clientX, y: e.clientY });
                            }
                          }}
                          onClick={(e) => toggleSel(gid, e.ctrlKey || e.shiftKey || e.metaKey)}
                          onDoubleClick={() => a && openPreviewAt(gid)}
                        >
                          {/* 영상도 확실히 보이게 — 썸네일 있으면 포스터, 없으면 첫 프레임(video). */}
                          <MediaThumbnail
                            thumb={gg ? thumbOf(gg) : null}
                            isVideo={isVideo}
                            src={a?.file_path}
                            fallback={<span className="scene-varpop-ph">{String(gg?.status || "…")}</span>}
                          />
                          {isVideo && <span className="scene-varpop-vid">▶</span>}
                          {/* 색·공유·최종 표시(계보 카드와 동일 정보) */}
                          {gg?.color && (
                            <span className="scene-varpop-colorbar" style={{ background: gg.color }} />
                          )}
                          {(gg?.shared || gg?.is_final) && (
                            <span className={"scene-varpop-sf" + (gg?.is_final ? " final" : "")}>
                              {gg?.is_final ? "★" : "S"}
                            </span>
                          )}
                          {rep && <span className="scene-varpop-cur">대표</span>}
                          {!rep && gg && a && (
                            <button
                              className="scene-varpop-rep"
                              title="이 결과를 카드 대표로 지정"
                              onMouseDown={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation();
                                setCardVariant(c.id, gid);
                              }}
                            >
                              ★ 대표
                            </button>
                          )}
                          {gg && a && (
                            // hover 액션 오버레이 — 계보 카드와 동일 기능(정보/다운로드/레퍼런스/재생성/크게보기).
                            // 컨테이너는 pointer-events:none, 버튼만 활성 → 빈 영역 클릭은 타일 선택으로 통과.
                            <div className="scene-varpop-ov">
                              <div className="scene-varpop-ov-top">
                                <button
                                  title="정보"
                                  onMouseDown={(e) => e.stopPropagation()}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onInfo?.({ kind: "generation", gen: gg, x: e.clientX, y: e.clientY });
                                  }}
                                >
                                  ⓘ
                                </button>
                              </div>
                              <div className="scene-varpop-ov-bot">
                                <button
                                  title="다운로드"
                                  onMouseDown={(e) => e.stopPropagation()}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    downloadOne(a.file_path, downloadName(gg, a.type));
                                  }}
                                >
                                  ⤓
                                </button>
                                <button
                                  title="레퍼런스로 사용"
                                  onMouseDown={(e) => e.stopPropagation()}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    dispatchAppEvent(APP_EVENTS.addReference, gg.id);
                                  }}
                                >
                                  @
                                </button>
                                <button
                                  title="프롬프트 재사용 — 프롬프트·옵션 불러오기"
                                  onMouseDown={(e) => e.stopPropagation()}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    dispatchAppEvent(APP_EVENTS.reusePrompt, gg.id);
                                  }}
                                >
                                  ⤶
                                </button>
                                <button
                                  title="재생성"
                                  onMouseDown={(e) => e.stopPropagation()}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onRegenerate?.(gg);
                                  }}
                                >
                                  ↻
                                </button>
                                <button
                                  title="크게 보기(방향키로 이동)"
                                  onMouseDown={(e) => e.stopPropagation()}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openPreviewAt(gid);
                                  }}
                                >
                                  ⤢
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {popupMarq && (
                      <div
                        className="scene-varpop-marq"
                        style={{ left: popupMarq.l, top: popupMarq.t, width: popupMarq.w, height: popupMarq.h }}
                      />
                    )}
                  </div>
                </div>
                {selected.length > 0 && (
                  <div className="scene-varpop-actions">
                    <BoardSelectionActionBar
                      selected={selected}
                      projects={projects || []}
                      onShare={(s) => onVariantShare?.(s)}
                      onDownload={(s) => onVariantDownload?.(s)}
                      onCompare={(s) => onVariantCompare?.(s)}
                      onAssign={(pid) => onVariantAssign?.(selected, pid)}
                      onCreateAndAssign={(name) => onVariantCreateAssign?.(selected, name)}
                      onDelete={() => void closeAndTrash()}
                    />
                  </div>
                )}
              </div>
            </div>
          );
        })()}

      {cards.length === 0 && (
        <div className="scene-empty">
          <div className="scene-empty-title">{scene.name}</div>
          <b>에셋 창에서 레퍼런스를 이 화면으로 드래그</b>하면 레퍼런스 카드가 만들어집니다.
          <div className="scene-empty-hint">
            카드 선택 후 <b>N</b> 키 → 빈 생성 카드 연결 · <b>Delete</b> → 삭제 · <b>Y</b> → 연결 자르기 · 미들버튼 드래그 → 화면 이동
          </div>
        </div>
      )}
    </div>
  );
}
