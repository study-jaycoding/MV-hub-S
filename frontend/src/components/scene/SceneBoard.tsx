// Canvas 씬 보드 — 계보 탭과 동일한 조작감:
//   · 좌드래그(배경)=마퀴 복수선택 · 미들버튼 드래그=화면이동(팬) · 휠=줌
//   · 카드 좌드래그=이동(선택된 것 함께) · 클릭=단일선택(Ctrl/Shift=토글) · 배경클릭=해제
//   · Delete=선택 삭제(생성물 있으면 휴지통, 빈 카드면 그냥 제거)
// 기능: 에셋 드롭 레퍼런스 카드(S2) · n키 빈 카드+연결선(S3) · 포트 수동 연결/해제(S4).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MutableRefObject } from "react";
import { api } from "../../api";
import { APP_EVENTS, dispatchAppEvent } from "../../lib/appEvents";
import { downloadName, downloadOne } from "../../lib/download";
import { DRAG_TYPES } from "../../lib/dragTypes";
import { toggleDisabledGen } from "../../lib/deactivated";
import { matchShortcut } from "../../lib/shortcuts";
import { KEY_COLORS } from "../../lib/appConstants";
import {
  notifySpotlightAssetsChanged,
  parseSpotlightAssetItems,
  readSpotlightAssetPayload,
  referenceDropTypeFromFile,
  spotlightAssetRefBase,
  type SpotlightAssetDragItem,
} from "../../lib/spotlightAssetRefs";
import {
  sceneRefFingerprint,
  uid,
  variantIds,
  type Scene,
  type SceneCard,
  type SceneCardKind,
  type SceneEdge,
  type SceneEdgeRole,
  type SceneGroup,
  type SceneRef,
} from "../../lib/scenes";
import {
  canConnect,
  classifyEdges,
  collectListInputs,
  collectRenderGenCardIds,
  collectViewGenCardIds,
  collectViewTexts,
  computeBridgeEdges,
  edgePathXY,
  fanOffset,
  resolveEdgeRole,
  resolveInputSourceId,
  resolvePortEdges,
} from "../../lib/sceneEdges";
import { arrangeNodes } from "../../lib/sceneLayout";
import { useSceneGenData } from "../../lib/useSceneGenData";
import { useT } from "../../lib/i18n";
import type { Generation, InfoTarget, PreviewItem, PreviewTarget, Project } from "../../types";
import { HistoryBoardNode } from "../history/HistoryBoardNode";
import { SceneMinimap } from "./SceneMinimap";
import { SceneModelModal } from "./SceneModelModal";
import { ViewTimeline, type TimelineClip } from "./ViewTimeline";
import { ViewSequencePreview } from "./ViewSequencePreview";
import { spotlightParamLabel, spotlightValueLabel } from "../../lib/spotlightPromptConfig";
import { TagEditor } from "../TagEditor";
import { GenerationConfirmOverlay } from "../generation/GenerationConfirmOverlay";
import { MediaThumbnail } from "../MediaThumbnail";
import { displayThumb, hideBrokenImg, thumbOf } from "../../lib/media";
import { BoardSelectionActionBar } from "../app/SelectionActionBar";
import { useClickSeparation } from "../../lib/useClickSeparation";

const CARD_W = 152;
const CARD_H = 130;
// 점 배경 격자 간격(scene.css 의 22px 와 동일). 카드 이동·크기조절이 이 격자에 스냅된다.
const GRID = 22;
// 카드 최소 크기(격자 배수). 너비는 완료 카드 상단 버튼(S/T/C/ⓘ)이 안 잘리게 넉넉히, 높이는 더 낮게 허용.
const CARD_MIN_W = GRID * 5; // 110
const CARD_MIN_H = GRID * 3; // 66
const snapGrid = (v: number) => Math.round(v / GRID) * GRID;
// 그룹 고정 색 팔레트(팝오버 프리셋). 이 외의 색은 '커스텀'(네이티브 컬러픽커)으로 지정.
const GROUP_COLORS = ["#e5484d", "#f5a524", "#e8c341", "#46a758", "#3b9eff", "#8b7bff", "#e93d82", "#8b98a5"];

// 레퍼런스 카드 썸네일 src — 영상 에셋은 thumb 가 '영상 파일 URL'이라 <img> 로는 깨진다.
// asset:proj|path 토큰이면 포스터(assetThumbUrl, 백엔드 첫 프레임)로 바꿔 이미지로 표시한다.
function refThumbSrc(r: SceneRef): string | undefined {
  if (r.type === "audio") return undefined; // 오디오는 썸네일이 없다 → placeholder(415 깨짐 방지)
  // display=캐시 썸네일. 영상은 원본 파일을 넘겨 백엔드가 포스터를 만들고(썸네일이 영상 파일 URL이면
  // <img>로는 깨짐), 이미지는 썸네일 우선. displayThumb 가 asset 토큰·원격 URL 모두 프록시로 통일.
  const raw = r.type === "video" ? r.file_path : r.thumb || r.file_path;
  return displayThumb(raw, 256) ?? undefined;
}

