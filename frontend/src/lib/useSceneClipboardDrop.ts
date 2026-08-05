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
  type SceneClipboard,
} from "./sceneInteractions";
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
  cardWidth: number;
  cardHeight: number;
}

interface SceneClipboardDropHandlers {
  copySelectedNodes: () => void;
  onDragOver: (event: ReactDragEvent) => void;
  onDrop: (event: ReactDragEvent) => void;
}

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

const isTextEntryPaste = (event: ClipboardEvent): boolean => {
  const target = event.target as HTMLElement | null;
  const active = document.activeElement as HTMLElement | null;
  return !!(
    (target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable ||
        target.closest?.("input, textarea, [contenteditable=true], .sl-dockbar"))) ||
    active?.closest(".sl-dockbar")
  );
};

/** SceneBoard의 노드 복사, 캡처 붙여넣기, 에셋/파일 드롭 수명주기를 관리한다. */
export function useSceneClipboardDrop(
  options: UseSceneClipboardDropOptions,
): SceneClipboardDropHandlers {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const clipboardRef = useRef<SceneClipboard | null>(null);
  const lastImageKeyRef = useRef<string | null>(null);

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

    void (async () => {
      try {
        await navigator.clipboard?.writeText?.(
          "[MV-hub] 노드 복사됨 — 캔버스에서 Ctrl+V 로 붙여넣기",
        );
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

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (isTextEntryPaste(event)) return;

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
        event.preventDefault();
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
      }
    };

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [addReferenceCards]);

  return { copySelectedNodes, onDragOver, onDrop };
}
