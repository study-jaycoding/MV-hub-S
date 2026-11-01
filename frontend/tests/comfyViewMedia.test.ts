// Comfy 결과는 저장 뒤에도 주소를 남긴다(재검토 A-10) — View 직접 연결·뒤 노드 입력·공개판 앱이 그 주소로 읽는다. 카드에서 지운 결과는 주소도 함께 지운다.
import { describe, expect, it } from "vitest";
import { applyComfyResolution } from "../src/features/canvas/comfyCommands";
import { applyCanvasEdit } from "../src/features/canvas/edits";
import { comfySceneFingerprints, gatherComfyMedia } from "../src/lib/sceneComfyInputs";
import { collectViewGenCardIds, comfyOutputMedia, comfyOutputMediaFrom, comfyViewMedia } from "../src/lib/sceneEdges";
import { withoutVariants, type Scene, type SceneCard } from "../src/lib/scenes";

const URL = "/media/comfy/local-job-a.png";
const comfyCard = (outputs: object[], extra: object = {}) =>
  ({ id: "c", kind: "comfy", x: 0, y: 0, comfyCfg: { name: "wf", content: "{}", outputs }, ...extra }) as SceneCard;

function resolved() {
  const card = comfyCard([{ kind: "image", url: URL }]);
  const view = { id: "v", kind: "view", x: 100, y: 0 } as SceneCard;
  const next = { id: "n", kind: "comfy", x: 200, y: 0, comfyCfg: { name: "next", content: "{}" } } as SceneCard;
  const base = { id: "s", name: "s", created_at: 1, cards: [card, view, next], edges: [{ id: "e1", from: "c", to: "v" }, { id: "e2", from: "c", to: "n" }] } as unknown as Scene;
  const fp = comfySceneFingerprints(base, "c")!;
  const run = { attemptId: "a", cardId: "c", runGroupId: "g", groupSeq: 1, copyIndex: 0, originHubId: "h", originDeviceId: "d", configFp: fp.configFp, inputFp: fp.inputFp, localState: "submitted" };
  const scene = { ...base, comfyRuns: [run], comfyCardRuns: { c: { groupId: "g", groupSeq: 1 } } } as unknown as Scene;
  const outputs = [{ output_key: "comfy/local-job-a.png", kind: "image", state: "saved", generation_id: "g1", url: URL }, { output_key: "text:1", kind: "text", state: "text", text: "글" }];
  return applyComfyResolution(scene, { attempt_id: "a", origin: { hub_id: "h", device_id: "d" }, state: "saved", result_revision: 1, disposition: "attached", outputs } as never).scene;
}

describe("저장된 결과의 주소", () => {
  it("카드 출력에 url 과 생성물 id 가 함께 남아 공개판 규칙(url 필수)으로 읽힌다", () => {
    const card = resolved().cards[0];
    expect(card.comfyCfg?.outputs).toEqual([{ kind: "image", url: URL, saved_generation_id: "g1" }, { kind: "text", text: "글" }]);
    expect(comfyOutputMediaFrom(card.comfyCfg!.outputs!)).toEqual([{ url: URL, kind: "image" }]);
    expect(comfyOutputMedia(card)).toEqual([{ url: URL, kind: "image" }]);
  });
  it("View 직접 연결로 재생할 미디어가 나오고 뒤 노드 입력도 그 주소다", () => {
    const scene = resolved();
    const byId = new Map(scene.cards.map((card) => [card.id, card]));
    expect(collectViewGenCardIds("v", byId, scene.edges)).toEqual([]); // 직접 연결은 출력으로만 읽는다
    expect(comfyViewMedia(scene.cards[0], () => undefined)).toEqual([{ url: URL, kind: "image" }]);
    expect(gatherComfyMedia("n", scene.cards, scene.edges, {}).map((media) => media.url)).toEqual([URL]);
  });
  it("url 없이 저장된 출력은 생성물 자료로 풀고, 자료가 없으면 건너뛴다", () => {
    const card = comfyCard([{ kind: "image", saved_generation_id: "old" }, { kind: "video", saved_generation_id: "none" }, { kind: "text", text: "글" }]);
    const paths: Record<string, string> = { old: "/media/old.png" };
    expect(comfyViewMedia(card, (id) => paths[id])).toEqual([{ url: "/media/old.png", kind: "image" }]);
  });
});

describe("카드에서 지운 결과", () => {
  const card = comfyCard(
    [{ kind: "image", url: URL, saved_generation_id: "g1" }, { kind: "image", url: "/media/comfy/b.png", saved_generation_id: "g2" }, { kind: "image", url: "/media/comfy/c.png" }, { kind: "text", text: "글" }],
    { genIds: ["g1", "g2"], genId: "g1" },
  );
  it("지운 생성물의 출력만 빠지고 다른 결과·아직 저장 전 출력·글자는 남는다", () => {
    const next = withoutVariants(card, new Set(["g1"]));
    expect(next.genIds).toEqual(["g2"]);
    expect(next.genId).toBe("g2");
    expect(next.comfyCfg?.outputs).toEqual(card.comfyCfg!.outputs!.slice(1));
  });
  it("지운 결과는 View·뒤 노드 입력·표시 출력에 다시 나오지 않는다", () => {
    const view = { id: "v", kind: "view", x: 0, y: 0 } as SceneCard;
    const next = { id: "n", kind: "comfy", x: 0, y: 0 } as SceneCard;
    const edges = [{ id: "e", from: "c", to: "n" }] as never;
    const edit = applyCanvasEdit({ cards: [card, view, next], edges, groups: [] }, { type: "removeCardVariants", cardId: "c", removedIds: ["g1"] }, {} as never)!;
    const after = edit.snapshot.cards[0];
    expect(comfyViewMedia(after, () => undefined).map((media) => media.url)).not.toContain(URL);
    expect(comfyOutputMedia(after).map((media) => media.url)).not.toContain(URL);
    expect(gatherComfyMedia("n", edit.snapshot.cards, edit.snapshot.edges, {}).map((media) => media.url)).not.toContain(URL);
  });
  it("출력이 없는 카드는 그대로 다룬다", () => {
    const plain = { id: "g", kind: "generation", x: 0, y: 0, genIds: ["g1", "g2"], genId: "g2" } as SceneCard;
    const next = withoutVariants(plain, new Set(["g2"]));
    expect(next).toEqual({ ...plain, genIds: ["g1"], genId: "g1" });
  });
});
