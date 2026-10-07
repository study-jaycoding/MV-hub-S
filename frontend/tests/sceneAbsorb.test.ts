// 옛 저장소(localStorage)의 변경을 새 저장소(IndexedDB)로 흡수하는 판정.
// 이 규칙이 틀어지면 ①옛 창의 편집이 조용히 사라지거나 ②새 창의 편집이 옛 내용으로 되돌아간다.
import { describe, expect, it } from "vitest";
import { planAbsorption } from "../src/lib/sceneAbsorb";
import type { Scene, ScenesByProject } from "../src/lib/scenes";

const scene = (id: string, name = id): Scene => ({ id, name, cards: [], edges: [], created_at: 1 });
const bucket = (...scenes: Scene[]): ScenesByProject => ({ acct: scenes });
const names = (all: ScenesByProject, key = "acct") => (all[key] || []).map((s) => s.name);

describe("옛 저장소 변경 흡수", () => {
  // 기준이 없으면 '옛 쪽이 바뀐 것'과 '원래 그랬던 것'을 구분할 수 없다. 그 상태로 흡수하면
  // 이관 직후 새 내용을 옛 내용으로 되돌린다.
  it("기준(B)이 없으면 아무것도 흡수하지 않는다", () => {
    const plan = planAbsorption(null, bucket(scene("s1", "새것")), bucket(scene("s1", "옛것")));
    expect(plan.changed).toBe(false);
    expect(names(plan.next)).toEqual(["새것"]);
  });

  it("옛 쪽에 변화가 없으면(L=B) 그대로 둔다", () => {
    const base = bucket(scene("s1", "원래"));
    const plan = planAbsorption(base, bucket(scene("s1", "내가 고침")), bucket(scene("s1", "원래")));
    expect(plan.changed).toBe(false);
    expect(names(plan.next)).toEqual(["내가 고침"]);
  });

  it("옛 쪽만 바뀌었으면(N=B) 그 변경을 가져온다", () => {
    const base = bucket(scene("s1", "원래"));
    const plan = planAbsorption(base, bucket(scene("s1", "원래")), bucket(scene("s1", "옛 창이 고침")));
    expect(plan.changed).toBe(true);
    expect(plan.adopted).toBe(1);
    expect(names(plan.next)).toEqual(["옛 창이 고침"]);
  });

  it("옛 쪽에서 지운 씬은 따라 지운다 — 삭제도 변경이다", () => {
    const base = bucket(scene("s1"), scene("s2"));
    const plan = planAbsorption(base, bucket(scene("s1"), scene("s2")), bucket(scene("s1")));
    expect(plan.removed).toBe(1);
    expect(names(plan.next)).toEqual(["s1"]);
  });

  it("옛 쪽에 새로 생긴 씬은 뒤에 붙인다(탭 순서 보존)", () => {
    const base = bucket(scene("s1"));
    const plan = planAbsorption(base, bucket(scene("s1")), bucket(scene("s1"), scene("s2")));
    expect(plan.adopted).toBe(1);
    expect(names(plan.next)).toEqual(["s1", "s2"]);
  });

  it("양쪽이 이미 같으면(N=L) 변화로 보지 않는다", () => {
    const base = bucket(scene("s1", "원래"));
    const same = bucket(scene("s1", "둘 다 같게 고침"));
    const plan = planAbsorption(base, same, same);
    expect(plan.changed).toBe(false);
    expect(plan.conflicts).toEqual([]);
  });

  // 자동으로 고르면 한쪽 작업이 말없이 사라진다. 사람이 고르게 남긴다.
  it("양쪽이 각자 바뀌었으면 덮지 않고 충돌로 남긴다", () => {
    const base = bucket(scene("s1", "원래"));
    const plan = planAbsorption(base, bucket(scene("s1", "내 수정")), bucket(scene("s1", "옛 창 수정")));
    expect(names(plan.next)).toEqual(["내 수정"]); // 새 저장소를 유지
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].mine?.name).toBe("내 수정");
    expect(plan.conflicts[0].theirs?.name).toBe("옛 창 수정");
    expect(plan.adopted).toBe(0);
  });

  it("한쪽이 지우고 다른 쪽이 고쳤으면 그것도 충돌이다", () => {
    const base = bucket(scene("s1", "원래"));
    const plan = planAbsorption(base, bucket(scene("s1", "내 수정")), {});
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].theirs).toBeNull();
    expect(names(plan.next)).toEqual(["내 수정"]);
  });

  // '빈 배열 버킷'(정상 삭제)과 '버킷 자체가 없음'(새 브라우저)은 DB 자동복구 판정에서 뜻이 다르다.
  // 흡수가 이 구분을 뭉개면 복구가 돌지 말아야 할 때 돌거나, 돌아야 할 때 안 돈다.
  it("빈 버킷과 버킷 없음을 구분해 보존한다", () => {
    const withEmpty = planAbsorption({ acct: [] }, { acct: [] }, { acct: [] });
    expect("acct" in withEmpty.next).toBe(true);
    expect(withEmpty.next.acct).toEqual([]);

    const noBucket = planAbsorption({}, {}, {});
    expect("acct" in noBucket.next).toBe(false);
  });

  it("버킷이 여럿이면 각각 따로 판정한다", () => {
    const base: ScenesByProject = { a: [scene("s1", "원래")], b: [scene("s2", "원래")] };
    const plan = planAbsorption(
      base,
      { a: [scene("s1", "원래")], b: [scene("s2", "내 수정")] },
      { a: [scene("s1", "옛 창 수정")], b: [scene("s2", "원래")] },
    );
    expect(names(plan.next, "a")).toEqual(["옛 창 수정"]); // a 는 옛 쪽만 바뀜 → 채택
    expect(names(plan.next, "b")).toEqual(["내 수정"]); // b 는 내 쪽만 바뀜 → 유지
    expect(plan.conflicts).toEqual([]);
  });

  // ★카드 안(중첩)의 변경을 못 보면 옛 창의 본문 수정이 조용히 버려진다. replacer 배열로 키를
  // 정렬하던 종전 구현이 정확히 이것을 놓쳤다(Codex 코드 리뷰 재현).
  it("카드 안의 글 변경도 흡수한다 — 씬 껍데기만 보지 않는다", () => {
    const withText = (id: string, text: string): Scene => ({
      ...scene(id),
      cards: [{ id: "c1", kind: "text", x: 0, y: 0, text }],
    });
    const base = bucket(withText("s1", "원래 글"));
    const plan = planAbsorption(base, bucket(withText("s1", "원래 글")), bucket(withText("s1", "옛 창이 고친 글")));
    expect(plan.adopted).toBe(1);
    expect(plan.next.acct[0].cards[0].text).toBe("옛 창이 고친 글");
  });

  it("카드 안이 서로 다르게 바뀌었으면 충돌로 잡는다", () => {
    const withText = (id: string, text: string): Scene => ({
      ...scene(id),
      cards: [{ id: "c1", kind: "text", x: 0, y: 0, text }],
    });
    const base = bucket(withText("s1", "원래"));
    const plan = planAbsorption(base, bucket(withText("s1", "내 글")), bucket(withText("s1", "옛 창 글")));
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.next.acct[0].cards[0].text).toBe("내 글");
  });

  // 같은 내용인데 키 순서만 다른 직렬화를 변경으로 읽으면, 멀쩡한 씬이 매번 충돌로 잡힌다.
  it("키 순서만 다른 같은 내용은 변경이 아니다", () => {
    const a: Scene = { id: "s1", name: "x", cards: [], edges: [], created_at: 1 };
    const b = { created_at: 1, edges: [], cards: [], name: "x", id: "s1" } as Scene;
    const plan = planAbsorption({ acct: [a] }, { acct: [a] }, { acct: [b] });
    expect(plan.changed).toBe(false);
    expect(plan.conflicts).toEqual([]);
  });
});
