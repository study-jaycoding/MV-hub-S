import { describe, expect, it } from "vitest";
import {
  applySceneMove,
  dropIndexAt,
  moveItem,
  normalizeSceneWorkspace,
  sceneDimmed,
  sceneMatchesWorkspace,
  sceneTabTitle,
  sceneWorkspaceLabel,
  sceneWorkspaceMissing,
} from "../src/lib/sceneWorkspace";
import type { Scene } from "../src/lib/scenes";

const scene = (id: string, workspace?: { id: string; name: string | null }): Scene => ({
  id,
  name: id,
  cards: [],
  edges: [],
  created_at: 0,
  ...(workspace ? { workspace } : {}),
});

const team = (id: string, name = id) => ({ scope: "team" as const, id, name });
const personal = { scope: "personal" as const, id: null, name: null };
const unknown = { scope: "unknown" as const, id: null, name: null };

describe("normalizeSceneWorkspace — 손상값은 '지정 없음'", () => {
  it("id 가 있어야 지정으로 본다", () => {
    expect(normalizeSceneWorkspace({ id: "ws1", name: "뻘뻘뻘" })).toEqual({ id: "ws1", name: "뻘뻘뻘" });
    expect(normalizeSceneWorkspace({ id: " ws1 ", name: "  " })).toEqual({ id: "ws1", name: null });
    expect(normalizeSceneWorkspace({ name: "이름만" })).toBeUndefined();
    expect(normalizeSceneWorkspace(null)).toBeUndefined();
    expect(normalizeSceneWorkspace("ws1")).toBeUndefined();
  });
});

describe("회색 판정 — 지정 없음·미확정은 회색이 아니다", () => {
  it("팀 공간은 id 로만 비교한다", () => {
    const assigned = scene("s1", { id: "wsA", name: "뻘뻘뻘" });
    expect(sceneDimmed(assigned, team("wsA"))).toBe(false);
    expect(sceneDimmed(assigned, team("wsB"))).toBe(true);
    // 이름이 바뀌어도 id 가 같으면 내 공간
    expect(sceneDimmed(scene("s1", { id: "wsA", name: "옛 이름" }), team("wsA", "새 이름"))).toBe(false);
  });
  it("지정 없는 씬·공간 미확정은 어디서나 정상(기존 씬이 전부 회색이 되면 안 된다)", () => {
    expect(sceneDimmed(scene("s2"), team("wsA"))).toBe(false);
    expect(sceneDimmed(scene("s2"), personal)).toBe(false);
    expect(sceneDimmed(scene("s1", { id: "wsA", name: null }), unknown)).toBe(false);
    expect(sceneMatchesWorkspace(scene("s1", { id: "wsA", name: null }), unknown)).toBe(true);
  });
  it("개인 공간을 보고 있으면 팀 지정 씬은 회색", () => {
    expect(sceneDimmed(scene("s1", { id: "wsA", name: null }), personal)).toBe(true);
  });
});

describe("표시 이름 — 목록의 현재 이름이 우선", () => {
  const assigned = scene("s1", { id: "wsA", name: "옛 이름" });
  it("목록에 있으면 현재 이름, 없으면 저장된 이름", () => {
    expect(sceneWorkspaceLabel(assigned, [{ id: "wsA", name: "새 이름" }])).toBe("새 이름");
    expect(sceneWorkspaceLabel(assigned, [{ id: "wsB", name: "다른 곳" }])).toBe("옛 이름");
    expect(sceneWorkspaceLabel(scene("s2"), [])).toBeNull();
  });
  it("목록을 아직 못 받았으면 '없어졌다'고 판정하지 않는다", () => {
    expect(sceneWorkspaceMissing(assigned, null)).toBe(false);
    expect(sceneWorkspaceMissing(assigned, [])).toBe(false);
    expect(sceneWorkspaceMissing(assigned, [{ id: "wsB" }])).toBe(true);
    expect(sceneWorkspaceMissing(scene("s2"), [{ id: "wsB" }])).toBe(false);
  });
  it("툴팁은 상태마다 다른 문장", () => {
    expect(sceneTabTitle(scene("s2"), team("wsA"), null, false)).toContain("우클릭=이름·워크스페이스");
    expect(sceneTabTitle(assigned, team("wsB"), "산해학원", false)).toContain("'산해학원' 워크스페이스입니다");
    expect(sceneTabTitle(assigned, team("wsA"), "뻘뻘뻘", false)).toContain("워크스페이스: 뻘뻘뻘");
    expect(sceneTabTitle(assigned, team("wsA"), "뻘뻘뻘", true)).toContain("찾을 수 없습니다");
  });
});

