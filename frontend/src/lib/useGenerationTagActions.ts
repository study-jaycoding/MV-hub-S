import { useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { api } from "../api";
import type { Generation } from "../types";
import {
  addGenerationTags,
  generationBulkIds,
  generationsByIds,
  removeGenerationTags,
  replaceGenerationTags,
} from "./generationTags";
import { createMutationQueue } from "./mutationQueue";

interface UseGenerationTagActionsArgs {
  flash: (message: string) => void;
  gensRef: MutableRefObject<Generation[]>;
  onTagNamesAdded: (names: string[]) => void;
  reload: (silent?: boolean, light?: boolean) => void | Promise<void>;
  selectedRef: MutableRefObject<Set<string>>;
  setGens: Dispatch<SetStateAction<Generation[]>>;
}

class TagSaveError extends Error {
  constructor(readonly failed: number) {
    super("generation tag save failed");
  }
}

export function useGenerationTagActions({
  flash,
  gensRef,
  onTagNamesAdded,
  reload,
  selectedRef,
  setGens,
}: UseGenerationTagActionsArgs) {
  const latestCallbacksRef = useRef({ flash, reload });
  latestCallbacksRef.current = { flash, reload };
  const tagQueueRef = useRef<ReturnType<typeof createMutationQueue> | null>(null);
  if (!tagQueueRef.current) {
    tagQueueRef.current = createMutationQueue(
      async (errors) => {
        const latest = latestCallbacksRef.current;
        await latest.reload(false, false); // 실패 때는 낙관적으로 합친 facets.tags 도 서버값으로 복구.
        const failed = errors.reduce<number>(
          (sum, error) => sum + (error instanceof TagSaveError ? error.failed : 1),
          0,
        );
        latest.flash(`태그 저장 ${failed}건 실패 — 서버 상태로 되돌렸습니다`);
      },
      // 빠른 연속 편집을 모두 저장한 마지막 시점에 한 번만 목록을 맞춘다. 저장 건마다 조회하면
      // 앞 저장의 서버값이 뒤 낙관적 편집을 잠깐 덮어 캔버스 태그가 깜빡이는 문제가 생긴다.
      () => latestCallbacksRef.current.reload(true, false),
    );
  }

  const applyGens = (update: (generations: Generation[]) => Generation[]) => {
    const next = update(gensRef.current);
    gensRef.current = next;
    setGens((current) => {
      const updated = update(current);
      gensRef.current = updated;
      return updated;
    });
    return next;
  };

  const enqueueSave = (operation: () => Promise<unknown>, total: number) => {
    void tagQueueRef.current?.enqueue(async () => {
      try {
        await operation();
      } catch (error) {
        if (error instanceof TagSaveError) throw error;
        throw new TagSaveError(total);
      }
    });
  };

  const onSetTags = (g: Generation, tags: string[]) => {
    applyGens((generations) => replaceGenerationTags(generations, g.id, "tags", tags));
    onTagNamesAdded(tags);
    enqueueSave(() => api.setTags(g.id, tags), 1);
  };

  const onSetAutoTags = (g: Generation, names: string[]) => {
    applyGens((generations) => replaceGenerationTags(generations, g.id, "auto_tags", names));
    enqueueSave(() => api.setGenAutoTags(g.id, names), 1);
  };

  const enqueueBulkTags = (
    items: { id: string; tags: string[] }[],
    auto: boolean,
  ) => {
    enqueueSave(async () => {
      const result = await api.setTagsBatch(items, auto);
      if (result.failed.length) throw new TagSaveError(result.failed.length);
    }, items.length);
  };

  const onBulkAddTags = (g: Generation, names: string[]) => {
    const idSet = generationBulkIds(selectedRef.current, g.id);
    if (!idSet.size) return;
    const next = applyGens((generations) => addGenerationTags(generations, idSet, "tags", names));
    onTagNamesAdded(names);
    enqueueBulkTags(
      generationsByIds(next, idSet).map((x) => ({ id: x.id, tags: x.tags })),
      false,
    );
    flash(`선택한 ${idSet.size}개에 태그 적용`);
  };

  const onBulkRemoveTags = (g: Generation, names: string[]) => {
    const idSet = generationBulkIds(selectedRef.current, g.id);
    if (!idSet.size) return;
    const next = applyGens((generations) => removeGenerationTags(generations, idSet, "tags", names));
    enqueueBulkTags(
      generationsByIds(next, idSet).map((x) => ({ id: x.id, tags: x.tags })),
      false,
    );
  };

  const onBulkAddAutoTags = (g: Generation, names: string[]) => {
    const idSet = generationBulkIds(selectedRef.current, g.id);
    if (!idSet.size) return;
    const next = applyGens((generations) =>
      addGenerationTags(generations, idSet, "auto_tags", names),
    );
    enqueueBulkTags(
      generationsByIds(next, idSet).map((x) => ({ id: x.id, tags: x.auto_tags || [] })),
      true,
    );
    flash(`선택한 ${idSet.size}개에 전역 태그 적용`);
  };

  const onBulkRemoveAutoTags = (g: Generation, names: string[]) => {
    const idSet = generationBulkIds(selectedRef.current, g.id);
    if (!idSet.size) return;
    const next = applyGens((generations) =>
      removeGenerationTags(generations, idSet, "auto_tags", names),
    );
    enqueueBulkTags(
      generationsByIds(next, idSet).map((x) => ({ id: x.id, tags: x.auto_tags || [] })),
      true,
    );
    flash(`선택한 ${idSet.size}개에서 전역 태그 해제`);
  };

  return {
    onBulkAddAutoTags,
    onBulkAddTags,
    onBulkRemoveAutoTags,
    onBulkRemoveTags,
    onSetAutoTags,
    onSetTags,
  };
}
