import { useCallback, useRef, useState, type MutableRefObject } from "react";
import type { Generation } from "../types";
import { applyWorkspaceReview, canOpenWorkspaceReview, type ReviewAction } from "./generationReview";
import { variantIds, type SceneCard } from "./scenes";
import { ownEntry } from "./ownEntry";
import type { WorkspaceCommandOperation, WorkspaceCommandTarget } from "./workspaceCommand";
import type { SceneGenDataApi, useSceneGenData } from "./useSceneGenData";

interface Options {
  cardsRef: MutableRefObject<SceneCard[]>;
  selectedRef: MutableRefObject<Set<string>>;
  genDataRef: SceneGenDataApi["genDataRef"];
  setGenData: SceneGenDataApi["setGenData"];
  refreshGenerationAfter: ReturnType<typeof useSceneGenData>["refreshGenerationAfter"];
  variantTargetIds: () => string[];
  onSetTags?: (g: Generation, tags: string[]) => void;
  onSetAutoTags?: (g: Generation, names: string[]) => void;
  onPublish?: (g: Generation) => void;
  onUnpublish?: (g: Generation) => void;
  onFinalize?: (g: Generation) => void;
  onUnfinalize?: (g: Generation) => void;
  onReview?: (g: Generation, action: ReviewAction) => void;
  canFinalize?: (g: Generation) => boolean;
  onWorkspaceCommand?: (
    g: Generation,
    operation: WorkspaceCommandOperation,
    workspace: WorkspaceCommandTarget,
    targets?: Generation[], // '생성 결과' 창에서 여러 장을 고른 채 내린 명령 — 고른 전체
  ) => Promise<boolean>;
}
export function useSceneCardLibraryActions({ cardsRef, selectedRef, genDataRef, setGenData, refreshGenerationAfter, variantTargetIds,
  onSetTags, onSetAutoTags, onWorkspaceCommand, onPublish, onUnpublish, onFinalize, onUnfinalize, onReview, canFinalize }: Options) {
  const onSetTagsRef = useRef(onSetTags);
  onSetTagsRef.current = onSetTags;
  const [tagEditCardId, setTagEditCardId] = useState<string | null>(null); // 태그 편집 팝업이 열린 카드 id(같은 생성물이 여러 카드여도 하나만)
  const [tagEditNodeGenId, setTagEditNodeGenId] = useState<string | null>(null); // 카드 내부 HistoryBoardNode 의 태그 편집 대상 gen id
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
  // #+/#- 워크스페이스 변경 — App 핸들러(서버 저장+라이브러리 갱신)에 위임하고, 성공 시 씬
  // genData 사본도 낙관 패치해 다시 열었을 때 활성 칩(현재 귀속)이 맞게 보이게 한다.
  const applyCardWorkspace = onWorkspaceCommand
    ? async (
        g: Generation,
        operation: WorkspaceCommandOperation,
        workspace: WorkspaceCommandTarget,
        targets?: Generation[], // 여러 장에 한 번에(결과 창) — 없으면 그 카드 하나
      ): Promise<boolean> => {
        const ok = await onWorkspaceCommand(g, operation, workspace, targets);
        if (ok) {
          setGenData((prev) => {
            const next = { ...prev };
            for (const { id } of targets?.length ? targets : [g]) {
              const cur = prev[id];
              if (!cur) continue;
              if (operation === "assign") next[id] = { ...cur, workspace_id: workspace.id, workspace_name: workspace.name };
              // remove 는 '그 공간 소속이었을 때만' 해제된다 — 다른 공간 소속이면 서버도 무변경
              else if (cur.workspace_id === workspace.id) next[id] = { ...cur, workspace_id: null, workspace_name: null };
            }
            return next;
          });
        }
        return ok;
      }
    : undefined;
  // '생성 결과' 창 — 여러 장을 고른 채 그중 한 카드에서 내린 워크스페이스 명령은 고른 전체에(편집기가 그렇게 안내한다).
  //  태그와 같은 규칙: 그 카드가 고른 묶음 안일 때만 묶음 전체, 아니면 그 카드 하나.
  const variantWorkspace = applyCardWorkspace
    ? (g: Generation, operation: WorkspaceCommandOperation, workspace: WorkspaceCommandTarget) => {
        const ids = variantTargetIds();
        const targets = ids.includes(g.id) && ids.length > 1
          ? ids.map((id) => ownEntry(genDataRef.current, id)).filter((item): item is Generation => !!item)
          : undefined;
        return applyCardWorkspace(g, operation, workspace, targets);
      }
    : undefined;

  // '생성 결과' 창 — 여러 장을 고른 채 한 카드에서 태그를 더하거나 빼면 고른 나머지에도 같이(라이브러리 카드와 같은 약속).
  //  그 카드 자신은 편집기가 직접 바꾸므로 여기서는 나머지만. 카드마다 기존 경로(applyCardTags: 씬 사본 + App 저장)로 넣는다.
  const bulkVariantTags = (focus: Generation, names: string[], field: "tags" | "auto_tags", mode: "add" | "remove") => {
    for (const id of variantTargetIds()) {
      if (id === focus.id) continue;
      const g = ownEntry(genDataRef.current, id);
      if (!g) continue;
      const current = (field === "tags" ? g.tags : g.auto_tags) ?? [];
      const next = mode === "add"
        ? [...current, ...names.filter((name) => !current.includes(name))]
        : current.filter((name) => !names.includes(name));
      if (next.length === current.length) continue; // 더할 것도 뺄 것도 없다
      if (field === "tags") applyCardTags(g, next);
      else applyCardAutoTags(g, next);
    }
  };
  // 캔버스 노드·'생성 결과' 창 카드의 공유·최종 — 확인을 받은 뒤 부른다. 씬은 자체 genData 사본을 쓰므로 App 핸들러(서버 반영)만으론
  //  카드가 즉시 안 바뀐다 → 낙관적으로 먼저 뒤집어 보이고, 핸들러가 끝난 뒤 재조회해 서버 확정값으로 맞춘다 — 고정 지연이면 느린
  //  네트워크에서 쓰기 전 옛 값을 덮어써 카드가 되돌아갈 수 있어, 반드시 핸들러 완료 후에 조회한다.
  const variantShareAct = (g: Generation, patch: Partial<Generation>, act?: (g: Generation) => void) => {
    setGenData((prev) => (prev[g.id] ? { ...prev, [g.id]: { ...prev[g.id], ...patch } } : prev));
    refreshGenerationAfter(g.id, Promise.resolve(act?.(g)));
  };
  const variantShare = {
    onPublish: (g: Generation) => variantShareAct(g, { shared: true }, onPublish),
    onUnpublish: (g: Generation) => variantShareAct(g, { shared: false, is_held: false }, onUnpublish),
    onFinalize: (g: Generation) => variantShareAct(g, { is_final: true, shared: true, is_held: false }, onFinalize), // 최종 지정은 공유·보류 해제를 함께
    onUnfinalize: (g: Generation) => variantShareAct(g, { is_final: false, is_held: false }, onUnfinalize),
    // 이 길은 최종 → 공유·해제뿐이다(lib/generationReview applyWorkspaceReview)
    onReview: (g: Generation, action: ReviewAction) =>
      variantShareAct(g, { shared: action === "shared", is_final: false, is_held: false }, (target) => onReview?.(target, action)),
  };

  // ── 생성 결과 카드의 S 선택 창 — 히스토리 보드와 같다 ──
  const [sConfirm, setSConfirm] = useState<{ id: string } | null>(null);
  const cbRef = useRef({ canFinalize, variantShare });
  cbRef.current = { canFinalize, variantShare };
  const onNodeSClick = useCallback((g: Generation) => {
    const { canFinalize } = cbRef.current;
    if (!canOpenWorkspaceReview(g, canFinalize ? canFinalize(g) : true)) return;
    setSConfirm((open) => (open?.id === g.id ? null : { id: g.id })); // 열린 창은 S 를 다시 눌러 닫는다
  }, []);
  const onNodeSConfirmYes = useCallback((g: Generation, action: ReviewAction) => {
    setSConfirm(null);
    applyWorkspaceReview(g, action, cbRef.current.variantShare);
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
  const editSelectedTag = (): boolean => {
    if (!onSetTagsRef.current) return false;
    const target = [...selectedRef.current]
      .map((id) => cardsRef.current.find((card) => card.id === id))
      .find(
        (card) =>
          !!card &&
          card.kind === "generation" &&
          !!card.genId &&
          !!ownEntry(genDataRef.current, card.genId),
      );
    if (!target) return false;
    setTagEditNodeGenId(null);
    setTagEditCardId(target.id);
    return true;
  };

  return { tagEditCardId, setTagEditCardId, tagEditNodeGenId, setTagEditNodeGenId, applyCardTags, applyCardAutoTags,
    applyCardWorkspace, variantWorkspace, bulkVariantTags, variantShare, sConfirm, setSConfirm, onNodeSClick,
    onNodeSConfirmYes, onNodeSConfirmNo, onNodeTag, editSelectedTag };
}
