import { APP_EVENTS, dispatchAppEvent } from "./appEvents";
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
  // 캔버스(씬)는 생성물 사본을 따로 들고 있고 완료 카드는 평소 다시 읽지 않는다. 그래서 저장 묶음이 끝날 때마다(성공·실패 모두)
  //  같은 창에 알려 그 사본을 서버 값으로 다시 읽게 한다(APP_EVENTS.generationTagsSettled → useSceneGenData).
  //  실패 때만 알리면 안 된다: 복구 조회나 앞선 다시 읽기를 기다리는 사이에 들어온 다음 편집은 그 뒤에야 저장되는데, 씬의 다시
  //  읽기(0.3초 뒤)가 그 저장보다 먼저 끝나면 방금 한 편집이 옛 값으로 덮인 채 남는다(Codex 코드 리뷰 10-07 — 한 번만 갚는
  //  방식은 같은 순서가 한 단계 뒤에서 또 생겼다). 마지막 저장 뒤에는 반드시 한 번 다시 읽으므로 끝에는 서버와 맞는다.
  //  ponytail: 연속 편집 도중 다시 읽기가 다음 저장보다 먼저 끝나면 방금 넣은 태그가 잠깐 사라졌다 돌아올 수 있다 — 거슬리면
  //   씬 쪽에서 '저장 대기 중인 태그'를 다시 읽기 결과 위에 덧씌운다.
  const announceSettled = () => dispatchAppEvent(APP_EVENTS.generationTagsSettled);
  if (!tagQueueRef.current) {
    tagQueueRef.current = createMutationQueue(
      async (errors) => {
        const latest = latestCallbacksRef.current;
        try {
          await latest.reload(false, false); // 실패 때는 낙관적으로 합친 facets.tags 도 서버값으로 복구.
        } finally {
          announceSettled();
        }
        const failed = errors.reduce<number>(
          (sum, error) => sum + (error instanceof TagSaveError ? error.failed : 1),
          0,
        );
        latest.flash(`태그 저장 ${failed}건 실패 — 서버 상태로 되돌렸습니다`);
      },
      // 빠른 연속 편집을 모두 저장한 마지막 시점에 한 번만 목록을 맞춘다. 저장 건마다 조회하면
      // 앞 저장의 서버값이 뒤 낙관적 편집을 잠깐 덮어 캔버스 태그가 깜빡이는 문제가 생긴다.
      //  알림은 목록 조회 **뒤에** — 조회를 기다리는 사이에 들어온 편집의 저장이 그때 출발하므로, 씬의 다시 읽기(0.3초 뒤)가 그 저장을 담는다.
      async () => {
        try {
          await latestCallbacksRef.current.reload(true, false);
        } finally {
          announceSettled();
        }
      },
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
