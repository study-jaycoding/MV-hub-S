import { describe, expect, it } from "vitest";

import {
  cardKey,
  detachedCandidates,
  readLocalCanvasState,
  type CardHistoryLink,
} from "./canvasDetached";
import type { Scene, SceneCard } from "./scenes";

const card = (id: string, genIds: string[] = []): SceneCard => ({
  id,
  kind: "generation",
  x: 0,
  y: 0,
  genIds,
  genId: genIds[genIds.length - 1] ?? null,
});

const scene = (id: string, name: string, cards: SceneCard[]): Scene => ({
  id,
  name,
  cards,
  edges: [],
  created_at: 0,
});

const link = (generation_id: string, scene_id: string, card_id: string): CardHistoryLink => ({
  generation_id,
  scene_id,
  card_id,
});

// 씬1 = 이 캔버스(카드 A 가 지금 열린 카드, 카드 B 도 살아 있음) / 씬2 = 다른 캔버스
const scenes = [
  scene("s1", "뻘뻘뻘", [card("A"), card("B", ["g-attached"])]),
  scene("s2", "산해학원", [card("C")]),
];
const local = readLocalCanvasState(scenes, true);
const target = { sceneId: "s1", cardId: "A" };

describe("readLocalCanvasState", () => {
  it("붙어 있는 생성물·살아 있는 카드·씬 이름을 모은다", () => {
    expect(local.readable).toBe(true);
    expect(local.attached.has("g-attached")).toBe(true);
    expect(local.liveCards.has(cardKey("s1", "B"))).toBe(true);
    expect(local.liveCards.has(cardKey("s1", "gone"))).toBe(false);
    expect(local.sceneNames.get("s2")).toBe("산해학원");
  });

  it("못 읽었으면 목록이 있어도 readable=false 다", () => {
    expect(readLocalCanvasState(scenes, false).readable).toBe(false);
  });
});

describe("detachedCandidates", () => {
  it("로컬을 못 읽으면 판정하지 않는다 — 전부 미아로 보이면 안 된다", () => {
    const result = detachedCandidates(
      [link("g1", "s1", "A")],
      readLocalCanvasState(null, false),
      target,
    );
    expect(result.status).toBe("unreadable");
    expect(result.items).toEqual([]);
  });

  it("지금 카드에 붙어 있는 것은 미아가 아니다", () => {
    const result = detachedCandidates([link("g-attached", "s1", "B")], local, target);
    expect(result.items).toEqual([]);
  });

  it("가까운 순으로 준다 — 이 카드 → 지워진 카드 → 다른 카드 → 다른 캔버스", () => {
    const result = detachedCandidates(
      [
        link("g-other-scene", "s2", "C"),
        link("g-live-card", "s1", "B"),
        link("g-gone-card", "s1", "지워진카드"),
        link("g-this-card", "s1", "A"),
      ],
      local,
      target,
    );
    expect(result.items.map((item) => item.generationId)).toEqual([
      "g-this-card",
      "g-gone-card",
      "g-live-card",
      "g-other-scene",
    ]);
    expect(result.items.map((item) => item.label)).toEqual([
      "이 카드에 있었음",
      "이 캔버스 · 지워진 카드",
      "이 캔버스 · 다른 카드",
      "다른 캔버스 · 산해학원",
    ]);
  });

  it("없어진 씬은 이름 대신 '지워짐'", () => {
    const result = detachedCandidates([link("g1", "s-gone", "X")], local, target);
    expect(result.items[0].label).toBe("다른 캔버스 · 지워짐");
  });

  it("여러 자리에 있었으면 가장 가까운 자리 하나로 접는다", () => {
    const result = detachedCandidates(
      [link("g1", "s2", "C"), link("g1", "s1", "A"), link("g1", "s1", "B")],
      local,
      target,
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      generationId: "g1",
      sceneId: "s1",
      cardId: "A",
      origin: "this-card",
    });
  });

  it("같은 순위 안에서는 서버가 준 최신순을 지킨다", () => {
    const result = detachedCandidates(
      [link("new", "s2", "C"), link("old", "s2", "C")],
      local,
      target,
    );
    expect(result.items.map((item) => item.generationId)).toEqual(["new", "old"]);
  });

  it("씬·카드가 빈 줄은 버린다", () => {
    const result = detachedCandidates(
      [link("g1", "", "A"), link("", "s1", "A"), link("g2", "s1", "")],
      local,
      target,
    );
    expect(result.items).toEqual([]);
  });

  it("'이 카드' 는 씬까지 같아야 한다 — 다른 캔버스의 같은 이름 카드가 섞이면 안 된다", () => {
    const result = detachedCandidates([link("g1", "s2", "A")], local, target);
    expect(result.items[0].origin).toBe("other-scene");
  });
});
