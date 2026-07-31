// sceneComfyInputs 순수 이동 계약 — 세부 그래프 로직은 sceneEdges.test 가 커버, 여기선 경계·위임 계약만.
import { describe, it, expect } from "vitest";
import { hasTextConnection, gatherComfyMedia, driveTextParams } from "../src/lib/sceneComfyInputs";
import type { SceneCard } from "../src/lib/scenes";

const comfy = (id: string, o: Partial<SceneCard> = {}): SceneCard => ({ id, kind: "comfy", x: 0, y: 0, ...o }) as SceneCard;

describe("sceneComfyInputs", () => {
  it("입력 엣지가 없으면 수집 미디어 없음", () => {
    expect(gatherComfyMedia("c", [comfy("c")], [], {})).toEqual([]);
  });
  it("텍스트 연결 엣지가 없으면 hasTextConnection=false", () => {
    expect(hasTextConnection("c", new Map([["c", comfy("c")]]), [], {})).toBe(false);
  });
  it("텍스트 연결이 없으면 driveTextParams 는 baseParams 를 그대로(참조 동일) 반환", () => {
    const base = { text: "hi", model: "m" };
    const out = driveTextParams("c", base, [{ key: "text", type: "text" }], [comfy("c")], [], {});
    expect(out).toBe(base); // 연결 없음 → 원본 편집값 유지(불필요 복사 없음)
  });
});
