// 씬별 undo 히스토리 store 순수 로직 — 저장/복원·LRU·삭제정리·stale 지문(탭 왕복 Ctrl+Z 유지 근거).
import { describe, it, expect } from "vitest";
import {
  saveSceneHistory,
  loadSceneHistory,
  clearSceneHistory,
  sameSnap,
  type SceneSnap,
} from "../src/lib/sceneUndoStore";
import type { SceneCard } from "../src/lib/scenes";

const card = (o: Partial<SceneCard>): SceneCard => ({ id: "c", kind: "text", x: 0, y: 0, ...o }) as SceneCard;
const snap = (cards: SceneCard[] = [card({})]): SceneSnap => ({ cards, edges: [], groups: [] });
const hist = (s: SceneSnap) => ({ undo: [s], redo: [], lastCommit: s });

describe("sceneUndoStore save/load", () => {
  it("저장한 씬 히스토리를 그대로 복원한다", () => {
    const s = snap();
    saveSceneHistory("scene-A", hist(s));
    expect(loadSceneHistory("scene-A")?.lastCommit).toBe(s);
  });
  it("clearSceneHistory 로 삭제되면 undefined", () => {
    saveSceneHistory("scene-del", hist(snap()));
    clearSceneHistory("scene-del");
    expect(loadSceneHistory("scene-del")).toBeUndefined();
  });
  it("빈 sceneId 는 저장하지 않는다", () => {
    saveSceneHistory("", hist(snap()));
    expect(loadSceneHistory("")).toBeUndefined();
  });
  it("LRU — 24개를 넘기면 가장 오래된 씬이 밀려난다", () => {
    for (let i = 0; i < 30; i++) saveSceneHistory(`lru-${i}`, hist(snap()));
    expect(loadSceneHistory("lru-0")).toBeUndefined(); // 초과분 제거됨
    expect(loadSceneHistory("lru-29")).toBeDefined(); // 최신은 유지
  });
});

describe("sameSnap (stale 판정 지문 — 전체 스냅샷 비교)", () => {
  it("내용이 같으면 참조가 달라도 같다고 본다(정상 탭 왕복 = 히스토리 유지)", () => {
    expect(sameSnap(snap([card({ id: "a", x: 1, y: 2, text: "hi" })]), snap([card({ id: "a", x: 1, y: 2, text: "hi" })]))).toBe(true);
  });
  it("위치가 다르면 다르다(외부 편집 감지 → stale 폐기)", () => {
    expect(sameSnap(snap([card({ id: "a", x: 1, y: 2 })]), snap([card({ id: "a", x: 9, y: 2 })]))).toBe(false);
  });
  it("undo 로 복원되는 필드(refs 등)가 다르면 다르다 — 좁은 지문이면 놓치던 것", () => {
    expect(
      sameSnap(
        snap([card({ id: "a", refs: [{ file_path: "x", type: "image" }] } as Partial<SceneCard>)]),
        snap([card({ id: "a", refs: [] } as Partial<SceneCard>)]),
      ),
    ).toBe(false);
  });
});
