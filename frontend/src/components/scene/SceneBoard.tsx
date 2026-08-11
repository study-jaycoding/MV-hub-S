// Canvas 씬 보드 — 계보 탭과 동일한 조작감:
//   · 좌드래그(배경)=마퀴 복수선택 · 미들버튼 드래그=화면이동(팬) · 휠=줌
//   · 카드 좌드래그=이동(선택된 것 함께) · 클릭=단일선택 · Ctrl=토글(누적) · Shift=연결 체인선택 · 배경클릭=해제
//   · Delete=선택 삭제(생성물 있으면 휴지통, 빈 카드면 그냥 제거)
// 기능: 에셋 드롭 레퍼런스 카드(S2) · n키 빈 카드+연결선(S3) · 포트 수동 연결/해제(S4).
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { CSSProperties, MutableRefObject, ReactNode } from "react";
import { api } from "../../api";
import {
  assetVersionsSnapshot,
  ingestAssetTreeVersions,
  subscribeAssetVersions,
} from "../../lib/assetVersions";
import { APP_EVENTS, ASSET_CHANNEL_MESSAGES, dispatchAppEvent } from "../../lib/appEvents";
import { openAssetBroadcast } from "../../lib/assetBroadcast";
import { toggleDisabledGen } from "../../lib/deactivated";
import {
  sceneRefFingerprint,
  settleComfyRunning,
  uid,
  variantIds,
  type Scene,
  type SceneCard,
  type SceneCardKind,
  type SceneEdge,
  type SceneEdgeRole,
  type SceneGroup,
  type SceneRef,
  type SceneSetFolder,
} from "../../lib/scenes";
import {
  canConnect,
  classifyEdges,
  collectListInputs,
  collectRenderGenCardIds,
  collectViewGenCardIds,
  collectViewTexts,
  comfyOutputMedia,
  computeBridgeEdges,
  buildGenerationExecutionPlan,
  type SceneGenerationRun,
  incomingTextOf,
  comfyTextDriveKeys,
  comfyGenMeta,
  edgePathXY,
  fanOffset,
  refLaneOrderIndex,
  resolveEdgeRoles,
  resolvePortEdges,
} from "../../lib/sceneEdges";
import { arrangeNodes } from "../../lib/sceneLayout";
import {
  GROUP_HEADER_HEIGHT,
  deriveGroupViews,
  groupRectFromCards,
  pruneGroups,
  reconcileRefs,
} from "../../lib/sceneDerive";
import { gatherComfyMedia, hasTextConnection } from "../../lib/sceneComfyInputs";
import { isSceneComfyConfigCurrent } from "../../lib/sceneComfyExecutor";
import { refMediaSrc, refMediaType, refThumbSrc } from "../../lib/sceneMedia";
import {
  buildSelectedConnections,
  SCENE_GRID as GRID,
} from "../../lib/sceneInteractions";
import { sceneGroupControlTargetIds } from "../../lib/sceneGroupSelection";
import {
  isComfyRunning,
  subscribeComfyRunning,
  getComfyRunningVersion,
} from "../../lib/sceneComfyRunningStore";
import { useSceneGenData } from "../../lib/useSceneGenData";
import {
  useSceneComfyExecution,
  type SaveComfyOptions,
  type SaveComfyResult,
} from "../../lib/useSceneComfyExecution";
import { useT } from "../../lib/i18n";
import type { Generation, InfoTarget, PreviewItem, PreviewTarget, Project } from "../../types";
import { SceneMinimap } from "./SceneMinimap";
import { SceneVariantPopup } from "./SceneVariantPopup";
import { SceneModelModal } from "./SceneModelModal";
import { SceneComfyModal } from "./SceneComfyModal";
import { comfyApi } from "../../lib/comfyApi";
import {
  isRecentlyDone,
  observeStatus,
  seedPending,
  subscribeRecentDone,
  getRecentDoneVersion,
} from "../../lib/sceneRecentDoneStore";
import { flashMsg } from "../../lib/flash";
import { useSceneHistory } from "../../lib/useSceneHistory";
import { useSceneKeyboardShortcuts } from "../../lib/useSceneKeyboardShortcuts";
import { sceneEscapeTarget } from "../../lib/sceneKeyboard";
import { useSceneDragSession } from "../../lib/useSceneDragSession";
import { useSceneViewport } from "../../lib/useSceneViewport";
import { useSceneClipboardDrop } from "../../lib/useSceneClipboardDrop";
import { useSceneCardResize } from "../../lib/useSceneCardResize";
import { useSceneCardMove } from "../../lib/useSceneCardMove";
import { useSceneGroupMove } from "../../lib/useSceneGroupMove";
import { useSceneMarqueeSelection } from "../../lib/useSceneMarqueeSelection";
import type { SceneComfyCfg } from "../../lib/scenes";
import type { SceneGenerationAssignment } from "../../lib/sceneGenerationInputs";
import { ViewTimeline, type TimelineClip } from "./ViewTimeline";
import { displayThumb, thumbOf } from "../../lib/media";
import { useClickSeparation } from "../../lib/useClickSeparation";
import { OutputCard } from "./cards/OutputCard";
import { ReferenceCard } from "./cards/ReferenceCard";
import { TextCard } from "./cards/TextCard";
import { SetCard } from "./cards/SetCard";
import { ListCard } from "./cards/ListCard";
import { RenderCard } from "./cards/RenderCard";
import { GenerationCard } from "./cards/GenerationCard";
import { ComfyCard } from "./cards/ComfyCard";
import { ModelCard } from "./cards/ModelCard";
import { InputCard } from "./cards/InputCard";
import { HeadCard } from "./cards/HeadCard";
import { ViewCard } from "./cards/ViewCard";
import { CARD_H, CARD_W, GROUP_COLORS } from "./sceneColors";
// ── 뷰포트 컬링(가상화) 플래그 — 화면 밖 카드를 렌더에서 빼 메모리·DOM 절감. 단계 롤아웃용. ──
// CULL_ENABLED=false 면 완전 무동작(rAF·setState·ResizeObserver 없음, renderCards===visibleCards).
// Phase 1: 켜되 마진 넉넉(먼 카드만 언마운트) — 문제 시 이 값만 false 로 되돌리면 즉시 원복.
const CULL_ENABLED = true;
const CULL_MARGIN = 1500; // 뷰포트 밖 이 canvas px 까지는 유지(가장자리 팝인 완화). 다이얼: 줄이면 메모리↓·팝인↑
// 점 배경 격자 간격(scene.css 의 22px 와 동일). 카드 이동·크기조절이 이 격자에 스냅된다.
// 카드 최소 크기(격자 배수). 너비는 완료 카드 상단 버튼(S/T/C/ⓘ)이 안 잘리게 넉넉히, 높이는 더 낮게 허용.
const CARD_MIN_W = GRID * 5; // 110
const CARD_MIN_H = GRID * 3; // 66
// 그룹 고정 색 팔레트 — sceneColors.ts 로 이동(HeadCard 와 공용, R2 분할).
// 그룹 멤버 카드를 이 속도(화면 px/ms) 이상으로 경계 밖으로 빼면 '속도 이탈' — 프레임이 카드를 놓아주고
//  그룹에서 빠진다(느리게 빼면 기존처럼 프레임이 늘어나 덮음). 폴더에서 아이콘 확 빼내는 제스처.
const GROUP_EJECT_SPEED = 3.0;

// refThumbSrc·refTypeLabel — lib/sceneMedia.ts 로 이동(R2 카드 분할로 카드 컴포넌트들과 공용).
// refMediaSrc·refMediaType·mediaFileName 은 순수 헬퍼라 sceneMedia.ts 로 분리(상단에서 import).

// 단순 미디어 비교 아이템(레퍼런스 포함) — fallback=로드 실패 시 대체, full=크게 보기용 원본.
type CompareMediaItem = { url: string; name: string; type: "image" | "video"; fallback?: string; full?: string };

interface Props {
  scene: Scene;
  onChange: (patch: Partial<Scene>) => void;
  // 좌상단 패널 — 현재 씬을 텍스트 파일로 저장 / 파일에서 새 탭으로 불러오기.
  //  · onSaveScene 은 저장 시점의 '라이브 카메라'를 받아 debounce 로 지연된 stale 카메라 대신 최신을 쓴다.
  onSaveScene?: (camera?: { z: number; x: number; y: number }) => void;
  onLoadSceneFile?: (file: File) => void;
  // 씬 탭 바 호버 여부 — true 면 좌상단 씬 패널(저장/불러오기)을 보인다(평소엔 숨김).
  ioPanelHot?: boolean;
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
  // 레퍼런스 등 비생성 미디어가 섞인 선택 → 상단 선택바가 '미디어 비교'를 띄우게 App 에 보고(없으면 null).
  onSelectionCompare?: (media: CompareMediaItem[] | null) => void;
  onVariantAssign?: (sel: Generation[], projectId: string | null) => void;
  onVariantCreateAssign?: (sel: Generation[], name: string) => void;
  onVariantDelete?: (sel: Generation[]) => Promise<string[]>; // 삭제 성공 id 반환
  // 캔버스에서 선택된 '결과 카드'들의 Generation 을 App 에 올려 프롬프트 위 선택바를 띄운다.
  onSelectionGens?: (gens: Generation[]) => void;
  // 선택바의 '삭제'·트레이 편집이 부를 명령형 핸들.
  actionRef?: MutableRefObject<{
    deleteSelected: () => void;
    setCardRefs: (cardId: string, refs: SceneRef[]) => SceneRef[];
    flushPending: () => void; // 밀린 입력 저장 확정 — App 이 씬 전환 직전 호출(옛 씬에 정확히 저장)
  } | null>;
  // 생성 카드 아래 'Generate' 툴바 — 즉시 생성(하단 프롬프트 submit 재사용). 배치수는 노드별(card.batchCount)로 관리.
  onGenerateCard?: (batch?: number, assignment?: SceneGenerationAssignment | null) => void; // 최신 Set 정보도 함께 전달
  // 렌더(배치) 노드 — 연결된 생성카드 id들을 넘기면 각 카드가 자기 모델·refs·텍스트로 한 번에 생성된다.
  onRenderCards?: (cardIds: string[], batch?: number) => void | Promise<void>;
  // 배치 짝 생성 — 상류 comfy 를 배치수만큼 병렬 실행한 결과(runs)를 넘기면 각 run(짝)이 그 comfy 결과로 1장 생성.
  onRenderCardRuns?: (runs: SceneGenerationRun[]) => void | Promise<void>;
  // 현재 실행 중인 comfy 노드 목록 통지 — App 이 '내 작업'에 임시 생성중 카드(Comfy 로고)를 띄우는 데 쓴다.
  onComfyRunningChange?: (items: { id: string; name: string }[]) => void;
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
  // Ctrl+K 로 프롬프트를 숨겼을 때 캔버스 상단 중앙(씬 패널·미니맵과 같은 줄)에 얹을 멀티선택 액션바.
  topCenterOverlay?: ReactNode;
}

