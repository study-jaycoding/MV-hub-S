// 모델 설정 저장 뒤 카드 높이 맞춤(Jay 2026-10-22) — 높이만 바꾸고, 실행 취소 기록을 따로 만들지 않는 파생 변경이다.
import { expect, test } from "vitest";
import { applyCanvasEdit } from "../src/features/canvas/edits";
import type { SceneCard } from "../src/lib/scenes";

const model: SceneCard = { id: "m1", kind: "model", x: 10, y: 20, w: 152, h: 130, modelCfg: { model: "seedance", params: { aspect_ratio: "16:9" } } };

test("fitCardHeight 는 그 카드의 높이만 바꾸고 파생 변경으로 남긴다", () => {
  const edit = applyCanvasEdit({ cards: [model], edges: [], groups: [] }, { type: "fitCardHeight", cardId: "m1", h: 187.6 }, {});
  expect(edit?.policy).toBe("derived");
  expect(edit?.snapshot.cards[0]).toEqual({ ...model, h: 188 });
});

test("없는 카드면 아무것도 하지 않는다", () => {
  expect(applyCanvasEdit({ cards: [model], edges: [], groups: [] }, { type: "fitCardHeight", cardId: "x", h: 200 }, {})).toBeNull();
});
