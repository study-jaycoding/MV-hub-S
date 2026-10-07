// 캔버스의 툴바 필터·폴더 선택 판정 — 캔버스 노드(안 맞으면 흐리게)와 '생성 결과' 창(안 맞으면 걸러 냄)이 같이 쓴다.
import { expect, it } from "vitest";
import { inBoardFolder, matchesBoardFilters, type BoardFilters } from "../src/lib/boardFilters";
import type { Generation } from "../src/types";

const off: BoardFilters = { typeFilter: "all", sharedOnly: false, commentOnly: false, finalOnly: false };
const gen = (patch: Partial<Generation> = {}) => ({
  id: "g", tags: [], color: null, shared: false, is_final: false, is_held: false, comment_count: 0,
  assets: [{ type: "image" }], project_id: "p1", folder_path: "ep01/shot010", ...patch,
} as unknown as Generation);

it("필터가 다 꺼져 있으면 모두 맞는다 — 켠 조건마다 그 조건만 본다", () => {
  expect(matchesBoardFilters(gen(), off)).toBe(true);
  expect(matchesBoardFilters(gen(), { ...off, colorFilter: new Set(), tagFilter: new Set() })).toBe(true); // 빈 집합 = 꺼짐
  const cases: [Partial<BoardFilters>, Partial<Generation>][] = [
    [{ typeFilter: "video" }, { assets: [{ type: "video" }] } as never],
    [{ colorFilter: new Set(["#f00"]) }, { color: "#f00" }],
    [{ tagFilter: new Set(["keep"]) }, { tags: ["other", "keep"] }],
    [{ sharedOnly: true }, { shared: true }],
    [{ commentOnly: true }, { comment_count: 2 }],
    [{ finalOnly: true }, { is_final: true }],
  ];
  for (const [filter, match] of cases) {
    expect(matchesBoardFilters(gen(), { ...off, ...filter }), JSON.stringify(Object.keys(filter))).toBe(false);
    expect(matchesBoardFilters(gen(match), { ...off, ...filter }), JSON.stringify(Object.keys(filter))).toBe(true);
  }
});

it("고른 폴더가 없으면 모두 '안' — 있으면 그 폴더와 하위만, 프로젝트만 골랐으면(path '') 프로젝트만 본다", () => {
  expect(inBoardFolder(gen(), null)).toBe(true);
  expect(inBoardFolder(gen(), { projectId: "p1", path: "ep01/shot010" })).toBe(true);
  expect(inBoardFolder(gen(), { projectId: "p1", path: "ep01" })).toBe(true); // 하위
  expect(inBoardFolder(gen(), { projectId: "p1", path: "ep0" })).toBe(false); // 이름 앞부분만 같은 다른 폴더
  expect(inBoardFolder(gen(), { projectId: "p2", path: "ep01" })).toBe(false);
  expect(inBoardFolder(gen({ folder_path: null }), { projectId: "p1", path: "ep01" })).toBe(false);
  expect(inBoardFolder(gen({ folder_path: null }), { projectId: "p1", path: "" })).toBe(true);
});