describe("드롭 위치 — 한 줄과 여러 줄", () => {
  const row = (left: number, top = 0) => ({ left, right: left + 40, top, bottom: top + 20 });
  it("중심 x 를 넘기 전이면 그 탭 앞, 마지막 탭 뒤면 길이", () => {
    const rects = [row(0), row(50), row(100)];
    expect(dropIndexAt(rects, 5, 10)).toBe(0);
    expect(dropIndexAt(rects, 25, 10)).toBe(1); // 첫 탭 중심(20) 넘음
    expect(dropIndexAt(rects, 75, 10)).toBe(2);
    expect(dropIndexAt(rects, 200, 10)).toBe(3);
    expect(dropIndexAt([], 10, 10)).toBe(0);
  });
  it("여러 줄이면 먼저 줄을 고르고 그 줄 안에서 자리를 정한다", () => {
    const rects = [row(0), row(50), row(0, 30), row(50, 30)]; // 2줄 × 2탭
    expect(dropIndexAt(rects, 5, 10)).toBe(0); // 첫 줄 앞
    expect(dropIndexAt(rects, 200, 10)).toBe(2); // 첫 줄 끝 = 둘째 줄 시작 인덱스
    expect(dropIndexAt(rects, 5, 40)).toBe(2); // 둘째 줄 앞
    expect(dropIndexAt(rects, 200, 40)).toBe(4); // 둘째 줄 끝 = 맨 뒤
    expect(dropIndexAt(rects, 5, 100)).toBe(2); // 아래로 벗어나면 가장 가까운 줄(둘째)
  });
});

describe("이동 연산 — 목록 스냅샷이 아니라 '이 씬을 저 씬 앞으로'", () => {
  it("제자리(자기 앞·자기 바로 뒤)는 아무것도 바꾸지 않는다", () => {
    const scenes = [scene("a"), scene("b"), scene("c")];
    expect(applySceneMove(scenes, { id: "b", beforeId: "b" })).toBeNull(); // 자기 앞
    expect(applySceneMove(scenes, { id: "b", beforeId: "c" })).toBeNull(); // 자기 바로 뒤
    expect(applySceneMove(scenes, { id: "b", beforeId: "a" })?.map((item) => item.id)).toEqual(["b", "a", "c"]);
    expect(applySceneMove(scenes, { id: "a", beforeId: null })?.map((item) => item.id)).toEqual(["b", "c", "a"]);
  });
  it("적용은 최신 목록에 대고 한다 — 그 사이 늘어난 씬이 사라지지 않는다", () => {
    const latest = [scene("a"), scene("b"), scene("c"), scene("새로생김")];
    const moved = applySceneMove(latest, { id: "c", beforeId: "a" });
    expect(moved?.map((item) => item.id)).toEqual(["c", "a", "b", "새로생김"]);
    // 맨 뒤로
    expect(applySceneMove(latest, { id: "a", beforeId: null })?.map((item) => item.id)).toEqual([
      "b", "c", "새로생김", "a",
    ]);
  });
  it("대상이나 기준이 사라졌으면 취소(null)", () => {
    const latest = [scene("a"), scene("b")];
    expect(applySceneMove(latest, { id: "없음", beforeId: "a" })).toBeNull();
    expect(applySceneMove(latest, { id: "a", beforeId: "없음" })).toBeNull();
    expect(applySceneMove(latest, { id: "a", beforeId: "a" })).toBeNull(); // 제자리
  });
  it("moveItem 은 바뀌지 않으면 같은 배열을 돌려준다", () => {
    const items = [1, 2, 3];
    expect(moveItem(items, 1, 1)).toBe(items);
    expect(moveItem(items, 1, 2)).toBe(items);
    expect(moveItem(items, 5, 0)).toBe(items);
    expect(moveItem(items, 0, 3)).toEqual([2, 3, 1]);
  });
});
