import { backgroundKeysBlocked } from "./keyGate";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, DragEvent as ReactDragEvent, MutableRefObject, SetStateAction } from "react";
import { api } from "../api";
import { DRAG_TYPES } from "./dragTypes";
import { flashMsg } from "./flash";
import { dataTransferHasFiles, filesFromDataTransfer } from "./media";
import { SCENE_WINDOW_SELECTOR } from "./useSceneViewport";
import {
  appendSceneReferenceCards,
  copySceneSelection,
  partitionSceneDropFiles,
  pasteSceneClipboard,
  scenePasteIntent,
  shouldRestoreRecipeFromDrop,
  type SceneClipboard,
} from "./sceneInteractions";
import { isSceneTextEntryTarget, scenePasteShortcut } from "./sceneKeyboard";
import {
  notifySpotlightAssetsChanged,
  parseSpotlightAssetItems,
  readSpotlightAssetPayload,
  referenceDropTypeFromFile,
  spotlightAssetRefBase,
  type SpotlightAssetDragItem,
} from "./spotlightAssetRefs";
import { uid, type SceneCard, type SceneEdge, type SceneRef } from "./scenes";

interface UseSceneClipboardDropOptions {
  // 씬을 바꾸는 틈(SceneBoard 의 switchingRef) — 그때 시작한 붙여넣기는 받지 않는다. 끝날 때의 검사(씬이 그대로인가)로는 못 거른다:
  //  틈에는 sceneIdRef 가 이미 새 씬이라, 0.18초 뒤의 폴백·업로드 응답이 틈이 끝난 뒤 새 씬에 붙는다(Codex 코드 리뷰).
  frozenRef: MutableRefObject<boolean>;
  sceneIdRef: MutableRefObject<string>;
  cardsRef: MutableRefObject<SceneCard[]>;
  edgesRef: MutableRefObject<SceneEdge[]>;
  selectedRef: MutableRefObject<Set<string>>;
  lastMouseRef: MutableRefObject<{ x: number; y: number; over: boolean }>;
  scrollRef: MutableRefObject<HTMLDivElement | null>;
  setCards: Dispatch<SetStateAction<SceneCard[]>>;
  setEdges: Dispatch<SetStateAction<SceneEdge[]>>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  toCanvas: (clientX: number, clientY: number) => { x: number; y: number };
  reconcileGenerationRefs: (cards: SceneCard[], edges: SceneEdge[]) => SceneCard[];
  persist: (cards: SceneCard[], edges: SceneEdge[]) => void;
  onLoadSceneFile?: (file: File) => void;
  // 각인된 생성물 파일을 떨어뜨렸을 때 — 레시피를 노드로 여는 데 성공하면 true.
  // false 면 평범한 미디어 파일로 보고 레퍼런스 카드가 된다.
  onDroppedGenerationFile?: (file: File) => Promise<boolean>;
  // 로컬 파일(끌어다 놓기·붙여넣기)로 레퍼런스 카드를 만든 직후 — 새 참조 토큰을 넘긴다.
  //  이 PC 설치 폴더에만 있으므로 부르는 쪽이 서버에 없음을 표시하고 자동 복구를 부른다(2026-09-29).
  onLocalRefsAdded?: (tokens: string[]) => void;
  cardWidth: number;
  cardHeight: number;
}

/** 올리는 중인 파일(놓기·붙여넣기)의 자리 표시 — 보드가 놓은 자리에 점선 카드로 그린다(28회차, Jay 결정). 응답이 오면 사라지고(성공·씬 바뀜·
 *  보드 떠남 모두 — 표시는 올리기의 것이다), 실패하면 `error` 글을 든 채 남아 ✕ 로 치운다. */
export interface PendingSceneImport {
  id: string;
  sceneId: string; // 놓은 순간의 씬 — 보드는 지금 씬의 것만 그린다
  x: number; // 놓은(붙인) 자리의 가운데(캔버스 좌표)
  y: number;
  count: number; // 올리는 파일 수(한 요청 — 파일별 진행은 모른다)
  names: string[];
  error: string | null;
}

interface SceneClipboardDropHandlers {
  copySelectedNodes: () => void;
  onDragOver: (event: ReactDragEvent) => void;
  onDrop: (event: ReactDragEvent) => void;
  pendingImports: PendingSceneImport[];
  dismissPendingImport: (id: string) => void;
}

