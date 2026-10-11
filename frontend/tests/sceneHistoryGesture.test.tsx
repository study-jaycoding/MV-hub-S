// @vitest-environment jsdom
// 되돌리기 묶음(useSceneHistory.beginGesture) — 한 번의 끌기에 난 저장은 한 단계로 묶인다. 훅만 떼어 본다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rewindSceneMove } from "../src/lib/sceneInteractions";
import type { SceneCard, SceneEdge, SceneGroup } from "../src/lib/scenes";
import { useSceneHistory } from "../src/lib/useSceneHistory";

const links = vi.hoisted(() => ({ revive: vi.fn(), remove: vi.fn(async () => {}) }));
vi.mock("../src/lib/sceneCardLinks", () => ({
  reviveCardGenerations: links.revive,
  markCardGenerationsRemoved: links.remove,
  mergeCardLinksIntoScenes: () => null,
  serverCardLinks: () => ({}),
}));

type History = ReturnType<typeof useSceneHistory>;
let host: HTMLDivElement;
let root: Root;
let history: History;
let state: { cards: SceneCard[]; edges: SceneEdge[]; groups: SceneGroup[] };
let saved: { cards?: SceneCard[]; groups?: SceneGroup[] }[];
const card = (id: string, x: number, extra: Partial<SceneCard> = {}) => ({ id, kind: "text", x, y: 0, text: id, ...extra }) as SceneCard;

function Harness() {
  const cardsRef = { current: state.cards };
  const edgesRef = { current: state.edges };
  const groupsRef = { current: state.groups };
  history = useSceneHistory({
    sceneId: "S",
    initialSnapshot: state,
    sceneIdRef: { current: "S" },
    cardsRef,
    edgesRef,
    groupsRef,
    setCards: (next) => { state = { ...state, cards: typeof next === "function" ? next(state.cards) : next }; },
    setEdges: (next) => { state = { ...state, edges: typeof next === "function" ? next(state.edges) : next }; },
    setGroups: (next) => { state = { ...state, groups: typeof next === "function" ? next(state.groups) : next }; },
    clearSelection: () => {},
    onChange: (patch) => { saved.push(patch as never); },
    frozenRef: frozen,
  });
  return null;
}
const frozen = { current: false }; // 씬을 바꾸는 틈(SceneBoard 의 switchingRef)
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear(); sessionStorage.clear(); links.revive.mockClear(); links.remove.mockClear();
  state = { cards: [card("a", 110), card("b", 660)], edges: [], groups: [] };
  saved = [];
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(<Harness />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const xs = () => (saved[saved.length - 1].cards ?? []).map((item) => item.x);
const moved = (dx: number, extra: Partial<SceneCard> = {}) => [card("a", 110 + dx, extra), card("b", 660 + dx)];

it("묶음 안의 저장은 되돌리기 한 단계다 — 뒤 저장이 뺀 소속도 그 한 단계에 실려, 되돌리면 되살리고 다시 실행하면 다시 뺀다", () => {
  history.beginGesture();
  history.persist(moved(220), []);
  history.persist(moved(440), [], [], { removedForward: [{ cardId: "a", genIds: ["g1"] }] });
  history.endGesture();
  history.undo();
  expect(xs()).toEqual([110, 660]); // 한 번에 끌기 전으로
  expect(links.revive).toHaveBeenCalledWith("S", "a", ["g1"]);
  history.undo(); // 더 되돌릴 것이 없다
  expect(xs()).toEqual([110, 660]);
  history.redo();
  expect(xs()).toEqual([550, 1100]);
  expect(links.remove).toHaveBeenCalledWith("S", "a", ["g1"]);
});

it("묶음의 시작점은 끌기 전 좌표다 — 끄는 중에 낀 파생 저장이 좌표를 옮겨 놓았어도, 그 저장이 넣은 값은 두고 좌표만 되감는다", () => {
  const origins = { a: { x: 110, y: 0 }, b: { x: 660, y: 0 } };
  history.beginGesture((snapshot) => rewindSceneMove(snapshot, origins, new Map()));
  history.persist(moved(220, { text: "결과 반영" }), [], [], { undo: false }); // 끄는 중의 파생 저장(생성 결과) — 좌표는 이미 옮겨져 있다
  history.persist(moved(440, { text: "결과 반영" }), []); // 놓을 때의 저장
  history.endGesture();
  history.undo();
  expect(xs()).toEqual([110, 660]); // 중간 자리(330)가 아니다
  expect(saved[saved.length - 1].cards![0].text).toBe("결과 반영"); // 파생 저장이 넣은 값은 남는다
});

it("묶음은 스택의 높이로 제 엔트리를 안다 — 생성 결과 반영이 스택의 객체를 새로 만들어도 뒤 저장이 새 단계를 쌓지 않는다", () => {
  history.beginGesture();
  history.persist(moved(220), []);
  history.propagateGenIdsToHistory("a", card("a", 330, { genIds: ["g9"], genId: "g9" })); // 스택 엔트리를 새 객체로 바꾼다
  history.persist(moved(440), []);
  history.endGesture();
  history.undo();
  expect(xs()).toEqual([110, 660]);
  history.undo(); // 한 단계뿐이었다
  expect(xs()).toEqual([110, 660]);
});

// 2026-10-11 Codex 코드 리뷰: 씬을 바꾸는 틈에는 손에 든 카드가 떠난 씬의 것이고 기록은 이미 새 씬의 것이다 — 그동안 들어온 저장·
//  되돌리기·'과거 스냅샷 고치기'(생성 결과 반영)를 받으면 떠난 씬의 값이 새 씬의 저장과 되돌리기 기록에 들어간다.
it("틈(frozen)에는 저장·되돌리기·과거 스냅샷 고치기를 받지 않는다 — 풀린 뒤의 되돌리기에 틈의 값이 섞여 나오지 않는다", () => {
  history.persist(moved(220), []); // 틈 전의 편집 한 단계
  const before = saved.length;
  frozen.current = true;
  try {
    history.persist([card("z", 0)], []); // 떠난 씬의 카드
    history.commitDerivedState({ cards: [card("z", 0)], edges: [], groups: [] });
    history.propagateGenIdsToHistory("a", card("a", 330, { genIds: ["g-other"], genId: "g-other" })); // 떠난 씬의 결과 목록
    history.undo();
    history.redo();
    expect(saved.length).toBe(before); // 아무것도 부모에 쓰지 않았다
  } finally {
    frozen.current = false;
  }
  history.undo(); // 풀린 뒤 — 틈 전의 한 단계가 그대로 되돌려진다
  expect(xs()).toEqual([110, 660]);
  expect(saved[saved.length - 1].cards!.map((item) => item.genIds)).toEqual([undefined, undefined]); // 틈의 결과 목록이 기록에 들어가지 않았다
  history.undo(); // 더 되돌릴 것이 없다(틈의 저장이 단계를 쌓지 않았다)
  expect(xs()).toEqual([110, 660]);
});

it("묶음이 닫힌 뒤의 저장은 따로 쌓인다", () => {
  history.beginGesture();
  history.persist(moved(220), []);
  history.endGesture();
  history.persist(moved(440), []);
  history.undo();
  expect(xs()).toEqual([330, 880]);
  history.undo();
  expect(xs()).toEqual([110, 660]);
});
