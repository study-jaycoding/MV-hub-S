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

  const onBulkAddTags = (g: Generation, names: string[]) => {
    const idSet = generationBulkIds(selectedRef.current, g.id);
    if (!idSet.size) return;
    const next = addGenerationTags(gensRef.current, idSet, "tags", names);
    applyGens(next);
    Promise.allSettled(generationsByIds(next, idSet).map((x) => api.setTags(x.id, x.tags)))
      .then(scheduleTagReload)
      .catch(() => {});
    flash(`선택한 ${idSet.size}개에 태그 적용`);
  };

  const onBulkRemoveTags = (g: Generation, names: string[]) => {
    const idSet = generationBulkIds(selectedRef.current, g.id);
    if (!idSet.size) return;
    const next = removeGenerationTags(gensRef.current, idSet, "tags", names);
    applyGens(next);
    Promise.allSettled(generationsByIds(next, idSet).map((x) => api.setTags(x.id, x.tags)))
      .then(scheduleTagReload)
      .catch(() => {});
  };

  const onBulkAddAutoTags = (g: Generation, names: string[]) => {
    const idSet = generationBulkIds(selectedRef.current, g.id);
    if (!idSet.size) return;
    const next = addGenerationTags(gensRef.current, idSet, "auto_tags", names);
    applyGens(next);
    Promise.allSettled(
      generationsByIds(next, idSet).map((x) => api.setGenAutoTags(x.id, x.auto_tags || [])),
    )
      .then(scheduleTagReload)
      .catch(() => {});
    flash(`선택한 ${idSet.size}개에 전역 태그 적용`);
  };

  const onBulkRemoveAutoTags = (g: Generation, names: string[]) => {
    const idSet = generationBulkIds(selectedRef.current, g.id);
    if (!idSet.size) return;
    const next = removeGenerationTags(gensRef.current, idSet, "auto_tags", names);
    applyGens(next);
    Promise.allSettled(
      generationsByIds(next, idSet).map((x) => api.setGenAutoTags(x.id, x.auto_tags || [])),
    )
      .then(scheduleTagReload)
      .catch(() => {});
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
