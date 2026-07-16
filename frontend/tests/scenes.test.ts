// scenes 순수 헬퍼 특성화 — 변형 id·지문(양방향 동기화 안정성 근거).
import { describe, it, expect } from "vitest";
import { variantIds, sceneRefFingerprint } from "../src/lib/scenes";

describe("variantIds", () => {
  it("genIds 가 있으면 그것을(순서 보존)", () => {
    expect(variantIds({ genIds: ["a", "b"], genId: "b" })).toEqual(["a", "b"]);
  });
  it("genIds 없고 genId 만 있으면 [genId]", () => {
    expect(variantIds({ genIds: undefined, genId: "solo" })).toEqual(["solo"]);
  });
  it("둘 다 없으면 빈 배열", () => {
    expect(variantIds({ genIds: undefined, genId: null })).toEqual([]);
  });
});

describe("sceneRefFingerprint", () => {
  it("같은 refs 는 같은 지문(안정)", () => {
    const refs = [{ file_path: "a", type: "image", name: "n", thumb: "t", source_gen_id: "g" }];
    expect(sceneRefFingerprint(refs)).toBe(sceneRefFingerprint([...refs]));
  });
  it("빈 값 정규화: name/thumb/source_gen_id 누락은 '' 로", () => {
    const a = sceneRefFingerprint([{ file_path: "a", type: "image" }]);
    const b = sceneRefFingerprint([
      { file_path: "a", type: "image", name: "", thumb: "", source_gen_id: "" },
    ]);
    expect(a).toBe(b);
  });
  it("순서·내용이 다르면 지문 다름", () => {
    const one = sceneRefFingerprint([{ file_path: "a", type: "image" }]);
    const two = sceneRefFingerprint([{ file_path: "b", type: "image" }]);
    expect(one).not.toBe(two);
  });
});
