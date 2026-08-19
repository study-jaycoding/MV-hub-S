import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, DragEvent as ReactDragEvent, MutableRefObject, SetStateAction } from "react";
import { api } from "../api";
import { DRAG_TYPES } from "./dragTypes";
import { dataTransferHasFiles, filesFromDataTransfer } from "./media";
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
  cardWidth: number;
  cardHeight: number;
}

interface SceneClipboardDropHandlers {
  copySelectedNodes: () => void;
  onDragOver: (event: ReactDragEvent) => void;
  onDrop: (event: ReactDragEvent) => void;
}

// 캔버스가 탭 전환 등으로 다시 마운트돼도 방금 복사한 노드는 유지한다. 시스템 클립보드에는
// 안내 문구만 쓰므로, 실제 노드 구조는 이 메모리 스냅샷이 유일한 원본이다.
let sceneClipboardSnapshot: SceneClipboard | null = null;
// 복사 때 시스템 클립보드에 심는 고유 표식 — 붙여넣기 시 클립보드 텍스트가 이 표식과 다르면
// 사용자가 그 사이 외부에서 다른 것을 복사한 것이므로 옛 노드 스냅샷을 붙이지 않는다.
// null = 표식 기록 실패(클립보드 권한 등) — 그땐 기존 이미지 지문 휴리스틱만 쓴다.
let sceneClipboardMarker: string | null = null;

const hasAssetDrag = (dataTransfer: DataTransfer) =>
  Array.from(dataTransfer.types).includes(DRAG_TYPES.asset);

const assetItemToRef = (item: SpotlightAssetDragItem): SceneRef => {
  const base = spotlightAssetRefBase(item);
  return {
    file_path: base.file_path,
    type: base.type,
    name: base.name,
    thumb: base.thumb,
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
    async (files: File[], centerX: number, centerY: number) => {
      const accepted = files.filter((file) => referenceDropTypeFromFile(file));
      if (!accepted.length) return;
      const sceneId = optionsRef.current.sceneIdRef.current;
      try {
        const response = await api.uploadReferenceFiles(accepted);
        const items = response.saved || [];
        if (items.length) {
          if (optionsRef.current.sceneIdRef.current === sceneId) {
            addReferenceCards(
              items.map((item) => ({ ...assetItemToRef(item), origin: "upload" as const })),
              centerX,
              centerY,
            );
          }
          notifySpotlightAssetsChanged(items);
        }
      } catch (error) {
        console.warn("[scene] 외부 파일 레퍼런스 추가 실패", error);
      }
    },
    [addReferenceCards],
  );

  const onDragOver = useCallback((event: ReactDragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (hasAssetDrag(event.dataTransfer) || dataTransferHasFiles(event.dataTransfer)) {
      event.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const onDrop = useCallback(
    (event: ReactDragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const current = optionsRef.current;
      if (hasAssetDrag(event.dataTransfer)) {
        const items = parseSpotlightAssetItems(readSpotlightAssetPayload(event.dataTransfer));
        if (!items.length) return;
        const point = current.toCanvas(event.clientX, event.clientY);
        addReferenceCards(
          items.map((item) => ({ ...assetItemToRef(item), origin: "asset" as const })),
          point.x,
          point.y,
        );
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
          void openRecipe(mediaFiles[0]).then((handled) => {
            if (!handled) void importExternalFiles(mediaFiles, point.x, point.y);
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
        await navigator.clipboard?.writeText?.(marker);
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
    const pasted = pasteSceneClipboard(
      current.cardsRef.current,
      current.edgesRef.current,
      clipboard,
      uid,
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
      const intent = scenePasteIntent(
        imageKey,
        lastImageKeyRef.current,
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
        void api
          .uploadCapture(image)
          .then((result) => {
            if (optionsRef.current.sceneIdRef.current === sceneId) {
              addReferenceCards(
                [
                  {
                    ...assetItemToRef({
                      project: result.project,
                      path: result.path,
                      name: result.name,
                      type: result.type || "image",
                    }),
                    origin: "upload" as const,
                  },
                ],
                centerX,
                centerY,
                connectTo,
              );
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
          .catch((error) => console.warn("[scene] 캡쳐 붙여넣기 실패", error));
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
      if (event.repeat || isTextEntryTarget(event.target)) return;
      if (!scenePasteShortcut(event, clipboardRef.current?.cards.length || 0)) return;
      // 직전 폴백 직후 사용자가 빠르게 Ctrl+V를 한 번 더 누른 것은 새로운 명령이다. 뒤늦게 도착한
      // 이전 paste 이벤트와 구분할 수 있도록 새 keydown에서 중복 방지 표식을 해제한다.
      fallbackPasteAtRef.current = 0;

      // 정상 브라우저에서는 곧바로 paste 이벤트가 와서 이 타이머를 취소한다. 브라우저·확장·포커스
      // 문제로 paste 이벤트 자체가 빠진 경우에만 내부 노드 복사본을 직접 붙인다.
      if (pasteFallbackTimerRef.current !== null) {
        window.clearTimeout(pasteFallbackTimerRef.current);
      }
      pasteFallbackTimerRef.current = window.setTimeout(() => {
        pasteFallbackTimerRef.current = null;
        void (async () => {
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

  return { copySelectedNodes, onDragOver, onDrop };
}
