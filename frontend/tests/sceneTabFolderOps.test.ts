// 탭 폴더 규칙(Jay 2026-11-11) — 탭 줄 차례와 폴더 연산(넣기·빼기·폴더째 옮기기·이름·풀기). 연산은 최신 목록 위에서 다시 돈다.
import { describe, expect, it } from "vitest";

import type { Scene } from "../src/lib/scenes";
import { applyTabFolderOp, tabRowItems, type TabFolder } from "../src/lib/sceneWorkspace";

const F: TabFolder = { id: "F", name: "Act_01" };
const G: TabFolder = { id: "G", name: "Act_02" };
const scene = (id: string, folder?: TabFolder): Scene => ({ id, name: id, cards: [], edges: [], created_at: 0, ...(folder ? { tabFolder: folder } : {}) });
const ids = (list: Scene[] | null) => list?.map((s) => s.id + (s.tabFolder ? `@${s.tabFolder.id}` : ""));

describe("tabRowItems", () => {
  it("폴더는 첫 탭 자리에 한 번, 이름은 첫 탭 것 — 안의 탭은 줄에 안 보인다", () => {
    const items = tabRowItems([scene("a"), scene("b", F), scene("c"), scene("d", { id: "F", name: "옛 이름" })], null);
    expect(items.map((it) => it.key)).toEqual(["t:a", "f:F", "t:c"]);
    const folder = items[1];
    expect(folder.kind === "folder" && folder.folder.name).toBe("Act_01");
    expect(folder.kind === "folder" && folder.members.map((s) => s.id)).toEqual(["b", "d"]);
  });

  it("보는 탭이 폴더 안이면 그 폴더 바로 뒤에 탭으로 나온다", () => {
    const items = tabRowItems([scene("a", F), scene("b", F), scene("c")], "b");
    expect(items.map((it) => it.key)).toEqual(["f:F", "t:b", "t:c"]);
    const shown = items[1];
    expect(shown.kind === "tab" && shown.inFolder?.id).toBe("F");
  });

  it("빈 폴더는 맨 뒤 — 같은 id 의 탭이 있으면 빈 폴더로 또 보이지 않고, 겹친 빈 폴더도 한 번", () => {
    const items = tabRowItems([scene("a"), scene("b", F)], null, [F, G, G]);
    expect(items.map((it) => it.key)).toEqual(["t:a", "f:F", "f:G"]);
  });

  it("모양이 아닌 폴더 값(손상·옛 백업)은 그냥 줄의 탭", () => {
    const broken = { ...scene("a"), tabFolder: { id: "", name: "x" } } as Scene;
    expect(tabRowItems([broken], null).map((it) => it.key)).toEqual(["t:a"]);
  });
});

describe("applyTabFolderOp", () => {
  const list = [scene("a"), scene("b", F), scene("c"), scene("d")];

  it("put — 폴더에 넣고 그 자리(beforeId 앞)로 옮긴다, 다른 씬은 같은 객체", () => {
    const next = applyTabFolderOp(list, { type: "put", id: "d", folder: F, beforeId: "c" });
    expect(ids(next)).toEqual(["a", "b@F", "d@F", "c"]);
    expect(next?.[0]).toBe(list[0]);
    expect(next?.[3]).toBe(list[2]);
  });

  it("put folder null — 폴더에서 빼서 맨 뒤로(beforeId null)", () => {
    expect(ids(applyTabFolderOp(list, { type: "put", id: "b", folder: null, beforeId: null }))).toEqual(["a", "c", "d", "b"]);
  });

  it("put 제자리(자기 id 앞)도 폴더는 바뀐다", () => {
    expect(ids(applyTabFolderOp(list, { type: "put", id: "b", folder: null, beforeId: "b" }))).toEqual(["a", "b", "c", "d"]);
  });

  it("put — 바뀔 것이 없거나 대상·기준이 사라졌으면 null(저장 안 함)", () => {
    expect(applyTabFolderOp(list, { type: "put", id: "b", folder: F, beforeId: "c" })).toBeNull();
    expect(applyTabFolderOp(list, { type: "put", id: "x", folder: F, beforeId: null })).toBeNull();
    expect(applyTabFolderOp(list, { type: "put", id: "a", folder: F, beforeId: "gone" })).toBeNull();
  });

  it("moveFolder — 안의 탭이 순서 그대로 beforeId 앞에 모인다", () => {
    const spread = [scene("a", F), scene("b"), scene("c", F), scene("d")];
    expect(ids(applyTabFolderOp(spread, { type: "moveFolder", folderId: "F", beforeId: null }))).toEqual(["b", "d", "a@F", "c@F"]);
    expect(ids(applyTabFolderOp(spread, { type: "moveFolder", folderId: "F", beforeId: "d" }))).toEqual(["b", "a@F", "c@F", "d"]);
  });

  it("moveFolder — 자기 탭 앞·같은 순서·없는 폴더면 null", () => {
    const spread = [scene("a", F), scene("b", F), scene("c")];
    expect(applyTabFolderOp(spread, { type: "moveFolder", folderId: "F", beforeId: "b" })).toBeNull();
    expect(applyTabFolderOp(spread, { type: "moveFolder", folderId: "F", beforeId: "c" })).toBeNull();
    expect(applyTabFolderOp(spread, { type: "moveFolder", folderId: "Z", beforeId: null })).toBeNull();
  });

  it("rename — 그 폴더의 씬만 새 이름, 빈 이름·같은 이름은 null", () => {
    const two = [scene("a", F), scene("b"), scene("c", F)];
    const next = applyTabFolderOp(two, { type: "rename", folderId: "F", name: "  1화 " });
    expect(next?.map((s) => s.tabFolder?.name)).toEqual(["1화", undefined, "1화"]);
    expect(next?.[1]).toBe(two[1]);
    expect(applyTabFolderOp(two, { type: "rename", folderId: "F", name: "  " })).toBeNull();
    expect(applyTabFolderOp(two, { type: "rename", folderId: "F", name: "Act_01" })).toBeNull();
  });

  it("ungroup — 안의 탭은 제자리에서 폴더 값만 빠진다(필드 자체가 없어진다)", () => {
    const next = applyTabFolderOp([scene("a", F), scene("b"), scene("c", F)], { type: "ungroup", folderId: "F" });
    expect(ids(next)).toEqual(["a", "b", "c"]);
    expect(next?.some((s) => "tabFolder" in s)).toBe(false);
    expect(applyTabFolderOp([scene("a")], { type: "ungroup", folderId: "F" })).toBeNull();
  });
});