export function SceneBoard({
  scene,
  onChange,
  topCenterOverlay,
  onSaveScene,
  onLoadSceneFile,
  ioPanelHot,
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
  onSelectionCompare,
  onVariantAssign,
  onVariantCreateAssign,
  onVariantDelete,
  onSelectionGens,
  actionRef,
  onGenerateCard,
  onRenderCards,
  onRenderCardRuns,
  onComfyRunningChange,
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
  // 최초 마운트에도 박제된 running 을 치유해 시작(effect 전 첫 페인트에 '생성중' 잔상 방지).
  const [cards, setCards] = useState<SceneCard[]>(() => settleComfyRunning(scene.cards, isComfyRunning));
  const [edges, setEdges] = useState<SceneEdge[]>(scene.edges);
  const [groups, setGroups] = useState<SceneGroup[]>(scene.groups || []);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null); // 이름 편집 중인 그룹
  const [colorPopId, setColorPopId] = useState<string | null>(null); // 색 팔레트 팝오버가 열린 그룹
  const [ejectedIds, setEjectedIds] = useState<Set<string>>(new Set()); // 드래그 중 속도로 그룹에서 튕겨낸 카드 — 이탈해도 박스 크기 유지
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());
  // 방금 생성된 카드 — 라임 glow 로 '방금 만들어짐'을 직관 표시. '방금 완료' 판정은 모듈 store 로 분리해
  //  탭 전환(SceneBoard 언마운트)에도 유지된다(App watcher 가 탭 무관 폴링). glowVer 로 store 변경 시 리렌더.
  useSyncExternalStore(subscribeRecentDone, getRecentDoneVersion, getRecentDoneVersion);
  // 드래그 중인 카드 id — 컬링(keepIds)이 이동 중 카드를 마진 밖으로 나가도 언마운트하지 않게 유지한다.
  const [draggingIds, setDraggingIds] = useState<readonly string[]>([]);
  const [marquee, setMarquee] = useState<{ l: number; t: number; w: number; h: number } | null>(null);
  const [tempWire, setTempWire] = useState<{ fromId: string; x2: number; y2: number } | null>(null);
  // genId→실제 생성물 바인딩·폴링·계보(refParents)·비활성/삭제 상태는 useSceneGenData 훅으로 추출(동작 보존).
  //  각 생성물이 '레퍼런스로 쓴' 부모 gen id(refParents)는 수동 연결선 색(레퍼런스 점선 vs 계보 실선) 판정 근거.
  const { genData, setGenData, genDataRef, missingIds, disabledIds, refParents } = useSceneGenData(cards);
  // 캔버스에 있는 동안 관찰한 생성 카드 상태를 store 에 반영(전환 규칙은 store 가 판정). 초기 done/새로고침은
  //  store 가 baseline 으로만 처리해 glow 안 함. active→done 만 recentlyDone. (App watcher 와 공동으로 채움)
  useEffect(() => {
    for (const c of cards) {
      if (c.kind !== "generation") continue;
      // 변형 전체를 반영(useSceneGenData 가 모든 변형을 조회) — 대표가 바뀌거나 비대표가 늦게 완료돼도 커버.
      for (const gid of variantIds(c)) {
        const st = genData[gid]?.status;
        if (st) observeStatus(gid, String(st));
      }
    }
  }, [genData, cards]);
  const [cardMenu, setCardMenu] = useState<string | null>(null); // 변형(결과) 팝업이 열린 카드 id
  const [tagEditCardId, setTagEditCardId] = useState<string | null>(null); // 태그 편집 팝업이 열린 카드 id(같은 생성물이 여러 카드여도 하나만)
  const [tagEditNodeGenId, setTagEditNodeGenId] = useState<string | null>(null); // 카드 내부 HistoryBoardNode 의 태그 편집 대상 gen id
  // Tab 노드 피커(Houdini식) — 커서 위치에 New/Model/List/Text 메뉴. sx/sy=보드기준 화면좌표(팝업 배치), cx/cy=새 노드 캔버스좌표.
  const [nodePicker, setNodePicker] = useState<{ sx: number; sy: number; cx: number; cy: number } | null>(null);
  const nodePickerRef = useRef<{ sx: number; sy: number; cx: number; cy: number } | null>(null);
  nodePickerRef.current = nodePicker; // 열림여부(truthy) + 생성 좌표(cx/cy) 둘 다 여기서 참조
  const [modelModalId, setModelModalId] = useState<string | null>(null); // 모델 노드 설정 모달 대상 카드 id
  const [comfyModalId, setComfyModalId] = useState<string | null>(null); // comfy 노드 설정 모달 대상 카드 id
  const [viewTextModal, setViewTextModal] = useState<string[] | null>(null); // View 텍스트 보기 모달 내용
  const [viewTimeline, setViewTimeline] = useState<TimelineClip[] | null>(null); // View 재생 타임라인(연속 재생) 클립들
  const [editTextId, setEditTextId] = useState<string | null>(null); // 편집 중인 텍스트/제목 노드(그 외엔 @토큰 알약 미리보기)
  const editTextIdRef = useRef<string | null>(null);
  editTextIdRef.current = editTextId;
  // 편집 중이던 노드가 사라지면(삭제·undo·씬 전환) 편집 상태 해제 — 유령 editTextId 가 남으면
  // 키보드 가드("편집 중이면 캔버스 단축키 무시")가 Ctrl+C 포함 모든 키를 새로고침 전까지 차단한다.
  useEffect(() => {
    if (editTextId && !cards.some((c) => c.id === editTextId)) setEditTextId(null);
  }, [cards, editTextId]);
  const caretPosRef = useRef<Map<string, number>>(new Map()); // 텍스트 노드별 마지막 캐럿 위치 — 재편집 시 그곳으로 복원
  const [tagEditGid, setTagEditGid] = useState<string | null>(null); // 변형 팝업 타일별 태그 편집 대상 gen id
  const [popupSel, setPopupSel] = useState<Set<string>>(new Set()); // 팝업 내 다중선택(gid)
  const [gripDragging, setGripDragging] = useState(false); // 팝업 재사용 그립 드래그 중 — 백드롭 클릭통과(프롬프트로 드롭)
  const [popupMarq, setPopupMarq] = useState<{ l: number; t: number; w: number; h: number } | null>(null);
  const varGridRef = useRef<HTMLDivElement>(null);
  const sceneFileRef = useRef<HTMLInputElement>(null); // 씬 불러오기 파일 인풋(숨김)
  // 씬 패널(저장/불러오기) 표시 — 씬 탭 바 또는 패널 자체에 호버 중일 때만(평소 숨김, 캔버스 작업 방해 금지).
  // 탭 바 → 패널로 마우스가 건너오는 동안 사라지지 않게 0.35초 유예. 숨김은 CSS(opacity)로 —
  // 언마운트하면 '불러오기' 파일 선택창이 열린 사이 hidden input 이 사라져 선택이 무시된다.
  const [ioPanelHover, setIoPanelHover] = useState(false);
  const [ioPanelLinger, setIoPanelLinger] = useState(false);
  useEffect(() => {
    if (ioPanelHot) {
      setIoPanelLinger(true);
      return;
    }
    const t = setTimeout(() => setIoPanelLinger(false), 350);
    return () => clearTimeout(t);
  }, [ioPanelHot]);
  const ioPanelVisible = !!ioPanelHot || ioPanelLinger || ioPanelHover;
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
  const popupAnchorRef = useRef<string | null>(null); // 팝업 Shift 범위선택 기준점(마지막 단일/토글 클릭)
  // 가위(연결 자르기) — 후디니식: Y 를 누르고 있는 동안만 활성. 좌드래그로 궤적을 그리고 지나간
  // 연결선을 빨갛게 표시(예고)했다가, 마우스를 떼면 그 선들을 실제로 끊는다.
  const [cutHeld, setCutHeld] = useState(false); // Y 키를 누르고 있는 중
  const [cutStroke, setCutStroke] = useState<{ x: number; y: number }[] | null>(null); // 드래그 궤적(캔버스 좌표)
  const [edgesToCut, setEdgesToCut] = useState<Set<string>>(new Set()); // 끊을 예정(빨강) 연결 id
  // 순서변경 드래그 — 삽입 위치 흰 선(화면좌표·fixed) + 잡고 있는 항목(흐리게)
  const [reorderLine, setReorderLine] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [reorderFrom, setReorderFrom] = useState<string | null>(null);
  // 리스트/렌더 행 선택 — listId 스코프의 항목(cid) 집합. 클릭=단일, Ctrl+클릭=복수 토글.
  //  선택 후 그립 드래그하면 선택 전부 함께 이동, 렌더는 선택 전부 일괄 체크/해제.
  const [rowSel, setRowSel] = useState<{ listId: string; cids: Set<string> }>({ listId: "", cids: new Set() });
  const rowSelRef = useRef(rowSel);
  rowSelRef.current = rowSel;
  const toggleRowSel = (listId: string, cid: string, additive: boolean) => {
    setRowSel((prev) => {
      if (additive && prev.listId === listId) {
        const cids = new Set(prev.cids);
        cids.has(cid) ? cids.delete(cid) : cids.add(cid);
        return { listId, cids };
      }
      return { listId, cids: new Set([cid]) };
    });
  };
  // 씬 전환 = 선택 해제. 같은 씬이라도 외부(생성 결과 바인딩·프롬프트 순서변경)에서 cards/edges 가
  // 바뀌면 반영하되 선택은 유지 — 카드 드래그 중엔 persist 안 하므로 prop 이 안 바뀌어 방해받지 않는다.
  const sceneIdRef = useRef(scene.id);
  useEffect(() => {
    // ★기존 저장분(레거시)에 박제된 status:"running" 치유 — 지금 실제로 실행 중(모듈 store)이 아니면
    //  done/idle 로 정규화해 '영원히 생성중' 표시를 없앤다(persist 쪽 settleComfyRunning 과 짝).
    const inCards = settleComfyRunning(scene.cards, isComfyRunning);
    if (sceneIdRef.current !== scene.id) {
      const prevId = sceneIdRef.current;
      persistSceneHistory(prevId); // 떠나는 씬의 undo 히스토리 보관(돌아오면 이어서)
      sceneIdRef.current = scene.id;
      setSelected(new Set());
      setSelectedGroupIds(new Set());
      setRowSel({ listId: "", cids: new Set() }); // 씬 전환 시 리스트/렌더 행 선택도 해제(stale 방지)
      // 들어온 씬의 히스토리를 store 에서 복원(없거나 stale 이면 리셋). 씬마다 자기 Ctrl+Z 를 유지.
      restoreSceneHistory(scene.id, { cards: inCards, edges: scene.edges, groups: scene.groups || [] });
    }
    setCards(inCards);
    setEdges(scene.edges);
    setGroups(scene.groups || []);
    // 표시 중인 상태를 항상 '최근 커밋'으로 맞춘다 — 외부 갱신(생성 완료 등) 후 Ctrl+Z 가
    // 그 갱신까지 되돌리는(스테일 복원) 문제 방지. (내 persist 는 이미 같은 값이라 무해)
    syncCommitBaseline({ cards: inCards, edges: scene.edges, groups: scene.groups || [] });
  }, [scene.id, scene.cards, scene.edges, scene.groups]);

  const {
    scrollRef,
    canvasRef,
    zoomRef,
    panRef,
    minimapUpdateRef: mmUpdateRef,
    viewRect,
    getCamera,
    toCanvas,
    navigateTo,
    frameRects,
    beginPan,
  } = useSceneViewport({
    sceneId: scene.id,
    camera: scene.camera,
    onCameraChange,
    cullingEnabled: CULL_ENABLED,
    gridSize: GRID,
  });
  // 캔버스 위 마지막 마우스 좌표(클라이언트) — 선택 없이 n 눌렀을 때 이 위치에 카드 생성.
  const lastMouseRef = useRef<{ x: number; y: number; over: boolean }>({ x: 0, y: 0, over: false });
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const groupFramesRef = useRef<
    Array<{ id: string; frame: { x: number; y: number; w: number; h: number } }>
  >([]);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const selectedGroupIdsRef = useRef(selectedGroupIds);
  selectedGroupIdsRef.current = selectedGroupIds;

  // 전역 어셋 버전 표 구독 — 어셋 원본이 바뀌어 버전이 갱신되면 리렌더돼 카드 썸네일 URL 을 다시 만든다.
  useSyncExternalStore(subscribeAssetVersions, assetVersionsSnapshot, assetVersionsSnapshot);
  // Comfy '생성중' 모듈 store 구독 — 탭 전환(언마운트·재마운트)에도 실행중 표시가 살아있게(#2).
  useSyncExternalStore(subscribeComfyRunning, getComfyRunningVersion, getComfyRunningVersion);

  // 카드가 참조하는 어셋 프로젝트들(only 로 제한 가능)을 다시 읽어 전역 버전 표를 갱신한다.
  // 프로젝트별 in-flight 로 중복 조회를 막는다. 포커스 재조회(Phase 1)와 실시간 변경 수신(Phase 2) 공용.
  const assetVerInFlight = useRef<Set<string>>(new Set());
  const refreshAssetVersions = useCallback((only?: string[], srcCards?: SceneCard[], fresh = false) => {
    const projs = new Set<string>();
    // srcCards 를 주면 그 목록으로(씬 전환 직후엔 내부 cardsRef 가 아직 이전 씬이라, prop scene.cards 를 넘겨 정확히).
    for (const c of srcCards ?? cardsRef.current) {
      for (const r of c.refs || []) {
        if (r.file_path?.startsWith("asset:")) {
          const proj = r.file_path.slice(6).split("|")[0];
          if (proj && (!only || only.includes(proj))) projs.add(proj);
        }
      }
    }
    projs.forEach((proj) => {
      if (assetVerInFlight.current.has(proj)) return;
      assetVerInFlight.current.add(proj);
      api
        .assetTree(proj, fresh) // 실시간 신호는 무효화된 캐시 재사용, 초기/포커스 안전망은 강제 재탐색
        .then((tree) => ingestAssetTreeVersions(proj, tree.children || []))
        .catch(() => {
          /* 조회 실패는 무시(다음 신호에 재시도) */
        })
        .finally(() => assetVerInFlight.current.delete(proj));
    });
  }, []);

  // Phase 0(초기 로드): 카드가 처음 생기면 즉시 최신 버전 확인 — 포커스/WS 신호를 기다리지 않는다.
  // 새로고침 직후엔 localStorage 의 '마지막 본 버전'으로 먼저 그리는데, 앱을 안 보는 사이 원본이
  // 바뀌었을 수 있어 여기서 한 번 맞춘다(바뀐 게 없으면 버전 동일 → 리렌더 없음).
  const didInitVerRefreshScene = useRef<string | null>(null);
  useEffect(() => {
    // 씬별 1회 — 씬 전환 후 새 씬도 최초 1회 버전 맞춤. ★scene.cards(prop=새 씬 카드)로 판정·조회 —
    //  내부 cards state 는 전환 직후 한 박자 늦어(이전 씬), 그걸 쓰면 새 씬을 옛 카드로 '처리완료' 표시해 버린다.
    if (didInitVerRefreshScene.current === scene.id || scene.cards.length === 0) return;
    didInitVerRefreshScene.current = scene.id;
    refreshAssetVersions(undefined, scene.cards, true);
  }, [scene.id, scene.cards, refreshAssetVersions]);

  // Phase 1(안전망): 창을 다시 볼 때(포커스/탭 전환) 최신 버전 확인 — watchdog 이 없거나 놓친 경우 대비.
  useEffect(() => {
    let lastAt = 0; // 포커스 왕복 때 네트워크 폴더를 반복 순회하지 않도록 스로틀
    const onFocus = () => {
      if (document.hidden) return;
      const now = Date.now();
      if (now - lastAt < 30_000) return;
      lastAt = now;
      refreshAssetVersions(undefined, undefined, true);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refreshAssetVersions]);

  // Phase 2(실시간): 어셋 파일 변경 신호(WS→BroadcastChannel) 수신 → 변경된 프로젝트 중 카드가 참조하는
  // 것만 즉시 다시 읽어 버전 표 갱신(새로고침·포커스 불필요). 변경 목록이 비면 카드의 전 프로젝트를 갱신.
  useEffect(() => {
    const bc = openAssetBroadcast();
    if (!bc) return;
    bc.onmessage = (event) => {
      if (event.data?.type !== ASSET_CHANNEL_MESSAGES.assetsUpdated) return;
      const changed: string[] = Array.isArray(event.data.projects) ? event.data.projects : [];
      refreshAssetVersions(changed.length ? changed : undefined);
    };
    return () => bc.close();
  }, [refreshAssetVersions]);
  const cardEls = useRef<Record<string, HTMLDivElement | null>>({});
  const heightsRef = useRef<Record<string, number>>({});
  const widthsRef = useRef<Record<string, number>>({}); // head 등 폭도 내용에 맞춰 자동측정
  const [heightTick, bumpHeights] = useState(0);

  // 카드 크기(캔버스 좌표). 레퍼런스·Input·Output 은 고정폭·측정높이(내용에 맞춰 컴팩트, 리사이즈 없음),
  // 그 외(생성/텍스트/모델/리스트)는 사용자가 조절한 w/h(없으면 기본 CARD_W/CARD_H).
  const isAutoCard = (c: SceneCard) =>
    c.kind === "reference" || c.kind === "output" || c.kind === "input";
  // head = 폭·높이 모두 글씨에 맞춘 자동 크기(측정값). 아직 측정 전이면 fallback.
  const isAutoSize = (c: SceneCard) => c.kind === "head";
  const widthOf = (c: SceneCard) =>
    c.kind === "reference"
      ? CARD_W
      : c.kind === "output" || c.kind === "input"
        ? 150
        : c.kind === "head"
          ? widthsRef.current[c.id] || c.w || 160
          : c.w ?? CARD_W;
  const heightOf = (c: SceneCard) =>
    isAutoCard(c)
      ? heightsRef.current[c.id] || CARD_H
      : c.kind === "head"
        ? heightsRef.current[c.id] || c.h || 48
        : c.h ?? CARD_H;

  // ── f 키 프레이밍 · 미니맵 이동 공용 카메라 유틸 ──
  // 카드 한 장의 바깥 사각형(캔버스 좌표). 레퍼런스는 실제 측정 높이, 생성은 고정.
  const cardRect = (c: SceneCard) => ({
    x: c.x,
    y: c.y,
    w: widthOf(c),
    h: heightOf(c),
  });
  // f 키 — 선택 있으면 그 카드(들) 중심, 없으면 전체 카드. 단일 카드는 과확대 방지로 줌 상한을 낮게.
  const frameView = () => {
    const sel = selectedRef.current;
    const list = sel.size
      ? cardsRef.current.filter((c) => sel.has(c.id))
      : cardsRef.current;
    frameRects(list.map(cardRect), sel.size ? 1.4 : 1.0);
  };

  // 카드 실제 높이 측정 → 연결선 끝점(세로 중앙)을 정확히. offsetHeight 는 scale 영향 없는 레이아웃 높이.
  // 카드 구성(개수·레퍼런스 수)이 바뀔 때만 측정 — 단순 위치 이동(드래그)엔 재측정하지 않는다.
  const structSig = cards
    .map(
      (c) =>
        c.id +
        ":" +
        c.kind +
        ":" +
        (c.refs?.length || 0) +
        // head 는 글씨 내용·크기가 바뀌면 박스 크기도 달라지므로 재측정 트리거에 포함.
        (c.kind === "head" ? ":" + (c.text || "") + ":" + (c.fontSize || 0) : ""),
    )
    .join("|");
  useLayoutEffect(() => {
    let changed = false;
    const nextH: Record<string, number> = {};
    const nextW: Record<string, number> = {};
    for (const c of cardsRef.current) {
      const el = cardEls.current[c.id];
      const h = el?.offsetHeight || heightsRef.current[c.id];
      if (h) nextH[c.id] = h;
      if (h && h !== heightsRef.current[c.id]) changed = true;
      if (c.kind === "head") {
        const w = el?.offsetWidth || widthsRef.current[c.id];
        if (w) nextW[c.id] = w;
        if (w && w !== widthsRef.current[c.id]) changed = true;
      }
    }
    if (changed) {
      heightsRef.current = nextH;
      widthsRef.current = nextW; // head 만 담김 — widthOf 는 head 에서만 이 값을 참조
      bumpHeights((n) => n + 1);
    }
  }, [structSig]);

  // 저장 커밋과 undo/redo 스택은 전용 훅이 소유한다. 화면 상태와 ref는 SceneBoard가 계속 소유한다.
  const {
    persist,
    syncCommitBaseline,
    persistSceneHistory,
    restoreSceneHistory,
    commitDerivedState,
    hasUncommittedCardsOrEdges,
    propagateGenIdsToHistory,
    pruneGenIdsFromHistory,
    undo,
    redo,
  } = useSceneHistory({
    sceneId: scene.id,
    initialSnapshot: {
      cards: settleComfyRunning(scene.cards, isComfyRunning),
      edges: scene.edges,
      groups: scene.groups || [],
    },
    sceneIdRef,
    cardsRef,
    edgesRef,
    groupsRef,
    setCards,
    setEdges,
    setGroups,
    clearSelection: () => setSelected(new Set()),
    onChange,
  });
  // ── C3: 텍스트·comfy 파라미터 입력은 키 입력마다 persist 하면 대형 씬 localStorage 직렬화가 잦아 버벅인다.
  //  화면(setCards)·cardsRef 는 즉시 갱신(생성이 최신값을 읽음), 저장(persist)만 디바운스. 밀린 저장은
  //  입력 blur·언마운트·씬 전환(App 이 flushPending 호출) 시 확정 → 유실·스테일 없음.
  const pendingPersistRef = useRef<number | undefined>(undefined);
  const flushPending = () => {
    if (pendingPersistRef.current !== undefined) {
      clearTimeout(pendingPersistRef.current);
      pendingPersistRef.current = undefined;
    }
    if (!hasUncommittedCardsOrEdges(cardsRef.current, edgesRef.current)) return; // 밀린 편집 없음
    persist(cardsRef.current, edgesRef.current); // 사용자 편집 확정 → undo:true
  };
  const flushPendingRef = useRef(flushPending);
  flushPendingRef.current = flushPending;
  const scheduleInputPersist = () => {
    if (pendingPersistRef.current !== undefined) clearTimeout(pendingPersistRef.current);
    pendingPersistRef.current = window.setTimeout(() => {
      pendingPersistRef.current = undefined;
      flushPendingRef.current();
    }, 400);
  };
  // ── 카드 반영 어댑터 — 화면(cardsRef+setCards)은 항상 즉시, 저장은 mode 로 구분. Comfy 실행부가
  //  persist/scheduleInputPersist 를 직접 부르지 않고 이 하나로만 카드를 반영하게 해 결합을 좁힌다(P4 준비).
  //   · live          : 화면만(저장 안 함) — 순차 실행 중 다음 노드가 최신 출력을 읽게
  //   · deferUser     : 사용자 입력 → 저장 디바운스(blur/실행 시 flush)
  //   · persistUser   : 사용자 편집 확정 저장(undo 스택에 쌓임)
  //   · persistDerived: 실행상태·파생 저장(undo 스택 제외)
  type ApplyCardsMode = "live" | "deferUser" | "persistUser" | "persistDerived";
  const applyCards = (nextCards: SceneCard[], mode: ApplyCardsMode) => {
    cardsRef.current = nextCards;
    setCards(nextCards);
    if (mode === "live") return;
    if (mode === "deferUser") {
      scheduleInputPersist();
      return;
    }
    persist(nextCards, edgesRef.current, groupsRef.current, { undo: mode !== "persistDerived" });
  };
  // 언마운트(탭 이탈·씬 언마운트) 시 밀린 저장 확정 — 그때 onChange 는 아직 현재 씬을 가리킨다.
  //  + 새로고침/창닫기(pagehide) 에도 확정 — 디바운스 대기 중 편집 유실 방지.
  useEffect(() => {
    const onHide = () => flushPendingRef.current();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      flushPendingRef.current(); // 밀린 저장 확정(스택에 반영) 후
      persistSceneHistory(sceneIdRef.current); // 현재 씬 undo 히스토리를 store 에 보관 — 탭 복귀 시 Ctrl+Z 유지
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
      if (c && c.kind === "generation") {
        // ★연결 상태로 정규화 — 저장 refs 가 비어도 연결된 레퍼런스를 다시 모아 프롬프트·생성에 반영한다
        //  ('캔버스에서 연결=레퍼런스'). @·드래그로 직접 넣은 참조는 reconcileRefs 가 보존.
        const normRefs = reconcileRefs(c.refs || [], gatherTarget(c.id, cards, edges));
        // 저장값과 다르면(=연결됐는데 refs 가 비었던 깨진 카드) 한 번 고쳐 저장(undo 대상). 재수집은
        //  idempotent 라 다음 커밋에서 지문이 같아 멈춘다(루프·undo 오염 없음).
        if (sceneRefFingerprint(c.refs || []) !== sceneRefFingerprint(normRefs)) {
          const nextCards = cards.map((cc) => (cc.id === c.id ? { ...cc, refs: normRefs } : cc));
          cardsRef.current = nextCards;
          setCards(nextCards);
          persist(nextCards, edgesRef.current);
        }
        payload = { cardId: c.id, refs: normRefs };
      }
    }
    const sig = payload ? payload.cardId + "|" + sceneRefFingerprint(payload.refs) : "";
    if (sig === lastEmitRef.current) return;
    lastEmitRef.current = sig;
    onBindingRef.current?.(payload);
  }, [selected, cards, edges]);
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
        // 이미 로드된 카드만 갱신 — 씬 전환으로 prune 된 gen 을 재조회 응답이 되살려 넣지 않게(다른 핸들러와 동일 규칙).
        .then((fresh) => fresh && setGenData((prev) => (prev[g.id] ? { ...prev, [g.id]: fresh } : prev)))
        .catch(() => {});
    });
  }, []);
  const onNodeSConfirmNo = useCallback(() => setSConfirm(null), []);
  // T(태그) — 이 생성물이 얹힌 캔버스 카드를 찾아 그 카드의 태그 편집 팝업을 연다(# 키와 동일 경로).
  // 안정 참조(useCallback)라 HistoryBoardNode 의 memo 를 깨지 않는다.
  const onNodeTag = useCallback((g: Generation) => {
    const card = cardsRef.current.find(
      (c) => (c.kind === "generation" || c.kind === "comfy") && variantIds(c).includes(g.id),
    );
    if (card) {
      setTagEditCardId(card.id);
      setTagEditNodeGenId(g.id);
    }
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
  // 카드 삭제·씬 전환에도 핸들러 캐시가 무한 누적되지 않게 — 현재 카드에 없는 id 는 정리(누수 방지).
  useEffect(() => {
    const cache = nodePreviewHandlers.current;
    if (cache.size === 0) return; // 비었으면 지울 것 없음
    // 캐시는 '미리보기를 요청한 카드'만 담긴 subset — size 를 cards.length 와 비교하면 stale 이 남으므로
    //  항상 현재 카드 id 로 prune 한다.
    const live = new Set(cards.map((c) => c.id));
    for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
  }, [cards]);

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
      .filter(
        (c): c is SceneCard =>
          !!c &&
          (c.kind === "reference" || c.kind === "generation" ||
            c.kind === "list" || c.kind === "render"),
      )
      .sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x)); // 위→아래, 같은 높이면 좌→우
    const out: SceneRef[] = [];
    const seenGid = new Set<string>(); // 같은 생성물이 직접+리스트/렌더 두 경로로 와도 한 번만(중복 방지)
    // 카드/리스트가 제공한 참조엔 from_card 표시 — 소스 연결이 바뀌면(reconcileRefs) 함께 사라지게.
    const tagged = (refs: SceneRef[]) => refs.map((r) => ({ ...r, from_card: true as const }));
    // 생성물 카드(generation·generation-list·render 안 항목)를 그 asset 으로 SceneRef 화. genData 미로드/comfy 미저장이면 skip.
    const pushGenRef = (gc?: SceneCard) => {
      const gid = gc?.genId || (gc ? variantIds(gc)[0] : undefined);
      const gen = gid ? genDataRef.current[gid] : undefined;
      const asset = gen?.assets?.[0];
      if (!gid || !asset || seenGid.has(gid)) return;
      seenGid.add(gid);
      const baseName = asset.type === "video" ? "vid" : "img";
      out.push(
        ...tagged([
          {
            file_path: asset.source_url || asset.file_path,
            type: asset.type,
            name: gen?.source_name || `${baseName}-${gid.slice(0, 8)}`,
            thumb: asset.thumbnail_path || asset.file_path,
            source_gen_id: gid,
          },
        ]),
      );
    };
    for (const src of srcs) {
      if (src.kind === "reference" && src.refs) out.push(...tagged(src.refs));
      else if (src.kind === "generation") pushGenRef(src);
      else if (src.kind === "list") {
        const li = collectListInputs(src.id, byId, resolved);
        // 레퍼런스 리스트 → 그 안 레퍼런스 전부(순서대로). 생성물 리스트 → 각 생성물을 asset ref 로.
        if (li.kind === "reference")
          for (const cid of li.sourceIds) {
            const rc = byId.get(cid);
            if (rc?.refs) out.push(...tagged(rc.refs));
          }
        else if (li.kind === "generation")
          for (const cid of li.generationCardIds) pushGenRef(byId.get(cid));
      } else if (src.kind === "render") {
        for (const cid of collectRenderGenCardIds(src.id, byId, resolved)) pushGenRef(byId.get(cid));
      }
    }
    return out;
  };
  // reconcileRefs(연결 refs 정규화·from_card 규칙)는 순수 계산이라 sceneDerive.ts 로 분리(테스트 대상).
  const withGenRefs = (cs: SceneCard[], es: SceneEdge[]): SceneCard[] =>
    cs.map((c) =>
      c.kind === "generation"
        ? { ...c, refs: reconcileRefs(c.refs || [], gatherTarget(c.id, cs, es)) }
        : c,
    );

  // 노드 복사, 캡처 붙여넣기, 에셋/파일 드롭은 전용 훅이 브라우저 이벤트와 업로드 수명주기를 맡는다.
  const { copySelectedNodes, onDragOver, onDrop } = useSceneClipboardDrop({
    sceneIdRef,
    cardsRef,
    edgesRef,
    selectedRef,
    lastMouseRef,
    scrollRef,
    setCards,
    setEdges,
    setSelected,
    toCanvas,
    reconcileGenerationRefs: withGenRefs,
    persist,
    onLoadSceneFile,
    cardWidth: CARD_W,
    cardHeight: CARD_H,
  });

  // ★연결 refs 지연 재동기화 — gatherTarget 은 genData 가 로드된 카드만 asset ref 로 잡는다. 연결 시점에
  //  리스트/렌더로 묶인 둘째~N째 카드의 genData 가 아직 안 실렸으면 그 카드는 skip 돼 card.refs 에 '첫째만'
  //  남아 굳었다(연결 변경 때만 재계산되므로 늦게 온 genData 를 못 반영). genData(또는 생성 소스·토폴로지)
  //  변화 시 모든 생성카드 refs 를 다시 모아, 값이 바뀐 것만 파생 커밋한다(undo 스택 오염·무한루프 없음:
  //  지문 비교 가드 + 시그니처가 refs 를 안 봄).
  const genRefSourceSig = useMemo(
    () =>
      cards
        .filter((c) => c.kind === "generation" || (c.kind === "comfy" && !!(c.genIds?.length || c.genId)))
        .map((c) => `${c.id}:${c.genId || ""}:${(c.genIds || []).join(",")}`)
        .join("|"),
    [cards],
  );
  const refTopologySig = useMemo(
    () => edges.map((e) => `${e.from}>${e.to}:${e.order ?? ""}:${e.role ?? ""}`).join("|"),
    [edges],
  );
  useEffect(() => {
    const cur = cardsRef.current;
    const nextCards = withGenRefs(cur, edgesRef.current);
    const changed = cur.some(
      (c, i) =>
        c.kind === "generation" &&
        sceneRefFingerprint(c.refs || []) !== sceneRefFingerprint(nextCards[i].refs || []),
    );
    if (!changed) return;
    cardsRef.current = nextCards;
    setCards(nextCards);
    // 파생 동기화 — undo 스택은 늘리지 않고(구조 변경 아님) lastCommit·부모만 최신화.
    commitDerivedState({ cards: nextCards, edges: edgesRef.current, groups: groupsRef.current });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genRefSourceSig, refTopologySig, genData]);

  // 하단 프롬프트 트레이 편집(직접ref 삭제·순서변경)을 카드에 저장한다. App 이 sceneActionRef 로 호출.
  //  · 연결 상태로 정규화(reconcileRefs+gatherTarget) → 연결된 레퍼런스는 트레이에서 지워도 다시 병합(연결=레퍼런스).
  //  · persist 경로를 타 undo 스택(Ctrl+Z)에 자연스럽게 섞인다. 값이 안 바뀌면 무시(undo 오염 방지).
  //  ★정규화된 refs 를 반환한다 — 트레이가 이 값을 재채택해 자기 UI 를 맞춘다(전체비우기·재사용 등으로
  //   연결 ref 가 트레이에서 빠져도, 정규화가 되살린 값으로 트레이가 되돌아온다. stale tray·유령생성 방지).
  const setCardRefs = (cardId: string, refs: SceneRef[]): SceneRef[] => {
    const cur = cardsRef.current.find((c) => c.id === cardId);
    if (!cur || cur.kind !== "generation") return refs;
    const nextRefs = reconcileRefs(refs, gatherTarget(cardId, cardsRef.current, edgesRef.current));
    if (sceneRefFingerprint(cur.refs || []) === sceneRefFingerprint(nextRefs)) return nextRefs; // 값 동일 → 저장 생략, 정규화값만 반환
    const nextCards = cardsRef.current.map((c) => (c.id === cardId ? { ...c, refs: nextRefs } : c));
    cardsRef.current = nextCards;
    setCards(nextCards);
    persist(nextCards, edgesRef.current);
    return nextRefs;
  };

  // 전역 mousemove/mouseup/blur 생명주기와 프레임당 이동 합치기는 전용 훅이 담당한다.
  const beginDrag = useSceneDragSession();
  const onResizeDown = useSceneCardResize({
    cardsRef,
    edgesRef,
    zoomRef,
    setCards,
    persist,
    beginDrag,
    defaultSize: { w: CARD_W, h: CARD_H },
    minSize: { w: CARD_MIN_W, h: CARD_MIN_H },
  });

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
      // 드롭 판정: 예전엔 작은 입력 포트(.scene-port.in) 위에 정확히 놔야만 연결됐다 → 조작이 불편.
      // 이제 카드 몸통 어디에 놔도 그 카드로 연결되게 히트영역을 카드 전체로 넓힌다. 유효성(자기연결·종류
      // 규칙)은 아래 canConnect 가 이미 거르므로 안전하다.
      const cardEl = el?.closest(".scene-card") as HTMLElement | null;
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
    beginDrag(move, up, () => setTempWire(null)); // blur: 유효 드롭 좌표 없음 → 연결 안 만들고 임시선만 제거
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
        : kind === "set"
          ? { ...base, kind: "set", w: 198, h: 110, setCfg: { tagsText: "" } }
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
                    ? { ...base, kind: "head", text: "제목", color: "#e8c341", fontSize: 32 }
                    : kind === "render"
                      ? { ...base, kind: "render" }
                      : kind === "comfy"
                        ? {
                            ...base,
                            kind: "comfy",
                            w: 210,
                            h: 190,
                            comfyCfg: { status: "idle", paramExposed: [], paramValues: {}, params: [] },
                          }
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
  // 선택 노드(2개 이상)를 키로 연결 — 포트 드래그 대신. 공간 순서(왼→오른쪽,위→아래)로 인접쌍을
  // canConnect 허용 방향으로 잇는다(a→b 불가면 b→a 시도). 이미 있는 엣지·불가쌍은 건너뛴다.
  const connectSelected = () => {
    const newEdges = buildSelectedConnections(
      cardsRef.current,
      edgesRef.current,
      selectedRef.current,
      uid,
    );
    if (!newEdges.length) return;
    const nextEdges = [...edgesRef.current, ...newEdges];
    const nextCards = withGenRefs(cardsRef.current, nextEdges); // 새 연결로 생성카드 refs 재계산
    setCards(nextCards);
    setEdges(nextEdges);
    persist(nextCards, nextEdges);
  };
  // text 노드 내용 편집 저장(디바운스 없이 즉시 — 로컬 저장이라 가벼움). output 노드의 채널 이름도 text 필드 공용.
  const setNodeText = (cardId: string, text: string) => {
    const nextCards = cardsRef.current.map((c) => (c.id === cardId ? { ...c, text } : c));
    cardsRef.current = nextCards; // 즉시 반영 — 생성/flush 가 최신 텍스트를 읽게
    setCards(nextCards);
    scheduleInputPersist(); // 저장은 디바운스(blur·언마운트·씬전환 시 flush)
  };
  const setNodeSetFolder = (cardId: string, folder?: SceneSetFolder) => {
    const nextCards = cardsRef.current.map((c) =>
      c.id === cardId
        ? { ...c, setCfg: { ...(c.setCfg || {}), folder } }
        : c,
    );
    applyCards(nextCards, "persistUser");
  };
  const setNodeSetTagsText = (cardId: string, tagsText: string) => {
    const nextCards = cardsRef.current.map((c) =>
      c.id === cardId
        ? { ...c, setCfg: { ...(c.setCfg || {}), tagsText } }
        : c,
    );
    applyCards(nextCards, "deferUser");
  };
  // head 노드 글씨 색 저장.
  const setNodeColor = (cardId: string, color: string) => {
    const nextCards = cardsRef.current.map((c) => (c.id === cardId ? { ...c, color } : c));
    setCards(nextCards);
    persist(nextCards, edgesRef.current);
  };
  // head 노드 글씨 크기 저장(12~200px 클램프). 박스는 측정으로 자동 맞춰진다.
  const setNodeFontSize = (cardId: string, fontSize: number) => {
    const fs = Math.max(12, Math.min(200, Math.round(fontSize)));
    const nextCards = cardsRef.current.map((c) => (c.id === cardId ? { ...c, fontSize: fs } : c));
    setCards(nextCards);
    persist(nextCards, edgesRef.current);
  };
  // comfy 노드: comfyCfg 부분 병합 저장(모달 저장·실행 상태 갱신·파라미터 값 변경 공용).
  //  opts.undo=false = 실행상태(running/done/failed)·재파싱 등 파생 저장 → undo 스택에 안 쌓는다(사용자 편집만 undo).
  const patchComfyCfg = (
    cardId: string,
    patch: Partial<SceneComfyCfg>,
    opts?: { undo?: boolean; defer?: boolean }, // defer=true = 파라미터 입력 → 저장 디바운스(blur/실행 시 flush)
  ) => {
    const nextCards = cardsRef.current.map((c) =>
      c.id === cardId && c.kind === "comfy"
        ? { ...c, comfyCfg: { ...(c.comfyCfg || {}), ...patch } }
        : c,
    );
    // 순차 comfy 실행 시 다음 comfy 가 최신 출력을 보게(체인 정확성) — applyCards 가 cardsRef 즉시 갱신.
    const mode: ApplyCardsMode = opts?.defer
      ? "deferUser"
      : opts?.undo === false
        ? "persistDerived"
        : "persistUser";
    applyCards(nextCards, mode);
  };
  // 노드별 배치수 설정 — 카드에 저장해 노드마다 각자 관리(1~4). 씬 저장으로 유지.
  const setCardBatch = (cardId: string, n: number) => {
    const b = Math.max(1, Math.min(4, n));
    const nextCards = cardsRef.current.map((c) => (c.id === cardId ? { ...c, batchCount: b } : c));
    cardsRef.current = nextCards;
    setCards(nextCards);
    persist(nextCards, edgesRef.current);
  };
  // comfy 노드: 노출 파라미터 1개 값 변경(카드 인라인 컨트롤에서).
  const setComfyParam = (cardId: string, key: string, value: string | number | boolean) => {
    const card = cardsRef.current.find((c) => c.id === cardId);
    const values = { ...(card?.comfyCfg?.paramValues || {}), [key]: value };
    patchComfyCfg(cardId, { paramValues: values }, { defer: true }); // 파라미터 입력 저장 디바운스(blur/실행 시 flush)
  };
  // comfy 노드에 새 API(워크플로우 JSON)를 넣는다 — 빈 노드 최초 로드·기존 노드 교체 공용.
  //  파싱 성공해야 반영한다(실패 시 기존 유지). 다른 워크플로우로 바뀌므로 노출 파라미터·값·결과는 초기화한다.
  const applyComfyApi = async (cardId: string, name: string, content: string): Promise<boolean> => {
    const sid = sceneIdRef.current; // 파싱 대기 중 씬 전환되면 다른 씬에 반영 안 함
    try {
      const res = await comfyApi.parse(content, []);
      if (sceneIdRef.current !== sid) return false;
      // 다른 워크플로우로 교체 → 노출·값·결과뿐 아니라 카드에 쌓인 생성물(대표 genId·목록 genIds)도 초기화한다.
      // (안 지우면 옛 워크플로 결과가 대표·▤배지·렌더 입력으로 남아 새 워크플로에 잘못 딸려간다.)
      const nextCards = cardsRef.current.map((c) =>
        c.id === cardId && c.kind === "comfy"
          ? {
              ...c,
              genId: null,
              genIds: [],
              comfyCfg: {
                ...(c.comfyCfg || {}),
                name,
                content,
                nodeCount: res.node_count,
                paramExposed: [],
                paramValues: {},
                params: [],
                outputs: [],
                output: null,
                status: "idle" as const,
                error: null,
              },
            }
          : c,
      );
      applyCards(nextCards, "persistUser");
      return true;
    } catch {
      return false; // 파싱 실패 — 기존 워크플로우 그대로 둔다(교체 취소)
    }
  };
  // comfy 노드: 파일 선택으로 API 교체(.json). 버튼에서 호출 — 숨은 input 을 즉석 생성.
  const pickComfyFile = (cardId: string) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      const text = await f.text();
      await applyComfyApi(cardId, f.name.replace(/\.json$/i, ""), text);
    };
    input.click();
  };
  // comfy 노드: 현재 워크플로우를 다시 파싱(노드수 갱신 + 실행상태/에러 리셋 → 재실행 준비). 내용·노출은 유지.
  const refreshComfy = async (cardId: string) => {
    const content = cardsRef.current.find((c) => c.id === cardId)?.comfyCfg?.content;
    if (!content) return;
    const sid = sceneIdRef.current;
    try {
      const res = await comfyApi.parse(content, []);
      if (sceneIdRef.current !== sid) return;
      patchComfyCfg(cardId, { nodeCount: res.node_count, status: "idle", error: null }, { undo: false }); // 재파싱=파생, undo 제외
    } catch {
      /* 파싱 실패 — 상태만 두고 무시 */
    }
  };
  // comfy 노드 입력 수집 — 연결된 레퍼런스/생성물/리스트를 공간 순서(위→아래,왼→오)대로,
  // 종류(image/video)별로 풀해상도 URL 로 모은다. (텍스트 노드 gather 패턴과 동형)
  // Comfy 노드의 이미지/영상 출력을 라이브러리 generation 으로 저장 → '내 작업'에 자동 편입.
  //  · 실행이 끝나 출력이 생기면 자동 호출(silent). 텍스트 출력은 서버가 제외.
  //  · 프롬프트=노출 text 파라미터 값(연결이면 연결텍스트), 없으면 워크플로명.
  //  · 저장 후 outputs[i].saved_generation_id 마킹(표시용). 멱등은 서버가 file_path 로 판정(재실행마다 새 파일=새 항목).
  const saveComfyToLibrary = async (
    cardId: string,
    opts?: SaveComfyOptions,
  ): Promise<SaveComfyResult> => {
    const silent = opts?.silent;
    const sid = sceneIdRef.current; // 저장 대기 중 씬 전환 시 다른 씬 카드에 반영 안 함
    const card = cardsRef.current.find((c) => c.id === cardId);
    const cfg = card?.comfyCfg;
    const runContent = opts?.configSnapshot?.content ?? cfg?.content; // 저장 시작 시점 워크플로 — 응답 도착 전 교체되면 카드 상태는 안 건드린다
    const configSnapshot =
      opts?.configSnapshot ||
      (runContent
        ? {
            name: cfg?.name,
            content: runContent,
            paramValues: { ...(cfg?.paramValues || {}) },
            params: cfg?.params?.map((param) => ({
              ...param,
              choices: param.choices ? [...param.choices] : param.choices,
            })),
          }
        : undefined);
    const outs = (opts?.outputs ?? cfg?.outputs ?? []).filter(
      (o) => (o.kind === "image" || o.kind === "video") && o.url,
    );
    if (!outs.length) {
      if (!silent) flashMsg("저장할 이미지·영상 출력이 없습니다");
      return { saved: 0, failed: 0 };
    }
    const map = new Map(cardsRef.current.map((c) => [c.id, c] as const));
    // 프롬프트·입력 메타 수집은 '최선 노력' — 여기서 예외가 나도(엣지 순회·malformed 워크플로 등) 출력물 저장은
    //  진행돼야 하고, 렌더 배치 실행(runPlanComfyCopies)이 중단되면 안 된다(silent 자동저장 규약). 이전엔 이 구간이
    //  try 밖이라 의존이 섞인 복잡한 보드에서 예외 1개가 렌더 전체를 죽여 '노드는 완료·저장 실패·생성 미시작'을 유발했다.
    //  실패 시 프롬프트=워크플로명, 입력=빈 목록으로 강등한다.
    let promptText = configSnapshot?.name || "Comfy 출력";
    let inputs: { url: string; type: "image" | "video"; name: string; source_gen_id: string | null }[] = [];
    const executedParamValues =
      opts?.inputSnapshot?.executedParamValues ?? configSnapshot?.paramValues ?? {};
    try {
      if (opts?.inputSnapshot) {
        // 자동 저장은 '현재 그래프'를 다시 읽지 않고 실제 API에 들어간 텍스트·미디어를 사용한다.
        // 실행 직후 연결을 바꿔도 옛 출력의 출처와 seed가 새 입력으로 잘못 기록되지 않는다.
        promptText =
          opts.inputSnapshot.textParamKeys
            .map((key) => String(executedParamValues[key] ?? ""))
            .filter((text) => text.trim())
            .join("\n") || configSnapshot?.name || "Comfy 출력";
        inputs = opts.inputSnapshot.media.map((item) => ({
          url: item.url,
          type: item.type,
          name: item.name,
          source_gen_id: item.source_gen_id ?? null,
        }));
      } else {
        // 수동 저장은 현재 카드 기준으로 메타를 수집한다.
        const driveKeys = [...comfyTextDriveKeys(cfg?.params, cfg?.content)];
        const connected = hasTextConnection(cardId, map, edgesRef.current, refParents);
        const linked = connected ? incomingTextOf(cardId, map, edgesRef.current) : "";
        promptText =
          driveKeys
            .map((key) => (connected ? linked : String(executedParamValues[key] ?? "")))
            .filter((text) => text.trim())
            .join("\n") || configSnapshot?.name || "Comfy 출력";
        inputs = gatherComfyMedia(cardId, cardsRef.current, edgesRef.current, genDataRef.current).map((item) => ({
          url: item.url,
          type: item.type,
          name: item.name,
          source_gen_id: item.source_gen_id ?? null, // 생성물 입력이면 계보 연결(서버가 열람권한 검증)
        }));
      }
    } catch (e) {
      console.warn("comfy 저장 메타(프롬프트/입력) 수집 실패 — 출력물만 저장:", e);
    }
    try {
      const res = await comfyApi.saveToLibrary({
        outputs: outs.map((o) => ({ url: o.url as string, kind: o.kind })),
        name: configSnapshot?.name,
        prompt: promptText,
        // 파라미터값(노드|필드) + 생성 정보용 표준 메타(model·비율·해상도)를 함께 저장.
        params: {
          ...executedParamValues,
          ...comfyGenMeta(configSnapshot?.content, configSnapshot?.params, executedParamValues),
        },
        inputs,
        elapsed_seconds: opts?.elapsedSeconds ?? null,
      });
      if (sceneIdRef.current !== sid) return { saved: res.saved.length, failed: 0 }; // 저장 후 씬 전환됨 → 카드 상태 반영 생략(라이브러리엔 이미 저장됨)
      if (opts?.isInputCurrent && !opts.isInputCurrent()) return { saved: res.saved.length, failed: 0 };
      const byUrl = new Map(res.saved.map((s) => [s.url, s.generation_id]));
      const savedIds = res.saved.map((s) => s.generation_id);
      if (
        configSnapshot &&
        !isSceneComfyConfigCurrent(cardsRef.current, cardId, configSnapshot)
      ) {
        return { saved: res.saved.length, failed: 0 };
      }
      // ★현재 카드 기준으로 패치 — 저장 대기 중 재실행(outputs 교체)되면 늦게 온 응답이
      //  옛 outputs 로 되돌리지 않게(레이스 방지). url 이 여전히 있는 것만 마킹.
      //  + 이 노드가 만든 생성물 id 를 card.genIds 에 누적 → 생성카드처럼 관리·렌더 가능(kind='comfy' 유지).
      const next = cardsRef.current.map((c) => {
        if (c.id !== cardId || c.kind !== "comfy") return c;
        // 저장 진행 중 워크플로가 교체됐으면(content 변경) 옛 결과를 새 워크플로 카드에 붙이지 않는다.
        //  (라이브러리에는 이미 저장됨 — 여기선 카드의 genIds/genId/outputs 만 안 건드림.)
        if (c.comfyCfg?.content !== runContent) return c;
        const outputsToLink = opts?.outputs ?? c.comfyCfg?.outputs ?? [];
        const linkedOutputs = outputsToLink.map((o) =>
          o.url && byUrl.has(o.url) ? { ...o, saved_generation_id: byUrl.get(o.url) } : o,
        );
        const genIds = [...(c.genIds || [])];
        for (const id of savedIds) if (id && !genIds.includes(id)) genIds.push(id); // 오래된→최신
        // 대표(현재 표시)는 방금 만든 최신 결과로 갱신 — 생성하면 카드가 새 결과를 보여준다.
        // (사용자가 팝업에서 다른 걸 대표로 고르면 setCardVariant 가 덮고, 다음 실행 때 다시 최신으로.)
        const newestSaved = savedIds[savedIds.length - 1];
        return {
          ...c,
          genIds,
          genId: newestSaved || c.genId || genIds[genIds.length - 1] || null,
          comfyCfg: { ...(c.comfyCfg || {}), outputs: linkedOutputs },
        };
      });
      cardsRef.current = next;
      setCards(next);
      persist(next, edgesRef.current, groupsRef.current, { undo: false }); // 저장된 gid 반영=파생, undo 제외
      const savedCard = next.find((c) => c.id === cardId);
      if (savedCard) propagateGenIdsToHistory(cardId, savedCard); // 누적된 결과를 undo/redo 히스토리에도 반영(#3)
      // 방금 만든 결과를 canvas glow 로 강조(#1b) — comfy 결과는 저장 즉시 done 이라 active baseline 을
      //  먼저 심고 done 으로 전환시켜야 glow 규칙(active→done)이 발화한다(generation 카드와 동일 강조).
      if (savedIds.length) {
        seedPending(savedIds);
        for (const id of savedIds) observeStatus(id, "done");
      }
      if (!silent) {
        const created = res.saved.filter((s) => !s.existed).length;
        flashMsg(created ? `${created}개 내 작업에 저장했습니다` : "이미 내 작업에 저장돼 있습니다");
      }
      return { saved: res.saved.length, failed: 0 };
    } catch (e) {
      // 자동(silent) 저장 실패는 조용히 로그만 — 매 실행 에러 토스트로 도배하지 않는다.
      if (silent) console.warn("comfy 출력 자동 저장 실패:", e);
      else flashMsg(e instanceof Error ? e.message : "내 작업 저장 실패");
      return { saved: 0, failed: outs.length };
    }
  };
  // Comfy 실행의 중복 방지·배치 정산·씬 전환 중단·실행 표시를 전용 훅에 위임한다.
  const {
    comfyWaitingIds,
    runningComfyIds,
    runComfy,
    orchestrateGenerate,
    orchestrateRender,
  } = useSceneComfyExecution({
    sceneIdRef,
    cardsRef,
    edgesRef,
    genDataRef,
    refParents,
    setCards,
    flushPending,
    patchComfyCfg,
    saveComfyToLibrary,
    onGenerateCard,
    onRenderCards,
    onRenderCardRuns,
    onComfyRunningChange,
  });
  // render 노드: 특정 생성카드의 체크 토글(체크된 카드만 Render 대상). unchecked 목록에 넣고 뺀다.
  const toggleRenderCheck = (renderId: string, genCardId: string) => {
    // 렌더 행이 복수 선택돼 있고 클릭한 게 그중 하나면 선택 전부에 같은 상태를 적용(일괄 체크/해제).
    const rs = rowSelRef.current;
    const exists = new Set(cardsRef.current.map((c) => c.id)); // stale 선택 방어 — 존재하는 카드만
    const targets = (
      rs.listId === renderId && rs.cids.has(genCardId) && rs.cids.size > 1
        ? [...rs.cids].filter((c) => exists.has(c))
        : [genCardId]
    );
    const nextCards = cardsRef.current.map((c) => {
      if (c.id !== renderId) return c;
      const un = new Set(c.unchecked || []);
      const willUncheck = !un.has(genCardId); // 클릭한 행의 새 상태로 통일
      for (const t of targets) willUncheck ? un.add(t) : un.delete(t);
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
  // 여러 항목(movingCids)을 insertIndex(원래 배열 기준) 로 함께 옮긴다 — 상대순서 보존, insertIndex 이후
  //  첫 '이동 안 하는' 항목 앞에 블록으로 삽입. 순서가 그대로면 아무것도 안 함.
  const reorderListMultiToIndex = (listId: string, movingCids: string[], insertIndex: number) => {
    const byId = new Map(cardsRef.current.map((c) => [c.id, c] as const));
    const order = [...collectListInputs(listId, byId, edgesRef.current).sourceIds];
    const movingSet = new Set(movingCids.filter((c) => order.includes(c)));
    if (!movingSet.size) return;
    if (movingSet.size === 1) return reorderListToIndex(listId, [...movingSet][0], insertIndex);
    const movingOrdered = order.filter((c) => movingSet.has(c)); // 현재 상대순서 보존
    const rest = order.filter((c) => !movingSet.has(c));
    let anchor: string | null = null; // insertIndex 이후 첫 비이동 항목 = 이 앞에 블록 삽입
    for (let i = insertIndex; i < order.length; i++)
      if (!movingSet.has(order[i])) { anchor = order[i]; break; }
    const pos = anchor ? rest.indexOf(anchor) : rest.length;
    const next = [...rest.slice(0, pos), ...movingOrdered, ...rest.slice(pos)];
    if (next.join("|") === order.join("|")) return; // 변화 없음
    commitListOrder(listId, next);
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
    // ★리스트가 선택돼 있을 때만 행 순서 변경. 미선택이면 여기서 빠져(stopPropagation 안 함) 이벤트를
    //  보드로 흘려보내 리스트 카드 이동(드래그)이 되게 한다 — 옮기려다 실수로 순서가 바뀌던 불편 해소.
    //  (순서를 바꾸려면 먼저 리스트를 클릭해 선택한 뒤 행을 드래그한다.)
    if (!selectedRef.current.has(listId)) return;
    e.preventDefault();
    e.stopPropagation(); // 카드 이동/마퀴로 번지지 않게
    const container = (e.currentTarget as HTMLElement).closest("[data-reorder]") as HTMLElement | null;
    if (!container) return;
    const GAP = 4; // 삽입선을 항목 사이 틈 가운데쯤에
    let insertIndex = -1;
    const recompute = (cx: number, cy: number) => {
      const items = Array.from(container.querySelectorAll<HTMLElement>("[data-reid]"));
      if (!items.length) return;
      // 흰 선은 마퀴와 같은 컨테이너(scrollRef)에 absolute 로 그린다 — 화면좌표를 그 기준 로컬좌표로 변환.
      // (position:fixed 는 상위 backdrop-filter/transform 이 있으면 엉뚱하게 잡혀 안 보일 수 있어 회피.)
      const sr = scrollRef.current?.getBoundingClientRect();
      const ox = sr ? sr.left : 0;
      const oy = sr ? sr.top : 0;
      let idx = items.length;
      if (orientation === "v") {
        for (let i = 0; i < items.length; i++) {
          const r = items[i].getBoundingClientRect();
          if (cy < r.top + r.height / 2) { idx = i; break; }
        }
        const line =
          idx < items.length
            ? (() => { const r = items[idx].getBoundingClientRect(); return { x: r.left - ox, y: r.top - oy - GAP, w: r.width, h: 3 }; })()
            : (() => { const r = items[items.length - 1].getBoundingClientRect(); return { x: r.left - ox, y: r.bottom - oy + GAP - 3, w: r.width, h: 3 }; })();
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
            ? (() => { const r = items[idx].getBoundingClientRect(); return { x: r.left - ox - GAP, y: r.top - oy, w: 3, h: r.height }; })()
            : (() => { const r = items[items.length - 1].getBoundingClientRect(); return { x: r.right - ox + GAP - 3, y: r.top - oy, w: 3, h: r.height }; })();
        setReorderLine(line);
      }
      insertIndex = idx;
    };
    recompute(e.clientX, e.clientY);
    setReorderFrom(fromId);
    // 드래그한 항목이 이 리스트의 선택에 포함돼 있으면 선택 전부를 함께 이동(상대순서 보존). 아니면 그것만.
    const rs = rowSelRef.current;
    const movingCids =
      rs.listId === listId && rs.cids.has(fromId) ? [...rs.cids] : [fromId];
    const move = (ev: MouseEvent) => recompute(ev.clientX, ev.clientY);
    const up = () => {
      if (insertIndex >= 0) reorderListMultiToIndex(listId, movingCids, insertIndex);
      setReorderLine(null);
      setReorderFrom(null);
    };
    beginDrag(move, up, () => { setReorderLine(null); setReorderFrom(null); }); // blur: 순서 커밋 안 함, 표시선만 정리
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
      if (gid && disabledIds.has(gid)) continue; // 비활성(회색) 결과는 View 재생·미리보기에서 제외
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
    // comfy 노드의 이미지/영상 출력물도 View 클립으로 추가(연결 순서 = 공간순).
    const comfySrcs = es
      .filter((e) => e.to === viewId)
      .map((e) => byId.get(e.from))
      .filter((c): c is SceneCard => c?.kind === "comfy")
      .sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x));
    for (const c of comfySrcs)
      for (const m of comfyOutputMedia(c))
        clips.push({ url: m.url, type: m.kind, name: c.comfyCfg?.name || "Comfy 결과", thumb: m.url });
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
    if (buildViewClips(viewId, byId, es).length) {
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
    flushPending(); // 디바운스 중인 텍스트/파라미터 편집을 먼저 확정 — 대표선택의 파생저장에 흡수돼 undo 대상에서 빠지지 않게
    const nc = cardsRef.current.map((c) => (c.id === cardId ? { ...c, genId: gid } : c));
    applyCards(nc, "persistDerived"); // 대표 선택은 파생 저장(undo 스택 제외) — Ctrl+Z 에서 대표는 항상 유지(사용자 요구)
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
    cardsRef.current = nc; // restoreState 가 현재 대표를 cardsRef 에서 읽으므로, 삭제로 대표가 바뀌는 경로도 ref 를 즉시 맞춘다
    setCards(nc);
    persist(nc, edgesRef.current);
    pruneGenIdsFromHistory(cardId, removed); // 삭제된 변형을 히스토리에서도 제거 — undo 로 되살려 깨진 참조 방지
  };

  const beginVariantMarquee = useSceneMarqueeSelection<string>({
    selected: popupSel,
    surfaceRef: varGridRef,
    setSelected: setPopupSel,
    setMarquee: setPopupMarq,
    beginDrag,
    cellSelector: ".scene-varpop-item",
    keyOf: (element) => element.dataset.gid,
    preventDefault: true,
  });

  // 팝업 그리드 배경 드래그 = 마퀴 복수선택(썸네일 위에서 시작하면 클릭/더블클릭에 양보).
  const onVarGridMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest(".scene-varpop-item")) return;
    beginVariantMarquee(e);
  };

  // ── 그룹(Ctrl+G) — 선택 카드를 하나의 묶음으로. 테두리(rect)는 수동 지정·리사이즈, 멤버십은 드롭 위치로 ──
  // 카드 id 목록의 바운딩박스 → 그룹 테두리 rect(위쪽 헤더 높이 포함). 그룹 생성 시 초기 rect 로 사용.
  const rectFromCards = (ids: string[]) =>
    groupRectFromCards(
      ids,
      new Map(cardsRef.current.map((card) => [card.id, card] as const)),
      (card) => ({ w: widthOf(card), h: heightOf(card) }),
    );
  // pruneGroups(삭제·유령 카드 정리)는 순수 계산이라 sceneDerive.ts 로 분리(테스트 대상).
  const applyGroups = (next: SceneGroup[]) => {
    setGroups(next);
    const validIds = new Set(next.map((group) => group.id));
    setSelectedGroupIds((previous) => {
      const pruned = new Set([...previous].filter((id) => validIds.has(id)));
      return pruned.size === previous.size ? previous : pruned;
    });
    persist(cardsRef.current, edgesRef.current, next);
  };
  const groupSelected = () => {
    const ids = [...selectedRef.current].filter((id) => cardsRef.current.some((c) => c.id === id));
    if (!ids.length) return;
    // 카드는 한 그룹에만 — 선택 카드를 기존 그룹에서 떼고(빈 그룹 제거) 새 그룹으로 묶는다.
    const existing = new Set(cardsRef.current.map((c) => c.id));
    const stripped = pruneGroups(groupsRef.current, new Set(ids), existing);
    const grp: SceneGroup = { id: uid(), name: `그룹 ${stripped.length + 1}`, cardIds: ids, rect: rectFromCards(ids) };
    applyGroups([...stripped, grp]);
    setSelected(new Set());
    setSelectedGroupIds(new Set([grp.id]));
  };
  const groupControlIds = (id: string) =>
    sceneGroupControlTargetIds(selectedGroupIdsRef.current, id);
  const activateGroupControl = (id: string) => {
    if (selectedGroupIdsRef.current.has(id)) return;
    setSelected(new Set());
    setSelectedGroupIds(new Set([id]));
  };
  // × 버튼 = 그룹 해제(멤버 카드는 그대로 두고 묶음만 제거).
  const removeGroup = (id: string) => {
    const targets = new Set(groupControlIds(id));
    applyGroups(groupsRef.current.filter((g) => !targets.has(g.id)));
  };
  const renameGroup = (id: string, name: string) =>
    applyGroups(groupsRef.current.map((g) => (g.id === id ? { ...g, name } : g)));
  const toggleGroupCollapsed = (id: string) => {
    const targets = new Set(groupControlIds(id));
    const collapsed = !groupsRef.current.find((g) => g.id === id)?.collapsed;
    applyGroups(groupsRef.current.map((g) => (targets.has(g.id) ? { ...g, collapsed } : g)));
  };
  const setGroupColor = (id: string, color?: string) => {
    const targets = new Set(groupControlIds(id));
    applyGroups(
      groupsRef.current.map((g) =>
        targets.has(g.id) ? { ...g, color: color || undefined } : g,
      ),
    );
  };
  const setSelectedGroupsColor = (color?: string) => {
    const targets = selectedGroupIdsRef.current;
    if (!targets.size) return;
    applyGroups(
      groupsRef.current.map((g) =>
        targets.has(g.id) ? { ...g, color: color || undefined } : g,
      ),
    );
  };
  // 카드 드롭 위치로 그룹 멤버십 재배정 — 다른 프레임 안에 놓으면 그 그룹으로 이동. 어느 프레임에도
  //  안 들면 원래 그룹 유지(슬로우 드래그는 박스가 자동맞춤으로 담음). 그룹서 빼는 건 '빠르게 이탈'로만.
  //  · startFrames: 드래그 시작 시점의 그룹 프레임 스냅샷(자동 그룹 프레임이 드래그 중 흔들리지 않게).
  //  · setGroups 로 반영하고, persist 에 넘길 최신 그룹 배열을 반환(변화 없으면 현재 배열 그대로).
  const reassignGroups = (
    targetIds: string[],
    startFrames: { id: string; frame: { x: number; y: number; w: number; h: number } }[],
    ejected: Set<string> = new Set(), // 속도 이탈로 튕겨낸 카드 — 원래 그룹으로는 안 돌아감(이탈 확정)
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
      // ★슬로우 드래그로 그룹 밖에 놓아도 원래 그룹을 유지한다(박스가 자동맞춤으로 그 카드를 담음) —
      //  그룹에서 빼는 건 '빠르게 이탈'로만. (드롭 위치가 어느 프레임에도 안 들면 예전엔 해제됐다.)
      if (!ejected.has(tid) && hitId === null) hitId = curId;
      if (ejected.has(tid) && hitId === curId) hitId = null; // 튕겨낸 카드가 원래 그룹에 다시 떨어져도 이탈 확정
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
    // ★캔버스에서 카드를 지워도 서버 생성물('내 작업')은 건드리지 않는다(Jay 결정 ⓑ) — 캔버스 편집물만 제거.
    //  (생성물을 실제로 지우려면 라이브러리에서 별도로. 이렇게 해야 삭제→Ctrl+Z 로 되살려도 생성물이 온전하다.)
    const nextEdges = edgesRef.current.filter((e) => !idset.has(e.from) && !idset.has(e.to));
    // 삭제된 output(채널)을 가리키던 input 은 channel 을 비운다(무효 참조 방지).
    const survivingCards = cardsRef.current
      .filter((c) => !idset.has(c.id))
      .map((c) =>
        c.kind === "input" && c.channel && idset.has(c.channel) ? { ...c, channel: undefined } : c,
      );
    const nextCards = withGenRefs(survivingCards, nextEdges);
    // 삭제 후 카드 기준으로 그룹 정리 — 삭제 카드 제거 + 유령 멤버 id 도 정리.
    const nextGroups = pruneGroups(groupsRef.current, idset, new Set(nextCards.map((c) => c.id)));
    setCards(nextCards);
    setEdges(nextEdges);
    setGroups(nextGroups);
    setSelected(new Set());
    // 삭제된 카드가 리스트/렌더 행 선택에 있으면 그 항목만 걷어낸다(리스트 노드 자체가 지워지면 통째 해제).
    setRowSel((prev) => {
      if (!prev.cids.size) return prev;
      if (idset.has(prev.listId)) return { listId: "", cids: new Set() };
      const cids = new Set([...prev.cids].filter((c) => !idset.has(c)));
      return cids.size === prev.cids.size ? prev : { listId: prev.listId, cids };
    });
    setCardMenu((m) => (m && idset.has(m) ? null : m)); // 삭제된 카드의 팝업은 닫는다
    persist(nextCards, nextEdges, nextGroups);
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
  //  언마운트(탭 이탈·씬 언마운트) 시 핸들을 비워 옛 SceneBoard 클로저/refs 가 App 에 붙잡히지 않게 한다.
  useLayoutEffect(() => {
    if (actionRef) actionRef.current = { deleteSelected: () => deleteCards(selResultCardIds()), setCardRefs, flushPending };
    return () => {
      if (actionRef) actionRef.current = null;
    };
  });

  // ── 전역 키보드 단축키 ──
  // 실제 키 판정·리스너 생명주기는 useSceneKeyboardShortcuts가 담당하고,
  // 여기서는 SceneBoard 상태를 바꾸는 행동만 제공한다.
  const createNodeFromPicker = (kind: SceneCardKind) => {
    const picker = nodePickerRef.current;
    if (!picker) return;
    const at = { x: picker.cx, y: picker.cy };
    setNodePicker(null);
    if (kind === "generation") createGenerationConnected(at);
    else createNode(kind, at);
  };

  const toggleNodePicker = (): boolean => {
    if (nodePickerRef.current) {
      setNodePicker(null);
      return true;
    }
    const mouse = lastMouseRef.current;
    const rect = scrollRef.current?.getBoundingClientRect();
    if (!mouse.over || !rect) return false;

    const canvasPoint = toCanvas(mouse.x, mouse.y);
    const menuWidth = 150;
    const menuHeight = 9 * 29 + 10;
    let screenX = mouse.x - rect.left;
    let screenY = mouse.y - rect.top;
    if (screenX + menuWidth > rect.width) {
      screenX = Math.max(4, rect.width - menuWidth - 4);
    }
    if (screenY + menuHeight > rect.height) {
      screenY = Math.max(4, screenY - menuHeight);
    }
    setNodePicker({
      sx: screenX,
      sy: screenY,
      cx: Math.round(canvasPoint.x - CARD_W / 2),
      cy: Math.round(canvasPoint.y - CARD_H / 2),
    });
    return true;
  };

  const autoConnectSelection = (): boolean => {
    const selectedCards = [...selectedRef.current]
      .map((id) => cardsRef.current.find((card) => card.id === id))
      .filter((card): card is SceneCard => !!card);
    if (selectedCards.length < 2) return false;

    const layerOf = (card: SceneCard) =>
      card.kind === "generation"
        ? 1
        : card.kind === "list" || card.kind === "render"
          ? 2
          : card.kind === "view"
            ? 3
            : card.kind === "output"
              ? 4
              : 0;
    const cardsById = new Map(cardsRef.current.map((card) => [card.id, card] as const));

    if (selectedCards.every((card) => card.kind === "generation")) {
      const sorted = [...selectedCards].sort((left, right) => left.x - right.x);
      const pairs: Array<[string, string]> = [];
      for (let index = 0; index < sorted.length - 1; index++) {
        pairs.push([sorted[index].id, sorted[index + 1].id]);
      }
      if (!pairs.length) return false;
      addEdges(pairs);
      return true;
    }

    const pairs: Array<[string, string]> = [];
    for (const source of selectedCards) {
      const candidates = selectedCards.filter(
        (target) =>
          layerOf(target) > layerOf(source) &&
          canConnect(source, target, cardsById, edgesRef.current),
      );
      if (!candidates.length) continue;
      const minimumLayer = Math.min(...candidates.map(layerOf));
      for (const target of candidates) {
        if (layerOf(target) !== minimumLayer) continue;
        // 양방향이 가능한 모호한 쌍만 화면 위치로 방향을 정하고, 한 방향만 가능한 연결은 규칙을 유지한다.
        if (
          canConnect(target, source, cardsById, edgesRef.current) &&
          target.x < source.x
        ) {
          pairs.push([target.id, source.id]);
        } else {
          pairs.push([source.id, target.id]);
        }
      }
    }
    if (!pairs.length) return false;
    addEdges(pairs);
    return true;
  };

  const arrangeSelection = (repeat: boolean): boolean => {
    const picked = [...selectedRef.current]
      .map((id) => cardsRef.current.find((card) => card.id === id))
      .filter((card): card is SceneCard => !!card);
    if (picked.length < 2) return false;
    if (repeat) return true;

    const layoutNodes = picked.map((card) => ({
      id: card.id,
      x: card.x,
      y: card.y,
      w: widthOf(card),
      h: cardEls.current[card.id]?.offsetHeight || heightOf(card),
    }));
    const positions = arrangeNodes(layoutNodes, edgesRef.current);
    const changed = picked.some(
      (card) => card.x !== positions[card.id].x || card.y !== positions[card.id].y,
    );
    if (!changed) return true;

    const moved = cardsRef.current.map((card) =>
      positions[card.id]
        ? { ...card, x: positions[card.id].x, y: positions[card.id].y }
        : card,
    );
    const nextCards = withGenRefs(moved, edgesRef.current);
    setCards(nextCards);
    persist(nextCards, edgesRef.current);
    return true;
  };

  const disableSelected = (): boolean => {
    const generationIds = [...selectedRef.current]
      .map((id) => cardsRef.current.find((card) => card.id === id)?.genId)
      .filter((id): id is string => !!id);
    if (!generationIds.length) return false;
    toggleDisabledGen(generationIds);
    return true;
  };

  const editSelectedTag = (): boolean => {
    if (!onSetTagsRef.current) return false;
    const target = [...selectedRef.current]
      .map((id) => cardsRef.current.find((card) => card.id === id))
      .find(
        (card) =>
          !!card &&
          card.kind === "generation" &&
          !!card.genId &&
          !!genDataRef.current[card.genId],
      );
    if (!target) return false;
    setTagEditNodeGenId(null);
    setTagEditCardId(target.id);
    return true;
  };

  useSceneKeyboardShortcuts({
    isTextEditing: () => !!editTextIdRef.current,
    isPopupOpen: () => !!cardMenuRef.current,
    isPickerOpen: () => !!nodePickerRef.current,
    selectionCount: () => selectedRef.current.size,
    onEscape: () => {
      const target = sceneEscapeTarget({
        colorOpen: !!colorPopId,
        pickerOpen: !!nodePickerRef.current,
        popupOpen: !!cardMenuRef.current,
        selectionCount: selectedRef.current.size + selectedGroupIdsRef.current.size,
        rowSelectionCount: rowSelRef.current.cids.size,
      });
      if (target === "color") setColorPopId(null);
      else if (target === "picker") setNodePicker(null);
      else if (target === "popup") setCardMenu(null);
      else if (target === "selection") {
        setSelected(new Set());
        setSelectedGroupIds(new Set());
        setRowSel({ listId: "", cids: new Set() });
      }
    },
    onPopupColor: (color) => applyColorToGids([...popupSelRef.current], color),
    onPopupDisable: () => {
      const ids = [...popupSelRef.current];
      if (!ids.length) return false;
      toggleDisabledGen(ids);
      return true;
    },
    onPopupTag: () => {
      if (!onSetTagsRef.current) return false;
      const generationId = [...popupSelRef.current].find(
        (id) => !!genDataRef.current[id],
      );
      if (!generationId) return false;
      setTagEditGid(generationId);
      return true;
    },
    onCreateNode: createNodeFromPicker,
    onTogglePicker: toggleNodePicker,
    onUndo: undo,
    onRedo: redo,
    onCopy: copySelectedNodes,
    onGroup: groupSelected,
    onFrame: frameView,
    onAutoConnect: autoConnectSelection,
    onArrange: arrangeSelection,
    onConnect: connectSelected,
    onDisable: disableSelected,
    onColor: (color) =>
      selectedGroupIdsRef.current.size ? setSelectedGroupsColor(color) : setSelColor(color),
    onTag: editSelectedTag,
    onCutHeldChange: setCutHeld,
    onDelete: () => deleteCards([...selectedRef.current]),
  });

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
    // 편집 요소 + 프롬프트 dock(레퍼런스 트레이 등) 포커스를 캔버스 클릭 시 해제 — 안 하면 트레이가 계속
    //  포커스로 남아, 캔버스 클릭 후 붙여넣기가 캔버스 카드 대신 트레이로 잘못 가던 문제가 생긴다.
    if (
      ae &&
      ae !== t &&
      (ae.isContentEditable ||
        ae.tagName === "INPUT" ||
        ae.tagName === "TEXTAREA" ||
        ae.closest(".sl-dockbar"))
    )
      ae.blur();
  };

  // '생성에 쓰인 노드 전체' — 시작 카드 + 위로 연결된 모든 소스(조상)를 모은다. 엣지를 거꾸로(to→from)
  // 따라가며, 무선(Input/Output)은 resolvePortEdges 로 실제 소스까지 해석해 함께 포함한다.
  const collectRecipe = (startId: string): Set<string> => {
    const byId = new Map(cardsRef.current.map((c) => [c.id, c] as const));
    // to → [from...] 역방향 인접맵을 1회만 만든다(노드마다 전체 엣지 재순회 회피). (from,to) 중복은 Set 으로 제거.
    const rev = new Map<string, Set<string>>();
    for (const ed of [...edgesRef.current, ...resolvePortEdges(byId, edgesRef.current)]) {
      let s = rev.get(ed.to);
      if (!s) rev.set(ed.to, (s = new Set()));
      s.add(ed.from);
    }
    const out = new Set<string>([startId]);
    const stack = [startId];
    while (stack.length) {
      const cur = stack.pop()!;
      // input 노드가 참조하는 output(channel)도 함께 선택한다. resolvePortEdges 는 input 을 실제 소스로
      //  건너뛰어(input→하류 를 소스→하류 로 치환) 중간 output 노드를 빠뜨린다 → 여기서 output 만 채운다.
      //  ★스택에 넣지 않는다: output 의 '대표 소스'는 이미 resolvePortEdges 가 수집했다. output 을 따라가면
      //   rev[output] 의 모든 소스(대표가 아닌 것 포함)까지 잡혀 실제 사용보다 과수집된다.
      const curCard = byId.get(cur);
      if (curCard?.kind === "input" && curCard.channel && byId.has(curCard.channel))
        out.add(curCard.channel);
      const froms = rev.get(cur);
      if (froms)
        for (const from of froms)
          if (!out.has(from)) {
            out.add(from);
            stack.push(from);
          }
    }
    return out;
  };

  const beginCardMove = useSceneCardMove({
    cardsRef,
    edgesRef,
    groupsRef,
    selectedRef,
    groupFramesRef,
    zoomRef,
    scrollRef,
    setCards,
    setSelected,
    setDraggingIds,
    setEjectedIds,
    beginDrag,
    cardSize: (card) => ({ w: widthOf(card), h: heightOf(card) }),
    collectRecipe,
    reassignGroups,
    reconcileGenerationRefs: withGenRefs,
    persist,
    ejectSpeed: GROUP_EJECT_SPEED,
  });
  const beginGroupMove = useSceneGroupMove({
    cardsRef,
    edgesRef,
    groupsRef,
    selectedGroupIdsRef,
    zoomRef,
    scrollRef,
    setCards,
    setGroups,
    setSelected,
    setSelectedGroupIds,
    setDraggingIds,
    beginDrag,
    reconcileGenerationRefs: withGenRefs,
    persist,
  });
  const beginBoardMarquee = useSceneMarqueeSelection<string>({
    selected,
    surfaceRef: scrollRef,
    hitRootRef: canvasRef,
    setSelected,
    setMarquee,
    beginDrag,
    cellSelector: ".scene-card",
    keyOf: (element) => element.dataset.id,
    preserveSelectionOnEmptyDrag: true,
    onPlainClick: () => {
      setSelected(new Set());
      setSelectedGroupIds(new Set());
      setRowSel({ listId: "", cids: new Set() });
    },
  });

  const onMouseDown = (e: React.MouseEvent) => {
    // 미들 버튼 화면 이동은 뷰포트 훅이 카메라 갱신·저장·커서 정리를 함께 담당한다.
    if (beginPan(e, beginDrag)) return;
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
      beginDrag(move, up, () => { setCutStroke(null); setEdgesToCut(new Set()); }); // blur: 절단 안 하고 표시만 정리
      return;
    }
    if (e.button !== 0) return;
    // 그룹 헤더/테두리 잡기 → 선택된 그룹 전체 이동 · 제자리 클릭 = 그룹 자체 선택(Shift/Ctrl=토글)
    const grabEl = (e.target as HTMLElement).closest(".scene-group-grab") as HTMLElement | null;
    if (grabEl?.dataset.groupId && beginGroupMove(e, grabEl.dataset.groupId)) {
      return;
    }
    const cardEl = (e.target as HTMLElement).closest(".scene-card") as HTMLElement | null;
    if (cardEl?.dataset.id) {
      setSelectedGroupIds(new Set());
      beginCardMove(e, cardEl.dataset.id);
      return;
    }

    setSelectedGroupIds(new Set());
    beginBoardMarquee(e);
  };

  // 그룹 색 팔레트 — 팝오버 바깥 클릭 시 닫기.
  useEffect(() => {
    if (!colorPopId) return;
    const onDown = (ev: MouseEvent) => {
      if (!(ev.target as HTMLElement)?.closest?.(".scene-group-colorwrap, .scene-headnode-colorwrap"))
        setColorPopId(null);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [colorPopId]);
  // 엣지 계산·렌더에서 카드를 id 로 매우 자주 조회한다(E×C). 선형 find 대신 Map(O(1))로 —
  // cards 가 바뀔 때만(드래그 등) 1회 재구성. 드래그 중 렌더 비용을 크게 줄인다.
  const cardsById = useMemo(() => new Map(cards.map((c) => [c.id, c] as const)), [cards]);
  const cardById = (id: string) => cardsById.get(id);

  // 상류 comfy 가 'running' 인 생성카드 집합 — 어느 버튼(생성카드 Generate / comfy 노드 실행)으로 돌리든
  //  컨피가 도는 동안 그 다운스트림 생성카드가 '생성중(회색)'으로 보이게 comfy 상태에서 파생한다.
  //  (running comfy 가 없으면 조기 반환 — 매 렌더 계획수립 비용 회피.)
  const genWaitingFromComfy = useMemo(() => {
    const runningComfy = new Set(
      cards.filter((c) => c.kind === "comfy" && c.comfyCfg?.status === "running").map((c) => c.id),
    );
    const out = new Set<string>();
    if (!runningComfy.size) return out;
    const resolved = resolvePortEdges(cardsById, edges);
    for (const c of cards) {
      if (c.kind !== "generation") continue;
      const plan = buildGenerationExecutionPlan(c.id, cardsById, resolved);
      if (plan.comfyIds.some((id) => runningComfy.has(id))) out.add(c.id);
    }
    return out;
  }, [cards, edges, cardsById]);

  // 다중선택 '미디어 비교' 대상 — 레퍼런스처럼 비생성 카드가 섞였을 때 이미지·영상을 나란히 보기(영상은 동시재생).
  //  전부 생성카드면 여기선 null → App 상단 선택바가 기존 생성 비교(CompareModal)로 처리한다(생성정보 포함).
  //  비교 불가 조합(오디오·모델·리스트·컨피·결과없는 생성)이면 null.
  const sceneCompareMedia = useMemo((): CompareMediaItem[] | null => {
    if (selected.size < 2) return null;
    const sels = [...selected].map((id) => cardsById.get(id)).filter((c): c is SceneCard => !!c);
    const media: CompareMediaItem[] = [];
    let hasRef = false;
    for (const c of sels) {
      if (c.kind === "generation") {
        const g = c.genId ? genData[c.genId] : undefined;
        const a = g?.assets?.[0];
        if (!g || !a) return null; // 아직 결과 없는 생성카드 → 비교 불가
        media.push({ url: a.file_path, name: g.prompt?.slice(0, 40) || "생성", type: a.type === "video" ? "video" : "image", full: a.file_path });
      } else if (c.kind === "reference") {
        hasRef = true;
        const r = c.refs?.[0];
        if (!r) return null;
        const mt = refMediaType(r);
        if (mt !== "image" && mt !== "video") return null; // 오디오·빈 레퍼런스는 제외
        // 이미지: displayThumb 로 표시용 URL(백엔드 리사이즈, 로컬 에셋 원본은 서버에 없어 <img> 로 깨짐).
        //  선명하게 r.file_path 로 1024 를 요청하되, 로드 실패(스테일 경로 등)면 캔버스에서 검증된 썸네일(refThumbSrc)로
        //  폴백한다. 영상: 재생해야 하므로 실제 파일 URL(refMediaSrc).
        if (mt === "video") {
          const url = refMediaSrc(r);
          if (!url) return null;
          media.push({ url, name: r.name || "레퍼런스", type: "video" });
        } else {
          const thumb = refThumbSrc(r); // 캔버스와 동일한 검증된 표시 URL(폴백)
          const url = displayThumb(r.file_path, 1024) ?? thumb ?? refMediaSrc(r);
          if (!url) return null;
          // 크게 보기(zoom)는 원본(refMediaSrc=assetFileUrl, 고해상도). 없으면 표시 URL.
          media.push({ url, name: r.name || "레퍼런스", type: "image", fallback: thumb, full: refMediaSrc(r) ?? url });
        }
      } else {
        return null; // 모델·리스트·컨피 등은 비교 대상 아님
      }
    }
    return hasRef ? media : null; // 레퍼런스 없이 전부 생성 → 기존 생성 비교로
  }, [selected, cardsById, genData]);
  // 미디어 비교 대상(레퍼런스 포함)을 상단 선택바에 보고 — 변형 팝업 열려 있으면(그 자체 바) 숨긴다.
  const onSelCmpRef = useRef(onSelectionCompare);
  onSelCmpRef.current = onSelectionCompare;
  useEffect(() => {
    onSelCmpRef.current?.(cardMenu ? null : sceneCompareMedia);
  }, [sceneCompareMedia, cardMenu]);
  useEffect(() => () => onSelCmpRef.current?.(null), []);

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
  // 컬링돼도 반드시 렌더할 카드 — 선택/편집/Comfy 대기/아직 높이 미측정(오프스크린 생성 시 엣지·미니맵
  // 오배치 방지). heightsRef 는 언마운트에도 안 지워져 한 번 측정되면 컬링 대상이 됨.
  const keepIds = useMemo(() => {
    const ids = new Set<string>(selected);
    if (editTextId) ids.add(editTextId);
    for (const id of comfyWaitingIds) ids.add(id);
    for (const id of draggingIds) ids.add(id); // 드래그 중 카드는 마진 밖으로 나가도 유지(언마운트 방지)
    for (const c of cards) {
      if (!Object.prototype.hasOwnProperty.call(heightsRef.current, c.id)) ids.add(c.id);
    }
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, editTextId, comfyWaitingIds, draggingIds, cards, heightTick]);
  // 실제 렌더 대상 — 플래그 off/뷰포트 미측정이면 전체(visibleCards). on 이면 뷰포트+마진 교차 || keepIds.
  // 확장 뷰포트(뷰포트 ± 마진) — 카드·연결선 컬링이 공유하는 단 하나의 기준 사각형. 컬링 꺼졌거나
  // 뷰포트 미측정이면 null → 전부 렌더(무동작). viewRect 는 팬/줌 시 rAF+엡실론 게이트로만 갱신됨.
  const cullRect = useMemo(() => {
    if (!CULL_ENABLED || !viewRect) return null;
    return {
      l: viewRect.l - CULL_MARGIN,
      t: viewRect.t - CULL_MARGIN,
      r: viewRect.r + CULL_MARGIN,
      b: viewRect.b + CULL_MARGIN,
    };
  }, [viewRect]);

  const renderCards = useMemo(() => {
    if (!cullRect) return visibleCards;
    return visibleCards.filter((card) => {
      if (keepIds.has(card.id)) return true;
      const r = cardRect(card);
      return r.x <= cullRect.r && r.x + r.w >= cullRect.l && r.y <= cullRect.b && r.y + r.h >= cullRect.t;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleCards, cullRect, keepIds, heightTick]);

  // 장기 누적 방지 — 실제 삭제된(현재 cards 에 없는) 카드의 측정 캐시를 정리. ★컬링으로 언마운트된
  // 카드는 cards 에 남아 있어 안 지워진다(측정값 유지 → keepIds 의 '미측정' 오판 방지). ref 직접 변경(무리렌더).
  useEffect(() => {
    const live = new Set(cards.map((c) => c.id));
    const prune = (obj: Record<string, unknown>) => {
      for (const k of Object.keys(obj)) if (!live.has(k)) delete obj[k];
    };
    prune(heightsRef.current);
    prune(widthsRef.current);
    prune(cardEls.current);
  }, [cards]);
  // 숨긴(회색) 카드가 중간에 있어도 앞뒤 흐름이 끊긴 것처럼 보이지 않게 — 숨김 노드를 건너뛰어
  // 보이는 '앞 카드 → 뒤 카드'로 회색 점선 우회선을 만든다(중간에 뭔가 숨겨져 있다는 표시).
  const bridgeEdges = useMemo(
    () => computeBridgeEdges(cards, edges, grayHidden),
    [cards, edges, grayHidden],
  );

  // ── 그룹 기하 — 순수 계산은 sceneDerive로 분리. 저장 rect 아래로 줄지 않고 멤버가 넘을 때만 임시 확장한다. ──
  // 각 그룹의 프레임(펼침)·막대(접힘) 사각형. 접힘 막대는 프레임 좌상단에 고정폭으로.
  // 매 렌더 전체 그룹×멤버 bounds 계산이라 메모화 — 입력(그룹·카드위치/크기·이탈·측정)이 바뀔 때만.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const groupViews = useMemo(
    () =>
      deriveGroupViews(
        groups,
        cardsById,
        (card) => ({ w: widthOf(card), h: heightOf(card) }),
        ejectedIds,
      ),
    [groups, cards, ejectedIds, heightTick],
  );
  groupFramesRef.current = groupViews.map(({ g, frame }) => ({ id: g.id, frame }));
  const collapsedBarById = useMemo(
    () => new Map(groupViews.filter((v) => v.g.collapsed).map((v) => [v.g.id, v.bar] as const)),
    [groupViews],
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
  const edgeRoles = useMemo(
    () => resolveEdgeRoles(edges, cardsById, refParents),
    [edges, cardsById, refParents],
  );
  // 물리 레인 — model/text 는 각자, ref·lineage 는 같은 중앙 레인('ref')으로 묶는다(같은 y라 fan 을 합쳐야
  // 겹치지 않는다). laneFrac 은 이 물리 레인 기준 y 비율(위=모델·중간=ref/계보·아래=텍스트).
  const laneOf = (role: SceneEdgeRole): "model" | "ref" | "text" =>
    role === "model" ? "model" : role === "text" ? "text" : "ref";
  // 입력 포트 세로 위치 — 카드 '세로 중앙' 기준 고정 오프셋(카드가 커져도 간격 유지·항상 중앙 정렬). 모든 카드 공통.
  //  ref=중앙(0), 모델=위, 텍스트=아래. gen·comfy 등 다입력 카드에 동일 적용.
  const PORT_V_GAP = 26;
  const laneDelta = (lane: "model" | "ref" | "text") =>
    lane === "model" ? -PORT_V_GAP : lane === "text" ? PORT_V_GAP : 0;
  // 다입력 카드(생성·comfy)로 들어오는 연결의 fan-in 을 (타깃+물리레인) 단위로 — 같은 레인끼리만 세로로
  //  펼쳐 겹침 방지. comfy 도 ref(중앙)·text(아래) 레인 포트로 그려지므로 레인별 fan 이 포트와 맞아야 한다
  //  (안 그러면 전체 입력 기준 fan 이라 ref 선이 ref 포트에서 어긋남).
  const inEdgesLaned = useMemo(() => {
    const m = new Map<string, SceneEdge[]>();
    for (const e of visibleEdges) {
      const toKind = cardsById.get(e.to)?.kind;
      if (toKind !== "generation" && toKind !== "comfy") continue;
      const key = e.to + ":" + laneOf(edgeRoles.get(e.id) || "ref");
      const arr = m.get(key);
      if (arr) arr.push(e);
      else m.set(key, [e]);
    }
    const yOf = (id: string) => cardsById.get(id)?.y ?? 0;
    // 생성카드의 ref 레인 fan-in 은 card.refs 순서를 따른다(프롬프트에서 순서 바꾸면 연결선도 그대로).
    //  · card.refs 가 순서 권위이므로 타깃별로 인덱스 맵을 만들어 정렬한다. 못 매핑한 엣지(comfy 등)는 뒤(Infinity),
    //    동률/미매핑은 기존처럼 소스 y 로 tie-break. ref 레인·생성카드에만 적용하고 그 외(model/text·comfy 타깃)는 y 순 유지.
    const refIdxCache = new Map<string, Map<string, number>>();
    const refIdxFor = (genId: string) => {
      let mp = refIdxCache.get(genId);
      if (!mp) {
        mp = refLaneOrderIndex(genId, cardsById, visibleEdges);
        refIdxCache.set(genId, mp);
      }
      return mp;
    };
    for (const [key, list] of m) {
      const ci = key.lastIndexOf(":");
      const toId = key.slice(0, ci);
      const lane = key.slice(ci + 1);
      const idx = lane === "ref" && cardsById.get(toId)?.kind === "generation" ? refIdxFor(toId) : null;
      // ref 레인엔 lineage(계보) 엣지도 같은 물리 레인으로 섞인다(laneOf). card.refs 로 재정렬할 실제 ref
      //  엣지가 2개 이상 매핑됐을 때만 적용해, 순수 계보/단일 입력 레인의 기존 y 정렬을 흐트러뜨리지 않는다.
      //  매핑 안 된 엣지(lineage·comfy·무선 input)는 Infinity 라 뒤로, 서로는 y 로 tie-break(기존과 동일).
      const reorderable = idx ? list.filter((e) => idx.has(e.id)).length >= 2 : false;
      if (idx && reorderable) {
        list.sort((p, q) => {
          const ip = idx.get(p.id) ?? Infinity;
          const iq = idx.get(q.id) ?? Infinity;
          if (ip !== iq) return ip - iq;
          return yOf(p.from) - yOf(q.from);
        });
      } else list.sort((p, q) => yOf(p.from) - yOf(q.from));
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleEdges, cardsById, edgeRoles]);
  const edgeEnds = (e: SceneEdge, a: SceneCard, b: SceneCard) => {
    const lane = laneOf(edgeRoles.get(e.id) || "ref");
    // 타깃이 생성카드면 물리 레인 y + 그 레인 내 fan, 아니면 중앙 + 타깃 전체 fan.
    // 다입력 카드(gen·comfy)는 세로중앙 + 레인 오프셋으로, 그 외는 중앙(0.5).
    const gen = b.kind === "generation";
    const laned = gen || b.kind === "comfy";
    const y2base = b.y + heightOf(b) * 0.5 + (laned ? laneDelta(lane) : 0);
    // 레인 포트를 가진 카드(생성·comfy)는 레인별 fan 으로 그 레인 포트에 맞춘다. 그 외는 중앙 전체 fan.
    const fanList = laned ? inEdgesLaned.get(b.id + ":" + lane) : inEdges.get(b.id);
    return {
      x1: a.x + widthOf(a) + PORT_GAP, // 출력 포트(카드 오른쪽 밖)
      y1: a.y + heightOf(a) / 2 + fanOffset(outEdges.get(a.id), e.id, FAN),
      x2: b.x - PORT_GAP, // 입력 포트(카드 왼쪽 밖)
      y2: y2base + fanOffset(fanList, e.id, FAN),
    };
  };

  // 접힌 그룹 막대로 재연결되는 브릿지 선 — 멤버가 숨어 visibleEdges 에서 빠진 연결을 막대 포트로 그린다.
  // 접힌 그룹이 있을 때만 도는 flatMap 이지만 매 렌더 재계산되던 것을 메모화(입력 변경 시에만).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const groupBridges = useMemo(
    () =>
      collapsedMemberOf.size
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
        : [],
    [collapsedMemberOf, edges, grayHidden, edgeRoles, refCardEdgeIds, genRefEdgeIds, collapsedBarById, cards, heightTick],
  );

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
          const groupSelected = selectedGroupIds.has(g.id);
          const controlIds = sceneGroupControlTargetIds(selectedGroupIds, g.id);
          const controlGroups = groups.filter((group) => controlIds.includes(group.id));
          const firstControlColor = controlGroups[0]?.color;
          const sharedControlColor = controlGroups.every(
            (group) => group.color === firstControlColor,
          )
            ? firstControlColor
            : undefined;
          const controlCount = controlIds.length;
          const gstyle: CSSProperties = { left: box.x, top: box.y, width: box.w, height: box.h };
          if (g.color) (gstyle as Record<string, string | number>)["--gc"] = g.color;
          if (colorPopId === g.id) {
            gstyle.zIndex = 60; // 팔레트 열리면 카드 위로 올려 가려지지 않게
            gstyle.overflow = "visible"; // 접힌 그룹의 overflow:hidden 이 팝오버를 자르지 않게
          }
          return (
            <div
              key={g.id}
              className={
                "scene-group" +
                (collapsed ? " collapsed" : "") +
                (groupSelected ? " selected" : "")
              }
              style={gstyle}
              data-group-id={g.id}
              data-selected={groupSelected ? "true" : "false"}
            >
              {!collapsed && (
                <>
                  <span className="scene-group-edge edge-top scene-group-grab" data-group-id={g.id} />
                  <span className="scene-group-edge edge-right scene-group-grab" data-group-id={g.id} />
                  <span className="scene-group-edge edge-bottom scene-group-grab" data-group-id={g.id} />
                  <span className="scene-group-edge edge-left scene-group-grab" data-group-id={g.id} />
                </>
              )}
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
                  title={
                    controlCount > 1
                      ? `선택 그룹 ${controlCount}개 ${collapsed ? "펼치기" : "접기"}`
                      : collapsed ? "펼치기" : "접기"
                  }
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    activateGroupControl(g.id);
                    toggleGroupCollapsed(g.id);
                  }}
                >
                  {collapsed ? "+" : "−"}
                </button>
                <div className="scene-group-colorwrap" onMouseDown={(e) => e.stopPropagation()}>
                  <button
                    className="scene-group-color"
                    title={controlCount > 1 ? `선택 그룹 ${controlCount}개 색상` : "그룹 색"}
                    style={{ background: g.color || "var(--border2)" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      activateGroupControl(g.id);
                      setColorPopId((p) => (p === g.id ? null : g.id));
                    }}
                  />
                  {colorPopId === g.id && (
                    <div className="scene-group-colorpop">
                      {GROUP_COLORS.map((c) => (
                        <button
                          key={c}
                          className={"scene-group-swatch" + (sharedControlColor === c ? " on" : "")}
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
                          value={sharedControlColor || g.color || "#5a6270"}
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
                  title={
                    controlCount > 1
                      ? `선택 그룹 ${controlCount}개 해제(카드는 유지)`
                      : "그룹 해제(카드는 유지)"
                  }
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    activateGroupControl(g.id);
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
                    activateGroupControl(g.id);
                    const rect0 = g.rect ?? frame; // 자동 그룹이면 현재 프레임을 초기 rect 로 고정
                    const sx = e.clientX;
                    const sy = e.clientY;
                    let last = rect0; // 최종 rect — up 에서 명시적으로 persist(groupsRef 최신성 레이스 방지)
                    const mv = (ev: MouseEvent) => {
                      const z = zoomRef.current;
                      const w = Math.max(140, rect0.w + (ev.clientX - sx) / z);
                      const h = Math.max(GROUP_HEADER_HEIGHT + 48, rect0.h + (ev.clientY - sy) / z);
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
                    beginDrag(mv, upr, upr); // blur: 현재 테두리로 멤버십 커밋(좌표·클릭 모호함 없어 upr 재사용 안전)
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
            // 연결선 컬링 — 양 끝점 bbox 가 확장뷰포트 밖이면 곡선 전체가 밖(제어점이 bbox 내라 보장) → 안 그림.
            if (
              cullRect &&
              (Math.max(x1, x2) < cullRect.l ||
                Math.min(x1, x2) > cullRect.r ||
                Math.max(y1, y2) < cullRect.t ||
                Math.min(y1, y2) > cullRect.b)
            )
              return null;
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

        {renderCards.map((card) => {
          const sel = selected.has(card.id);
          const isRef = card.kind === "reference";
          const autoH = isAutoCard(card); // 레퍼런스·Input·Output = 내용에 맞춘 자동 높이(고정 height 미지정)
          const autoSize = isAutoSize(card); // head = 폭·높이 모두 자동(글씨에 맞춰 박스가 줄고 늘어남)
          const isGen = card.kind === "generation";
          const g = isGen && card.genId ? genData[card.genId] : null; // 바인딩된 실제 생성물
          const showNode = !!g && String(g.status) === "done"; // 완료 → 히스토리 카드로 표시
          const kindCls =
            card.kind === "reference"
              ? "scene-card-ref" + (card.refs?.[0]?.origin === "asset" ? " from-asset" : "")
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
                ((card.kind === "generation" || card.kind === "comfy") && variantIds(card).some(isRecentlyDone) ? " glow" : "") + // 방금 생성됨 — 라임 glow(클릭 시 해제, comfy 완료도 포함 #1b)
                (editTextId === card.id ? " editing" : "") + // 편집 중 — head 이중 외곽선 방지 등
                (showNode ? " has-node" : "") // 완료 결과가 있으면 히스토리 노드가 카드 뼈대를 대체
              }
              data-id={card.id}
              style={{
                left: card.x,
                top: card.y,
                ...(autoSize ? {} : { width: widthOf(card), ...(autoH ? {} : { height: heightOf(card) }) }),
              }}
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
                <ReferenceCard
                  card={card}
                  fill={fill}
                  getGen={(id) => genDataRef.current[id]}
                  onInfo={onInfo}
                  onPreview={onPreview}
                  onOutPortDown={onOutPortDown}
                />
              ) : card.kind === "text" ? (
                <TextCard
                  card={card}
                  cardsById={cardsById}
                  resolvedEdges={resolvedEdges}
                  genData={genData}
                  editing={editTextId === card.id}
                  caretPosRef={caretPosRef}
                  setEditTextId={setEditTextId}
                  setSelected={setSelected}
                  setNodeText={setNodeText}
                  flushPending={flushPending}
                  onOutPortDown={onOutPortDown}
                  onResizeDown={onResizeDown}
                />
              ) : card.kind === "set" ? (
                <SetCard
                  card={card}
                  setFolder={setNodeSetFolder}
                  setTagsText={setNodeSetTagsText}
                  flushPending={flushPending}
                  onOutPortDown={onOutPortDown}
                  onResizeDown={onResizeDown}
                />
              ) : card.kind === "model" ? (
                <ModelCard card={card} onOutPortDown={onOutPortDown} onResizeDown={onResizeDown} />
              ) : card.kind === "list" ? (
                <ListCard
                  card={card}
                  cardsById={cardsById}
                  resolvedEdges={resolvedEdges}
                  genData={genData}
                  disabledIds={disabledIds}
                  rowSel={rowSel}
                  reorderFrom={reorderFrom}
                  cardWidth={widthOf(card)}
                  toggleRowSel={toggleRowSel}
                  startReorder={startReorder}
                  getNodePreview={getNodePreview}
                  setCardMenu={setCardMenu}
                  addListAsReference={addListAsReference}
                  onOutPortDown={onOutPortDown}
                  onResizeDown={onResizeDown}
                />
              ) : card.kind === "view" ? (
                <ViewCard
                  card={card}
                  cardsById={cardsById}
                  resolvedEdges={resolvedEdges}
                  buildViewClips={buildViewClips}
                  playView={playView}
                  setViewTextModal={setViewTextModal}
                  onResizeDown={onResizeDown}
                  t={t}
                />
              ) : card.kind === "output" ? (
                <OutputCard
                  card={card}
                  sel={sel}
                  edges={edges}
                  cardsById={cardsById}
                  setNodeText={setNodeText}
                  flushPending={flushPending}
                />
              ) : card.kind === "input" ? (
                <InputCard
                  card={card}
                  sel={sel}
                  cards={cards}
                  cardsById={cardsById}
                  edges={edges}
                  setNodeChannel={setNodeChannel}
                  onOutPortDown={onOutPortDown}
                />
              ) : card.kind === "render" ? (
                <RenderCard
                  card={card}
                  sel={sel}
                  cardsById={cardsById}
                  resolvedEdges={resolvedEdges}
                  genData={genData}
                  disabledIds={disabledIds}
                  rowSel={rowSel}
                  reorderFrom={reorderFrom}
                  showRenderBar={!!onRenderCards}
                  toggleRowSel={toggleRowSel}
                  toggleRenderCheck={toggleRenderCheck}
                  startReorder={startReorder}
                  getNodePreview={getNodePreview}
                  setCardMenu={setCardMenu}
                  setCardBatch={setCardBatch}
                  orchestrateRender={orchestrateRender}
                  onOutPortDown={onOutPortDown}
                  onResizeDown={onResizeDown}
                />
              ) : card.kind === "comfy" ? (
                <ComfyCard
                  card={card}
                  sel={sel}
                  fill={fill}
                  width={widthOf(card)}
                  runningLocal={runningComfyIds.has(card.id)}
                  laneDelta={laneDelta}
                  getNodePreview={getNodePreview}
                  graph={{ cards, cardsById, edges, refParents, genData }}
                  hist={{
                    disabledIds,
                    typeFilter,
                    colorFilter,
                    tagFilter,
                    sharedOnly,
                    commentOnly,
                    finalOnly,
                    folderSel,
                    sConfirm,
                    onSClick: onNodeSClick,
                    onSDouble: onNodeSDouble,
                    onSConfirmYes: onNodeSConfirmYes,
                    onSConfirmNo: onNodeSConfirmNo,
                    onInfo,
                    onRegenerate,
                    onTag: onSetTags ? onNodeTag : undefined,
                    onOpenComments,
                  }}
                  tagEdit={{
                    cardId: tagEditCardId,
                    nodeGenId: tagEditNodeGenId,
                    enabled: !!onSetTags,
                    hasAutoTags: !!onSetAutoTags,
                    autoTagOptions: autoTagOptions ?? [],
                    applyCardTags,
                    applyCardAutoTags,
                    close: () => {
                      setTagEditCardId(null);
                      setTagEditNodeGenId(null);
                    },
                  }}
                  actions={{
                    applyComfyApi,
                    pickComfyFile,
                    setComfyModalId,
                    refreshComfy,
                    setComfyParam,
                    flushPending,
                    runComfy,
                    setCardMenu,
                    setCardBatch,
                    onOutPortDown,
                    onResizeDown,
                  }}
                />
              ) : card.kind === "head" ? (
                <HeadCard
                  card={card}
                  sel={sel}
                  editing={editTextId === card.id}
                  colorPopId={colorPopId}
                  setEditTextId={setEditTextId}
                  setColorPopId={setColorPopId}
                  setNodeText={setNodeText}
                  setNodeFontSize={setNodeFontSize}
                  setNodeColor={setNodeColor}
                  flushPending={flushPending}
                />
              ) : (
                <GenerationCard
                  card={card}
                  sel={sel}
                  g={g}
                  showNode={showNode}
                  waiting={comfyWaitingIds.has(card.id) || genWaitingFromComfy.has(card.id)}
                  genMissing={!!card.genId && missingIds.has(card.genId)}
                  width={widthOf(card)}
                  height={heightOf(card)}
                  fill={fill}
                  selectedOnly={selected.size === 1}
                  laneDelta={laneDelta}
                  getNodePreview={getNodePreview}
                  hist={{
                    disabledIds,
                    typeFilter,
                    colorFilter,
                    tagFilter,
                    sharedOnly,
                    commentOnly,
                    finalOnly,
                    folderSel,
                    sConfirm,
                    onSClick: onNodeSClick,
                    onSDouble: onNodeSDouble,
                    onSConfirmYes: onNodeSConfirmYes,
                    onSConfirmNo: onNodeSConfirmNo,
                    onInfo,
                    onRegenerate,
                    onTag: onSetTags ? onNodeTag : undefined,
                    onOpenComments,
                  }}
                  actions={{
                    setCardMenu,
                    setCardBatch,
                    orchestrateGenerate,
                    showGenerateBar: !!onGenerateCard,
                    onOutPortDown,
                    onResizeDown,
                  }}
                  tagEdit={{
                    active: card.id === tagEditCardId && (!tagEditNodeGenId || tagEditNodeGenId === g?.id) && !!onSetTags,
                    hasAutoTags: !!onSetAutoTags,
                    autoTagOptions: autoTagOptions ?? [],
                    applyCardTags,
                    applyCardAutoTags,
                    close: () => {
                      setTagEditCardId(null);
                      setTagEditNodeGenId(null);
                    },
                  }}
                />
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
            // 끝점 점도 같은 기준으로 컬링 — bbox 가 확장뷰포트 밖이면 두 점 다 화면에서 멀어 안 그림.
            if (
              cullRect &&
              (Math.max(x1, x2) < cullRect.l ||
                Math.min(x1, x2) > cullRect.r ||
                Math.max(y1, y2) < cullRect.t ||
                Math.min(y1, y2) > cullRect.b)
            )
              return null;
            return (
              <g key={e.id}>
                <circle className={cls} cx={x1} cy={y1} r={5.5} />
                <circle className={cls} cx={x2} cy={y2} r={5.5} />
              </g>
            );
          })}
        </svg>
      </div>

      {/* Ctrl+K 로 프롬프트를 숨겼을 때 — 멀티선택 액션바를 캔버스 상단 중앙(씬 패널·미니맵과 같은 줄)에 얹는다. */}
      {topCenterOverlay && (
        <div className="scene-topbar-overlay" onMouseDown={(e) => e.stopPropagation()}>
          {topCenterOverlay}
        </div>
      )}
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

      {/* 좌상단 씬 패널 — 씬 이름 + 저장(파일로)/불러오기(새 탭). 미디어 없이 참조만 저장(ComfyUI식 가벼운 텍스트). */}
      {(onSaveScene || onLoadSceneFile) && (
        <div
          className={"scene-io-panel" + (ioPanelVisible ? "" : " io-hidden")}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseEnter={() => setIoPanelHover(true)}
          onMouseLeave={() => setIoPanelHover(false)}
        >
          <div className="scene-io-name" title={scene.name}>{scene.name}</div>
          <div className="scene-io-btns">
            {onSaveScene && (
              <button
                className="scene-io-btn"
                title="이 씬을 파일로 저장"
                onClick={() => onSaveScene(getCamera())}
              >
                저장
              </button>
            )}
            {onLoadSceneFile && (
              <button
                className="scene-io-btn"
                title="씬 파일을 새 탭으로 불러오기"
                onClick={() => sceneFileRef.current?.click()}
              >
                불러오기
              </button>
            )}
          </div>
          <input
            ref={sceneFileRef}
            type="file"
            accept=".json,application/json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onLoadSceneFile?.(f);
              e.target.value = ""; // 같은 파일을 다시 고를 수 있게 초기화
            }}
          />
        </div>
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
                ["Set", "S", "set"],
                ["List", "L", "list"],
                ["Render", "R", "render"],
                ["View", "V", "view"],
                ["Input", "I", "input"],
                ["Output", "O", "output"],
                ["Head", "H", "head"],
                ["Comfy", "C", "comfy"],
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

      {/* Comfy 노드 더블클릭 → ComfyUI 워크플로우 로드 + 파라미터 노출 모달. 저장 시 comfyCfg 스냅샷. */}
      {comfyModalId &&
        (() => {
          const c = cards.find((x) => x.id === comfyModalId);
          if (!c) return null;
          return (
            <SceneComfyModal
              key={comfyModalId}
              initial={c.comfyCfg}
              onClose={() => setComfyModalId(null)}
              onSave={(cfg) => {
                // 워크플로우(content)가 바뀌면 이전 실행 결과를 비운다 — 안 그러면 하류 생성카드가
                // 예전 워크플로 출력을 참조한다(재실행 전까지 stale). content 그대로면 결과 보존.
                const prev = cardsRef.current.find((x) => x.id === comfyModalId)?.comfyCfg;
                const contentChanged = (prev?.content || "") !== (cfg.content || "");
                if (contentChanged) {
                  // content 교체 → 카드에 쌓인 생성물(대표·목록)까지 초기화(applyComfyApi 와 동일 규칙).
                  const nextCards = cardsRef.current.map((c) =>
                    c.id === comfyModalId && c.kind === "comfy"
                      ? {
                          ...c,
                          genId: null,
                          genIds: [],
                          comfyCfg: { ...(c.comfyCfg || {}), ...cfg, outputs: [], output: null, status: "idle" as const, error: null },
                        }
                      : c,
                  );
                  cardsRef.current = nextCards;
                  setCards(nextCards);
                  persist(nextCards, edgesRef.current);
                } else {
                  patchComfyCfg(comfyModalId, cfg);
                }
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
      {cardMenu && (
        <SceneVariantPopup
          cardId={cardMenu}
          cards={cards}
          genData={genData}
          disabledIds={disabledIds}
          folderSel={folderSel}
          projects={projects || []}
          autoTagOptions={autoTagOptions ?? []}
          ui={{
            popupSel,
            setPopupSel,
            popupAnchorRef,
            popupMarq,
            gripDragging,
            setGripDragging,
            tagEditGid,
            setTagEditGid,
            tagEditorPos,
            varGridRef,
            varpopWrapRef,
            onVarGridMouseDown,
          }}
          gen={{
            sConfirm,
            canFinalize,
            onNodeSClick,
            onNodeSDouble,
            onNodeSConfirmYes,
            onNodeSConfirmNo,
            onInfo,
            onOpenComments,
            onRegenerate,
            onPreview,
            tagsEnabled: !!onSetTags,
            hasAutoTags: !!onSetAutoTags,
            applyCardTags,
            applyCardAutoTags,
          }}
          actions={{
            setCardMenu,
            setCardVariant,
            pruneVariants,
            latestCard: (id) => cardsRef.current.find((x) => x.id === id),
            onVariantDelete,
            onVariantShare,
            onVariantDownload,
            onVariantCompare,
            onVariantAssign,
            onVariantCreateAssign,
          }}
        />
      )}

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
