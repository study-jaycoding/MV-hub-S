import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { api } from "../api";
import type { Generation } from "../types";
import {
  addGenerationTags,
  generationBulkIds,
  generationsByIds,
  removeGenerationTags,
  replaceGenerationTags,
} from "./generationTags";

interface UseGenerationTagActionsArgs {
  flash: (message: string) => void;
  gensRef: MutableRefObject<Generation[]>;
  scheduleTagReload: () => void;
  selectedRef: MutableRefObject<Set<string>>;
  setGens: Dispatch<SetStateAction<Generation[]>>;
}

export function useGenerationTagActions({
  flash,
  gensRef,
  scheduleTagReload,
  selectedRef,
  setGens,
}: UseGenerationTagActionsArgs) {
  const applyGens = (next: Generation[]) => {
    gensRef.current = next;
    setGens(next);
  };

  const onSetTags = (g: Generation, tags: string[]) => {
    applyGens(replaceGenerationTags(gensRef.current, g.id, "tags", tags));
    api.setTags(g.id, tags).then(scheduleTagReload).catch((e) => flash("태그 변경 실패: " + String(e)));
  };

  const onSetAutoTags = (g: Generation, names: string[]) => {
    applyGens(replaceGenerationTags(gensRef.current, g.id, "auto_tags", names));
    api.setGenAutoTags(g.id, names)
      .then(scheduleTagReload)
      .catch((e) => flash("전역 태그 변경 실패: " + String(e)));
  };

  const persistBulkTags = (
    items: { id: string; tags: string[] }[],
    auto: boolean,
    action: string,
  ) => {
    api
      .setTagsBatch(items, auto)
      .then((result) => {
        if (result.failed.length) flash(`${action} ${result.failed.length}/${items.length}건 실패`);
        scheduleTagReload();
      })
      .catch(() => {
        flash(`${action} 실패`);
        scheduleTagReload();
      });
  };

  const onBulkAddTags = (g: Generation, names: string[]) => {
    const idSet = generationBulkIds(selectedRef.current, g.id);
    if (!idSet.size) return;
    const next = addGenerationTags(gensRef.current, idSet, "tags", names);
    applyGens(next);
    persistBulkTags(
      generationsByIds(next, idSet).map((x) => ({ id: x.id, tags: x.tags })),
      false,
      "태그 적용",
    );
    flash(`선택한 ${idSet.size}개에 태그 적용`);
  };

  const onBulkRemoveTags = (g: Generation, names: string[]) => {
    const idSet = generationBulkIds(selectedRef.current, g.id);
    if (!idSet.size) return;
    const next = removeGenerationTags(gensRef.current, idSet, "tags", names);
    applyGens(next);
    persistBulkTags(
      generationsByIds(next, idSet).map((x) => ({ id: x.id, tags: x.tags })),
      false,
      "태그 해제",
    );
  };

  const onBulkAddAutoTags = (g: Generation, names: string[]) => {
    const idSet = generationBulkIds(selectedRef.current, g.id);
    if (!idSet.size) return;
    const next = addGenerationTags(gensRef.current, idSet, "auto_tags", names);
    applyGens(next);
    persistBulkTags(
      generationsByIds(next, idSet).map((x) => ({ id: x.id, tags: x.auto_tags || [] })),
      true,
      "전역 태그 적용",
    );
    flash(`선택한 ${idSet.size}개에 전역 태그 적용`);
  };

  const onBulkRemoveAutoTags = (g: Generation, names: string[]) => {
    const idSet = generationBulkIds(selectedRef.current, g.id);
    if (!idSet.size) return;
    const next = removeGenerationTags(gensRef.current, idSet, "auto_tags", names);
    applyGens(next);
    persistBulkTags(
      generationsByIds(next, idSet).map((x) => ({ id: x.id, tags: x.auto_tags || [] })),
      true,
      "전역 태그 해제",
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