// 캔버스가 탭 전환 등으로 다시 마운트돼도 방금 복사한 노드는 유지한다. 시스템 클립보드에는
// 안내 문구만 쓰므로, 실제 노드 구조는 이 메모리 스냅샷이 유일한 원본이다.
let sceneClipboardSnapshot: SceneClipboard | null = null;
// 복사 때 시스템 클립보드에 심는 고유 표식 — 붙여넣기 시 클립보드 텍스트가 이 표식과 다르면
// 사용자가 그 사이 외부에서 다른 것을 복사한 것이므로 옛 노드 스냅샷을 붙이지 않는다.
// null = 표식 기록 실패(클립보드 권한 등) — 그땐 기존 이미지 지문 휴리스틱만 쓴다.
let sceneClipboardMarker: string | null = null;

// 올리기에 실패한 자리 표시의 글 — 카드 자리에 남는다(토스트는 곧 사라진다).
const IMPORT_FAILED = "넣지 못했습니다 — 다시 놓아 주세요";

const hasAssetDrag = (dataTransfer: DataTransfer) =>
  Array.from(dataTransfer.types).includes(DRAG_TYPES.asset);

const assetItemToRef = (item: SpotlightAssetDragItem): SceneRef => {
  const base = spotlightAssetRefBase(item);
  return {
    file_path: base.file_path,
    type: base.type,
    name: base.name,
    thumb: base.thumb,
    // 지문을 함께 남긴다 — 나중에 원본이 옮겨져도 내용으로 다시 찾을 수 있다(2026-09-28).
    ...(item.sha256 ? { content_sha: item.sha256 } : {}),
    ...(item.bytes ? { bytes: item.bytes } : {}),
  };
};

const clipboardImage = (event: ClipboardEvent): File | null => {
  const items = event.clipboardData?.items;
  if (!items) return null;
  for (let index = 0; index < items.length; index++) {
    if (items[index].type.startsWith("image/")) return items[index].getAsFile();
  }
  return null;
};

// 폴더 창·'생성 결과' 창이 떠 있나 — 그동안 보드는 가려져 있다. 붙여넣기는 초점과 무관하게(Ctrl+V 는 창 안에서 눌러도 여기까지 온다)
//  가려진 보드에 노드를 붙였다(Codex 상의에서 코드로 확인). 창이 떠 있으면 보드에 붙이지 않는다.
const gridWindowOpen = (): boolean => !!document.querySelector(".folder-peek, .scene-varwin");
// 보드 안에 뜬 창(모델·Comfy 설정·생성 결과·타임라인 재생·글·복구) 위의 끌기는 보드의 것이 아니다 — 창은 보드의 자식이라 놓기가 보드까지
//  올라오고, 받으면 창 뒤의 씬에 카드가 생겨 저장된다. 받지 않으면 전역 지킴이(lib/media installFileDropGuard)가 '놓을 수 없음'으로 돌린다.
//  창 안에서 따로 받는 자리(Comfy 설정 창의 파일 칸)는 거기서 전파를 멈춘다.
//  창이 body 로 띄운 것(포털 — '생성 결과' 창의 태그 패널)도 같다: 화면에서는 보드 밖인데 React 의 이벤트는 부모인 보드까지 올라온다.
//  그래서 '보드의 DOM 안에서 난 것인가'도 같이 본다(Codex 코드 리뷰).
const overSceneWindow = (event: ReactDragEvent): boolean => {
  const target = event.target as Element | null;
  const board = event.currentTarget as Element | null;
  return !!target?.closest && (!!target.closest(SCENE_WINDOW_SELECTOR) || (!!board?.contains && !board.contains(target)));
};

const isTextEntryTarget = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  const active = document.activeElement as HTMLElement | null;
  // ClipboardEvent.target 이 브라우저에 따라 document/body 로 잡혀도 실제 포커스가 입력창이면
  // 캔버스 붙여넣기를 실행하지 않는다. dockbar 포함 여부도 공용 판정 함수가 함께 처리한다.
  return isSceneTextEntryTarget(element) || isSceneTextEntryTarget(active);
};

