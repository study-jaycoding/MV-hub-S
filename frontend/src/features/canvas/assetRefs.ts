import type { Scene, SceneCard } from "../../lib/scenes";
import { promoteAssetReference, type AssetSyncReceipt } from "../../shared/contracts/assets";

export function sceneRefWorkspaceId(scene: Pick<Scene, "workspace" | "refWorkspaceHint">): string {
  return scene.workspace?.id || scene.refWorkspaceHint?.id || "";
}

export interface RelinkTarget {
  project: string;
  path: string;
  sha256?: string;
  bytes?: number;
  // 에셋 대장 번호 — 대장이 확인한 답(fixed)이거나, 토큰은 그대로인 번호 알림(open_ids)
  registry_asset_id?: string;
  sync_receipt?: AssetSyncReceipt;
  registration?: { asset_content_id: string; target_project_id: string; expected_content_sha?: string; sha256?: string; bytes?: number };
}

/** 결과의 열쇠 — **공간 + 참조**. 같은 옛 참조라도 캔버스의 공간이 다르면 다른 파일로 찾힐 수 있다.
 *  참조만 열쇠로 쓰면 나중에 처리된 공간의 답이 다른 공간의 씬까지 덮는다(Codex 2026-09-28). */
export const relinkKey = (workspaceId: string, token: string, contentId?: string, projectId?: string): string =>
  `${workspaceId}\u0000${token}${projectId ? `\u0000${contentId || ""}\u0000${projectId}` : ""}`;

/** 한 씬(공간 ws)의 카드에서 찾은 참조만 갈아끼운다 — 안 바뀐 카드는 같은 객체 그대로. 썸네일은 새 주소로
 *  다시 만들게 비운다. 열린 캔버스는 이것을 **자기 메모리의 카드**에 바로 입힌다(SceneBoard applyAssetRelink). */
export function relinkCards(
  cards: SceneCard[],
  ws: string,
  found: Map<string, RelinkTarget>,
): { cards: SceneCard[]; changed: number } {
  let changed = 0;
  const next = cards.map((card) => {
    if (!card.refs?.length) return card;
    let touched = false;
    const refs = card.refs.map((ref) => {
      const hit = ref.file_path ? found.get(relinkKey(ws, ref.file_path, ref.asset_content_id, ref.target_project_id))
        || found.get(relinkKey(ws, ref.file_path)) : undefined;
      if (!hit) return ref;
      if (hit.registration) {
        const registered = hit.registration;
        if (!/^sha256:[a-f0-9]{64}$/.test(registered.asset_content_id)
          || ref.asset_content_id || ref.target_project_id !== registered.target_project_id
          || ref.content_sha !== registered.expected_content_sha
          || (ref.content_sha && ref.content_sha !== registered.sha256)) return ref;
        touched = true;
        changed += 1;
        return { ...ref, asset_content_id: registered.asset_content_id,
          content_sha: ref.content_sha || registered.sha256, bytes: ref.bytes || registered.bytes };
      }
      if (hit.sync_receipt) {
        const promoted = promoteAssetReference(ref, hit.sync_receipt);
        if (promoted === ref) return ref;
        touched = true;
        changed += 1;
        return promoted;
      }
      const nextPath = `asset:${hit.project}|${hit.path}`;
      if (nextPath === ref.file_path) {
        // 토큰은 그대로 — 대장 번호만 알려 준 답(open_ids). 이미 번호가 있으면 덮지 않는다.
        if (!hit.registry_asset_id || ref.registry_asset_id) return ref;
        touched = true;
        changed += 1;
        return { ...ref, registry_asset_id: hit.registry_asset_id };
      }
      if (ref.registry_asset_id) {
        // 대장 번호가 있는 참조는 **같은 번호의 답만** 받는다(Codex P0). 같은 번호면 논리 파일이 같으니, 넣을 때 판
        //  (content_sha)과 지금 판이 달라도 따라간다 — 고쳐 저장한 새 판을 보여 주는 것이 지금 캔버스 동작과 같다.
        if (hit.registry_asset_id !== ref.registry_asset_id) return ref;
      } else if (
        ref.content_sha &&
        (hit.sha256 !== ref.content_sha || (ref.bytes && hit.bytes && ref.bytes !== hit.bytes))
      ) {
        // 이 참조가 든 지문과 다른 답은 적용하지 않는다 — 같은 토큰을 쓰는 다른 그림이거나(PC 마다 imports 이름이
        //  겹친다), 지문 없이 경로로 찾은 답이다. 지문을 가진 참조는 내용으로만 잇는다(2026-09-29, Codex).
        return ref;
      }
      touched = true;
      changed += 1;
      return {
        ...ref,
        file_path: nextPath,
        thumb: null, // 옛 주소로 만든 썸네일은 버린다
        // 넣을 때 판은 지킨다(대장 번호로 따라간 새 판과 다를 수 있다). 없던 참조만 이번에 찾은 판을 적는다.
        content_sha: ref.content_sha ?? hit.sha256,
        bytes: ref.content_sha
          ? (ref.bytes ?? (hit.sha256 === ref.content_sha ? hit.bytes : undefined))
          : (hit.bytes ?? ref.bytes),
        ...(hit.registry_asset_id ? { registry_asset_id: hit.registry_asset_id } : {}),
      };
    });
    return touched ? { ...card, refs } : card;
  });
  return { cards: changed ? next : cards, changed };
}

/** 찾은 것만 갈아끼운 새 씬 목록과 바뀐 참조 수. 각 씬은 **자기 공간의 답만** 받는다.
 *  안 바뀐 씬은 같은 객체 그대로 — 화면이 그 씬을 다시 그리지 않게. */
export function applyRelink(
  scenes: Scene[],
  found: Map<string, RelinkTarget>,
): { scenes: Scene[]; changed: number } {
  let changed = 0;
  const next = scenes.map((scene) => {
    const relinked = relinkCards(scene.cards, sceneRefWorkspaceId(scene), found);
    changed += relinked.changed;
    return relinked.changed ? { ...scene, cards: relinked.cards } : scene;
  });
  return { scenes: changed ? next : scenes, changed };
}

