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
  type SceneGroup,
  type SceneRef,
} from "../../lib/scenes";
import { classifyEdges, computeBridgeEdges, edgePathXY, fanOffset } from "../../lib/sceneEdges";
import { useSceneGenData } from "../../lib/useSceneGenData";
import type { Generation, InfoTarget, PreviewItem, PreviewTarget, Project } from "../../types";
import { HistoryBoardNode } from "../history/HistoryBoardNode";
import { TagEditor } from "../TagEditor";
import { GenerationConfirmOverlay } from "../generation/GenerationConfirmOverlay";
import { MediaThumbnail } from "../MediaThumbnail";
import { displayThumb, hideBrokenImg, thumbOf } from "../../lib/media";
import { BoardSelectionActionBar } from "../app/SelectionActionBar";
import { useClickSeparation } from "../../lib/useClickSeparation";

const CARD_W = 152;
const CARD_H = 130;

// 레퍼런스 카드 썸네일 src — 영상 에셋은 thumb 가 '영상 파일 URL'이라 <img> 로는 깨진다.
// asset:proj|path 토큰이면 포스터(assetThumbUrl, 백엔드 첫 프레임)로 바꿔 이미지로 표시한다.
function refThumbSrc(r: SceneRef): string | undefined {
  if (r.type === "audio") return undefined; // 오디오는 썸네일이 없다 → placeholder(415 깨짐 방지)
  // display=캐시 썸네일. 영상은 원본 파일을 넘겨 백엔드가 포스터를 만들고(썸네일이 영상 파일 URL이면
  // <img>로는 깨짐), 이미지는 썸네일 우선. displayThumb 가 asset 토큰·원격 URL 모두 프록시로 통일.
  const raw = r.type === "video" ? r.file_path : r.thumb || r.file_path;
  return displayThumb(raw, 256) ?? undefined;
}

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
  // 사이드바에서 선택한 폴더 — 그 폴더(하위 포함) 밖 완성카드를 딤 처리(어떤 게 들어갔는지 표시).
  folderSel?: { projectId: string; path: string } | null;
  // 태그 편집(라이브러리와 공용 — 태그는 생성물 레코드에 저장되어 뷰 간 자동 공유).
  onSetTags?: (g: Generation, tags: string[]) => void;
  onSetAutoTags?: (g: Generation, names: string[]) => void;
  autoTagOptions?: string[]; // 내 전역(auto) 태그 목록 — TagEditor 의 # 전역 picker
  onOpenComments?: (g: Generation) => void; // C → 공유 코멘트 스레드 패널 열기(생성탭 카드와 동일)
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
  folderSel,
  onSetTags,
  onSetAutoTags,
  autoTagOptions,
  onOpenComments,
}: Props) {
  const [cards, setCards] = useState<SceneCard[]>(scene.cards);
  const [edges, setEdges] = useState<SceneEdge[]>(scene.edges);
  const [groups, setGroups] = useState<SceneGroup[]>(scene.groups || []);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null); // 이름 편집 중인 그룹
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [marquee, setMarquee] = useState<{ l: number; t: number; w: number; h: number } | null>(null);
  const [tempWire, setTempWire] = useState<{ fromId: string; x2: number; y2: number } | null>(null);
  // genId→실제 생성물 바인딩·폴링·계보(refParents)·비활성/삭제 상태는 useSceneGenData 훅으로 추출(동작 보존).
  //  각 생성물이 '레퍼런스로 쓴' 부모 gen id(refParents)는 수동 연결선 색(레퍼런스 점선 vs 계보 실선) 판정 근거.
  const { genData, setGenData, genDataRef, missingIds, disabledIds, refParents } = useSceneGenData(cards);
  const [cardMenu, setCardMenu] = useState<string | null>(null); // 변형(결과) 팝업이 열린 카드 id
  const [refMenu, setRefMenu] = useState<string | null>(null); // 레퍼런스 카드 더블클릭 → 담긴 refs 보기 팝업
  const [tagEditCardId, setTagEditCardId] = useState<string | null>(null); // 태그 편집 팝업이 열린 카드 id(같은 생성물이 여러 카드여도 하나만)
  const [tagEditGid, setTagEditGid] = useState<string | null>(null); // 변형 팝업 타일별 태그 편집 대상 gen id
  const [popupSel, setPopupSel] = useState<Set<string>>(new Set()); // 팝업 내 다중선택(gid)
  const [gripDragging, setGripDragging] = useState(false); // 팝업 재사용 그립 드래그 중 — 백드롭 클릭통과(프롬프트로 드롭)
  const [popupMarq, setPopupMarq] = useState<{ l: number; t: number; w: number; h: number } | null>(null);
  const varGridRef = useRef<HTMLDivElement>(null);
  const varpopWrapRef = useRef<HTMLDivElement>(null);
  // 변형 팝업 태그 에디터를 '편집 중인 타일 바로 아래'에 띄우기 위한 위치(wrap 기준). 타일은
  // overflow:hidden 이라 안에 넣으면 잘리므로 wrap 레벨에 절대배치하되, 타일 rect 를 측정해 그 밑에 둔다.
  const [tagEditorPos, setTagEditorPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!tagEditGid) {
      setTagEditorPos(null);
      return;
    }
    const measure = () => {
      const wrap = varpopWrapRef.current;
      const tile = varGridRef.current?.querySelector<HTMLElement>(`[data-gid="${tagEditGid}"]`);
      if (!wrap || !tile) return;
      const wr = wrap.getBoundingClientRect();
      const tr = tile.getBoundingClientRect();
      setTagEditorPos({ left: tr.left - wr.left + tr.width / 2, top: tr.bottom - wr.top + 6 });
    };
    measure();
    const grid = varGridRef.current;
    grid?.addEventListener("scroll", measure);
    window.addEventListener("resize", measure);
    return () => {
      grid?.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [tagEditGid]);
  useEffect(() => {
    // 팝업 열림/카드 전환/닫기 시 선택·태그편집 대상 초기화 — 이전 카드의 태그 에디터가 다른 카드
    // 팝업 위에 stale 위치로 남지 않게.
    setPopupSel(new Set());
    setTagEditGid(null);
  }, [cardMenu]);
  // 팝업이 '모달 레이어'인지·그 선택을 전역 keydown 에서 읽기 위한 ref(빈-deps 핸들러용).
  const cardMenuRef = useRef(cardMenu);
  cardMenuRef.current = cardMenu;
  const refMenuRef = useRef(refMenu);
  refMenuRef.current = refMenu;
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
      undoStackRef.current = []; // 다른 씬으로 넘어가면 되돌리기 히스토리도 새로.
    }
    setCards(scene.cards);
    setEdges(scene.edges);
    setGroups(scene.groups || []);
    // 표시 중인 상태를 항상 '최근 커밋'으로 맞춘다 — 외부 갱신(생성 완료 등) 후 Ctrl+Z 가
    // 그 갱신까지 되돌리는(스테일 복원) 문제 방지. (내 persist 는 이미 같은 값이라 무해)
    lastCommitRef.current = { cards: scene.cards, edges: scene.edges, groups: scene.groups || [] };
  }, [scene.id, scene.cards, scene.edges, scene.groups]);

  const scrollRef = useRef<HTMLDivElement>(null);
  // 캔버스 위 마지막 마우스 좌표(클라이언트) — 선택 없이 n 눌렀을 때 이 위치에 카드 생성.
  const lastMouseRef = useRef<{ x: number; y: number; over: boolean }>({ x: 0, y: 0, over: false });
  const canvasRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(scene.camera?.z ?? 1);
  const panRef = useRef({ x: scene.camera?.x ?? 0, y: scene.camera?.y ?? 0 });
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // ── 되돌리기(Ctrl+Z) 히스토리 ── persist 가 유일한 커밋 지점이라 여기 한 곳에서 직전 상태를 쌓는다.
  const undoStackRef = useRef<Array<{ cards: SceneCard[]; edges: SceneEdge[]; groups: SceneGroup[] }>>([]);
  const lastCommitRef = useRef<{ cards: SceneCard[]; edges: SceneEdge[]; groups: SceneGroup[] }>({
    cards: scene.cards,
    edges: scene.edges,
    groups: scene.groups || [],
  });
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

  // 카드/엣지/그룹을 함께 저장 — 그룹 인자를 안 주면 현재 그룹을 유지(대부분의 호출부는 카드·엣지만 바꿈).
  const persist = (
    nextCards: SceneCard[],
    nextEdges: SceneEdge[],
    nextGroups: SceneGroup[] = groupsRef.current,
  ) => {
    // 되돌리기용: 직전 커밋 상태를 스택에 쌓고(상한 200), 이번 상태를 최신 커밋으로 기록.
    undoStackRef.current.push(lastCommitRef.current);
    if (undoStackRef.current.length > 200) undoStackRef.current.shift();
    lastCommitRef.current = { cards: nextCards, edges: nextEdges, groups: nextGroups };
    onChangeRef.current({ cards: nextCards, edges: nextEdges, groups: nextGroups });
  };
  // Ctrl+Z — 직전 커밋 상태로 복원(redo 는 요청 범위 밖이라 없음). undo 자체는 히스토리에 안 쌓는다.
  const undo = () => {
    const prev = undoStackRef.current.pop();
    if (!prev) return;
    lastCommitRef.current = prev;
    setCards(prev.cards);
    setEdges(prev.edges);
    setGroups(prev.groups);
    setSelected(new Set());
    onChangeRef.current(prev); // 부모(씬 저장)에도 반영
  };

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
    // 공유/해제=본인 것. 추가로 슈퍼바이저는 남의 '공유된' 카드를 해제할 수 있다(B안).
    const may = cbRef.current.canFinalize ? cbRef.current.canFinalize(g) : true;
    if (!g.is_mine && !(g.shared && may)) return;
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
  // T(태그) — 이 생성물이 얹힌 캔버스 카드를 찾아 그 카드의 태그 편집 팝업을 연다(# 키와 동일 경로).
  // 안정 참조(useCallback)라 HistoryBoardNode 의 memo 를 깨지 않는다.
  const onNodeTag = useCallback((g: Generation) => {
    const card = cardsRef.current.find((c) => c.kind === "generation" && c.genId === g.id);
    if (card) setTagEditCardId(card.id);
  }, []);

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
  // 여러 연결을 한 번에 추가(중복·자기연결 제외). 다중 레퍼런스 일괄 연결·c 자동연결에서 재사용.
  const addEdges = (pairs: Array<[string, string]>) => {
    const seen = new Set(edgesRef.current.map((e) => e.from + ">" + e.to));
    const additions: SceneEdge[] = [];
    for (const [from, to] of pairs) {
      if (from === to) continue;
      const k = from + ">" + to;
      if (seen.has(k)) continue;
      seen.add(k);
      additions.push({ id: uid(), from, to });
    }
    if (!additions.length) return;
    const ne = [...edgesRef.current, ...additions];
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

  // ── 레퍼런스 카드 병합/분리 ──
  // 여러 레퍼런스 카드를 하나로 병합 — 왼쪽 카드에 refs 전부 합치고(중복 제거) 나머지 삭제.
  // 지워진 카드에 걸린 엣지는 남는 카드로 재연결(연결 유지) + 중복/자기연결 정리.
  const mergeRefCards = (ids: string[]) => {
    const picked = ids
      .map((id) => cardsRef.current.find((c) => c.id === id))
      .filter((c): c is SceneCard => !!c && c.kind === "reference");
    if (picked.length < 2) return;
    const sorted = [...picked].sort((a, b) => a.x - b.x);
    const keep = sorted[0];
    const gone = new Set(sorted.slice(1).map((c) => c.id));
    const seen = new Set<string>();
    const mergedRefs: SceneRef[] = [];
    for (const c of sorted) {
      for (const r of c.refs || []) {
        const k = r.file_path + "#" + (r.source_gen_id || "");
        if (seen.has(k)) continue;
        seen.add(k);
        mergedRefs.push(r);
      }
    }
    const baseCards = cardsRef.current
      .filter((c) => !gone.has(c.id))
      .map((c) => (c.id === keep.id ? { ...c, refs: mergedRefs } : c));
    const eseen = new Set<string>();
    const nextEdges = edgesRef.current
      .map((ed) => ({
        ...ed,
        from: gone.has(ed.from) ? keep.id : ed.from,
        to: gone.has(ed.to) ? keep.id : ed.to,
      }))
      .filter((ed) => {
        if (ed.from === ed.to) return false;
        const k = ed.from + ">" + ed.to;
        if (eseen.has(k)) return false;
        eseen.add(k);
        return true;
      });
    const nextGroups = pruneGroups(groupsRef.current, gone); // 병합으로 사라진 카드는 그룹 멤버에서 제거
    const nextCards = withGenRefs(baseCards, nextEdges);
    setCards(nextCards);
    setEdges(nextEdges);
    setGroups(nextGroups);
    setSelected(new Set([keep.id]));
    persist(nextCards, nextEdges, nextGroups);
  };
  // 레퍼런스 카드에서 한 장(index)을 빼 개별 레퍼런스 카드로 분리(오른쪽에 배치).
  const separateRef = (cardId: string, index: number) => {
    const card = cardsRef.current.find((c) => c.id === cardId);
    if (!card || card.kind !== "reference" || !card.refs) return;
    const ref = card.refs[index];
    if (!ref) return;
    const remaining = card.refs.filter((_, i) => i !== index);
    const newCard: SceneCard = {
      id: uid(),
      kind: "reference",
      x: card.x + CARD_W + 40,
      y: card.y + Math.min(index, 4) * 22,
      refs: [ref],
    };
    let nextCards: SceneCard[];
    let nextEdges = edgesRef.current;
    let nextGroups = groupsRef.current;
    if (remaining.length === 0) {
      // 마지막 한 장을 분리 → 원본은 비므로 삭제(엣지·그룹 멤버도 정리). 분리한 장은 새 카드로 이동.
      nextCards = cardsRef.current.filter((c) => c.id !== cardId).concat(newCard);
      nextEdges = edgesRef.current.filter((ed) => ed.from !== cardId && ed.to !== cardId);
      nextGroups = pruneGroups(groupsRef.current, new Set([cardId]));
      setRefMenu(null);
    } else {
      nextCards = cardsRef.current
        .map((c) => (c.id === cardId ? { ...c, refs: remaining } : c))
        .concat(newCard);
    }
    const nc = withGenRefs(nextCards, nextEdges);
    setCards(nc);
    setEdges(nextEdges);
    setGroups(nextGroups);
    persist(nc, nextEdges, nextGroups);
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
      if (!toId) return;
      // ① 다중 레퍼런스 일괄 연결 — 드래그한 카드가 선택에 포함돼 있으면, 같은 종류(레퍼런스/생성)로
      //    선택된 카드 전부를 한 번에 연결한다. 아니면 그 카드 하나만.
      const sel = selectedRef.current;
      const srcKind = cardsRef.current.find((c) => c.id === cardId)?.kind;
      const froms = sel.has(cardId)
        ? [...sel].filter((id) => cardsRef.current.find((c) => c.id === id)?.kind === srcKind)
        : [cardId];
      addEdges(froms.map((f) => [f, toId] as [string, string]));
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

  // ── 그룹(Ctrl+G) — 선택 카드를 하나의 묶음으로. 테두리는 멤버 바운딩박스로 자동, 이름변경·접기 가능 ──
  // 삭제된 카드를 그룹 멤버에서 빼고 빈 그룹은 제거(순수).
  const pruneGroups = (gs: SceneGroup[], removed: Set<string>): SceneGroup[] =>
    gs
      .map((g) => ({ ...g, cardIds: g.cardIds.filter((id) => !removed.has(id)) }))
      .filter((g) => g.cardIds.length > 0);
  const applyGroups = (next: SceneGroup[]) => {
    setGroups(next);
    persist(cardsRef.current, edgesRef.current, next);
  };
  const groupSelected = () => {
    const ids = [...selectedRef.current].filter((id) => cardsRef.current.some((c) => c.id === id));
    if (!ids.length) return;
    // 카드는 한 그룹에만 — 선택 카드를 기존 그룹에서 떼고(빈 그룹 제거) 새 그룹으로 묶는다.
    const stripped = pruneGroups(groupsRef.current, new Set(ids));
    const grp: SceneGroup = { id: uid(), name: `그룹 ${stripped.length + 1}`, cardIds: ids };
    applyGroups([...stripped, grp]);
  };
  const ungroupSelected = () => {
    const sel = selectedRef.current;
    const next = groupsRef.current.filter((g) => !g.cardIds.some((id) => sel.has(id)));
    if (next.length !== groupsRef.current.length) applyGroups(next);
  };
  const renameGroup = (id: string, name: string) =>
    applyGroups(groupsRef.current.map((g) => (g.id === id ? { ...g, name } : g)));
  const toggleGroupCollapsed = (id: string) =>
    applyGroups(groupsRef.current.map((g) => (g.id === id ? { ...g, collapsed: !g.collapsed } : g)));

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
    const nextGroups = pruneGroups(groupsRef.current, idset); // 삭제 카드는 그룹 멤버에서 제거·빈 그룹 정리
    setCards(nextCards);
    setEdges(nextEdges);
    setGroups(nextGroups);
    setSelected(new Set());
    setCardMenu((m) => (m && idset.has(m) ? null : m)); // 삭제된 카드의 팝업은 닫는다
    setRefMenu((m) => (m && idset.has(m) ? null : m)); // 삭제된 레퍼런스 카드의 검사 팝업도 닫는다
    persist(nextCards, nextEdges, nextGroups);
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
        else if (refMenuRef.current) setRefMenu(null); // 레퍼런스 검사 팝업 닫기
        return;
      }
      // 레퍼런스 검사 팝업이 열려 있으면 캔버스 키(n/a/c/Delete 등) 전부 차단(모달).
      if (refMenuRef.current) return;
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
        } else if (onSetTags && matchShortcut(e, "tag")) {
          // # = 선택한 타일 태그 편집(타일 T 버튼과 동일). 여러 개 선택이면 첫 번째.
          const gid = pids.find((id) => genDataRef.current[id]);
          if (gid) {
            e.preventDefault();
            setTagEditGid(gid);
          }
        }
        return; // n/y/Delete 등 캔버스 명령은 팝업 중 무시
      }
      const sel = selectedRef.current;
      // Ctrl+Z = 되돌리기. Shift/Alt 조합은 제외(브라우저 redo·기타와 충돌 방지, redo 는 미지원).
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        undo();
        return;
      }
      // Ctrl+G = 선택 카드 그룹 · Ctrl+Shift+G = 그룹 해제. (mod+g 라 g=초록색 단축키와 충돌 없음)
      if ((e.ctrlKey || e.metaKey) && (e.key === "g" || e.key === "G")) {
        e.preventDefault(); // 브라우저 '다음 찾기' 방지
        if (e.shiftKey) ungroupSelected();
        else groupSelected();
        return;
      }
      // c = 자동 연결. 레퍼런스+생성 → 레퍼런스를 생성에 연결. 생성끼리만 → 왼→오 계보 체인.
      if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "c" || e.key === "C")) {
        const selCards = [...sel]
          .map((id) => cardsRef.current.find((cc) => cc.id === id))
          .filter((c): c is SceneCard => !!c);
        const refs = selCards.filter((c) => c.kind === "reference");
        const gens = selCards.filter((c) => c.kind === "generation");
        if (refs.length && gens.length) {
          // 레퍼런스 → 생성: 각 레퍼런스를 각 생성 카드에 연결(기존).
          e.preventDefault();
          addEdges(refs.flatMap((r) => gens.map((gc) => [r.id, gc.id] as [string, string])));
          return;
        }
        if (gens.length >= 2) {
          // 생성 카드끼리: 화면 왼→오 순서로 계보 체인 연결(왼쪽=부모, 오른쪽=자식).
          e.preventDefault();
          const sorted = [...gens].sort((a, b) => a.x - b.x);
          const pairs: Array<[string, string]> = [];
          for (let i = 0; i < sorted.length - 1; i++) pairs.push([sorted[i].id, sorted[i + 1].id]);
          addEdges(pairs);
          return;
        }
      }
      // a = 선택된 레퍼런스 카드(2장 이상)를 하나로 병합.
      if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "a" || e.key === "A")) {
        const refIds = [...sel].filter(
          (id) => cardsRef.current.find((c) => c.id === id)?.kind === "reference",
        );
        if (refIds.length >= 2) {
          e.preventDefault();
          mergeRefCards(refIds);
          return;
        }
      }
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
        // 선택된 것(레퍼런스/카드) 전부에서 새 카드 하나로 연결. 하나만 잡으면 엣지 1개.
        // 아무것도 선택 안 했으면 → 화면 중앙에 '단독' 빈 생성 카드(연결 없음).
        const srcCards = [...sel]
          .map((id) => cardsRef.current.find((c) => c.id === id))
          .filter((c): c is SceneCard => !!c);
        e.preventDefault();
        let nx: number;
        let ny: number;
        if (srcCards.length) {
          // 선택 있음 → 선택된 것들의 오른쪽·세로 중앙(가로 배치 겹침 방지).
          nx = Math.max(...srcCards.map((c) => c.x)) + CARD_W + 64;
          ny = Math.round(srcCards.reduce((s, c) => s + c.y, 0) / srcCards.length);
        } else {
          // 선택 없음 → 마우스 위치(캔버스 위)에. 캔버스 밖이면 화면 중앙 폴백.
          const m = lastMouseRef.current;
          const rect = scrollRef.current?.getBoundingClientRect();
          if (m.over) {
            const p = toCanvas(m.x, m.y);
            nx = Math.round(p.x - CARD_W / 2);
            ny = Math.round(p.y - CARD_H / 2);
          } else if (rect) {
            const center = toCanvas(rect.left + rect.width / 2, rect.top + rect.height / 2);
            nx = Math.round(center.x - CARD_W / 2);
            ny = Math.round(center.y - CARD_H / 2);
          } else {
            nx = 200;
            ny = 200;
          }
        }
        const empty: SceneCard = {
          id: uid(),
          kind: "generation",
          x: nx,
          y: ny,
          status: "empty",
          refs: [],
          genId: null,
        };
        const newEdges: SceneEdge[] = srcCards.map((c) => ({ id: uid(), from: c.id, to: empty.id }));
        const nextEdges = [...edgesRef.current, ...newEdges];
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
  // 캔버스(카드/배경)를 클릭하면 열려 있던 프롬프트 입력창의 포커스를 해제한다 → 카드 선택 후
  // r/g/b(색)·n·c·a 등 캔버스 단축키가 프롬프트에 글자로 새지 않게. 프롬프트는 직접 클릭해야 타이핑.
  // capture 단계라 카드의 stopPropagation 과 무관하게 항상 먼저 잡는다. 캔버스 내부 입력요소(태그 편집
  // 등)를 클릭한 경우는 제외(그건 그 입력창을 쓰려는 것).
  const onBoardMouseDownCapture = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    if (
      t.isContentEditable ||
      t.tagName === "INPUT" ||
      t.tagName === "TEXTAREA" ||
      t.closest("input, textarea, [contenteditable='true']")
    )
      return;
    const ae = document.activeElement as HTMLElement | null;
    if (ae && ae !== t && (ae.isContentEditable || ae.tagName === "INPUT" || ae.tagName === "TEXTAREA"))
      ae.blur();
  };

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
    // 그룹 헤더 잡기 → 멤버 카드 전체 이동(드래그) · 제자리 클릭 = 멤버 전체 선택(Shift/Ctrl=토글)
    const grabEl = (e.target as HTMLElement).closest(".scene-group-grab") as HTMLElement | null;
    if (grabEl) {
      const gid = grabEl.dataset.groupId;
      const grp = gid ? groupsRef.current.find((x) => x.id === gid) : null;
      if (grp) {
        e.preventDefault();
        const gAdditive = e.shiftKey || e.ctrlKey || e.metaKey;
        const gsx = e.clientX;
        const gsy = e.clientY;
        const memberIds = grp.cardIds.filter((id) => cardsRef.current.some((c) => c.id === id));
        const origins: Record<string, { x: number; y: number }> = {};
        for (const tid of memberIds) {
          const c = cardsRef.current.find((cc) => cc.id === tid);
          if (c) origins[tid] = { x: c.x, y: c.y };
        }
        let gMoved = false;
        const move = (ev: MouseEvent) => {
          if (!gMoved && Math.hypot(ev.clientX - gsx, ev.clientY - gsy) < 4) return;
          gMoved = true;
          const z = zoomRef.current;
          const dx = (ev.clientX - gsx) / z;
          const dy = (ev.clientY - gsy) / z;
          setCards((prev) =>
            prev.map((c) => (origins[c.id] ? { ...c, x: origins[c.id].x + dx, y: origins[c.id].y + dy } : c)),
          );
        };
        const up = () => {
          if (gMoved) persist(cardsRef.current, edgesRef.current);
          else
            setSelected((prev) => {
              if (gAdditive) {
                const n = new Set(prev);
                const all = memberIds.every((id) => n.has(id));
                memberIds.forEach((id) => (all ? n.delete(id) : n.add(id)));
                return n;
              }
              return new Set(memberIds);
            });
        };
        beginDrag(move, up);
        return;
      }
    }
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
      // 배경 → 마퀴 복수선택. 시작 시점 선택을 기억한다.
      const prevSel = new Set(selectedRef.current);
      const move = (ev: MouseEvent) => {
        if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
        moved = true;
        const r = scrollRef.current!.getBoundingClientRect();
        const x0 = Math.min(startX, ev.clientX);
        const y0 = Math.min(startY, ev.clientY);
        const x1 = Math.max(startX, ev.clientX);
        const y1 = Math.max(startY, ev.clientY);
        setMarquee({ l: x0 - r.left, t: y0 - r.top, w: x1 - x0, h: y1 - y0 });
        const boxed = new Set<string>();
        canvasRef.current?.querySelectorAll(".scene-card").forEach((el) => {
          const cr = (el as HTMLElement).getBoundingClientRect();
          if (cr.right >= x0 && cr.left <= x1 && cr.bottom >= y0 && cr.top <= y1) {
            const cid = (el as HTMLElement).dataset.id;
            if (cid) boxed.add(cid);
          }
        });
        // Shift/Ctrl: 기존 + 감싼 것. 아니면: 감싼 카드가 있으면 그걸로 교체, '빈 곳'을 감싸면 기존 선택 유지(해제 안 함).
        const hit = additive
          ? new Set([...prevSel, ...boxed])
          : boxed.size
            ? boxed
            : prevSel;
        setSelected(hit);
      };
      const up = () => {
        setMarquee(null);
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
  const grayHidden = new Set(
    grayOn
      ? cards
          .filter((c) => c.kind === "generation" && c.genId && disabledIds.has(c.genId))
          .map((c) => c.id)
      : [],
  );
  // 접힌 그룹의 멤버 카드 → 그 그룹. 접히면 멤버를 숨기고 연결은 그룹 막대로 브릿지한다.
  const collapsedMemberOf = new Map<string, SceneGroup>();
  for (const g of groups)
    if (g.collapsed && g.cardIds.length) for (const id of g.cardIds) collapsedMemberOf.set(id, g);
  const hiddenIds = new Set<string>([...grayHidden, ...collapsedMemberOf.keys()]);
  const visibleCards = hiddenIds.size ? cards.filter((c) => !hiddenIds.has(c.id)) : cards;
  // 숨긴(회색) 카드가 중간에 있어도 앞뒤 흐름이 끊긴 것처럼 보이지 않게 — 숨김 노드를 건너뛰어
  // 보이는 '앞 카드 → 뒤 카드'로 회색 점선 우회선을 만든다(중간에 뭔가 숨겨져 있다는 표시).
  const bridgeEdges = computeBridgeEdges(cards, edges, grayHidden);
  const heightOf = (c: SceneCard) =>
    c.kind === "generation" ? CARD_H : heightsRef.current[c.id] || CARD_H;

  // ── 그룹 기하 — 테두리는 멤버 카드 바운딩박스로 자동. 접힘=제목 막대(연결은 막대로 브릿지) ──
  const GPAD = 16; // 테두리 여백
  const GHD = 26; // 헤더 높이
  const GCOLLAPSED_W = 200; // 접힌 막대 너비
  const memberBounds = (g: SceneGroup) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let n = 0;
    for (const id of g.cardIds) {
      const c = cardById(id);
      if (!c) continue;
      n++;
      minX = Math.min(minX, c.x);
      minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x + CARD_W);
      maxY = Math.max(maxY, c.y + heightOf(c));
    }
    return n ? { minX, minY, maxX, maxY } : null;
  };
  // 각 그룹의 프레임(펼침)·막대(접힘) 사각형. 접힘 막대는 프레임 좌상단에 고정폭으로.
  const groupViews = groups
    .map((g) => {
      const b = memberBounds(g);
      if (!b) return null;
      const frame = {
        x: b.minX - GPAD,
        y: b.minY - GPAD - GHD,
        w: b.maxX - b.minX + GPAD * 2,
        h: b.maxY - b.minY + GPAD * 2 + GHD,
      };
      const bar = { x: frame.x, y: frame.y, w: GCOLLAPSED_W, h: GHD };
      return { g, frame, bar };
    })
    .filter((v): v is { g: SceneGroup; frame: { x: number; y: number; w: number; h: number }; bar: { x: number; y: number; w: number; h: number } } => !!v);
  const collapsedBarById = new Map(
    groupViews.filter((v) => v.g.collapsed).map((v) => [v.g.id, v.bar] as const),
  );
  // 접힌 그룹 멤버에 닿는 연결선 → 멤버 대신 그룹 막대의 포트로 재연결(브릿지). 내부(같은 그룹끼리)는 숨김.
  const barOut = (id: string) => {
    const g = collapsedMemberOf.get(id);
    if (g) {
      const bar = collapsedBarById.get(g.id);
      return bar ? { x: bar.x + bar.w, y: bar.y + bar.h / 2 } : null;
    }
    const c = cardById(id);
    return c ? { x: c.x + CARD_W, y: c.y + heightOf(c) / 2 } : null;
  };
  const barIn = (id: string) => {
    const g = collapsedMemberOf.get(id);
    if (g) {
      const bar = collapsedBarById.get(g.id);
      return bar ? { x: bar.x, y: bar.y + bar.h / 2 } : null;
    }
    const c = cardById(id);
    return c ? { x: c.x, y: c.y + heightOf(c) / 2 } : null;
  };

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

  // 접힌 그룹 막대로 재연결되는 브릿지 선 — 멤버가 숨어 visibleEdges 에서 빠진 연결을 막대 포트로 그린다.
  const groupBridges = collapsedMemberOf.size
    ? edges.flatMap((e) => {
        if (grayHidden.has(e.from) || grayHidden.has(e.to)) return [];
        const fg = collapsedMemberOf.get(e.from);
        const tg = collapsedMemberOf.get(e.to);
        if (!fg && !tg) return []; // 둘 다 안 접힘 → 일반선(visibleEdges)이 그림
        if (fg && tg && fg.id === tg.id) return []; // 같은 접힌 그룹 내부 연결 → 숨김
        const a = barOut(e.from);
        const b = barIn(e.to);
        if (!a || !b) return [];
        return [{ id: e.id, a, b, ref: refCardEdgeIds.has(e.id), refg: genRefEdgeIds.has(e.id) }];
      })
    : [];

  return (
    <div
      className={"scene-board" + (cutHeld ? " cutting" : "")}
      ref={scrollRef}
      onMouseDownCapture={onBoardMouseDownCapture}
      onMouseDown={onMouseDown}
      onMouseMove={(e) => {
        lastMouseRef.current = { x: e.clientX, y: e.clientY, over: true };
      }}
      onMouseLeave={() => {
        lastMouseRef.current.over = false;
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="scene-canvas" ref={canvasRef} style={{ transformOrigin: "0 0" }}>
        {/* 그룹 프레임(펼침)·막대(접힘) — 카드 뒤(맨 앞 렌더). 헤더만 잡기/이름변경/접기 가능 */}
        {groupViews.map(({ g, frame, bar }) => {
          const collapsed = !!g.collapsed;
          const box = collapsed ? bar : frame;
          const memberCount = g.cardIds.filter((id) => cardById(id)).length;
          const editing = editingGroupId === g.id;
          return (
            <div
              key={g.id}
              className={"scene-group" + (collapsed ? " collapsed" : "")}
              style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
            >
              <div
                className="scene-group-hd scene-group-grab"
                data-group-id={g.id}
                title="끌어서 그룹 이동 · 더블클릭=이름 변경"
              >
                <button
                  className="scene-group-btn"
                  title={collapsed ? "펼치기" : "접기"}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleGroupCollapsed(g.id);
                  }}
                >
                  {collapsed ? "▸" : "▾"}
                </button>
                {editing ? (
                  <input
                    className="scene-group-name-input"
                    autoFocus
                    defaultValue={g.name}
                    onMouseDown={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") {
                        renameGroup(g.id, (e.target as HTMLInputElement).value.trim() || g.name);
                        setEditingGroupId(null);
                      } else if (e.key === "Escape") setEditingGroupId(null);
                    }}
                    onBlur={(e) => {
                      renameGroup(g.id, e.target.value.trim() || g.name);
                      setEditingGroupId(null);
                    }}
                  />
                ) : (
                  <span
                    className="scene-group-name"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setEditingGroupId(g.id);
                    }}
                  >
                    {g.name}
                  </span>
                )}
                <span className="scene-group-count">{memberCount}</span>
              </div>
            </div>
          );
        })}
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
          {/* 접힌 그룹 브릿지 — 멤버 대신 그룹 막대 포트로 이어 그린다(연결 유지 표시).
              일반 엣지와 동일하게 hit-path(클릭 삭제) + data-edge(가위 절단) + cut 예고 스타일을 태운다. */}
          {groupBridges.map((gb) => {
            const d = edgePathXY(gb.a.x, gb.a.y, gb.b.x, gb.b.y);
            const cls =
              "scene-edge" +
              (gb.ref ? " ref" : gb.refg ? " refg" : "") +
              (edgesToCut.has(gb.id) ? " cut" : "");
            return (
              <g key={gb.id}>
                <path
                  className="scene-edge-hit"
                  data-edge={gb.id}
                  d={d}
                  onClick={() => removeEdge(gb.id)}
                />
                <path className={cls} d={d} />
              </g>
            );
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
              // 레퍼런스 카드 더블클릭 → 담긴 레퍼런스들을 팝업으로 보기(분리 가능). 생성 카드는 각자 처리.
              onDoubleClick={isRef ? () => setRefMenu(card.id) : undefined}
            >
              {isRef ? (
                <>
                  {/* 내부 래퍼만 클리핑(둥근 모서리) — 포트는 이 밖이라 잡기 영역이 안 잘린다 */}
                  <div className="scene-card-inner">
                    <div className="scene-card-hd">레퍼런스 {card.refs?.length ?? 0}</div>
                    <div className="scene-card-body">
                      {(card.refs || []).map((r, i) => (
                        <div className="scene-refthumb" key={i} title={r.name || `레퍼런스 ${i + 1}`}>
                          {(() => {
                            const src = refThumbSrc(r);
                            return src ? (
                              <img src={src} alt="" draggable={false} onError={hideBrokenImg} />
                            ) : (
                              <span className="scene-refthumb-ph" />
                            );
                          })()}
                          {r.type === "video" && <span className="scene-refthumb-vid">▶</span>}
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
                      folderSel={folderSel}
                      sConfirm={sConfirm?.id === g.id ? sConfirm : null}
                      onSClick={onNodeSClick}
                      onSDouble={onNodeSDouble}
                      onSConfirmYes={onNodeSConfirmYes}
                      onSConfirmNo={onNodeSConfirmNo}
                      onPreview={
                        onPreview
                          ? (target) => {
                              // 카드에 변형(결과)이 여러 개면 큰창에서 ←/→ 로 넘길 수 있게 그 변형들을
                              // items 로 함께 넘긴다(내작업 그리드/변형 팝업과 동일한 방향키 이동).
                              const items: PreviewItem[] = [];
                              for (const id of variantIds(card)) {
                                const av = genData[id]?.assets?.[0];
                                if (av)
                                  items.push({
                                    url: av.file_path,
                                    type: av.type,
                                    name: genData[id]?.prompt?.slice(0, 50) || "결과",
                                    genId: id,
                                  });
                              }
                              if (items.length > 1) {
                                const index = Math.max(
                                  0,
                                  items.findIndex((it) => it.genId === (target.genId ?? g?.id)),
                                );
                                onPreview({ ...target, items, index });
                              } else onPreview(target);
                            }
                          : () => {}
                      }
                      onInfo={onInfo || (() => {})}
                      onRegenerate={onRegenerate || (() => {})}
                      onTag={onSetTags ? onNodeTag : undefined}
                      onOpenComments={onOpenComments}
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
              className={"scene-varpop-backdrop" + (gripDragging ? " drag-through" : "")}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => setCardMenu(null)}
            >
              <div
                className="scene-varpop-wrap"
                ref={varpopWrapRef}
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
                      // 선택 폴더(하위 포함) 밖 변형이면 흐리게 — 팝업 안에서 어떤 변형이 그 폴더에
                      // 들어갔는지 한눈에(캔버스 카드 딤과 동일 규칙). folderSel 없으면 딤 없음.
                      const folderDim =
                        !!folderSel &&
                        !!gg &&
                        !(
                          gg.project_id === folderSel.projectId &&
                          (folderSel.path === "" ||
                            gg.folder_path === folderSel.path ||
                            (gg.folder_path?.startsWith(folderSel.path + "/") ?? false))
                        );
                      return (
                        <div key={gid} className="scene-varpop-cell">
                          {/* 대표 라벨/지정 버튼 — 카드 '밖' 상단(요청). 대표면 라벨, 아니면 지정 버튼. */}
                          {rep ? (
                            <span className="scene-varpop-cur">대표</span>
                          ) : gg && a ? (
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
                          ) : null}
                          <div
                          data-gid={gid}
                          className={
                            "scene-varpop-item" +
                            (rep ? " rep" : "") +
                            (on ? " on" : "") +
                            (off ? " off" : "") +
                            (folderDim ? " foldim" : "")
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
                          {/* 좌상단 S/T/C — 생성탭 카드(.card-tl)와 동일 룩·조작(공유/태그/코멘트) */}
                          {gg && (
                            <div className="card-tl">
                              {(gg.is_mine ||
                                gg.is_final ||
                                (gg.shared && (canFinalize ? canFinalize(gg) : true))) && (
                                <button
                                  className={
                                    "card-sf" + (gg.shared ? " on" : "") + (gg.is_final ? " final" : "")
                                  }
                                  title={
                                    gg.is_final
                                      ? "최종(골드) — 더블클릭=최종 해제"
                                      : gg.is_mine
                                        ? gg.shared
                                          ? "팀 공유됨 · 클릭=해제 · 더블클릭=최종"
                                          : "팀에 공유 (클릭) · 최종은 공유 후 더블클릭"
                                        : "더블클릭=최종 지정 (Supervisor)"
                                  }
                                  onMouseDown={(e) => e.stopPropagation()}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onNodeSClick(gg);
                                  }}
                                  onDoubleClick={(e) => {
                                    e.stopPropagation();
                                    onNodeSDouble(gg);
                                  }}
                                >
                                  {gg.is_final ? "★" : "S"}
                                </button>
                              )}
                              <button
                                className={"card-cm" + (gg.tags.length ? " on" : "")}
                                title={
                                  gg.tags.length
                                    ? `태그: ${gg.tags.join(", ")} · 클릭=태그 편집`
                                    : "태그 편집"
                                }
                                onMouseDown={(e) => e.stopPropagation()}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setTagEditGid((cur) => (cur === gid ? null : gid));
                                }}
                              >
                                T
                              </button>
                              <button
                                className={"card-cm" + (gg.has_unread ? " alert" : "")}
                                title={
                                  gg.has_unread
                                    ? `새 코멘트 · 총 ${gg.comment_count}개`
                                    : gg.comment_count
                                      ? `코멘트 ${gg.comment_count}개`
                                      : "코멘트 스레드 열기"
                                }
                                onMouseDown={(e) => e.stopPropagation()}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onOpenComments?.(gg);
                                }}
                              >
                                C
                              </button>
                            </div>
                          )}
                          {/* 좌상단 그립(생성탭 .card-drag-grip 과 동일 — S/T/C 바로 아래). 끌어내려/클릭해 프롬프트 재사용. */}
                          {gg && a && (
                            <span
                              className="card-drag-grip"
                              draggable
                              title="클릭 또는 끌어내려 프롬프트 재사용(프롬프트·옵션 불러오기)"
                              onMouseDown={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation();
                                dispatchAppEvent(APP_EVENTS.reusePrompt, gg.id);
                              }}
                              onDragStart={(e) => {
                                e.stopPropagation();
                                e.dataTransfer.setData(DRAG_TYPES.generation, gg.id);
                                e.dataTransfer.effectAllowed = "copy";
                                setGripDragging(true);
                              }}
                              onDragEnd={() => setGripDragging(false)}
                            >
                              ⠿
                            </span>
                          )}
                          {/* 색·비활성 표시(공유/최종은 위 S 버튼이 겸함) */}
                          {gg?.color && (
                            <span className="scene-varpop-colorbar" style={{ background: gg.color }} />
                          )}
                          {/* S(공유/최종) 확인 — 생성탭 카드와 동일 오버레이. 이 타일이 대상일 때만. */}
                          {sConfirm?.id === gid && gg && (
                            <GenerationConfirmOverlay
                              mode={sConfirm.kind}
                              shared={!!gg.shared}
                              isFinal={!!gg.is_final}
                              onYes={() => onNodeSConfirmYes(gg)}
                              onNo={onNodeSConfirmNo}
                            />
                          )}
                          {gg && a && (
                            // 호버 액션 오버레이 — 생성탭 카드(.thumb-overlay / .ov-icon)와 동일 클래스·크기.
                            // 상단=정보(우), 하단=다운로드/레퍼런스/재생성. 컨테이너 pointer-events:none, 버튼만 활성.
                            <div className="thumb-overlay">
                              <div className="ov-top">
                                <button
                                  className="ov-icon"
                                  style={{ marginLeft: "auto" }}
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
                              <div className="ov-bottom">
                                <button
                                  className="ov-icon"
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
                                  className="ov-icon"
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
                                  className="ov-icon"
                                  title="재생성"
                                  onMouseDown={(e) => e.stopPropagation()}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onRegenerate?.(gg);
                                  }}
                                >
                                  ↻
                                </button>
                              </div>
                            </div>
                          )}
                          </div>
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
                {/* 태그 편집 — 타일은 overflow:hidden 이라 잘리므로 팝업 레벨에 절대배치하되, 편집 중인
                    타일 rect 를 측정해 그 '바로 아래'에 띄운다(카드 밑으로). */}
                {tagEditGid &&
                  onSetTags &&
                  genData[tagEditGid] &&
                  tagEditorPos &&
                  (() => {
                    const g = genData[tagEditGid]!;
                    return (
                      <div
                        className="scene-varpop-tageditor"
                        style={{ left: tagEditorPos.left, top: tagEditorPos.top }}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                      >
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
                          onClose={() => setTagEditGid(null)}
                        />
                      </div>
                    );
                  })()}
              </div>
            </div>
          );
        })()}

      {/* 레퍼런스 검사 팝업 — 카드에 담긴 레퍼런스들을 보고, 카드 위 '분리'로 개별 카드로 뺀다(변형팝업과 동일 룩). */}
      {refMenu &&
        (() => {
          const card = cards.find((c) => c.id === refMenu && c.kind === "reference");
          const refs = card?.refs ?? [];
          if (!card || !refs.length) return null;
          return (
            <div
              className="scene-varpop-backdrop"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => setRefMenu(null)}
            >
              <div
                className="scene-varpop-wrap"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="scene-varpop">
                  <div className="scene-varpop-hd">
                    <span>레퍼런스 {refs.length}개 · 카드 위 ‘분리’로 개별 카드로</span>
                    <button className="scene-varpop-x" title="닫기" onClick={() => setRefMenu(null)}>
                      ×
                    </button>
                  </div>
                  <div className="scene-varpop-grid">
                    {refs.map((r, i) => (
                      <div key={i} className="scene-varpop-cell">
                        {refs.length > 1 && (
                          <button
                            className="scene-varpop-rep"
                            title="이 레퍼런스를 개별 카드로 분리"
                            onClick={(e) => {
                              e.stopPropagation();
                              separateRef(card.id, i);
                            }}
                          >
                            ⤴ 분리
                          </button>
                        )}
                        <div className="scene-varpop-item" title={r.name || `레퍼런스 ${i + 1}`}>
                          {(() => {
                            const src = refThumbSrc(r);
                            return src ? (
                              <img src={src} alt="" onError={hideBrokenImg} />
                            ) : (
                              <span className="scene-varpop-ph">?</span>
                            );
                          })()}
                          {r.type === "video" && <span className="scene-varpop-vid">▶</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
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