/** SceneBoard의 노드 복사, 캡처 붙여넣기, 에셋/파일 드롭 수명주기를 관리한다. */
export function useSceneClipboardDrop(
  options: UseSceneClipboardDropOptions,
): SceneClipboardDropHandlers {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const clipboardRef = useRef<SceneClipboard | null>(sceneClipboardSnapshot);
  const lastImageKeyRef = useRef<string | null>(null);
  const pasteFallbackTimerRef = useRef<number | null>(null);
  const fallbackPasteAtRef = useRef(0);
  // 이 보드가 아직 떠 있는가 — 올리는 사이 캔버스를 떠나면(다른 탭) 보드는 내려가는데, 늦게 끝난 올리기가 **내려간 보드의 카드 목록**에
  //  카드를 더해 씬을 통째로 저장했다. 그사이 돌아와 한 편집(새 보드)이 그 낡은 목록에 덮였다(조작 규칙 48). 씬 id 만 봐서는 못 거른다 —
  //  같은 씬으로 돌아와 있다. 내려간 보드의 올리기는 파일만 가져오고(Assets 에 있다) 캔버스에는 넣지 않는다.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  // 올리는 중인 파일의 자리 표시 — 함수형 갱신 없이 ref 사본으로 새 배열을 만든다(규칙 54). 내려간 보드에는 쓰지 않는다. 조작은 ref 에 담아
  //  둔 고정 함수들(아래 콜백들의 deps 에 들지 않게 — 셋 다 ref 와 setState 만 쓴다).
  const pendingRef = useRef<PendingSceneImport[]>([]);
  const [pendingImports, setPendingImports] = useState<PendingSceneImport[]>(pendingRef.current);
  const pendingOpsRef = useRef<{
    add: (entry: PendingSceneImport) => void;
    patch: (id: string, patch: Partial<PendingSceneImport>) => void;
    dismiss: (id: string) => void;
  } | null>(null);
  if (!pendingOpsRef.current) {
    const set = (next: PendingSceneImport[]) => {
      pendingRef.current = next;
      if (aliveRef.current) setPendingImports(next);
    };
    pendingOpsRef.current = {
      add: (entry) => set([...pendingRef.current, entry]),
      patch: (id, patch) => set(pendingRef.current.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry))),
      dismiss: (id) => set(pendingRef.current.filter((entry) => entry.id !== id)),
    };
  }

  const addReferenceCards = useCallback(
    (refs: SceneRef[], centerX: number, centerY: number, connectToGenerationIds?: string[]) => {
      if (!refs.length) return;
      const current = optionsRef.current;
      const appended = appendSceneReferenceCards({
        cards: current.cardsRef.current,
        edges: current.edgesRef.current,
        refs,
        center: { x: centerX, y: centerY },
        connectToGenerationIds,
        makeId: uid,
        cardWidth: current.cardWidth,
        cardHeight: current.cardHeight,
      });
      if (!appended.createdCards.length) return;

      const nextCards = appended.connectedTargetIds.length
        ? current.reconcileGenerationRefs(appended.cards, appended.edges)
        : appended.cards;
      current.cardsRef.current = nextCards;
      current.edgesRef.current = appended.edges;
      current.setCards(nextCards);
      current.setEdges(appended.edges);
      if (!appended.connectedTargetIds.length) {
        current.setSelected(new Set(appended.createdCards.map((card) => card.id)));
      }
      current.persist(nextCards, appended.edges);
    },
    [],
  );

  const importExternalFiles = useCallback(
    async (files: File[], centerX: number, centerY: number, sceneAtDrop?: string) => {
      const accepted = files.filter((file) => referenceDropTypeFromFile(file));
      // 놓은 것 가운데 들어가지 않은 파일은 알린다(조작 규칙 42) — 전엔 일부만 들어가도, 하나도 안 들어가도 아무 말이 없었다
      //  (미디어가 아닌 파일은 여기서, 빈 파일·너무 큰 파일은 서버가 건너뛴다 — backend reference-import 의 skipped).
      const left = files.filter((file) => !accepted.includes(file)).map((file) => file.name);
      // 안내는 **한 번에** 낸다 — 토스트는 마지막 문구만 남긴다(lib/useAppToast). 둘로 내면 앞의 것이 곧바로 덮인다(Codex 코드 리뷰).
      const tell = (first = "") => {
        const names = left.slice(0, 3).join(", ") + (left.length > 3 ? " …" : "");
        const leftNote = left.length
          ? `${left.length}개 파일은 캔버스에 넣지 못했습니다(이미지·영상·오디오가 아니거나, 비었거나, 너무 큽니다) — ${names}`
          : "";
        const text = [first, leftNote].filter(Boolean).join(" · ");
        if (text) flashMsg(text);
      };
      if (!accepted.length) return tell();
      const sceneId = sceneAtDrop ?? optionsRef.current.sceneIdRef.current;
      const pendingId = uid();
      pendingOpsRef.current!.add({ id: pendingId, sceneId, x: centerX, y: centerY, count: accepted.length, names: accepted.map((file) => file.name), error: null });
      try {
        // 로컬 파일은 이 PC 설치 폴더(imports)에만 둔다 — 서버에 올리지 않는다(Jay 2026-09-29 옛 방식).
        const response = await api.uploadReferenceFiles(accepted);
        pendingOpsRef.current!.dismiss(pendingId); // 카드를 넣는 것과 같은 묶음(React 가 한 번에 그린다) — 자리 표시가 카드로 바뀐다
        const items = response.saved || [];
        left.push(...(response.skipped || []));
        let switched = "";
        if (items.length) {
          if (!aliveRef.current) {
            switched = `${items.length}개 파일을 가져왔지만, 그사이 캔버스를 떠나 넣지 않았습니다 — Assets 에서 끌어 넣으세요.`;
          } else if (optionsRef.current.sceneIdRef.current === sceneId) {
            const refs = items.map((item) => ({ ...assetItemToRef(item), origin: "upload" as const }));
            addReferenceCards(refs, centerX, centerY);
            optionsRef.current.onLocalRefsAdded?.(refs.map((ref) => ref.file_path));
          } else {
            // 올리는 사이 씬을 바꿨다 — 파일은 가져왔지만 떠난 씬에도 지금 씬에도 넣지 않는다. 그 사실을 알린다.
            switched = `${items.length}개 파일을 가져왔지만, 그사이 씬이 바뀌어 캔버스에는 넣지 않았습니다 — Assets 에서 끌어 넣으세요.`;
          }
          notifySpotlightAssetsChanged(items);
        }
        tell(switched);
      } catch (error) {
        console.warn("[scene] 외부 파일 레퍼런스 추가 실패", error);
        // 알린다(조작 규칙 41) — 전엔 콘솔에만 남아, 놓은 파일이 들어오는 중인지·못 쓰는 파일인지·실패했는지 화면으로는 알 수 없었다
        pendingOpsRef.current!.patch(pendingId, { error: IMPORT_FAILED }); // 자리 표시가 빨갛게 남는다(✕ 로 치움) — 토스트는 곧 사라지므로
        flashMsg("파일을 캔버스에 넣지 못했습니다 — 다시 놓아 주세요.");
      }
    },
    [addReferenceCards],
  );

  const onDragOver = useCallback((event: ReactDragEvent) => {
    if (overSceneWindow(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (hasAssetDrag(event.dataTransfer) || dataTransferHasFiles(event.dataTransfer)) {
      event.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const onDrop = useCallback(
    (event: ReactDragEvent) => {
      if (overSceneWindow(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const current = optionsRef.current;
      if (hasAssetDrag(event.dataTransfer)) {
        const items = parseSpotlightAssetItems(readSpotlightAssetPayload(event.dataTransfer));
        if (!items.length) return;
        const point = current.toCanvas(event.clientX, event.clientY);
        const refs = items.map((item) => ({ ...assetItemToRef(item), origin: "asset" as const }));
        addReferenceCards(refs, point.x, point.y);
        // 한 번 물어 에셋 대장 번호(open_ids)를 받아 둔다 — 나중에 NAS 에서 이름을 바꾸거나 옮겨도 따라가게(2026-09-30).
        current.onLocalRefsAdded?.(refs.map((ref) => ref.file_path));
        return;
      }

      const { sceneFile, mediaFiles } = partitionSceneDropFiles(
        filesFromDataTransfer(event.dataTransfer),
      );
      if (sceneFile && current.onLoadSceneFile) {
        current.onLoadSceneFile(sceneFile);
        return;
      }
      if (mediaFiles.length) {
        const point = current.toCanvas(event.clientX, event.clientY);
        // 우리 프로그램에서 나간 파일(각인 있음)을 한 개만 떨어뜨리면 '어떻게 만들었나'를 노드로
        // 펼친다(ComfyUI 에서 워크플로 PNG 를 여는 것과 같은 동작). 각인이 없거나 카탈로그에서
        // 못 찾으면 아래 기존 동작(레퍼런스 카드로 추가)으로 그대로 흘러간다.
        // Shift 를 누른 채 놓으면 각인을 보지 않고 무조건 레퍼런스로 넣는다.
        const openRecipe = current.onDroppedGenerationFile;
        if (
          shouldRestoreRecipeFromDrop(mediaFiles, {
            shiftKey: event.shiftKey,
            hasHandler: !!openRecipe,
          }) && openRecipe
        ) {
          // 놓은 순간의 씬을 잡아 둔다 — 각인 판독(서버 왕복)을 기다리는 사이 씬을 바꾸면 파일이 그 씬에 들어갔다.
          const sceneAtDrop = current.sceneIdRef.current;
          void openRecipe(mediaFiles[0]).then((handled) => {
            if (!handled) void importExternalFiles(mediaFiles, point.x, point.y, sceneAtDrop);
          });
          return;
        }
        void importExternalFiles(mediaFiles, point.x, point.y);
      }
    },
    [addReferenceCards, importExternalFiles],
  );

  const copySelectedNodes = useCallback(() => {
    const current = optionsRef.current;
    clipboardRef.current = copySceneSelection(
      current.cardsRef.current,
      current.edgesRef.current,
      new Set(current.selectedRef.current),
    );
    sceneClipboardSnapshot = clipboardRef.current;

    sceneClipboardMarker = null; // 새 복사 시작 — 이전 표식은 즉시 무효(쓰기 완료 전 오판 방지)
    void (async () => {
      const marker = `[MV-hub#${uid()}] 노드 복사됨 — 캔버스에서 Ctrl+V 로 붙여넣기`;
      try {
        // 쓰기 함수가 없으면 '썼다'고 적지 않는다 — 표식이 클립보드에 실제로 들어갔을 때만 아래 붙여넣기 판정이 그것을 믿는다.
        if (typeof navigator.clipboard?.writeText !== "function") throw new Error("clipboard write unsupported");
        await navigator.clipboard.writeText(marker);
        sceneClipboardMarker = marker;
        lastImageKeyRef.current = null;
        return;
      } catch {
        // write 미지원/실패 시 이미지 지문 읽기로 폴백한다.
      }
      try {
        const clipboardItems = await navigator.clipboard?.read?.();
        if (!clipboardItems) return;
        for (const item of clipboardItems) {
          const imageType = item.types.find((type) => type.startsWith("image/"));
          if (!imageType) continue;
          const blob = await item.getType(imageType);
          lastImageKeyRef.current = `${blob.size}:${blob.type}`;
          return;
        }
      } catch {
        // 권한 없음/미지원이면 기존 이미지 지문 휴리스틱을 유지한다.
      }
    })();
  }, []);

  const pasteCopiedNodes = useCallback((): boolean => {
    const clipboard = clipboardRef.current;
    if (!clipboard?.cards.length) return false;
    const current = optionsRef.current;
    // 마우스가 캔버스 위에 있으면 그 지점에 붙인다(캡처 붙여넣기와 같은 규칙).
    // 캔버스 밖(단축키만 캔버스로 온 경우)이면 기존처럼 원본 자리에서 어긋나게 붙인다.
    const mouse = current.lastMouseRef.current;
    const pasteAt = mouse.over
      ? {
          ...current.toCanvas(mouse.x, mouse.y),
          cardWidth: current.cardWidth,
          cardHeight: current.cardHeight,
        }
      : undefined;
    const pasted = pasteSceneClipboard(
      current.cardsRef.current,
      current.edgesRef.current,
      clipboard,
      uid,
      undefined,
      pasteAt,
    );
    const nextCards = current.reconcileGenerationRefs(pasted.cards, pasted.edges);
    current.cardsRef.current = nextCards;
    current.edgesRef.current = pasted.edges;
    current.setCards(nextCards);
    current.setEdges(pasted.edges);
    current.setSelected(pasted.pastedCardIds);
    current.persist(nextCards, pasted.edges);
    clipboardRef.current = pasted.nextClipboard;
    sceneClipboardSnapshot = pasted.nextClipboard;
    return true;
  }, []);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (pasteFallbackTimerRef.current !== null) {
        window.clearTimeout(pasteFallbackTimerRef.current);
        pasteFallbackTimerRef.current = null;
      }
      // ★입력창 판정이 폴백 중복 방지보다 먼저 — 캔버스 폴백 직후 0.5초 안에 입력창에서
      //   Ctrl+V 하면 정상 텍스트 붙여넣기가 preventDefault 로 막히던 문제(합의 C-3b).
      if (isTextEntryTarget(event.target)) return;
      if (backgroundKeysBlocked() || gridWindowOpen()) return; // 위에 뜬 창·메뉴의 붙여넣기 — 가려진 보드에 붙이지 않는다
      if (optionsRef.current.frozenRef.current) return; // 씬을 바꾸는 틈 — 화면은 아직 떠난 씬이다
      // 일부 브라우저가 keydown 뒤 paste 이벤트를 늦게 보내는 경우, 이미 실행한 안전 폴백과
      // 같은 키 입력을 중복 처리하지 않는다.
      if (fallbackPasteAtRef.current && performance.now() - fallbackPasteAtRef.current < 500) {
        event.preventDefault();
        fallbackPasteAtRef.current = 0;
        return;
      }

      const image = clipboardImage(event);
      const imageKey = image ? `${image.size}:${image.type}` : null;
      const clipboard = clipboardRef.current;
      // 표식을 클립보드에 써 넣은 뒤라면, 지금 클립보드의 그림은 **그 뒤에 밖에서 새로 복사한 것**이다 — 방금 붙인 그림과 같아도 그림이다.
      //  (전엔 같은 그림을 두 번 붙이면 두 번째에 예전에 복사해 둔 노드가 붙었다.) 표식을 못 쓴 환경만 '방금 붙인 그림과 같은가'로 가린다.
      const intent = scenePasteIntent(
        imageKey,
        sceneClipboardMarker ? null : lastImageKeyRef.current,
        clipboard?.cards.length || 0,
      );

      if (intent === "image" && image) {
        event.preventDefault();
        lastImageKeyRef.current = imageKey;
        const current = optionsRef.current;
        const selected = current.selectedRef.current;
        const selectedId = selected.size === 1 ? [...selected][0] : null;
        const selectedCard = selectedId
          ? current.cardsRef.current.find((card) => card.id === selectedId)
          : undefined;
        const connectTo =
          selectedCard?.kind === "generation" ? [selectedCard.id] : undefined;

        let centerX: number;
        let centerY: number;
        const mouse = current.lastMouseRef.current;
        const bounds = current.scrollRef.current?.getBoundingClientRect();
        if (mouse.over) {
          const point = current.toCanvas(mouse.x, mouse.y);
          centerX = point.x;
          centerY = point.y;
        } else if (bounds) {
          const point = current.toCanvas(
            bounds.left + bounds.width / 2,
            bounds.top + bounds.height / 2,
          );
          centerX = point.x;
          centerY = point.y;
        } else if (connectTo) {
          centerX = 0;
          centerY = 0;
        } else {
          return;
        }

        const sceneId = current.sceneIdRef.current;
        const pendingId = uid();
        pendingOpsRef.current!.add({ id: pendingId, sceneId, x: centerX, y: centerY, count: 1, names: ["붙여 넣은 그림"], error: null });
        // 붙여넣은 그림은 이 PC 설치 폴더(captures)에만 둔다(Jay 2026-09-29 옛 방식).
        void api
          .uploadCapture(image)
          .then((result) => {
            pendingOpsRef.current!.dismiss(pendingId);
            if (!aliveRef.current) {
              flashMsg("붙여 넣은 그림을 가져왔지만, 그사이 캔버스를 떠나 넣지 않았습니다 — Assets 에서 끌어 넣으세요.");
            } else if (optionsRef.current.sceneIdRef.current === sceneId) {
              const ref = {
                ...assetItemToRef({
                  project: result.project,
                  path: result.path,
                  name: result.name,
                  type: result.type || "image",
                  sha256: result.sha256,
                  bytes: result.bytes,
                }),
                origin: "upload" as const,
              };
              addReferenceCards([ref], centerX, centerY, connectTo);
              optionsRef.current.onLocalRefsAdded?.([ref.file_path]);
            }
            notifySpotlightAssetsChanged([
              {
                project: result.project,
                path: result.path,
                name: result.name,
                type: result.type || "image",
              },
            ]);
          })
          .catch((error) => {
            console.warn("[scene] 캡쳐 붙여넣기 실패", error);
            pendingOpsRef.current!.patch(pendingId, { error: IMPORT_FAILED });
            flashMsg("붙여 넣은 그림을 캔버스에 넣지 못했습니다 — 다시 붙여 넣어 주세요.");
          });
        return;
      }

      if (intent === "nodes" && clipboard) {
        // 복사 때 심은 고유 표식과 클립보드 텍스트가 다르면, 그 사이 외부에서 다른 것을
        // 복사한 것 — 옛 노드 스냅샷을 붙이지 않는다(합의 FE-P3-1). 표식 기록에 실패했거나
        // 브라우저가 텍스트를 안 주면(빈 값) 기존 동작을 유지한다.
        const clipText = event.clipboardData?.getData("text/plain") || "";
        if (sceneClipboardMarker && clipText && clipText !== sceneClipboardMarker) return;
        event.preventDefault();
        pasteCopiedNodes();
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextEntryTarget(event.target) || backgroundKeysBlocked() || gridWindowOpen()) return;
      if (event.repeat) {
        // 길게 눌린 Ctrl+V — 브라우저는 반복 keydown 마다 paste 를 또 보낸다(카드가 반복 횟수만큼 붙고, 그림이면 그만큼 올라간다).
        //  보드가 받을 붙여넣기면 반복의 기본 동작(paste)을 막는다. 입력칸·위에 뜬 창의 붙여넣기는 위에서 이미 양보했다(조작 규칙 38).
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "v") event.preventDefault();
        return;
      }
      if (optionsRef.current.frozenRef.current) return; // 씬을 바꾸는 틈 — 예약(0.18초 뒤의 폴백)도 걸지 않는다
      if (!scenePasteShortcut(event, clipboardRef.current?.cards.length || 0)) return;
      // 직전 폴백 직후 사용자가 빠르게 Ctrl+V를 한 번 더 누른 것은 새로운 명령이다. 뒤늦게 도착한
      // 이전 paste 이벤트와 구분할 수 있도록 새 keydown에서 중복 방지 표식을 해제한다.
      fallbackPasteAtRef.current = 0;

      // 정상 브라우저에서는 곧바로 paste 이벤트가 와서 이 타이머를 취소한다. 브라우저·확장·포커스
      // 문제로 paste 이벤트 자체가 빠진 경우에만 내부 노드 복사본을 직접 붙인다.
      if (pasteFallbackTimerRef.current !== null) {
        window.clearTimeout(pasteFallbackTimerRef.current);
      }
      const sceneAtKey = optionsRef.current.sceneIdRef.current;
      // 예약한 뒤(0.18초)·클립보드를 읽은 뒤에 창이 떴거나 씬이 바뀌었으면 붙이지 않는다 — 그 키는 이미 지나간 화면의 것이다.
      //  보드가 내려갔어도(캔버스를 떠남) 같다 — 이미 시작한 클립보드 읽기는 타이머를 지워도 끝까지 간다(Codex 코드 리뷰).
      const stale = () => !aliveRef.current || backgroundKeysBlocked() || gridWindowOpen() || optionsRef.current.sceneIdRef.current !== sceneAtKey;
      pasteFallbackTimerRef.current = window.setTimeout(() => {
        pasteFallbackTimerRef.current = null;
        void (async () => {
          if (stale()) return;
          // 폴백도 표식을 검사한다(검증 P3) — 노드 복사 후 외부에서 다른 것을 복사했다면
          // 옛 노드 스냅샷을 붙이면 안 된다. readText 미지원/권한 거부면 기존 동작 유지.
          if (sceneClipboardMarker) {
            try {
              const text = await navigator.clipboard?.readText?.();
              if (text && text !== sceneClipboardMarker) return;
            } catch {
              /* 권한 없음 — 표식 검사 생략(폴백은 최후 수단) */
            }
          }
          if (stale()) return;
          if (pasteCopiedNodes()) fallbackPasteAtRef.current = performance.now();
        })();
      }, 180);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("paste", onPaste);
      if (pasteFallbackTimerRef.current !== null) {
        window.clearTimeout(pasteFallbackTimerRef.current);
        pasteFallbackTimerRef.current = null;
      }
    };
  }, [addReferenceCards, pasteCopiedNodes]);

  return { copySelectedNodes, onDragOver, onDrop, pendingImports, dismissPendingImport: pendingOpsRef.current.dismiss };
}