// 레퍼런스 카드 헤더 라벨 — 숫자 대신 어떤 레퍼런스인지(이미지/비디오/오디오)를 표시. 여러 장이면 뒤에 개수.
function refTypeLabel(refs?: SceneRef[]): string {
  if (!refs || !refs.length) return "레퍼런스";
  const t = refs[0].type;
  const label = t === "video" ? "비디오" : t === "audio" ? "오디오" : "이미지";
  return refs.length > 1 ? `${label} ${refs.length}` : label;
}
// 레퍼런스의 재생·미리보기용 실제 파일 URL — 영상 호버재생(src)·더블클릭 큰화면(preview)에 쓴다.
//  · asset:proj|path 토큰 → 원본 파일 URL, 그 외(원격 URL 등)는 그대로.
function refMediaSrc(r: SceneRef): string | undefined {
  const p = r.file_path;
  if (!p) return undefined;
  if (p.startsWith("asset:")) {
    const [proj, path] = p.slice(6).split("|");
    return proj && path ? api.assetFileUrl(proj, path) : undefined;
  }
  return p;
}
// SceneRef.type 을 PreviewTarget 의 좁은 유니온으로 정규화.
function refMediaType(r: SceneRef): "image" | "video" | "audio" {
  return r.type === "video" ? "video" : r.type === "audio" ? "audio" : "image";
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
  // 생성 카드 아래 'Generate' 툴바 — 배치수(App 공유)와 즉시 생성(하단 프롬프트 submit 재사용).
  batchCount?: number;
  onBatchCountChange?: (n: number) => void;
  onGenerateCard?: () => void;
  // 렌더(배치) 노드 — 연결된 생성카드 id들을 넘기면 각 카드가 자기 모델·refs·텍스트로 한 번에 생성된다.
  onRenderCards?: (cardIds: string[]) => void;
  grayOn?: boolean; // 상단 토글 — 켜면 비활성(회색) 카드를 캔버스에서 숨김
  fill?: boolean; // 툴바 fill 토글 — true=꽉채우기(cover), false=전체보기(contain). 결과·레퍼런스 카드에 적용.
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
  batchCount = 1,
  onBatchCountChange,
  onGenerateCard,
  onRenderCards,
  grayOn,
  fill = true,
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
  const t = useT(); // 언어(한/영) — View 노드 헤더 등 라벨 치환. 언어 변경 시 즉시 리렌더.
  const [cards, setCards] = useState<SceneCard[]>(scene.cards);
  const [edges, setEdges] = useState<SceneEdge[]>(scene.edges);
  const [groups, setGroups] = useState<SceneGroup[]>(scene.groups || []);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null); // 이름 편집 중인 그룹
  const [colorPopId, setColorPopId] = useState<string | null>(null); // 색 팔레트 팝오버가 열린 그룹
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [marquee, setMarquee] = useState<{ l: number; t: number; w: number; h: number } | null>(null);
  const [tempWire, setTempWire] = useState<{ fromId: string; x2: number; y2: number } | null>(null);
  // genId→실제 생성물 바인딩·폴링·계보(refParents)·비활성/삭제 상태는 useSceneGenData 훅으로 추출(동작 보존).
  //  각 생성물이 '레퍼런스로 쓴' 부모 gen id(refParents)는 수동 연결선 색(레퍼런스 점선 vs 계보 실선) 판정 근거.
  const { genData, setGenData, genDataRef, missingIds, disabledIds, refParents } = useSceneGenData(cards);
  const [cardMenu, setCardMenu] = useState<string | null>(null); // 변형(결과) 팝업이 열린 카드 id
  const [tagEditCardId, setTagEditCardId] = useState<string | null>(null); // 태그 편집 팝업이 열린 카드 id(같은 생성물이 여러 카드여도 하나만)
  // Tab 노드 피커(Houdini식) — 커서 위치에 New/Model/List/Text 메뉴. sx/sy=보드기준 화면좌표(팝업 배치), cx/cy=새 노드 캔버스좌표.
  const [nodePicker, setNodePicker] = useState<{ sx: number; sy: number; cx: number; cy: number } | null>(null);
  const nodePickerRef = useRef<{ sx: number; sy: number; cx: number; cy: number } | null>(null);
  nodePickerRef.current = nodePicker; // 열림여부(truthy) + 생성 좌표(cx/cy) 둘 다 여기서 참조
  const [modelModalId, setModelModalId] = useState<string | null>(null); // 모델 노드 설정 모달 대상 카드 id
  const [viewTextModal, setViewTextModal] = useState<string[] | null>(null); // View 텍스트 보기 모달 내용
  const [viewTimeline, setViewTimeline] = useState<TimelineClip[] | null>(null); // View 재생 타임라인(연속 재생) 클립들
  const [editTextId, setEditTextId] = useState<string | null>(null); // 편집 중인 텍스트/제목 노드(그 외엔 @토큰 알약 미리보기)
  const editTextIdRef = useRef<string | null>(null);
  editTextIdRef.current = editTextId;
  // 노드 복사·붙여넣기 클립보드(Ctrl+C/V) — 선택 카드 + 그들 사이 엣지 스냅샷.
  const clipboardRef = useRef<{ cards: SceneCard[]; edges: SceneEdge[] } | null>(null);
  // 직전에 레퍼런스로 넣은 클립보드 이미지 지문(크기:타입) — '새 캡쳐'인지 '이미 쓴 캡쳐'인지 구분해
  //  붙여넣기 우선순위(새 이미지=이미지 / 이미 쓴 이미지+복사한 노드=노드)를 최근 동작 기준으로 정한다.
  const lastImgKeyRef = useRef<string | null>(null);
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
  const popupSelRef = useRef(popupSel);
  popupSelRef.current = popupSel;
  // 가위(연결 자르기) — 후디니식: Y 를 누르고 있는 동안만 활성. 좌드래그로 궤적을 그리고 지나간
  // 연결선을 빨갛게 표시(예고)했다가, 마우스를 떼면 그 선들을 실제로 끊는다.
  const [cutHeld, setCutHeld] = useState(false); // Y 키를 누르고 있는 중
  const [cutStroke, setCutStroke] = useState<{ x: number; y: number }[] | null>(null); // 드래그 궤적(캔버스 좌표)
  const [edgesToCut, setEdgesToCut] = useState<Set<string>>(new Set()); // 끊을 예정(빨강) 연결 id
  // 순서변경 드래그 — 삽입 위치 흰 선(화면좌표·fixed) + 잡고 있는 항목(흐리게)
  const [reorderLine, setReorderLine] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [reorderFrom, setReorderFrom] = useState<string | null>(null);
  // 씬 전환 = 선택 해제. 같은 씬이라도 외부(생성 결과 바인딩·프롬프트 순서변경)에서 cards/edges 가
  // 바뀌면 반영하되 선택은 유지 — 카드 드래그 중엔 persist 안 하므로 prop 이 안 바뀌어 방해받지 않는다.
  const sceneIdRef = useRef(scene.id);
  useEffect(() => {
    if (sceneIdRef.current !== scene.id) {
      sceneIdRef.current = scene.id;
      setSelected(new Set());
      undoStackRef.current = []; // 다른 씬으로 넘어가면 되돌리기·다시실행 히스토리도 새로.
      redoStackRef.current = [];
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

  // ── 되돌리기(Ctrl+Z)·다시실행(Ctrl+Shift+Z) 히스토리 ── persist 가 유일한 커밋 지점이라 여기 한 곳에서 쌓는다.
  const undoStackRef = useRef<Array<{ cards: SceneCard[]; edges: SceneEdge[]; groups: SceneGroup[] }>>([]);
  const redoStackRef = useRef<Array<{ cards: SceneCard[]; edges: SceneEdge[]; groups: SceneGroup[] }>>([]);
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
  const [heightTick, bumpHeights] = useState(0);
  // 미니맵(네비게이터)의 뷰포트 박스 갱신 함수 — 팬/줌마다 applyTransform 이 호출(리렌더 없이).
  const mmUpdateRef = useRef<(() => void) | null>(null);

  const applyTransform = useCallback(() => {
    const c = canvasRef.current;
    if (c)
      c.style.transform = `translate(${panRef.current.x}px, ${panRef.current.y}px) scale(${zoomRef.current})`;
    // 점 배경(.scene-board)도 팬/줌에 맞춰 이동·확대 — 배경은 고정 뷰포트에 있어 그대로 두면 확대축소가
    // 안 보인다. 격자 간격(22px)을 배율만큼 키우고 원점 오프셋을 pan 에 맞춰 카드와 함께 움직이게 한다.
    const b = scrollRef.current;
    if (b) {
      const cell = 22 * zoomRef.current;
      b.style.backgroundSize = `${cell}px ${cell}px`;
      b.style.backgroundPosition = `${panRef.current.x}px ${panRef.current.y}px`;
    }
    mmUpdateRef.current?.(); // 팬/줌 반영 즉시 미니맵 뷰포트 박스도 갱신
  }, []);
  useLayoutEffect(applyTransform);

  // 카드 크기(캔버스 좌표). 레퍼런스·Input·Output 은 고정폭·측정높이(내용에 맞춰 컴팩트, 리사이즈 없음),
  // 그 외(생성/텍스트/모델/리스트)는 사용자가 조절한 w/h(없으면 기본 CARD_W/CARD_H).
  const isAutoCard = (c: SceneCard) =>
    c.kind === "reference" || c.kind === "output" || c.kind === "input";
  const widthOf = (c: SceneCard) =>
    c.kind === "reference" ? CARD_W : c.kind === "output" || c.kind === "input" ? 150 : c.w ?? CARD_W;
  const heightOf = (c: SceneCard) =>
    isAutoCard(c) ? heightsRef.current[c.id] || CARD_H : c.h ?? CARD_H;

  // ── f 키 프레이밍 · 미니맵 이동 공용 카메라 유틸 ──
  // 카드 한 장의 바깥 사각형(캔버스 좌표). 레퍼런스는 실제 측정 높이, 생성은 고정.
  const cardRect = (c: SceneCard) => ({
    x: c.x,
    y: c.y,
    w: widthOf(c),
    h: heightOf(c),
  });
  // 주어진 카드 집합이 화면에 꽉 차게(여백 포함) 프레이밍 — 중심 정렬 + 맞춤 줌.
  const frameCards = (list: SceneCard[], maxZoom: number) => {
    const vp = scrollRef.current?.getBoundingClientRect();
    if (!vp || !list.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of list) {
      const r = cardRect(c);
      minX = Math.min(minX, r.x);
      minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.w);
      maxY = Math.max(maxY, r.y + r.h);
    }
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);
    const pad = 0.82; // 가장자리 여백
    let z = Math.min((vp.width * pad) / bw, (vp.height * pad) / bh);
    z = Math.min(maxZoom, Math.max(0.3, z)); // 줌 한계(휠과 동일 하한)
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    zoomRef.current = z;
    panRef.current = { x: vp.width / 2 - cx * z, y: vp.height / 2 - cy * z };
    // 부드럽게 이동 — 잠시 transition 을 걸고 적용 후 해제(이후 팬/줌은 즉시반응 유지).
    const cv = canvasRef.current;
    if (cv) {
      cv.style.transition = "transform 0.25s ease";
      // 배경 점 격자도 같은 시간으로 함께 글라이드(안 그러면 배경만 최종위치로 순간이동해 어긋난다).
      if (scrollRef.current)
        scrollRef.current.style.transition = "background-position 0.25s ease, background-size 0.25s ease";
      window.setTimeout(() => {
        if (canvasRef.current) canvasRef.current.style.transition = "";
        if (scrollRef.current) scrollRef.current.style.transition = "";
      }, 300);
    }
    applyTransform();
    persistCamera();
  };
  // f 키 — 선택 있으면 그 카드(들) 중심, 없으면 전체 카드. 단일 카드는 과확대 방지로 줌 상한을 낮게.
  const frameView = () => {
    const sel = selectedRef.current;
    const list = sel.size
      ? cardsRef.current.filter((c) => sel.has(c.id))
      : cardsRef.current;
    frameCards(list, sel.size ? 1.4 : 1.0);
  };
  // 미니맵의 한 지점(캔버스 좌표)을 화면 중앙으로 — 줌은 그대로. commit=드래그 종료 시 저장.
  const navigateTo = (worldX: number, worldY: number, commit: boolean) => {
    const vp = scrollRef.current?.getBoundingClientRect();
    if (!vp) return;
    const z = zoomRef.current;
    panRef.current = { x: vp.width / 2 - worldX * z, y: vp.height / 2 - worldY * z };
    applyTransform();
    if (commit) persistCamera();
  };

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
    redoStackRef.current = []; // 새 편집이 일어나면 다시실행(redo) 분기는 무효(표준 undo/redo 동작)
    lastCommitRef.current = { cards: nextCards, edges: nextEdges, groups: nextGroups };
    onChangeRef.current({ cards: nextCards, edges: nextEdges, groups: nextGroups });
  };
  // 공통 복원 — 대상 상태로 화면·커밋·부모를 맞춘다(undo/redo 공용).
  const restoreState = (s: { cards: SceneCard[]; edges: SceneEdge[]; groups: SceneGroup[] }) => {
    lastCommitRef.current = s;
    setCards(s.cards);
    setEdges(s.edges);
    setGroups(s.groups);
    setSelected(new Set());
    onChangeRef.current(s); // 부모(씬 저장)에도 반영
  };
  // Ctrl+Z — 직전 커밋으로 복원. 현재 상태는 redo 스택으로 넘겨 Ctrl+Shift+Z 로 되돌릴 수 있게.
  const undo = () => {
    const prev = undoStackRef.current.pop();
    if (!prev) return;
    redoStackRef.current.push(lastCommitRef.current);
    restoreState(prev);
  };
  // Ctrl+Shift+Z — 되돌린 것을 다시 실행. 현재 상태는 undo 스택으로 되돌려 다시 Ctrl+Z 가능하게.
  const redo = () => {
    const next = redoStackRef.current.pop();
    if (!next) return;
    undoStackRef.current.push(lastCommitRef.current);
    restoreState(next);
  };

  // ── 선택된 단일 생성 카드를 하단 프롬프트에 바인딩(App 에 통지) ──
  // 카드 이동(위치 변경)만으론 다시 안 쏘도록 cardId+레퍼런스 지문으로 변화만 감지.
  const onBindingRef = useRef(onBindingChange);
  onBindingRef.current = onBindingChange;
  // 전역 keydown 핸들러([] deps)가 mount 시점 onSetTags 를 붙잡지 않게 미러(향후 undefined→정의 전환 방어).
  const onSetTagsRef = useRef(onSetTags);
  onSetTagsRef.current = onSetTags;
  // onNodePreview(안정 useCallback)가 최신 onPreview 를 참조하게 미러.
  const onPreviewRef = useRef(onPreview);
  onPreviewRef.current = onPreview;
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
  // 미리보기 핸들러 — 카드별로 '안정 참조'를 캐시한다(같은 card.id → 같은 함수). HistoryBoardNode memo 를
  //  안 깨서 드래그·선택 중 전 노드 재렌더를 막고, 동시에 '렌더된 그 카드'(card.id)로 정확히 조회한다
  //  → 같은 gen 이 여러 카드에 있어도(중복 gid) 인라인 때처럼 정확한 카드의 변형 묶음을 방향키로 넘긴다.
  const nodePreviewHandlers = useRef(new Map<string, (target: PreviewTarget) => void>());
  const getNodePreview = (cardId: string) => {
    const cache = nodePreviewHandlers.current;
    let h = cache.get(cardId);
    if (!h) {
      h = (target: PreviewTarget) => {
        const op = onPreviewRef.current;
        if (!op) return;
        const card = cardsRef.current.find((c) => c.id === cardId);
        const items: PreviewItem[] = [];
        if (card) {
          for (const id of variantIds(card)) {
            const av = genDataRef.current[id]?.assets?.[0];
            if (av)
              items.push({
                url: av.file_path,
                type: av.type,
                name: genDataRef.current[id]?.prompt?.slice(0, 50) || "결과",
                genId: id,
              });
          }
        }
        if (items.length > 1) {
          const index = Math.max(0, items.findIndex((it) => it.genId === target.genId));
          op({ ...target, items, index });
        } else op(target);
      };
      cache.set(cardId, h);
    }
    return h;
  };

  // ── S5 토대: 생성 카드는 자신에게 연결된 레퍼런스 카드들의 레퍼런스를 순서대로 모아 보유한다. ──
  // (연결/해제 시에만 재계산 — 이후 프롬프트에서 순서를 바꾸면 card.refs 를 직접 갱신한다)
  // 연결된 레퍼런스/리스트 소스를 "공간 순서(위→아래, 그다음 좌→우)"로 정렬해 모은다 — 직접 연결이든
  // 리스트 경유든 이미지 순서(→ Seedance <<<image1>>>/<<<image2>>> 위치 매핑)가 항상 같게(리스트도 order→y→x 기준).
  const gatherTarget = (genId: string, cs: SceneCard[], es: SceneEdge[]): SceneRef[] => {
    const byId = new Map(cs.map((c) => [c.id, c] as const));
    const resolved = resolvePortEdges(byId, es); // input(무선)으로 연결한 레퍼런스도 실제 소스로 해석
    const srcs = resolved
      .filter((e) => e.to === genId)
      .map((e) => byId.get(e.from))
      .filter((c): c is SceneCard => c?.kind === "reference" || c?.kind === "list")
      .sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x)); // 위→아래, 같은 높이면 좌→우
    const out: SceneRef[] = [];
    // 카드/리스트가 제공한 참조엔 from_card 표시 — 소스 연결이 바뀌면(reconcileRefs) 함께 사라지게.
    const tagged = (refs: SceneRef[]) => refs.map((r) => ({ ...r, from_card: true as const }));
    for (const src of srcs) {
      if (src.kind === "reference" && src.refs) out.push(...tagged(src.refs));
      // 레퍼런스만 모은 리스트를 생성카드에 연결하면 그 안의 레퍼런스 전부를 리스트 순서대로 가져온다.
      else if (src.kind === "list") {
        const li = collectListInputs(src.id, byId, resolved);
        if (li.kind === "reference")
          for (const cid of li.sourceIds) {
            const rc = byId.get(cid);
            if (rc?.refs) out.push(...tagged(rc.refs));
          }
      }
    }
    return out;
  };
  // 기존 refs(프롬프트에서 재정렬됐을 수 있음)의 순서를 보존하며, 새 연결은 뒤에 붙이고 끊긴 건 뺀다.
  // ★@·드래그로 '직접' 넣은 생성물 참조(source_gen_id 있고 from_card 없음)만 엣지와 무관하게 보존한다.
  //   레퍼런스 카드/리스트가 제공한 참조(from_card)는 그 소스가 바뀌면(target 에서 빠지면) 함께 사라진다 —
  //   안 그러면 옛 레퍼런스 카드(비디오 등)를 끊고 다른 걸 연결해도 옛 참조가 유령으로 남아 생성에 섞였다.
  const reconcileRefs = (existing: SceneRef[], target: SceneRef[]): SceneRef[] => {
    const key = (r: SceneRef) => r.file_path + "#" + (r.source_gen_id || "");
    const pool = [...target];
    const result: SceneRef[] = [];
    for (const r of existing) {
      const i = pool.findIndex((t) => key(t) === key(r));
      if (i >= 0) result.push(pool.splice(i, 1)[0]); // 연결된 레퍼런스 카드가 제공하는 참조 — 유지(from_card 포함)
      else if (r.source_gen_id && !r.from_card) result.push(r); // @·드래그로 직접 넣은 생성물 참조만 보존
      // 그 외(연결이 끊긴 레퍼런스 카드/리스트 참조)는 제거
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

  // ── 에셋 드롭/붙여넣기 → 레퍼런스 카드(항상 1장에 1개) ──
  const hasAssetDrag = (dt: DataTransfer) => Array.from(dt.types).includes(DRAG_TYPES.asset);
  const hasFileDrag = (dt: DataTransfer) => Array.from(dt.types).includes("Files");
  const itemToRef = (it: SpotlightAssetDragItem): SceneRef => {
    const b = spotlightAssetRefBase(it);
    return { file_path: b.file_path, type: b.type, name: b.name, thumb: b.thumb };
  };
  // 레퍼런스들을 각각 1장짜리 카드로 만들어 배치 — (cx,cy) 를 중심으로 가로 한 줄, 격자 스냅.
  const addRefCardsAt = (refs: SceneRef[], cx: number, cy: number) => {
    if (!refs.length) return;
    const gap = CARD_W + 20;
    const startX = cx - CARD_W / 2 - ((refs.length - 1) * gap) / 2;
    const created: SceneCard[] = refs.map((r, i) => ({
      id: uid(),
      kind: "reference",
      x: snapGrid(startX + i * gap),
      y: snapGrid(cy - CARD_H / 2),
      refs: [r],
    }));
    const next = [...cardsRef.current, ...created];
    cardsRef.current = next; // 비동기 업로드가 연달아 resolve 돼도 stale 배열에 덮이지 않게 즉시 반영
    setCards(next);
    setSelected(new Set(created.map((c) => c.id)));
    persist(next, edgesRef.current);
  };
  // 외부(다른 앱/OS)에서 드래그·붙여넣기한 파일 → 서버 imports 로 업로드 후 레퍼런스 카드로.
  const importExternalAsRefs = async (files: File[], cx: number, cy: number) => {
    const accepted = files.filter((f) => referenceDropTypeFromFile(f));
    if (!accepted.length) return; // 이미지/영상/오디오만
    try {
      const res = await api.uploadReferenceFiles(accepted);
      const items = res.saved || [];
      if (items.length) {
        addRefCardsAt(items.map(itemToRef), cx, cy);
        notifySpotlightAssetsChanged(items);
      }
    } catch (err) {
      console.warn("[scene] 외부 파일 레퍼런스 추가 실패", err);
    }
  };
  const onDragOver = (e: React.DragEvent) => {
    if (hasAssetDrag(e.dataTransfer) || hasFileDrag(e.dataTransfer)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  };
  const onDrop = (e: React.DragEvent) => {
    // 내부 에셋 드래그 — 여러 개면 각각 1장짜리 카드로.
    if (hasAssetDrag(e.dataTransfer)) {
      e.preventDefault();
      const items = parseSpotlightAssetItems(readSpotlightAssetPayload(e.dataTransfer));
      if (!items.length) return;
      const p = toCanvas(e.clientX, e.clientY);
      addRefCardsAt(items.map(itemToRef), p.x, p.y);
      return;
    }
    // 외부 파일 드래그 → 업로드 후 레퍼런스 카드.
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) {
      e.preventDefault();
      const p = toCanvas(e.clientX, e.clientY);
      void importExternalAsRefs(files, p.x, p.y);
    }
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
      const toCard = cardsRef.current.find((c) => c.id === toId);
      if (!toCard) return;
      // ① 다중 레퍼런스 일괄 연결 — 드래그한 카드가 선택에 포함돼 있으면, 같은 종류(레퍼런스/생성)로
      //    선택된 카드 전부를 한 번에 연결한다. 아니면 그 카드 하나만. 규칙에 맞는 소스만(canConnect).
      const sel = selectedRef.current;
      const srcKind = cardsRef.current.find((c) => c.id === cardId)?.kind;
      const byId = new Map(cardsRef.current.map((c) => [c.id, c] as const));
      const froms = (sel.has(cardId)
        ? [...sel].filter((id) => cardsRef.current.find((c) => c.id === id)?.kind === srcKind)
        : [cardId]
      ).filter((id) => {
        const f = cardsRef.current.find((c) => c.id === id);
        return f && canConnect(f, toCard, byId, edgesRef.current);
      });
      if (froms.length) addEdges(froms.map((f) => [f, toId] as [string, string]));
    };
    beginDrag(move, up);
  };

  // 생성 카드 우하단 핸들 드래그 → 크기 조절(자유 조절, 22px 격자 스냅, 최소 CARD_MIN). 카드 이동과
  // 겹치지 않게 stopPropagation. 손 떼면 저장.
  const onResizeDown = (e: React.MouseEvent, cardId: string) => {
    e.stopPropagation();
    e.preventDefault();
    const c = cardsRef.current.find((cc) => cc.id === cardId);
    if (!c) return;
    const startW = c.w ?? CARD_W;
    const startH = c.h ?? CARD_H;
    const sx = e.clientX;
    const sy = e.clientY;
    const move = (ev: MouseEvent) => {
      const z = zoomRef.current;
      const w = Math.max(CARD_MIN_W, snapGrid(startW + (ev.clientX - sx) / z));
      const h = Math.max(CARD_MIN_H, snapGrid(startH + (ev.clientY - sy) / z));
      setCards((prev) => {
        const cur = prev.find((cc) => cc.id === cardId);
        if (cur && cur.w === w && cur.h === h) return prev; // 스냅값 그대로면 리렌더 스킵
        return prev.map((cc) => (cc.id === cardId ? { ...cc, w, h } : cc));
      });
    };
    const up = () => persist(cardsRef.current, edgesRef.current);
    beginDrag(move, up);
  };

  // ── 노드 생성(Tab 피커·단축키 공용) ─────────────────────────────────────────
  // 마우스 위치(캔버스 위)를 새 노드 좌상단 좌표로. 캔버스 밖이면 화면 중앙 폴백.
  const cursorSpawn = (): { x: number; y: number } => {
    const m = lastMouseRef.current;
    const rect = scrollRef.current?.getBoundingClientRect();
    if (m.over) {
      const p = toCanvas(m.x, m.y);
      return { x: Math.round(p.x - CARD_W / 2), y: Math.round(p.y - CARD_H / 2) };
    }
    if (rect) {
      const c = toCanvas(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return { x: Math.round(c.x - CARD_W / 2), y: Math.round(c.y - CARD_H / 2) };
    }
    return { x: 200, y: 200 };
  };
  // 새 노드 한 개 생성(연결 없음) — text/model/list/generation. 선택 후 저장.
  const createNode = (kind: SceneCardKind, pos?: { x: number; y: number }) => {
    const at = pos ?? cursorSpawn();
    const base = { id: uid(), x: at.x, y: at.y };
    const card: SceneCard =
      kind === "text"
        ? { ...base, kind: "text", text: "" }
        : kind === "model"
          ? { ...base, kind: "model" }
          : kind === "list"
            ? { ...base, kind: "list" }
            : kind === "view"
              ? { ...base, kind: "view" }
              : kind === "output"
                ? { ...base, kind: "output", text: "" }
                : kind === "input"
                  ? { ...base, kind: "input" }
                  : kind === "head"
                    ? { ...base, kind: "head", text: "제목", w: 240, h: 56, color: "#e8c341" }
                    : kind === "render"
                      ? { ...base, kind: "render" }
                      : { ...base, kind: "generation", status: "empty", refs: [], genId: null };
    const nextCards = [...cardsRef.current, card];
    setCards(nextCards);
    setSelected(new Set([card.id]));
    persist(nextCards, edgesRef.current);
  };
  // 'New'(빈 생성 카드) 생성 — 선택된 카드(들)에서 새 카드로 자동 연결(부적합 소스는 제외). 아무것도
  // 선택 안 했으면 단독. pos 있으면 그 위치(피커), 없으면 선택 오른쪽/마우스 위치에.
  const createGenerationConnected = (pos?: { x: number; y: number }) => {
    const srcCards = [...selectedRef.current]
      .map((id) => cardsRef.current.find((c) => c.id === id))
      .filter((c): c is SceneCard => !!c);
    let nx: number;
    let ny: number;
    if (pos) {
      nx = pos.x;
      ny = pos.y;
    } else if (srcCards.length) {
      nx = Math.max(...srcCards.map((c) => c.x + widthOf(c))) + 64;
      ny = Math.round(srcCards.reduce((s, c) => s + c.y, 0) / srcCards.length);
    } else {
      const sp = cursorSpawn();
      nx = sp.x;
      ny = sp.y;
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
    const byId = new Map(cardsRef.current.map((c) => [c.id, c] as const));
    const newEdges: SceneEdge[] = srcCards
      .filter((c) => canConnect(c, empty, byId, edgesRef.current)) // view 등 소스로 부적절한 카드 제외
      .map((c) => ({ id: uid(), from: c.id, to: empty.id }));
    const nextEdges = [...edgesRef.current, ...newEdges];
    const nextCards = withGenRefs([...cardsRef.current, empty], nextEdges);
    setCards(nextCards);
    setEdges(nextEdges);
    setSelected(new Set([empty.id]));
    persist(nextCards, nextEdges);
  };
  // text 노드 내용 편집 저장(디바운스 없이 즉시 — 로컬 저장이라 가벼움). output 노드의 채널 이름도 text 필드 공용.
  const setNodeText = (cardId: string, text: string) => {
    const nextCards = cardsRef.current.map((c) => (c.id === cardId ? { ...c, text } : c));
    setCards(nextCards);
    persist(nextCards, edgesRef.current);
  };
  // head 노드 글씨 색 저장.
  const setNodeColor = (cardId: string, color: string) => {
    const nextCards = cardsRef.current.map((c) => (c.id === cardId ? { ...c, color } : c));
    setCards(nextCards);
    persist(nextCards, edgesRef.current);
  };
  // render 노드: 특정 생성카드의 체크 토글(체크된 카드만 Render 대상). unchecked 목록에 넣고 뺀다.
  const toggleRenderCheck = (renderId: string, genCardId: string) => {
    const nextCards = cardsRef.current.map((c) => {
      if (c.id !== renderId) return c;
      const un = new Set(c.unchecked || []);
      if (un.has(genCardId)) un.delete(genCardId);
      else un.add(genCardId);
      return { ...c, unchecked: [...un] };
    });
    setCards(nextCards);
    persist(nextCards, edgesRef.current);
  };
  // input 노드가 참조할 output(채널) 선택 저장. channel = output 카드 id(빈 문자열이면 미선택).
  // ★채널이 바뀌면 무선으로 끌어오던 레퍼런스가 달라지므로 생성카드 refs 를 다시 계산해야 한다(안 하면 stale).
  const setNodeChannel = (cardId: string, channel: string) => {
    const patched = cardsRef.current.map((c) =>
      c.id === cardId ? { ...c, channel: channel || undefined } : c,
    );
    const nextCards = withGenRefs(patched, edgesRef.current);
    setCards(nextCards);
    persist(nextCards, edgesRef.current);
  };
  // 리스트 노드 썸네일 드래그로 순서 변경 — 들어오는 엣지에 order 를 다시 매겨 collectListInputs 정렬을 바꾼다.
  // 리스트/렌더 항목의 새 순서(order = sourceId 배열)를 엣지 order·refs 멤버십에 반영해 저장.
  const commitListOrder = (listId: string, order: string[]) => {
    const byId = new Map(cardsRef.current.map((c) => [c.id, c] as const));
    const nextEdges = edgesRef.current.map((ed) => {
      if (ed.to !== listId) return ed;
      const idx = order.indexOf(ed.from);
      return idx >= 0 ? { ...ed, order: idx } : ed;
    });
    // 순서 변경 후 refs 멤버십 재계산(추가/제거 정합).
    let nextCards = withGenRefs(cardsRef.current, nextEdges);
    // ★레퍼런스 리스트가 생성카드에 연결돼 있으면 '리스트 순서 우선' — 그 카드 refs 를 리스트(gatherTarget) 순서로 재배열.
    //   (@·드래그로 넣은 참조 source_gen_id 는 뒤에 보존.) 사용자 결정: 연결 뒤 재정렬도 리스트 순서가 이긴다.
    if (collectListInputs(listId, byId, nextEdges).kind === "reference") {
      const genTargets = new Set(
        nextEdges.filter((e) => e.from === listId && byId.get(e.to)?.kind === "generation").map((e) => e.to),
      );
      if (genTargets.size)
        nextCards = nextCards.map((c) => {
          if (c.kind !== "generation" || !genTargets.has(c.id)) return c;
          const ordered = gatherTarget(c.id, cardsRef.current, nextEdges); // 리스트 순서 반영된 레퍼런스들
          const okey = new Set(ordered.map((r) => r.file_path + "#" + (r.source_gen_id || "")));
          const extras = (c.refs || []).filter((r) => !okey.has(r.file_path + "#" + (r.source_gen_id || "")));
          return { ...c, refs: [...ordered, ...extras] };
        });
    }
    setEdges(nextEdges);
    setCards(nextCards);
    persist(nextCards, nextEdges);
  };
  // fromCardId 를 insertIndex(원래 배열 기준 삽입 위치, 0..n) 로 옮긴다. 순서가 그대로면 아무것도 안 함.
  const reorderListToIndex = (listId: string, fromCardId: string, insertIndex: number) => {
    const byId = new Map(cardsRef.current.map((c) => [c.id, c] as const));
    const order = [...collectListInputs(listId, byId, edgesRef.current).sourceIds];
    const fi = order.indexOf(fromCardId);
    if (fi < 0) return;
    let ti = insertIndex;
    order.splice(fi, 1);
    if (ti > fi) ti -= 1; // 제거로 인덱스가 하나 당겨짐
    ti = Math.max(0, Math.min(order.length, ti));
    if (ti === fi) return; // 위치 변화 없음
    order.splice(ti, 0, fromCardId);
    commitListOrder(listId, order);
  };
  // 그립/타일을 마우스로 잡아 순서 변경(HTML5 드래그 대신 — 빠르게 움직여도 안정적). 드래그 중 삽입 위치를
  // 흰 선으로 표시하고, 손 떼는 순간 그 위치로 이동. orientation: "v"=세로 행 리스트, "h"=가로 감싸는 썸네일.
  const startReorder = (
    e: React.MouseEvent,
    listId: string,
    fromId: string,
    orientation: "v" | "h",
  ) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation(); // 카드 이동/마퀴로 번지지 않게
    const container = (e.currentTarget as HTMLElement).closest("[data-reorder]") as HTMLElement | null;
    if (!container) return;
    const GAP = 4; // 삽입선을 항목 사이 틈 가운데쯤에
    let insertIndex = -1;
    const recompute = (cx: number, cy: number) => {
      const items = Array.from(container.querySelectorAll<HTMLElement>("[data-reid]"));
      if (!items.length) return;
      let idx = items.length;
      if (orientation === "v") {
        for (let i = 0; i < items.length; i++) {
          const r = items[i].getBoundingClientRect();
          if (cy < r.top + r.height / 2) { idx = i; break; }
        }
        const line =
          idx < items.length
            ? (() => { const r = items[idx].getBoundingClientRect(); return { x: r.left, y: r.top - GAP, w: r.width, h: 3 }; })()
            : (() => { const r = items[items.length - 1].getBoundingClientRect(); return { x: r.left, y: r.bottom + GAP - 3, w: r.width, h: 3 }; })();
        setReorderLine(line);
      } else {
        // 가로 감싸는 배치 — 중심이 포인터에 가장 가까운 타일 기준, 포인터가 그 중심보다 오른쪽이면 뒤에 삽입.
        let best = 0, bestD = Infinity, after = false;
        for (let i = 0; i < items.length; i++) {
          const r = items[i].getBoundingClientRect();
          const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          const d = Math.hypot(cx - c.x, cy - c.y);
          if (d < bestD) { bestD = d; best = i; after = cx > c.x; }
        }
        idx = after ? best + 1 : best;
        const line =
          idx < items.length
            ? (() => { const r = items[idx].getBoundingClientRect(); return { x: r.left - GAP, y: r.top, w: 3, h: r.height }; })()
            : (() => { const r = items[items.length - 1].getBoundingClientRect(); return { x: r.right + GAP - 3, y: r.top, w: 3, h: r.height }; })();
        setReorderLine(line);
      }
      insertIndex = idx;
    };
    recompute(e.clientX, e.clientY);
    setReorderFrom(fromId);
    const move = (ev: MouseEvent) => recompute(ev.clientX, ev.clientY);
    const up = () => {
      if (insertIndex >= 0) reorderListToIndex(listId, fromId, insertIndex);
      setReorderLine(null);
      setReorderFrom(null);
    };
    beginDrag(move, up);
  };
  // View 에 연결된(직접+generation-list) 생성물을 순서대로 타임라인 클립(url·타입·썸네일)으로 모은다. 재생·미리보기 공용.
  const buildViewClips = (
    viewId: string,
    byId: Map<string, SceneCard>,
    es: SceneEdge[],
  ): TimelineClip[] => {
    const clips: TimelineClip[] = [];
    for (const cid of collectViewGenCardIds(viewId, byId, es)) {
      const card = byId.get(cid);
      const gid = card?.genId || (card ? variantIds(card)[0] : undefined);
      const gen = gid ? genDataRef.current[gid] : undefined;
      const a = gen?.assets?.[0];
      if (a && gid)
        clips.push({
          url: a.file_path,
          type: a.type === "video" ? "video" : "image",
          name: gen?.prompt?.slice(0, 50) || "결과",
          thumb: gen ? thumbOf(gen, 256) : null,
        });
    }
    return clips;
  };
  // View 노드 재생 — 연결된 생성물을 순서대로 이어 타임라인 플레이어로 '연속 재생'.
  const playView = (viewId: string) => {
    const byId = new Map(cardsRef.current.map((c) => [c.id, c] as const));
    const clips = buildViewClips(viewId, byId, resolvePortEdges(byId, edgesRef.current));
    if (clips.length) setViewTimeline(clips);
  };
  // 생성물 리스트 → 연결된 생성물 전부를 레퍼런스로 추가(하단 프롬프트 트레이). 단일 카드 @ 버튼과 동일 경로.
  const addListAsReference = (generationCardIds: string[]) => {
    const byId = new Map(cardsRef.current.map((c) => [c.id, c] as const));
    for (const cid of generationCardIds) {
      const gc = byId.get(cid);
      const gid = gc?.genId || (gc ? variantIds(gc)[0] : undefined);
      if (gid) dispatchAppEvent(APP_EVENTS.addReference, gid);
    }
  };
  // View 열기(더블클릭·버튼 공용) — 생성물이 있으면 재생, 없고 텍스트가 있으면 텍스트 보기.
  const openView = (viewId: string) => {
    const byId = new Map(cardsRef.current.map((c) => [c.id, c] as const));
    const es = resolvePortEdges(byId, edgesRef.current);
    if (collectViewGenCardIds(viewId, byId, es).length) {
      playView(viewId);
      return;
    }
    const texts = collectViewTexts(viewId, byId, es);
    if (texts.length) setViewTextModal(texts);
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

  // ── 그룹(Ctrl+G) — 선택 카드를 하나의 묶음으로. 테두리(rect)는 수동 지정·리사이즈, 멤버십은 드롭 위치로 ──
  const GPAD = 16; // 테두리 여백
  const GHD = 26; // 헤더 높이
  const GCOLLAPSED_W = 200; // 접힌 막대 너비
  // 카드 id 목록의 바운딩박스 → 그룹 테두리 rect(위쪽 헤더 높이 포함). 그룹 생성 시 초기 rect 로 사용.
  const rectFromCards = (ids: string[]) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
    for (const id of ids) {
      const c = cardsRef.current.find((cc) => cc.id === id);
      if (!c) continue;
      n++;
      minX = Math.min(minX, c.x);
      minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x + widthOf(c));
      maxY = Math.max(maxY, c.y + heightOf(c));
    }
    if (!n) return undefined;
    return { x: minX - GPAD, y: minY - GPAD - GHD, w: maxX - minX + GPAD * 2, h: maxY - minY + GPAD * 2 + GHD };
  };
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
    const grp: SceneGroup = { id: uid(), name: `그룹 ${stripped.length + 1}`, cardIds: ids, rect: rectFromCards(ids) };
    applyGroups([...stripped, grp]);
  };
  // × 버튼 = 그룹 해제(멤버 카드는 그대로 두고 묶음만 제거).
  const removeGroup = (id: string) => applyGroups(groupsRef.current.filter((g) => g.id !== id));
  const renameGroup = (id: string, name: string) =>
    applyGroups(groupsRef.current.map((g) => (g.id === id ? { ...g, name } : g)));
  const toggleGroupCollapsed = (id: string) =>
    applyGroups(groupsRef.current.map((g) => (g.id === id ? { ...g, collapsed: !g.collapsed } : g)));
  const setGroupColor = (id: string, color?: string) =>
    applyGroups(groupsRef.current.map((g) => (g.id === id ? { ...g, color: color || undefined } : g)));
  // 카드 드롭 위치로 그룹 멤버십 재배정 — 드롭한 프레임 안이면 그 그룹 가입, 어느 프레임에도 없으면 해제.
  //  · startFrames: 드래그 시작 시점의 그룹 프레임 스냅샷(자동 그룹 프레임이 드래그 중 흔들리지 않게).
  //  · setGroups 로 반영하고, persist 에 넘길 최신 그룹 배열을 반환(변화 없으면 현재 배열 그대로).
  const reassignGroups = (
    targetIds: string[],
    startFrames: { id: string; frame: { x: number; y: number; w: number; h: number } }[],
  ): SceneGroup[] => {
    if (!startFrames.length) return groupsRef.current;
    const cur = cardsRef.current;
    const next = groupsRef.current.map((g) => ({ ...g, cardIds: [...g.cardIds] }));
    let changed = false;
    for (const tid of targetIds) {
      const c = cur.find((cc) => cc.id === tid);
      if (!c) continue;
      const cx = c.x + widthOf(c) / 2;
      const cy = c.y + heightOf(c) / 2;
      let hitId: string | null = null;
      for (const f of startFrames)
        if (cx >= f.frame.x && cx <= f.frame.x + f.frame.w && cy >= f.frame.y && cy <= f.frame.y + f.frame.h)
          hitId = f.id; // 겹치면 뒤에(위에) 그려진 그룹 우선
      const curId = next.find((g) => g.cardIds.includes(tid))?.id ?? null;
      if (hitId === curId) continue; // 같은 그룹이면 변화 없음
      for (const g of next) {
        const i = g.cardIds.indexOf(tid);
        if (i >= 0) g.cardIds.splice(i, 1);
      }
      if (hitId) next.find((g) => g.id === hitId)!.cardIds.push(tid);
      changed = true;
    }
    if (!changed) return groupsRef.current;
    const pruned = next.filter((g) => g.cardIds.length > 0); // 비게 된 그룹 정리
    setGroups(pruned);
    return pruned;
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
    // 삭제된 output(채널)을 가리키던 input 은 channel 을 비운다(무효 참조 방지).
    const survivingCards = cardsRef.current
      .filter((c) => !idset.has(c.id))
      .map((c) =>
        c.kind === "input" && c.channel && idset.has(c.channel) ? { ...c, channel: undefined } : c,
      );
    const nextCards = withGenRefs(survivingCards, nextEdges);
    const nextGroups = pruneGroups(groupsRef.current, idset); // 삭제 카드는 그룹 멤버에서 제거·빈 그룹 정리
    setCards(nextCards);
    setEdges(nextEdges);
    setGroups(nextGroups);
    setSelected(new Set());
    setCardMenu((m) => (m && idset.has(m) ? null : m)); // 삭제된 카드의 팝업은 닫는다
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
  // 명령형 핸들 바인딩은 렌더 중 write(비순수) 대신 커밋 후 useLayoutEffect 에서(refs 라 항상 최신).
  useLayoutEffect(() => {
    if (actionRef) actionRef.current = { deleteSelected: () => deleteCards(selResultCardIds()) };
  });

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
      // 텍스트/제목 노드 편집 중이면(포커스가 새어도) 캔버스 단축키(m/l/t/o/i/h 등)를 무시 — 글자가 노드 생성으로 새지 않게.
      if (editTextIdRef.current && e.key !== "Escape") return;
      if (e.key === "Escape") {
        setColorPopId(null); // 그룹 색 팔레트 열려 있으면 닫기(닫혀 있으면 무해)
        if (nodePickerRef.current) setNodePicker(null); // 노드 피커 닫기(우선)
        else if (cardMenuRef.current) setCardMenu(null); // 팝업 열려 있으면 닫기
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
        } else if (onSetTagsRef.current && matchShortcut(e, "tag")) {
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
      // ── 노드 생성 단축키(N/M/L/T/V/R/O/I/H)는 Tab 피커가 열렸을 때만 작동 — 피커 위치에 만들고 닫는다.
      //    (a=정렬을 비롯한 그 외 단축키는 피커와 무관하게 평소대로.) 피커 없으면 이 키들은 아무것도 안 함.
      const np = nodePickerRef.current;
      if (np && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const NODE_KEYS: Record<string, SceneCardKind> = {
          n: "generation",
          m: "model",
          l: "list",
          t: "text",
          v: "view",
          o: "output",
          i: "input",
          h: "head",
          r: "render",
        };
        const kind = NODE_KEYS[e.key.toLowerCase()];
        if (kind) {
          e.preventDefault();
          const at = { x: np.cx, y: np.cy };
          setNodePicker(null);
          if (kind === "generation") createGenerationConnected(at);
          else createNode(kind, at);
          return;
        }
      }
      // Tab = Houdini식 노드 피커. 마우스가 보드 위에 있고 Shift 없이 누를 때만 — 그 외엔 기본 포커스
      // 이동을 막지 않는다(접근성). 위 모달 가드(cardMenu) 통과 후라 팝업 중엔 안 뜬다.
      if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const m = lastMouseRef.current;
        const rect = scrollRef.current?.getBoundingClientRect();
        if (!m.over || !rect) return; // 보드 위가 아니면 기본 Tab(포커스 이동) 허용
        e.preventDefault();
        const cp = toCanvas(m.x, m.y);
        setNodePicker({
          sx: m.x - rect.left,
          sy: m.y - rect.top,
          cx: Math.round(cp.x - CARD_W / 2),
          cy: Math.round(cp.y - CARD_H / 2),
        });
        return;
      }
      // Ctrl+Z = 되돌리기, Ctrl+Shift+Z = 다시 실행(redo). Alt 조합은 제외.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      // Ctrl+C = 선택 노드 복사(clipboardRef). 붙여넣기는 paste 이벤트에서(텍스트 편집 중이면 위 포커스 가드로 제외).
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "c" || e.key === "C")) {
        const ids = new Set(sel);
        if (!ids.size) return;
        e.preventDefault();
        clipboardRef.current = {
          cards: cardsRef.current.filter((c) => ids.has(c.id)).map((c) => ({ ...c })),
          edges: edgesRef.current
            .filter((ed) => ids.has(ed.from) && ids.has(ed.to))
            .map((ed) => ({ ...ed })),
        };
        return;
      }
      // Ctrl+V(카드 붙여넣기)는 paste 이벤트에서 처리 — 내부 노드 클립보드가 있으면 노드가 우선(없을 때만 캡쳐 이미지).
      // Ctrl+G = 선택 카드 그룹. 해제는 그룹 헤더의 × 버튼으로. (mod+g 라 g=초록색 단축키와 충돌 없음)
      if ((e.ctrlKey || e.metaKey) && (e.key === "g" || e.key === "G")) {
        e.preventDefault(); // 브라우저 '다음 찾기' 방지
        groupSelected();
        return;
      }
      // f = 프레이밍. 선택 카드 있으면 그 카드(들) 중심, 없으면 전체 카드가 다 보이게 맞춤.
      if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        frameView();
        return;
      }
      // c = 자동 연결(모든 노드 종류 공통, canConnect 규칙 적용). 연결 흐름 깊이(레이어):
      //   소스(레퍼런스/모델/텍스트)=0 → 생성=1 → 리스트=2 → View=3.
      //  · 각 카드를 '자기보다 깊고 연결 가능한 가장 가까운 레이어'의 선택 카드들에 모두 연결.
      //    (레퍼런스+생성 → 레퍼런스 전부가 생성으로 / 생성들+리스트 → 생성 전부가 리스트로 / 텍스트+리스트도 동일)
      //  · 생성 카드끼리만 선택하면 왼→오 계보 체인(기존).
      if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "c" || e.key === "C")) {
        const selCards = [...sel]
          .map((id) => cardsRef.current.find((cc) => cc.id === id))
          .filter((c): c is SceneCard => !!c);
        if (selCards.length >= 2) {
          // 소스(레퍼런스/모델/텍스트/input)=0 → 생성=1 → 리스트/렌더(수집기)=2 → View(싱크)=3 → Output(무선 발신)=4.
          //  렌더는 생성물을 모아 View 로 내보내는 수집기라 리스트와 같은 레이어(2) — 생성(1)→렌더(2)→미리보기(3)가 c 로 이어진다.
          const layerOf = (c: SceneCard) =>
            c.kind === "generation"
              ? 1
              : c.kind === "list" || c.kind === "render"
                ? 2
                : c.kind === "view"
                  ? 3
                  : c.kind === "output"
                    ? 4
                    : 0;
          const byId = new Map(cardsRef.current.map((c) => [c.id, c] as const));
          if (selCards.every((c) => c.kind === "generation")) {
            // 생성 카드끼리 — 화면 왼→오 계보 체인.
            e.preventDefault();
            const sorted = [...selCards].sort((a, b) => a.x - b.x);
            const pairs: Array<[string, string]> = [];
            for (let i = 0; i < sorted.length - 1; i++) pairs.push([sorted[i].id, sorted[i + 1].id]);
            if (pairs.length) addEdges(pairs);
            return;
          }
          // 레이어 연결 — s 보다 깊고 연결 가능한 선택 카드 중 '가장 얕은 레이어' 전부에 연결.
          const pairs: Array<[string, string]> = [];
          for (const s of selCards) {
            const cand = selCards.filter(
              (t) => layerOf(t) > layerOf(s) && canConnect(s, t, byId, edgesRef.current),
            );
            if (!cand.length) continue;
            const minLayer = Math.min(...cand.map(layerOf));
            for (const t of cand) if (layerOf(t) === minLayer) pairs.push([s.id, t.id]);
          }
          if (pairs.length) {
            e.preventDefault();
            addEdges(pairs);
            return;
          }
        }
      }
      // a = 선택 노드(2개 이상)를 가지런히 정렬 — 연결 흐름(왼→오른쪽) 기준 열 배치, 열 안은 현재 세로순서 보존.
      if (matchShortcut(e, "boardArrange")) {
        const picked = [...sel]
          .map((id) => cardsRef.current.find((c) => c.id === id))
          .filter((c): c is SceneCard => !!c);
        if (picked.length >= 2) {
          e.preventDefault();
          if (e.repeat) return; // 키 반복 눌림 무시(중복 정렬·undo 오염 방지)
          const layoutNodes = picked.map((c) => ({ id: c.id, x: c.x, y: c.y, w: widthOf(c), h: heightOf(c) }));
          const pos = arrangeNodes(layoutNodes, edgesRef.current);
          // 실제로 위치가 바뀐 카드가 없으면(이미 정렬됨) 저장·undo 생략.
          const changed = picked.some((c) => c.x !== pos[c.id].x || c.y !== pos[c.id].y);
          if (!changed) return;
          const nextCards = cardsRef.current.map((c) =>
            pos[c.id] ? { ...c, x: pos[c.id].x, y: pos[c.id].y } : c,
          );
          setCards(nextCards);
          persist(nextCards, edgesRef.current);
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
      if (onSetTagsRef.current && matchShortcut(e, "tag")) {
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
      if (e.key === "Delete") {
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
      let lastCx = e.clientX;
      let lastCy = e.clientY;
      // 한 지점(화면좌표)에서 겹치는 연결선(넓은 히트 패스 data-edge)을 마킹.
      const hitAt = (cx: number, cy: number) => {
        for (const el of document.elementsFromPoint(cx, cy)) {
          const id = (el as HTMLElement).dataset?.edge;
          if (id) marked.add(id);
        }
      };
      // 이전 점 → 현재 점 사이를 ~8px 간격으로 촘촘히 검사 — 빠르게 움직여 샘플이 듬성해도 지나간 선을 놓치지 않게.
      const sample = (cx: number, cy: number, interpolate: boolean) => {
        if (interpolate) {
          const dist = Math.hypot(cx - lastCx, cy - lastCy);
          const steps = Math.max(1, Math.ceil(dist / 8));
          for (let i = 1; i <= steps; i++)
            hitAt(lastCx + ((cx - lastCx) * i) / steps, lastCy + ((cy - lastCy) * i) / steps);
        } else {
          hitAt(cx, cy);
        }
        lastCx = cx;
        lastCy = cy;
        pts.push(toCanvas(cx, cy));
        setCutStroke([...pts]);
        setEdgesToCut(new Set(marked));
      };
      sample(e.clientX, e.clientY, false);
      const move = (ev: MouseEvent) => sample(ev.clientX, ev.clientY, true);
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
        const gAnchor = origins[memberIds[0]]; // 그룹 이동도 첫 멤버를 격자에 스냅하고 전체를 같은 오프셋으로.
        const gOrigRect = grp.rect; // 수동 rect 가 있으면 멤버와 함께 같은 오프셋으로 이동(멤버십은 유지).
        let gLastRect = gOrigRect; // 최종 rect — up 에서 명시적으로 persist(groupsRef 최신성 레이스 방지)
        const move = (ev: MouseEvent) => {
          if (!gMoved && Math.hypot(ev.clientX - gsx, ev.clientY - gsy) < 4) return;
          gMoved = true;
          const z = zoomRef.current;
          const dx = (ev.clientX - gsx) / z;
          const dy = (ev.clientY - gsy) / z;
          const sdx = gAnchor ? snapGrid(gAnchor.x + dx) - gAnchor.x : dx;
          const sdy = gAnchor ? snapGrid(gAnchor.y + dy) - gAnchor.y : dy;
          setCards((prev) =>
            prev.map((c) => (origins[c.id] ? { ...c, x: origins[c.id].x + sdx, y: origins[c.id].y + sdy } : c)),
          );
          if (gOrigRect) {
            gLastRect = { ...gOrigRect, x: gOrigRect.x + sdx, y: gOrigRect.y + sdy };
            setGroups((prev) => prev.map((x) => (x.id === gid ? { ...x, rect: gLastRect } : x)));
          }
        };
        const up = () => {
          if (gMoved) {
            const ng = gOrigRect
              ? groupsRef.current.map((x) => (x.id === gid ? { ...x, rect: gLastRect } : x))
              : groupsRef.current;
            if (gOrigRect) setGroups(ng);
            persist(cardsRef.current, edgesRef.current, ng);
          } else
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
      const anchor = origins[id]; // 잡은 카드 — 이 카드를 격자에 스냅하고 나머지는 같은 오프셋으로 이동(상대배치 보존).
      // 드래그 시작 시점의 그룹 프레임 스냅샷 — 드롭 위치로 멤버십(가입/해제)을 판정하는 기준.
      const startFrames = groupViews.map((v) => ({ id: v.g.id, frame: v.frame }));
      const move = (ev: MouseEvent) => {
        if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
        moved = true;
        const z = zoomRef.current;
        const dx = (ev.clientX - startX) / z;
        const dy = (ev.clientY - startY) / z;
        // 잡은 카드의 최종 위치를 22px 격자에 스냅 → 그 스냅된 이동량을 전체에 적용.
        const sdx = snapGrid(anchor.x + dx) - anchor.x;
        const sdy = snapGrid(anchor.y + dy) - anchor.y;
        setCards((prev) => {
          const a = prev.find((c) => c.id === id);
          if (a && a.x === anchor.x + sdx && a.y === anchor.y + sdy) return prev; // 스냅 후 위치 그대로면 스킵
          return prev.map((c) =>
            origins[c.id] ? { ...c, x: origins[c.id].x + sdx, y: origins[c.id].y + sdy } : c,
          );
        });
      };
      const up = () => {
        if (moved) {
          const ng = reassignGroups(targetIds, startFrames); // 드롭 위치로 그룹 가입/해제 반영
          persist(cardsRef.current, edgesRef.current, ng);
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
        // 배경을 '그냥 클릭'(드래그 없음·비추가)하면 선택 해제 — 이후 f=전체 프레이밍이 되게.
        if (!moved && !additive) setSelected(new Set());
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
  // 그룹 색 팔레트 — 팝오버 바깥 클릭 시 닫기.
  useEffect(() => {
    if (!colorPopId) return;
    const onDown = (ev: MouseEvent) => {
      if (!(ev.target as HTMLElement)?.closest?.(".scene-group-colorwrap")) setColorPopId(null);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [colorPopId]);
  // 붙여넣기(Ctrl+V) — 편집 요소 포커스면 그쪽이 처리. 아니면 클립보드 이미지(캡쳐)를 레퍼런스 카드로,
  // 이미지가 없고 내부에서 복사(Ctrl+C)한 카드가 있으면 그 카드들을 붙여넣는다(이미지 우선).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable ||
          t.closest?.("input, textarea, [contenteditable=true]"))
      )
        return; // 프롬프트 등 편집 중이면 그쪽 paste 가 처리
      const items = e.clipboardData?.items;
      let blob: File | null = null;
      if (items)
        for (let i = 0; i < items.length; i++) {
          if (items[i].type.startsWith("image/")) {
            blob = items[i].getAsFile();
            break;
          }
        }
      // 같은 Ctrl+V 안에서 '최근 동작' 기준으로 무엇을 붙여넣을지 정한다.
      //  · 방금 새로 '캡쳐한 이미지'(지문이 직전에 넣은 것과 다름)이거나 붙여넣을 노드가 없으면 → 이미지를 레퍼런스로.
      //  · 이미 넣었던 그 캡쳐가 OS 클립보드에 그대로 남아있고 내부에서 복사한 노드가 있으면 → 노드 붙여넣기.
      //  (캡쳐는 앱 밖(OS)에서 일어나 이벤트를 못 받으므로, 이미지 지문 변화로 '새 캡쳐'를 판별한다.)
      const clip = clipboardRef.current;
      const hasNodes = !!clip && clip.cards.length > 0;
      const blobKey = blob ? `${blob.size}:${blob.type}` : null;
      const isNewImage = !!blob && blobKey !== lastImgKeyRef.current;
      // 1) 새 캡쳐 이미지 또는 붙여넣을 노드가 없음 → 클립보드 이미지(캡쳐)를 레퍼런스 카드로.
      if (blob && (isNewImage || !hasNodes)) {
        e.preventDefault();
        lastImgKeyRef.current = blobKey; // 이 캡쳐는 '이미 넣은 것'으로 기록(다음 붙여넣기에서 노드 우선 판단)
        // 위치: 마우스가 보드 위면 그 지점, 아니면 뷰포트 중앙.
        const lm = lastMouseRef.current;
        const r = scrollRef.current?.getBoundingClientRect();
        let cx: number, cy: number;
        if (lm.over) {
          const p = toCanvas(lm.x, lm.y);
          cx = p.x;
          cy = p.y;
        } else if (r) {
          const p = toCanvas(r.left + r.width / 2, r.top + r.height / 2);
          cx = p.x;
          cy = p.y;
        } else return;
        void api
          .uploadCapture(blob)
          .then((rr) =>
            addRefCardsAt(
              [itemToRef({ project: rr.project, path: rr.path, name: rr.name, type: rr.type || "image" })],
              cx,
              cy,
            ),
          )
          .catch((err) => console.warn("[scene] 캡쳐 붙여넣기 실패", err));
        return;
      }
      // 2) 내부에서 복사한 노드 붙여넣기(새 id·격자 2칸 오프셋, 그들 사이 엣지 재매핑).
      if (hasNodes && clip) {
        e.preventDefault();
        const idMap = new Map<string, string>();
        const off = GRID * 2;
        const newCards = clip.cards.map((c) => {
          const nid = uid();
          idMap.set(c.id, nid);
          return { ...c, id: nid, x: c.x + off, y: c.y + off };
        });
        // input 채널(output id)도 재매핑 — output 을 함께 복사했으면 붙여넣은 output 을 가리키게(아니면 원본 유지).
        for (const c of newCards)
          if (c.kind === "input" && c.channel && idMap.has(c.channel)) c.channel = idMap.get(c.channel);
        const newEdges: SceneEdge[] = clip.edges.map((ed) => ({
          ...ed,
          id: uid(),
          from: idMap.get(ed.from)!,
          to: idMap.get(ed.to)!,
        }));
        const nextEdges = [...edgesRef.current, ...newEdges];
        const nextCards = withGenRefs([...cardsRef.current, ...newCards], nextEdges);
        cardsRef.current = nextCards;
        edgesRef.current = nextEdges;
        setCards(nextCards);
        setEdges(nextEdges);
        setSelected(new Set(newCards.map((c) => c.id)));
        persist(nextCards, nextEdges);
        return;
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 엣지 계산·렌더에서 카드를 id 로 매우 자주 조회한다(E×C). 선형 find 대신 Map(O(1))로 —
  // cards 가 바뀔 때만(드래그 등) 1회 재구성. 드래그 중 렌더 비용을 크게 줄인다.
  const cardsById = useMemo(() => new Map(cards.map((c) => [c.id, c] as const)), [cards]);
  const cardById = (id: string) => cardsById.get(id);

  // ── 미니맵(네비게이터)용 박스·바운즈 — 카드가 바뀔 때만 재계산 ──
  const mmBoxes = useMemo(
    () =>
      cards.map((c) => ({
        id: c.id,
        x: c.x,
        y: c.y,
        w: widthOf(c),
        h: heightOf(c),
        kind: c.kind,
      })),
    // heightTick: 레퍼런스 카드 높이 측정 후에도 bounds 가 정확하게 갱신되도록.
    [cards, heightTick],
  );
  const mmBounds = useMemo(() => {
    if (!mmBoxes.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of mmBoxes) {
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w);
      maxY = Math.max(maxY, b.y + b.h);
    }
    return { minX, minY, maxX, maxY };
  }, [mmBoxes]);
  // ★그래프 파생값 memo — 셀렉션/마퀴 드래그(selected·marquee 만 변경) 중엔 cards/edges/groups 가
  //  안 바뀌므로 아래 Set/Map·분류·정렬을 매 프레임 재계산하지 않는다(드래그 렌더 비용 절감).
  // grayOn: 비활성(회색) 카드 숨김 — 그 카드와 연결선을 렌더에서 제외(상태는 유지).
  const grayHidden = useMemo(
    () =>
      new Set(
        grayOn
          ? cards
              .filter((c) => c.kind === "generation" && c.genId && disabledIds.has(c.genId))
              .map((c) => c.id)
          : [],
      ),
    [grayOn, cards, disabledIds],
  );
  // 접힌 그룹의 멤버 카드 → 그 그룹. 접히면 멤버를 숨기고 연결은 그룹 막대로 브릿지한다.
  const collapsedMemberOf = useMemo(() => {
    const m = new Map<string, SceneGroup>();
    for (const g of groups)
      if (g.collapsed && g.cardIds.length) for (const id of g.cardIds) m.set(id, g);
    return m;
  }, [groups]);
  const hiddenIds = useMemo(
    () => new Set<string>([...grayHidden, ...collapsedMemberOf.keys()]),
    [grayHidden, collapsedMemberOf],
  );
  const visibleCards = useMemo(
    () => (hiddenIds.size ? cards.filter((c) => !hiddenIds.has(c.id)) : cards),
    [cards, hiddenIds],
  );
  // 숨긴(회색) 카드가 중간에 있어도 앞뒤 흐름이 끊긴 것처럼 보이지 않게 — 숨김 노드를 건너뛰어
  // 보이는 '앞 카드 → 뒤 카드'로 회색 점선 우회선을 만든다(중간에 뭔가 숨겨져 있다는 표시).
  const bridgeEdges = useMemo(
    () => computeBridgeEdges(cards, edges, grayHidden),
    [cards, edges, grayHidden],
  );

  // ── 그룹 기하 — 테두리는 저장된 rect 우선, 없으면 멤버 바운딩박스로 자동(하위호환). 접힘=제목 막대 ──
  const memberBounds = (g: SceneGroup) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let n = 0;
    for (const id of g.cardIds) {
      const c = cardById(id);
      if (!c) continue;
      n++;
      minX = Math.min(minX, c.x);
      minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x + widthOf(c));
      maxY = Math.max(maxY, c.y + heightOf(c));
    }
    return n ? { minX, minY, maxX, maxY } : null;
  };
  // 그룹 프레임: 저장된 rect 우선, 없으면 멤버 바운딩박스+여백. 둘 다 못 구하면 null(렌더 제외).
  const frameOf = (g: SceneGroup) => {
    if (g.rect) return g.rect;
    const b = memberBounds(g);
    if (!b) return null;
    return {
      x: b.minX - GPAD,
      y: b.minY - GPAD - GHD,
      w: b.maxX - b.minX + GPAD * 2,
      h: b.maxY - b.minY + GPAD * 2 + GHD,
    };
  };
  // 각 그룹의 프레임(펼침)·막대(접힘) 사각형. 접힘 막대는 프레임 좌상단에 고정폭으로.
  const groupViews = groups
    .map((g) => {
      const frame = frameOf(g);
      if (!frame) return null;
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
    return c ? { x: c.x + widthOf(c), y: c.y + heightOf(c) / 2 } : null;
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
    const x1 = from.x + widthOf(from);
    const y1 = from.y + heightOf(from) / 2;
    const x2 = to.x;
    const y2 = to.y + heightOf(to) / 2;
    const mx = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
  };
  // 수집·분류에 넘길 '해석된 엣지' — input(무선) 소스를 실제 소스로 치환. 그리기(선 좌표)는 원본 edges 사용.
  //  ★엣지 id 는 보존되므로(from 만 치환) refCardEdgeIds/genRefEdgeIds 의 e.id 판정이 원본 렌더와 그대로 맞물린다.
  const resolvedEdges = useMemo(() => resolvePortEdges(cardsById, edges), [cardsById, edges]);
  // 연결 종류 판정 — 카드 종류가 아니라 실제 데이터 기준. input 은 해석된 실제 소스로 판정(레퍼런스 무선연결도 파란점선).
  //  · refCardEdgeIds: 레퍼런스 카드 → 생성(파란 점선)
  //  · genRefEdgeIds : 생성물을 레퍼런스로 사용 → 초록 점선. 두 근거를 OR:
  //      (1) 씬 로컬 refs 에 소스의 source_gen_id 가 들어있거나(@·드래그로 넣은 경우),
  //      (2) 백엔드 history: 타깃이 소스를 레퍼런스 부모(materials)로 실제 사용(수동 연결도 잡힘).
  //  · 그 외 생성→생성은 '단순 계보 연결'(초록 실선).
  const { refCardEdgeIds, genRefEdgeIds } = useMemo(
    () => classifyEdges(resolvedEdges, cardsById, refParents),
    [resolvedEdges, cardsById, refParents],
  );
  // 한 포트에 연결이 여러 개면 세로로 펼쳐(fan-out) 끝점이 겹치지 않게 — 선마다 자기 색 점을 갖게 한다.
  // (연결이 1개면 오프셋 0 → 포트 정중앙. 흔한 경우는 그대로.)
  // ★실제로 렌더되는(보이는·유효한) 연결만으로 계산 — 숨긴 형제 연결이 보이는 단일선을 밀지 않게.
  const visibleEdges = useMemo(
    () =>
      edges.filter(
        (e) =>
          !hiddenIds.has(e.from) &&
          !hiddenIds.has(e.to) &&
          cardsById.has(e.from) &&
          cardsById.has(e.to),
      ),
    [edges, hiddenIds, cardsById],
  );
  // 팬아웃 정렬 맵 — 상대 카드 y 순(교차 최소화). 카드 이동(y 변경) 시 cardsById 갱신으로 재정렬된다.
  const { outEdges, inEdges } = useMemo(() => {
    const out = new Map<string, SceneEdge[]>();
    const inn = new Map<string, SceneEdge[]>();
    for (const e of visibleEdges) {
      const o = out.get(e.from);
      if (o) o.push(e);
      else out.set(e.from, [e]);
      const i = inn.get(e.to);
      if (i) i.push(e);
      else inn.set(e.to, [e]);
    }
    const yOf = (id: string) => cardsById.get(id)?.y ?? 0;
    for (const [, list] of out) list.sort((p, q) => yOf(p.to) - yOf(q.to));
    for (const [toId, list] of inn) {
      // 리스트 타깃은 항목 순서(edge.order, 없으면 y)로 fan-in 정렬 — 리스트 안에서 순서를 바꾸면
      // 들어오는 연결선 순서도 그에 맞춰 바뀐다. 그 외 타깃은 소스 y 순.
      if (cardsById.get(toId)?.kind === "list")
        list.sort((p, q) => {
          const po = p.order;
          const qo = q.order;
          if (po != null && qo != null && po !== qo) return po - qo;
          if (po != null && qo == null) return -1;
          if (po == null && qo != null) return 1;
          return yOf(p.from) - yOf(q.from);
        });
      else list.sort((p, q) => yOf(p.from) - yOf(q.from));
    }
    return { outEdges: out, inEdges: inn };
  }, [visibleEdges, cardsById]);
  const FAN = 13;
  const PORT_GAP = 24; // 연결 끝점(선 끝·점)을 카드 밖으로 이만큼 띄운다 — 끝점(바깥)과 클릭 포트(안쪽,≈12px) 간격을 카드↔포트 간격과 고르게.
  // 엣지 역할(model/ref/text/lineage/list) — 색·생성카드 입력 레인 결정. edge.role 우선, 없으면 추론.
  const edgeRoles = useMemo(() => {
    const m = new Map<string, SceneEdgeRole>();
    for (const e of edges) m.set(e.id, resolveEdgeRole(e, cardsById, refParents, edges));
    return m;
  }, [edges, cardsById, refParents]);
  // 물리 레인 — model/text 는 각자, ref·lineage 는 같은 중앙 레인('ref')으로 묶는다(같은 y라 fan 을 합쳐야
  // 겹치지 않는다). laneFrac 은 이 물리 레인 기준 y 비율(위=모델·중간=ref/계보·아래=텍스트).
  const laneOf = (role: SceneEdgeRole): "model" | "ref" | "text" =>
    role === "model" ? "model" : role === "text" ? "text" : "ref";
  const laneFrac = (lane: "model" | "ref" | "text") =>
    lane === "model" ? 0.28 : lane === "text" ? 0.72 : 0.5;
  // 생성카드로 들어오는 연결의 fan-in 을 (타깃+물리레인) 단위로 — 같은 레인끼리만 세로로 펼쳐 겹침 방지.
  const inEdgesLaned = useMemo(() => {
    const m = new Map<string, SceneEdge[]>();
    for (const e of visibleEdges) {
      if (cardsById.get(e.to)?.kind !== "generation") continue;
      const key = e.to + ":" + laneOf(edgeRoles.get(e.id) || "ref");
      const arr = m.get(key);
      if (arr) arr.push(e);
      else m.set(key, [e]);
    }
    const yOf = (id: string) => cardsById.get(id)?.y ?? 0;
    for (const [, list] of m) list.sort((p, q) => yOf(p.from) - yOf(q.from));
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleEdges, cardsById, edgeRoles]);
  const edgeEnds = (e: SceneEdge, a: SceneCard, b: SceneCard) => {
    const lane = laneOf(edgeRoles.get(e.id) || "ref");
    // 타깃이 생성카드면 물리 레인 y + 그 레인 내 fan, 아니면 중앙 + 타깃 전체 fan.
    const gen = b.kind === "generation";
    const y2base = b.y + heightOf(b) * (gen ? laneFrac(lane) : 0.5);
    const fanList = gen ? inEdgesLaned.get(b.id + ":" + lane) : inEdges.get(b.id);
    return {
      x1: a.x + widthOf(a) + PORT_GAP, // 출력 포트(카드 오른쪽 밖)
      y1: a.y + heightOf(a) / 2 + fanOffset(outEdges.get(a.id), e.id, FAN),
      x2: b.x - PORT_GAP, // 입력 포트(카드 왼쪽 밖)
      y2: y2base + fanOffset(fanList, e.id, FAN),
    };
  };

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
        return [
          { id: e.id, from: e.from, to: e.to, a, b, role: edgeRoles.get(e.id), ref: refCardEdgeIds.has(e.id), refg: genRefEdgeIds.has(e.id) },
        ];
      })
    : [];

  return (
    <div
      className={"scene-board" + (cutHeld ? " cutting" : "") + (tempWire ? " wiring" : "")}
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
          const gstyle: CSSProperties = { left: box.x, top: box.y, width: box.w, height: box.h };
          if (g.color) (gstyle as Record<string, string | number>)["--gc"] = g.color;
          if (colorPopId === g.id) {
            gstyle.zIndex = 60; // 팔레트 열리면 카드 위로 올려 가려지지 않게
            gstyle.overflow = "visible"; // 접힌 그룹의 overflow:hidden 이 팝오버를 자르지 않게
          }
          return (
            <div
              key={g.id}
              className={"scene-group" + (collapsed ? " collapsed" : "")}
              style={gstyle}
            >
              <div
                className="scene-group-hd scene-group-grab"
                data-group-id={g.id}
                title="끌어서 그룹 이동 · 더블클릭=이름 변경"
              >
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
                <button
                  className="scene-group-btn"
                  title={collapsed ? "펼치기" : "접기"}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleGroupCollapsed(g.id);
                  }}
                >
                  {collapsed ? "+" : "−"}
                </button>
                <div className="scene-group-colorwrap" onMouseDown={(e) => e.stopPropagation()}>
                  <button
                    className="scene-group-color"
                    title="그룹 색"
                    style={{ background: g.color || "var(--border2)" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setColorPopId((p) => (p === g.id ? null : g.id));
                    }}
                  />
                  {colorPopId === g.id && (
                    <div className="scene-group-colorpop">
                      {GROUP_COLORS.map((c) => (
                        <button
                          key={c}
                          className={"scene-group-swatch" + (g.color === c ? " on" : "")}
                          style={{ background: c }}
                          title={c}
                          onClick={(e) => {
                            e.stopPropagation();
                            setGroupColor(g.id, c);
                            setColorPopId(null);
                          }}
                        />
                      ))}
                      <label className="scene-group-swatch custom" title="커스텀 색">
                        <input
                          type="color"
                          value={g.color || "#5a6270"}
                          onChange={(e) => setGroupColor(g.id, e.target.value)}
                        />
                      </label>
                      <button
                        className="scene-group-swatch none"
                        title="색 없음"
                        onClick={(e) => {
                          e.stopPropagation();
                          setGroupColor(g.id, undefined);
                          setColorPopId(null);
                        }}
                      >
                        ×
                      </button>
                    </div>
                  )}
                </div>
                <button
                  className="scene-group-x"
                  title="그룹 해제(카드는 유지)"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeGroup(g.id);
                  }}
                >
                  ×
                </button>
              </div>
              {!collapsed && (
                <div
                  className="scene-group-resize"
                  title="크기 조절"
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    const rect0 = g.rect ?? frame; // 자동 그룹이면 현재 프레임을 초기 rect 로 고정
                    const sx = e.clientX;
                    const sy = e.clientY;
                    let last = rect0; // 최종 rect — up 에서 명시적으로 persist(groupsRef 최신성 레이스 방지)
                    const mv = (ev: MouseEvent) => {
                      const z = zoomRef.current;
                      const w = Math.max(140, rect0.w + (ev.clientX - sx) / z);
                      const h = Math.max(GHD + 48, rect0.h + (ev.clientY - sy) / z);
                      last = { x: rect0.x, y: rect0.y, w, h };
                      setGroups((prev) => prev.map((x) => (x.id === g.id ? { ...x, rect: last } : x)));
                    };
                    const upr = () => {
                      const rect = last;
                      // 늘린 rect 안에 중심이 든 카드를 이 그룹에 포함(다른 그룹에 있던 카드는 옮겨옴=한 카드 한 그룹).
                      // 기존 멤버는 rect 밖이어도 유지 — '줄여서 제외'는 안 함(제외는 노드를 밖으로 드래그).
                      const contained = new Set(
                        cardsRef.current
                          .filter((c) => {
                            const cx = c.x + widthOf(c) / 2;
                            const cy = c.y + heightOf(c) / 2;
                            return cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h;
                          })
                          .map((c) => c.id),
                      );
                      const ng = groupsRef.current
                        .map((x) => {
                          if (x.id === g.id) {
                            const keep = x.cardIds.filter((id) => cardsRef.current.some((c) => c.id === id));
                            return { ...x, rect, cardIds: Array.from(new Set([...keep, ...contained])) };
                          }
                          return { ...x, cardIds: x.cardIds.filter((id) => !contained.has(id)) };
                        })
                        .filter((x) => x.id === g.id || x.cardIds.length > 0); // 비게 된 다른 그룹만 정리
                      setGroups(ng);
                      persist(cardsRef.current, edgesRef.current, ng);
                    };
                    beginDrag(mv, upr);
                  }}
                />
              )}
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
            const role = edgeRoles.get(e.id);
            // ★기본은 회색(idle). 선택한 카드에 닿은 선만 종류색으로 활성화(모델=주황·텍스트=보라·레퍼런스=파란점선 등).
            const active = selected.has(e.from) || selected.has(e.to);
            const cls =
              "scene-edge" +
              (active
                ? (role === "model"
                    ? " model"
                    : role === "text"
                      ? " text"
                      : refCardEdgeIds.has(e.id)
                        ? " ref"
                        : genRefEdgeIds.has(e.id)
                          ? " refg"
                          : role === "ref" // 레퍼런스 리스트 출력 등 classifyEdges 밖의 ref = 파란점선
                            ? " ref"
                            : "") + " onsel"
                : " idle") +
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
            const active = selected.has(gb.from) || selected.has(gb.to);
            const cls =
              "scene-edge" +
              (active
                ? (gb.role === "model"
                    ? " model"
                    : gb.role === "text"
                      ? " text"
                      : gb.ref
                        ? " ref"
                        : gb.refg
                          ? " refg"
                          : gb.role === "ref"
                            ? " ref"
                            : "") + " onsel"
                : " idle") +
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
              const x1 = a.x + widthOf(a) + PORT_GAP; // 출력 포트 위치(카드 밖)에서 시작
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
          const autoH = isAutoCard(card); // 레퍼런스·Input·Output = 내용에 맞춘 자동 높이(고정 height 미지정)
          const isGen = card.kind === "generation";
          const g = isGen && card.genId ? genData[card.genId] : null; // 바인딩된 실제 생성물
          const showNode = !!g && String(g.status) === "done"; // 완료 → 히스토리 카드로 표시
          const kindCls =
            card.kind === "reference"
              ? "scene-card-ref"
              : card.kind === "generation"
                ? "scene-card-gen"
                : "scene-card-" + card.kind; // text/model/list
          return (
            <div
              key={card.id}
              ref={(el) => {
                cardEls.current[card.id] = el;
              }}
              className={
                "scene-card " +
                kindCls +
                (sel ? " sel" : "") +
                (showNode ? " has-node" : "") // 완료 결과가 있으면 히스토리 노드가 카드 뼈대를 대체
              }
              data-id={card.id}
              style={{ left: card.x, top: card.y, width: widthOf(card), ...(autoH ? {} : { height: heightOf(card) }) }}
              // View=재생, 모델=모달. 레퍼런스는 각 썸네일 더블클릭으로 큰화면(아래). 생성 카드는 각자 처리.
              onDoubleClick={
                card.kind === "view"
                  ? () => openView(card.id)
                  : card.kind === "model"
                    ? () => setModelModalId(card.id)
                    : undefined
              }
            >
              {isRef ? (
                <>
                  {/* 내부 래퍼만 클리핑(둥근 모서리) — 포트는 이 밖이라 잡기 영역이 안 잘린다 */}
                  <div className="scene-card-inner">
                    <div className="scene-card-hd">{refTypeLabel(card.refs)}</div>
                    <div
                      className={
                        "scene-card-body" +
                        ((card.refs?.length ?? 0) <= 1 ? " single" : "") +
                        (fill ? "" : " fit-contain")
                      }
                    >
                      {(card.refs || []).map((r, i) => {
                        const isVid = refMediaType(r) === "video";
                        return (
                          <div
                            className="scene-refthumb"
                            key={i}
                            title={r.name || `레퍼런스 ${i + 1} · 더블클릭=큰 화면`}
                            onMouseEnter={
                              isVid
                                ? (e) => {
                                    const v = e.currentTarget.querySelector("video");
                                    if (v) {
                                      v.muted = true; // React <video muted> 반영 버그 → 재생 직전 무음 강제
                                      v.play().catch(() => {});
                                    }
                                  }
                                : undefined
                            }
                            onMouseLeave={
                              isVid
                                ? (e) => {
                                    const v = e.currentTarget.querySelector("video");
                                    if (v) {
                                      v.pause();
                                      v.currentTime = 0;
                                    }
                                  }
                                : undefined
                            }
                            onDoubleClick={(e) => {
                              e.stopPropagation();
                              const url = refMediaSrc(r);
                              if (url) onPreview?.({ url, type: refMediaType(r), name: r.name || "레퍼런스" });
                            }}
                          >
                            <MediaThumbnail
                              thumb={refThumbSrc(r)}
                              isVideo={isVid}
                              src={refMediaSrc(r)}
                              fallback={<span className="scene-refthumb-ph" />}
                            />
                            {isVid ? (
                              <span className="scene-refthumb-vid vid">▶</span>
                            ) : refMediaType(r) === "audio" ? (
                              <span className="scene-refthumb-vid aud">♪</span>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <span
                    className="scene-port out"
                    onMouseDown={(e) => onOutPortDown(e, card.id)}
                    title="드래그해 생성 카드에 연결"
                  />
                </>
              ) : card.kind === "text" ? (
                (() => {
                  // 연결된 레퍼런스(레퍼런스 카드 refs + 생성물)를 순서대로 @image1/@video1... 에 매핑. input 은 실제 소스로 해석.
                  const refSrcs = resolvedEdges
                    .filter((e) => e.to === card.id)
                    .map((e) => cardsById.get(e.from))
                    .filter((c): c is SceneCard => !!c)
                    .sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x));
                  const counters: Record<string, number> = {};
                  const thumbByLabel = new Map<string, string | undefined>();
                  const addRef = (type: string | undefined, thumb?: string) => {
                    const t = type === "video" ? "video" : type === "audio" ? "audio" : "image";
                    counters[t] = (counters[t] || 0) + 1;
                    thumbByLabel.set(`@${t}${counters[t]}`, thumb);
                  };
                  const addGenRef = (gc?: SceneCard) => {
                    const gid = gc?.genId || (gc ? variantIds(gc)[0] : undefined);
                    const gen = gid ? genData[gid] : undefined;
                    addRef(gen?.assets?.[0]?.type, gen ? thumbOf(gen, 128) || undefined : undefined);
                  };
                  for (const s of refSrcs) {
                    if (s.kind === "reference")
                      (s.refs || []).forEach((r) => addRef(r.type, refThumbSrc(r)));
                    else if (s.kind === "generation") addGenRef(s);
                    else if (s.kind === "list") {
                      // 리스트로 묶은 레퍼런스/생성물을 순서대로 펼쳐 @image1/@image2… 로 매핑.
                      const li = collectListInputs(s.id, cardsById, resolvedEdges);
                      if (li.kind === "reference")
                        for (const cid of li.sourceIds)
                          (cardsById.get(cid)?.refs || []).forEach((r) => addRef(r.type, refThumbSrc(r)));
                      else if (li.kind === "generation")
                        for (const cid of li.generationCardIds) addGenRef(cardsById.get(cid));
                    }
                  }
                  // 텍스트를 @토큰 기준으로 쪼개, 토큰은 인라인 알약(썸네일)으로, 나머지는 그대로.
                  const renderInline = (text: string) => {
                    const re = /@(?:image|video|audio)\d+/gi;
                    const out: React.ReactNode[] = [];
                    let last = 0;
                    let m: RegExpExecArray | null;
                    let k = 0;
                    while ((m = re.exec(text))) {
                      if (m.index > last) out.push(text.slice(last, m.index));
                      const label = m[0];
                      const key = label.toLowerCase();
                      if (thumbByLabel.has(key)) {
                        // 연결된 레퍼런스가 있는 토큰만 알약(썸네일). 없으면 그냥 텍스트로 둔다.
                        const thumb = thumbByLabel.get(key);
                        out.push(
                          <span className="scene-inlinetok" key={`t${k++}`} title={label}>
                            {thumb ? (
                              <img src={thumb} alt="" draggable={false} onError={hideBrokenImg} />
                            ) : (
                              <span className="scene-inlinetok-ph" />
                            )}
                            {label}
                          </span>,
                        );
                      } else {
                        out.push(label); // 연결 안 됨 → 그냥 @image1 텍스트
                      }
                      last = m.index + m[0].length;
                    }
                    if (last < text.length) out.push(text.slice(last));
                    return out;
                  };
                  const editing = editTextId === card.id;
                  return (
                    <>
                      {/* 본문(보기=@토큰 인라인 알약, 더블클릭 시 편집 textarea). 단일 클릭/드래그는 카드 이동 —
                          보기 상태에선 카드 어디를 잡아도 이동돼 조작성이 좋다(편집 진입은 더블클릭). */}
                      <div className="scene-card-hd text scene-card-hd-float">텍스트</div>
                      <div className="scene-card-inner">
                        {editing ? (
                          <textarea
                            className="scene-textnode"
                            value={card.text || ""}
                            placeholder="텍스트 입력..."
                            spellCheck={false}
                            autoFocus
                            onMouseDown={(e) => e.stopPropagation()}
                            onBlur={() => setEditTextId(null)}
                            onChange={(e) => setNodeText(card.id, e.target.value)}
                          />
                        ) : (
                          <div
                            className="scene-textview-inline"
                            onDoubleClick={(e) => {
                              e.stopPropagation();
                              setSelected(new Set([card.id]));
                              setEditTextId(card.id); // 더블클릭하면 편집으로 전환(단일 클릭/드래그는 카드 이동)
                            }}
                          >
                            {card.text ? (
                              renderInline(card.text)
                            ) : (
                              <span className="scene-textnode-ph2">텍스트 입력...</span>
                            )}
                          </div>
                        )}
                      </div>
                      <button
                        className="scene-copy-btn"
                        title="텍스트 전체 복사"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          void navigator.clipboard?.writeText(card.text || "");
                        }}
                      >
                        ⧉
                      </button>
                      <span className="scene-port in" title="레퍼런스 연결(레퍼런스 카드·생성물)" />
                      <span
                        className="scene-port out"
                        onMouseDown={(e) => onOutPortDown(e, card.id)}
                        title="드래그해 생성 카드 텍스트 입력에 연결(보라)"
                      />
                      <span
                        className="scene-resize"
                        onMouseDown={(e) => onResizeDown(e, card.id)}
                        title="드래그해 크기 조절"
                      />
                    </>
                  );
                })()
              ) : card.kind === "model" ? (
                <>
                  {/* 모델 노드 — 설정한 모델 정보 표시. (더블클릭 모델피커는 후속 단계) */}
                  <div className="scene-card-hd model scene-card-hd-float">모델</div>
                  <div className="scene-card-inner scene-modelnode">
                    {card.modelCfg?.model ? (
                      <div className="scene-modelnode-body">
                        {/* 상단 중앙 = 모델명·타입, 아래 = 설정한 옵션 전부(라벨: 값) */}
                        <div className="scene-modelnode-head">
                          <div className="scene-modelnode-name">
                            {card.modelCfg.modelName || card.modelCfg.model}
                          </div>
                          {card.modelCfg.type && (
                            <div className="scene-modelnode-type">{card.modelCfg.type}</div>
                          )}
                        </div>
                        {card.modelCfg.params && Object.keys(card.modelCfg.params).length > 0 && (
                          <div className="scene-modelnode-params">
                            {Object.entries(card.modelCfg.params).map(([k, v]) => (
                              <div key={k} className="scene-modelnode-param">
                                <span className="k">{spotlightParamLabel(k)}</span>
                                <span className="v">{spotlightValueLabel(String(v))}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="scene-modelnode-body">
                        <div className="scene-modelnode-empty">더블클릭해 모델 설정</div>
                      </div>
                    )}
                  </div>
                  <span
                    className="scene-port out"
                    onMouseDown={(e) => onOutPortDown(e, card.id)}
                    title="드래그해 생성 카드 모델 입력에 연결(주황)"
                  />
                  <span
                    className="scene-resize"
                    onMouseDown={(e) => onResizeDown(e, card.id)}
                    title="드래그해 크기 조절"
                  />
                </>
              ) : card.kind === "list" ? (
                (() => {
                  // 동종 수집기 — 생성카드들(→View 재생) 또는 텍스트들(→합친 텍스트). input(무선)은 실제 소스로 해석.
                  const li = collectListInputs(card.id, cardsById, resolvedEdges);
                  const label =
                    li.kind === "generation"
                      ? `생성물 ${li.generationCardIds.length}개`
                      : li.kind === "text"
                        ? `텍스트 ${li.sourceIds.length}개`
                        : li.kind === "reference"
                          ? `레퍼런스 ${li.sourceIds.length}개`
                          : li.kind === "mixed"
                            ? "⚠ 혼합 입력(사용 불가)"
                            : li.kind === "invalid"
                              ? "⚠ 잘못된 입력"
                              : "생성/텍스트/레퍼런스 카드를 연결";
                  return (
                    <>
                      <div className="scene-card-hd list scene-card-hd-float">리스트</div>
                      <div className="scene-card-inner scene-listnode">
                        <div className="scene-listnode-body">
                          {li.kind === "generation" ? (
                            // 생성물 — 텍스트처럼 한 행씩(그립+작은 썸네일+라벨), 왼쪽 그립(⠿)을 잡아 드래그로 순서 변경.
                            <div className="scene-listrows" data-reorder>
                              {li.generationCardIds.map((cid) => {
                                const gc = cardsById.get(cid);
                                const gid = gc?.genId || (gc ? variantIds(gc)[0] : undefined);
                                const gen = gid ? genData[gid] : undefined;
                                const src = gen ? thumbOf(gen, 128) : null;
                                const n = gc ? variantIds(gc).length : 0; // 이 카드에 생성된 결과 수
                                return (
                                  <div
                                    key={cid}
                                    className={"scene-listrow" + (reorderFrom === cid ? " reordering" : "")}
                                    data-reid={cid}
                                  >
                                    <span
                                      className="scene-listrow-grip"
                                      title="드래그해 순서 변경"
                                      onMouseDown={(e) => startReorder(e, card.id, cid, "v")}
                                    >
                                      ⠿
                                    </span>
                                    <span
                                      className="scene-listrow-view"
                                      title={gen?.assets?.[0] ? "클릭해 크게 보기" : undefined}
                                      onMouseDown={(e) => e.stopPropagation()}
                                      onClick={(e) => {
                                        const a = gen?.assets?.[0];
                                        if (!a || !gid) return;
                                        e.stopPropagation();
                                        getNodePreview(cid)({ url: a.file_path, type: a.type, name: gen?.prompt?.slice(0, 50) || "결과", genId: gid });
                                      }}
                                    >
                                      {src ? (
                                        <img className="scene-listrow-thumb" src={src} alt="" draggable={false} onError={hideBrokenImg} />
                                      ) : (
                                        <span className="scene-listrow-thumb scene-listthumb-ph" />
                                      )}
                                    </span>
                                    <span
                                      className="scene-listrow-count"
                                      title={n > 0 ? "클릭해 이 카드의 생성 결과 모두 보기" : undefined}
                                      onMouseDown={(e) => e.stopPropagation()}
                                      onClick={(e) => {
                                        if (n <= 0) return;
                                        e.stopPropagation();
                                        setCardMenu(cid);
                                      }}
                                    >
                                      {n > 0 ? (
                                        <span className="scene-listrow-badge">▤ {n}</span>
                                      ) : (
                                        <span className="scene-listrow-empty">빈 카드</span>
                                      )}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          ) : li.kind === "text" ? (
                            // 텍스트들 — 각 텍스트를 한 행(카드)으로, 왼쪽 그립(⠿)을 잡아 드래그로 순서 변경.
                            <div className="scene-listrows" data-reorder>
                              {li.sourceIds.map((cid) => {
                                const tc = cardsById.get(cid);
                                const txt = (tc?.text || "").trim();
                                return (
                                  <div
                                    key={cid}
                                    className={"scene-listrow" + (reorderFrom === cid ? " reordering" : "")}
                                    data-reid={cid}
                                  >
                                    <span
                                      className="scene-listrow-grip"
                                      title="드래그해 순서 변경"
                                      onMouseDown={(e) => startReorder(e, card.id, cid, "v")}
                                    >
                                      ⠿
                                    </span>
                                    <span className="scene-listrow-text">{txt || "(빈 텍스트)"}</span>
                                  </div>
                                );
                              })}
                            </div>
                          ) : li.kind === "reference" ? (
                            // 레퍼런스 카드들 — 카드마다 대표 썸네일(첫 장)+장수 배지, 드래그해 순서 변경.
                            <div className="scene-listthumbs" data-reorder>
                              {li.sourceIds.map((cid, i) => {
                                const rc = cardsById.get(cid);
                                const refs = rc?.refs || [];
                                const src = refs[0] ? refThumbSrc(refs[0]) : null;
                                return (
                                  <div
                                    key={cid}
                                    className={"scene-listthumb" + (reorderFrom === cid ? " reordering" : "")}
                                    data-reid={cid}
                                    title={`${i + 1}번 (레퍼런스 ${refs.length}장) — 드래그해 순서 변경`}
                                    onMouseDown={(e) => startReorder(e, card.id, cid, "h")}
                                  >
                                    {src ? (
                                      <img src={src} alt="" draggable={false} onError={hideBrokenImg} />
                                    ) : (
                                      <span className="scene-listthumb-ph" />
                                    )}
                                    <span className="scene-listthumb-n">{i + 1}</span>
                                    {refs.length > 1 && (
                                      <span className="scene-listthumb-cnt">{refs.length}</span>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                            label
                          )}
                        </div>
                      </div>
                      {li.kind === "text" && (
                        <button
                          className="scene-copy-btn"
                          title="합친 텍스트 복사"
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            void navigator.clipboard?.writeText(li.text);
                          }}
                        >
                          ⧉
                        </button>
                      )}
                      {li.kind === "generation" && li.generationCardIds.length > 0 && (
                        <button
                          className="scene-copy-btn"
                          title="모든 생성물을 레퍼런스로 사용"
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            addListAsReference(li.generationCardIds);
                          }}
                        >
                          @
                        </button>
                      )}
                      <span className="scene-port in" title="생성/텍스트/레퍼런스 카드를 연결해 모음" />
                      <span
                        className="scene-port out"
                        onMouseDown={(e) => onOutPortDown(e, card.id)}
                        title="드래그해 View(재생) 또는 생성 카드에 연결"
                      />
                      <span
                        className="scene-resize"
                        onMouseDown={(e) => onResizeDown(e, card.id)}
                        title="드래그해 크기 조절"
                      />
                    </>
                  );
                })()
              ) : card.kind === "view" ? (
                (() => {
                  // 뷰어 끝점 — 생성물(직접+generation-list)은 미리보기로 재생, 텍스트(text·text-list)는 표시.
                  const genIds = collectViewGenCardIds(card.id, cardsById, resolvedEdges);
                  const texts = collectViewTexts(card.id, cardsById, resolvedEdges);
                  const hasMedia = genIds.length > 0;
                  const hasText = texts.length > 0;
                  return (
                    <>
                      <div className="scene-card-hd view scene-card-hd-float">{t("미리보기")}</div>
                      <div className="scene-card-inner scene-viewnode">
                        <div className="scene-viewnode-body">
                          {hasMedia ? (
                            // '합쳐진 영상' 한 화면 미리보기 — 대표 프레임을 크게, 마우스 올리면 순서대로 이어 재생.
                            <ViewSequencePreview clips={buildViewClips(card.id, cardsById, resolvedEdges)} />
                          ) : hasText ? (
                            // 연결된 텍스트의 실제 내용을 표시(개수 대신).
                            <div className="scene-viewtext">{texts.join("\n\n")}</div>
                          ) : (
                            <div className="scene-viewnode-empty">생성물/텍스트를 연결</div>
                          )}
                        </div>
                        {/* 연결이 있을 때만 버튼 노출 — 영상=재생, 텍스트=텍스트 보기, 아무것도 없으면 버튼 없음. */}
                        {hasMedia ? (
                          <button
                            className="scene-view-play"
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              playView(card.id);
                            }}
                          >
                            ▶ 재생
                          </button>
                        ) : hasText ? (
                          <button
                            className="scene-view-play"
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              setViewTextModal(texts);
                            }}
                          >
                            📄 텍스트 보기
                          </button>
                        ) : null}
                      </div>
                      <span className="scene-port in" title="생성 카드 / 텍스트 / 리스트를 연결" />
                      <span
                        className="scene-resize"
                        onMouseDown={(e) => onResizeDown(e, card.id)}
                        title="드래그해 크기 조절"
                      />
                    </>
                  );
                })()
              ) : card.kind === "output" ? (
                (() => {
                  // Output(무선 발신) — 소스 하나에 붙어 '채널'을 발행. 색은 붙은 소스 종류를 따른다.
                  const inEdge = edges.find((e) => e.to === card.id);
                  const src = inEdge ? cardsById.get(inEdge.from) : undefined;
                  const k = src?.kind;
                  return (
                    <>
                      <div className={"scene-card-inner scene-portnode out oc-" + (k || "none")}>
                        <div className="scene-card-hd portout">OUTPUT</div>
                        <div className="scene-portnode-body">
                          {/* 본문 = 입력된 값(채널 이름)만. 이름 입력은 선택 시 카드 아래 툴바에서. */}
                          <div className="scene-portnode-val">
                            {(card.text || "").trim() || (
                              <span className="scene-portnode-valph">
                                {src ? "채널 이름" : "소스를 연결"}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      {sel && (
                        <div className="scene-portedit" onMouseDown={(e) => e.stopPropagation()}>
                          <input
                            className="scene-portedit-name"
                            value={card.text || ""}
                            placeholder="채널 이름 입력"
                            onChange={(e) => setNodeText(card.id, e.target.value)}
                          />
                        </div>
                      )}
                      <span className="scene-port in" title="발행할 소스(모델/텍스트/레퍼런스/생성물/리스트)를 연결" />
                    </>
                  );
                })()
              ) : card.kind === "input" ? (
                (() => {
                  // Input(무선 수신) — output 채널 하나를 골라 그 소스에 직접 연결한 것처럼 사용.
                  const outputs = cards.filter((c) => c.kind === "output");
                  const realId = resolveInputSourceId(card.id, cardsById, edges);
                  const real = realId ? cardsById.get(realId) : undefined;
                  const k = real?.kind;
                  const chOk = !!card.channel && outputs.some((o) => o.id === card.channel);
                  const channelName = chOk ? (cardsById.get(card.channel!)?.text || "").trim() : "";
                  return (
                    <>
                      <div className={"scene-card-inner scene-portnode in oc-" + (k || "none")}>
                        <div className="scene-card-hd portin">INPUT</div>
                        <div className="scene-portnode-body">
                          {/* 본문 = 고른 채널 이름(입력값)만. 출력 선택 드롭다운은 선택 시 카드 아래 툴바에서. */}
                          <div className="scene-portnode-val">
                            {channelName || (
                              <span className="scene-portnode-valph">
                                {card.channel ? "⚠ 미연결" : "출력 선택"}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      {sel && (
                        <div className="scene-portedit" onMouseDown={(e) => e.stopPropagation()}>
                          <select
                            className="scene-portedit-sel"
                            value={chOk ? card.channel : ""}
                            onChange={(e) => setNodeChannel(card.id, e.target.value)}
                          >
                            <option value="">출력 선택…</option>
                            {outputs.map((o) => (
                              <option key={o.id} value={o.id}>
                                {(o.text || "").trim() || "(이름없음)"}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                      <span
                        className="scene-port out"
                        onMouseDown={(e) => onOutPortDown(e, card.id)}
                        title="드래그해 원하는 곳에 연결(고른 출력의 소스처럼 동작)"
                      />
                    </>
                  );
                })()
              ) : card.kind === "render" ? (
                (() => {
                  // 렌더(배치 생성) — 연결된 생성카드들을 모아 Render 버튼 한 번으로 각 카드를 자기 모델·refs·텍스트로 생성.
                  const gcids = collectRenderGenCardIds(card.id, cardsById, resolvedEdges);
                  const unchecked = new Set(card.unchecked || []); // 체크 해제된(렌더 제외) 카드들
                  const activeGcids = gcids.filter((cid) => !unchecked.has(cid)); // 실제 Render 대상(체크된 것만)
                  return (
                    <>
                      <div className="scene-card-hd render scene-card-hd-float">렌더</div>
                      <div className="scene-card-inner scene-listnode scene-rendernode">
                        <div className="scene-listnode-body">
                          {gcids.length ? (
                            // 생성물 — 텍스트처럼 한 행씩(그립+작은 썸네일+개수). 그립을 잡아 드래그로 순서 변경, 더블클릭=결과 팝업.
                            <div className="scene-listrows" data-reorder>
                              {gcids.map((cid) => {
                                const gc = cardsById.get(cid);
                                const gid = gc?.genId || (gc ? variantIds(gc)[0] : undefined);
                                const gen = gid ? genData[gid] : undefined;
                                const src = gen ? thumbOf(gen, 128) : null;
                                const n = gc ? variantIds(gc).length : 0;
                                return (
                                  <div
                                    key={cid}
                                    className={"scene-listrow" + (reorderFrom === cid ? " reordering" : "")}
                                    data-reid={cid}
                                  >
                                    <span
                                      className="scene-listrow-grip"
                                      title="드래그해 순서 변경"
                                      onMouseDown={(e) => startReorder(e, card.id, cid, "v")}
                                    >
                                      ⠿
                                    </span>
                                    <input
                                      type="checkbox"
                                      className="scene-listrow-check"
                                      checked={!unchecked.has(cid)}
                                      title={unchecked.has(cid) ? "체크(렌더 대상)" : "체크 해제(렌더 제외)"}
                                      onMouseDown={(e) => e.stopPropagation()}
                                      onClick={(e) => e.stopPropagation()}
                                      onChange={() => toggleRenderCheck(card.id, cid)}
                                    />
                                    <span
                                      className="scene-listrow-view"
                                      title={gen?.assets?.[0] ? "클릭해 크게 보기" : undefined}
                                      onMouseDown={(e) => e.stopPropagation()}
                                      onClick={(e) => {
                                        const a = gen?.assets?.[0];
                                        if (!a || !gid) return;
                                        e.stopPropagation();
                                        getNodePreview(cid)({ url: a.file_path, type: a.type, name: gen?.prompt?.slice(0, 50) || "결과", genId: gid });
                                      }}
                                    >
                                      {src ? (
                                        <img className="scene-listrow-thumb" src={src} alt="" draggable={false} onError={hideBrokenImg} />
                                      ) : (
                                        <span className="scene-listrow-thumb scene-listthumb-ph" />
                                      )}
                                    </span>
                                    <span
                                      className="scene-listrow-count"
                                      title={n > 0 ? "클릭해 이 카드의 생성 결과 모두 보기" : undefined}
                                      onMouseDown={(e) => e.stopPropagation()}
                                      onClick={(e) => {
                                        if (n <= 0) return;
                                        e.stopPropagation();
                                        setCardMenu(cid);
                                      }}
                                    >
                                      {n > 0 ? (
                                        <span className="scene-listrow-badge">▤ {n}</span>
                                      ) : (
                                        <span className="scene-listrow-empty">빈 카드</span>
                                      )}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                            "생성 카드를 연결"
                          )}
                        </div>
                      </div>
                      {sel && onRenderCards && (
                        <div className="scene-cardgen-bar" onMouseDown={(e) => e.stopPropagation()}>
                          <button
                            className="scene-cardgen-step"
                            title="배치 줄이기"
                            onClick={(e) => {
                              e.stopPropagation();
                              onBatchCountChange?.(Math.max(1, batchCount - 1));
                            }}
                          >
                            −
                          </button>
                          <span className="scene-cardgen-n" title="각 카드에서 생성할 장수(배치)">
                            {batchCount}
                          </span>
                          <button
                            className="scene-cardgen-step"
                            title="배치 늘리기"
                            onClick={(e) => {
                              e.stopPropagation();
                              onBatchCountChange?.(Math.min(4, batchCount + 1));
                            }}
                          >
                            +
                          </button>
                          <button
                            className="scene-cardgen-go"
                            title="체크된 생성 카드만 각자 한 번에 생성"
                            disabled={!activeGcids.length}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (activeGcids.length) onRenderCards(activeGcids);
                            }}
                          >
                            Render ▶ {activeGcids.length}
                          </button>
                        </div>
                      )}
                      <span className="scene-port in" title="생성 카드를 연결해 모음" />
                      <span
                        className="scene-port out"
                        onMouseDown={(e) => onOutPortDown(e, card.id)}
                        title="드래그해 미리보기(View)에 연결 — 담긴 생성물들을 재생"
                      />
                      <span
                        className="scene-resize"
                        onMouseDown={(e) => onResizeDown(e, card.id)}
                        title="드래그해 크기 조절"
                      />
                    </>
                  );
                })()
              ) : card.kind === "head" ? (
                (() => {
                  // Head(제목) — 포트 없는 주석 글씨. 크기 조절 시 글자 크기도 같이 커진다. 색은 스와치로 변경.
                  const editing = editTextId === card.id;
                  const fs = Math.max(12, Math.round(heightOf(card) * 0.62));
                  const col = card.color || "#e8c341";
                  return (
                    <>
                      {editing ? (
                        <input
                          className="scene-headnode-edit"
                          value={card.text || ""}
                          placeholder="제목"
                          autoFocus
                          style={{ fontSize: fs, color: col }}
                          onMouseDown={(e) => e.stopPropagation()}
                          onBlur={() => setEditTextId(null)}
                          onChange={(e) => setNodeText(card.id, e.target.value)}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === "Enter" || e.key === "Escape") setEditTextId(null);
                          }}
                        />
                      ) : (
                        <div
                          className="scene-headnode-text"
                          style={{ fontSize: fs, color: col }}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            setEditTextId(card.id);
                          }}
                        >
                          {card.text || "제목"}
                        </div>
                      )}
                      {sel && !editing && (
                        <input
                          type="color"
                          className="scene-headnode-color"
                          value={col}
                          title="글씨 색 변경"
                          onMouseDown={(e) => e.stopPropagation()}
                          onChange={(e) => setNodeColor(card.id, e.target.value)}
                        />
                      )}
                      <span
                        className="scene-resize"
                        onMouseDown={(e) => onResizeDown(e, card.id)}
                        title="드래그해 크기 조절(글자도 같이 커짐)"
                      />
                    </>
                  );
                })()
              ) : (
                <>
                  {showNode && g ? (
                    // 완료 결과 → 히스토리 카드(HistoryBoardNode) 그대로 — 캡션·오버레이(S/ⓘ/⠿/⤓/@/↻) 전부.
                    <HistoryBoardNode
                      generation={g}
                      x={0}
                      y={0}
                      width={widthOf(card)}
                      height={heightOf(card)}
                      isRoot={false}
                      isSelected={sel}
                      onLine={false}
                      offLine={false}
                      fill={fill}
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
                      onPreview={getNodePreview(card.id)}
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
                  {/* 3 입력 단자 — 위=모델(주황)·중간=레퍼런스(파랑)·아래=텍스트(보라). 연결 역할은
                      소스 노드 종류로 자동 판정되어 해당 레인으로 라우팅된다. */}
                  {(
                    [
                      ["model", 0.28, "모델 입력"],
                      ["ref", 0.5, "레퍼런스 입력"],
                      ["text", 0.72, "텍스트 입력"],
                    ] as [SceneEdgeRole, number, string][]
                  ).map(([role, frac, tip]) => (
                    <span
                      key={role}
                      className={"scene-port in lane-" + role}
                      data-role={role}
                      style={{ top: `${frac * 100}%` }}
                      title={tip}
                    />
                  ))}
                  <span
                    className="scene-port out"
                    onMouseDown={(e) => onOutPortDown(e, card.id)}
                    title="드래그해 다른 생성 카드에 연결"
                  />
                  <span
                    className="scene-resize"
                    onMouseDown={(e) => onResizeDown(e, card.id)}
                    title="드래그해 카드 크기 조절"
                  />
                  {/* 이 카드만 선택했을 때 카드 아래 Generate 툴바 — 연결된 모델·레퍼런스·텍스트로 바로 생성(하단 프롬프트 재사용). */}
                  {selected.size === 1 && sel && onGenerateCard && (
                    <div className="scene-cardgen-bar" onMouseDown={(e) => e.stopPropagation()}>
                      <button
                        className="scene-cardgen-step"
                        title="배치 줄이기"
                        onClick={(e) => {
                          e.stopPropagation();
                          onBatchCountChange?.(Math.max(1, batchCount - 1));
                        }}
                      >
                        −
                      </button>
                      <span className="scene-cardgen-n" title="한 번에 생성할 장수(배치)">
                        {batchCount}
                      </span>
                      <button
                        className="scene-cardgen-step"
                        title="배치 늘리기"
                        onClick={(e) => {
                          e.stopPropagation();
                          onBatchCountChange?.(Math.min(4, batchCount + 1));
                        }}
                      >
                        +
                      </button>
                      <button
                        className="scene-cardgen-go"
                        title="연결된 모델·레퍼런스·텍스트로 바로 생성"
                        onClick={(e) => {
                          e.stopPropagation();
                          onGenerateCard();
                        }}
                      >
                        Generate ✨
                      </button>
                    </div>
                  )}
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
            const dotRole = edgeRoles.get(e.id);
            const active = selected.has(e.from) || selected.has(e.to);
            const cls =
              "scene-dot" +
              (active
                ? dotRole === "model"
                  ? " model"
                  : dotRole === "text"
                    ? " text"
                    : refCardEdgeIds.has(e.id) || dotRole === "ref"
                      ? " ref"
                      : ""
                : " idle");
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

      {mmBounds && mmBoxes.length > 0 && (
        <SceneMinimap
          boxes={mmBoxes}
          bounds={mmBounds}
          selected={selected}
          scrollRef={scrollRef}
          panRef={panRef}
          zoomRef={zoomRef}
          updateRef={mmUpdateRef}
          onNavigate={navigateTo}
        />
      )}

      {marquee && (
        <div
          className="scene-marquee"
          style={{ left: marquee.l, top: marquee.t, width: marquee.w, height: marquee.h }}
        />
      )}

      {/* 순서변경 삽입 위치 — 화면좌표 기준(fixed) 흰 선. 항목 사이 어디에 놓일지 보여준다. */}
      {reorderLine && (
        <div
          className="scene-reorder-line"
          style={{ left: reorderLine.x, top: reorderLine.y, width: reorderLine.w, height: reorderLine.h }}
        />
      )}

      {cutHeld && (
        <div className="scene-cut-hint">✂ 연결 자르기 — 드래그로 선을 지나가고 손을 떼면 끊깁니다</div>
      )}

      {/* Tab 노드 피커 — 커서 위치의 작은 메뉴. 항목 클릭 시 그 자리에 노드 생성. 배경/Esc 로 닫힘. */}
      {nodePicker && (
        <>
          <div className="scene-nodepick-backdrop" onMouseDown={() => setNodePicker(null)} />
          <div className="scene-nodepick" style={{ left: nodePicker.sx, top: nodePicker.sy }}>
            {(
              [
                // 역할별 묶음: 생성(New·Model·Text) → 모음/흐름(List·Render·View) → 무선(Input·Output) → 주석(Head)
                ["New", "N", "generation"],
                ["Model", "M", "model"],
                ["Text", "T", "text"],
                ["List", "L", "list"],
                ["Render", "R", "render"],
                ["View", "V", "view"],
                ["Input", "I", "input"],
                ["Output", "O", "output"],
                ["Head", "H", "head"],
              ] as [string, string, SceneCardKind][]
            ).map(([label, key, kind]) => (
              <button
                key={kind}
                className="scene-nodepick-item"
                onMouseDown={(e) => {
                  e.stopPropagation();
                  const at = { x: nodePicker.cx, y: nodePicker.cy };
                  setNodePicker(null);
                  if (kind === "generation") createGenerationConnected(at);
                  else createNode(kind, at);
                }}
              >
                <span className="scene-nodepick-name">{label}</span>
                <span className="scene-nodepick-key">{key}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {/* 모델 노드 더블클릭 → 모델 설정 모달(하단 프롬프트 모델 UI 재사용). 저장 시 modelCfg 스냅샷. */}
      {modelModalId &&
        (() => {
          const c = cards.find((x) => x.id === modelModalId);
          if (!c) return null;
          return (
            <SceneModelModal
              key={modelModalId}
              initial={c.modelCfg}
              onClose={() => setModelModalId(null)}
              onSave={(cfg) => {
                const next = cardsRef.current.map((x) =>
                  x.id === modelModalId ? { ...x, modelCfg: cfg } : x,
                );
                setCards(next);
                persist(next, edgesRef.current);
              }}
            />
          );
        })()}

      {/* View 텍스트 보기 모달 — 연결된 텍스트 블록들을 순서대로 표시(+전체 복사). */}
      {viewTimeline && (
        <ViewTimeline
          clips={viewTimeline}
          onClose={() => setViewTimeline(null)}
          onDownload={async (srcs, name) => {
            const blob = await api.mergeVideos(srcs, name);
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `${name}.mp4`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 8000);
          }}
        />
      )}

      {viewTextModal && (
        <div className="scene-modelmodal-backdrop" onMouseDown={() => setViewTextModal(null)}>
          <div className="scene-textview" onMouseDown={(e) => e.stopPropagation()}>
            <div className="scene-modelmodal-hd">
              <span>텍스트</span>
              <button
                className="scene-modelmodal-x"
                onClick={() => setViewTextModal(null)}
                title="닫기"
              >
                ✕
              </button>
            </div>
            <div className="scene-textview-body">
              {viewTextModal.map((t, i) => (
                <div key={i} className="scene-textview-block">
                  {t}
                </div>
              ))}
            </div>
            <div className="scene-modelmodal-ft">
              <button
                onClick={() => void navigator.clipboard?.writeText(viewTextModal.join("\n\n"))}
              >
                전체 복사
              </button>
              <button className="primary" onClick={() => setViewTextModal(null)}>
                닫기
              </button>
            </div>
          </div>
        </div>
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
                              // preventDefault = 버튼이 포커스를 받아 그리드가 스크롤(옆으로 이동)되는 것 차단.
                              // mousedown 에서 바로 지정 → 빠르게 눌러도 확실히 선택(클릭 타이밍 의존 제거).
                              onMouseDown={(e) => {
                                e.preventDefault();
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

      {cards.length === 0 && (
        <div className="scene-empty">
          <div className="scene-empty-title">{scene.name}</div>
          <b>에셋 창에서 레퍼런스를 이 화면으로 드래그</b>하면 레퍼런스 카드가 만들어집니다.
          <div className="scene-empty-hint">
            <b>Tab</b> → 노드 만들기 메뉴(New/Model/Text/List/Render/View/Input/Output/Head) · <b>Delete</b> → 삭제 · <b>Y</b> → 연결 자르기 · 미들버튼 드래그 → 화면 이동
          </div>
        </div>
      )}
    </div>
  );
}
