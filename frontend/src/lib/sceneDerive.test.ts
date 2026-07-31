import { describe, it, expect } from "vitest";
import { reconcileRefs, pruneGroups } from "./sceneDerive";
import type { SceneRef, SceneGroup } from "./scenes";

const ref = (file_path: string, extra: Partial<SceneRef> = {}): SceneRef => ({
  file_path,
  type: "image",
  ...extra,
});

describe("reconcileRefs", () => {
  it("기존이 비면 target 을 순서 그대로 돌려준다", () => {
    const target = [ref("a"), ref("b")];
    const out = reconcileRefs([], target);
    expect(out.map((r) => r.file_path)).toEqual(["a", "b"]);
  });

  it("연결에서 온 참조(from_card)가 target 에서 빠지면 제거한다 (유령 방지)", () => {
    const existing = [ref("ghost", { from_card: true })];
    const out = reconcileRefs(existing, []);
    expect(out).toEqual([]);
  });

  it("직접 넣은 참조(!from_card)는 target 에 없어도 보존한다", () => {
    const existing = [ref("manual")]; // from_card 없음
    const out = reconcileRefs(existing, []);
    expect(out.map((r) => r.file_path)).toEqual(["manual"]);
  });

  it("from_card 참조가 양쪽에 있으면 연결본(target)으로 갱신한다", () => {
    const existing = [ref("a", { from_card: true, name: "old" })];
    const target = [ref("a", { from_card: true, name: "new" })];
    const out = reconcileRefs(existing, target);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("new");
  });

  it("수동 참조(!from_card)가 같은 파일을 연결로 제공받아도 수동본을 유지한다", () => {
    const existing = [ref("a", { name: "manual" })]; // 수동
    const target = [ref("a", { from_card: true, name: "linked" })];
    const out = reconcileRefs(existing, target);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("manual");
    expect(out[0].from_card).toBeUndefined();
  });

  it("기존 순서를 보존하고 새 연결은 뒤에 붙인다", () => {
    const existing = [ref("a", { from_card: true })];
    const target = [ref("a", { from_card: true }), ref("b", { from_card: true })];
    const out = reconcileRefs(existing, target);
    expect(out.map((r) => r.file_path)).toEqual(["a", "b"]);
  });

  it("key 는 file_path + source_gen_id 로 매칭한다 (같은 파일 다른 gen 은 별개)", () => {
    const existing = [ref("a", { from_card: true, source_gen_id: "g1", name: "old-g1" })];
    const target = [
      ref("a", { from_card: true, source_gen_id: "g2", name: "g2" }),
      ref("a", { from_card: true, source_gen_id: "g1", name: "new-g1" }),
    ];
    const out = reconcileRefs(existing, target);
    // g1 은 기존 자리에서 갱신, g2 는 뒤에 append
    expect(out.map((r) => r.source_gen_id)).toEqual(["g1", "g2"]);
    expect(out[0].name).toBe("new-g1");
  });

  it("혼합: 유령 제거 + 수동 보존 + 연결 갱신 + 새 연결 append 를 한 번에", () => {
    const existing = [
      ref("ghost", { from_card: true }), // target 에 없음 → 제거
      ref("manual"), // 수동 → 보존
      ref("keep", { from_card: true, name: "old" }), // target 에 있음 → 갱신
    ];
    const target = [
      ref("keep", { from_card: true, name: "new" }),
      ref("fresh", { from_card: true }), // 새 연결 → append
    ];
    const out = reconcileRefs(existing, target);
    expect(out.map((r) => r.file_path)).toEqual(["manual", "keep", "fresh"]);
    expect(out.find((r) => r.file_path === "keep")?.name).toBe("new");
  });

  it("입력 배열(existing·target)을 변형하지 않는다 (불변)", () => {
    const existing = Object.freeze([ref("a", { from_card: true })]) as SceneRef[];
    const target = Object.freeze([ref("a", { from_card: true }), ref("b", { from_card: true })]) as SceneRef[];
    expect(() => reconcileRefs(existing, target)).not.toThrow();
    expect(existing).toHaveLength(1);
    expect(target).toHaveLength(2);
  });
});

const grp = (id: string, cardIds: string[], extra: Partial<SceneGroup> = {}): SceneGroup => ({
  id,
  name: id,
  cardIds,
  ...extra,
});

describe("pruneGroups", () => {
  it("삭제된 카드와 유령(existing 에 없는) 카드를 멤버에서 뺀다", () => {
    const gs = [grp("g", ["a", "b", "ghost"])];
    const out = pruneGroups(gs, new Set(["b"]), new Set(["a", "b"]));
    expect(out).toHaveLength(1);
    expect(out[0].cardIds).toEqual(["a"]); // b=삭제, ghost=existing 에 없음
  });

  it("멤버가 모두 사라진 그룹은 제거한다", () => {
    const gs = [grp("g1", ["a"]), grp("g2", ["b"])];
    const out = pruneGroups(gs, new Set(["a"]), new Set(["a", "b"]));
    expect(out.map((g) => g.id)).toEqual(["g2"]);
  });

  it("그룹의 다른 속성(name·rect·color·collapsed)은 보존한다", () => {
    const gs = [
      grp("g", ["a", "b"], { name: "묶음", color: "#fff", collapsed: true, rect: { x: 1, y: 2, w: 3, h: 4 } }),
    ];
    const out = pruneGroups(gs, new Set(["b"]), new Set(["a", "b"]));
    expect(out[0]).toMatchObject({
      name: "묶음",
      color: "#fff",
      collapsed: true,
      rect: { x: 1, y: 2, w: 3, h: 4 },
      cardIds: ["a"],
    });
  });

  it("입력 그룹 배열을 변형하지 않는다 (불변)", () => {
    const original = grp("g", ["a", "b"]);
    const frozen = Object.freeze([Object.freeze({ ...original, cardIds: Object.freeze(["a", "b"]) })]) as SceneGroup[];
    expect(() => pruneGroups(frozen, new Set(["b"]), new Set(["a", "b"]))).not.toThrow();
    expect(frozen[0].cardIds).toEqual(["a", "b"]); // 원본 멤버 유지
  });
});
