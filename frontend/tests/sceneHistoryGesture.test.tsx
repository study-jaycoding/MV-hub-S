// @vitest-environment jsdom
// 되돌리기 묶음(useSceneHistory.beginGesture) — 한 번의 끌기에 난 저장은 한 단계로 묶인다. 훅만 떼어 본다.
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCanvasSession } from "../src/features/canvas/useCanvasSession";
import { rewindSceneMove } from "../src/lib/sceneInteractions";
import type { Scene, SceneCard, SceneEdge, SceneGroup } from "../src/lib/scenes";
import type { SceneWriteReceipt } from "../src/lib/sceneUndoPersistence";
import { useSceneHistory } from "../src/lib/useSceneHistory";

const links = vi.hoisted(() => ({ revive: vi.fn(), remove: vi.fn(async () => {}) }));
vi.mock("../src/lib/sceneCardLinks", () => ({
  reviveCardGenerations: links.revive,
  markCardGenerationsRemoved: links.remove,
  mergeCardLinksIntoScenes: () => null,
  serverCardLinks: () => ({}),
}));
const schedule = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/sceneUndoPersistence", async (original) => ({
  ...await original<typeof import("../src/lib/sceneUndoPersistence")>(),
  // 진짜 예약처럼 복제해 넘긴다 — 스택은 예약 뒤에도 그 자리에서 바뀌어, 참조를 들고 있으면 다시 남기지 않아도 시험이 통과한다
  scheduleUndoCheckpoint: (sceneId: string, history: unknown, ...rest: unknown[]) => schedule(sceneId, structuredClone(history), ...rest),
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
    onChange: (patch) => { saved.push(patch as never); return receipt; },
    frozenRef: frozen,
  });
  return null;
}
const frozen = { current: false }; // 씬을 바꾸는 틈(SceneBoard 의 switchingRef)
let receipt: SceneWriteReceipt | undefined;
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

// 배포 검토 A-04: 다시 하기 비우기는 끌기가 끝날 때인데 보존 기록은 놓을 때의 저장에서 남겼다 — 버린 갈래가 새로 고침 뒤 되살아났다.
describe("새로 고쳐도 남는 기록은 끌기가 끝난 뒤의 모습이다", () => {
  const last = () => schedule.mock.calls[schedule.mock.calls.length - 1];
  beforeEach(() => { receipt = { confirmed: Promise.resolve(true) }; schedule.mockClear(); });
  afterEach(() => { receipt = undefined; });

  it("되돌린 뒤 끌고 놓으면 마지막 예약에 버린 다시 하기가 없다 — 그 끌기의 영수증으로 다시 남긴다", () => {
    history.persist(moved(220), []);
    history.undo();
    const drag = receipt = { confirmed: Promise.resolve(true) };
    history.beginGesture();
    history.persist(moved(330), []);
    expect(last()[1].redo).toHaveLength(1); // 놓을 때의 저장이 남긴 모습 — 아직 비우기 전
    history.endGesture();
    expect(last()[1].redo).toEqual([]);
    expect(last()[1].undo).toHaveLength(1);
    expect(last()[3]).toBe(drag);
  });

  it("끌기가 끝나지 않은 채 창이 닫혀도 묶음 안 저장의 예약은 남는다", () => {
    history.beginGesture();
    history.persist(moved(220), []);
    expect(schedule).toHaveBeenCalledOnce();
  });

  it("기록이 달라지지 않은 끌기는 다시 남기지 않는다", () => {
    history.beginGesture();
    history.persist(moved(220), []);
    history.endGesture();
    expect(schedule).toHaveBeenCalledOnce();
  });

  it("영수증이 없으면 남기지 않는다", () => {
    receipt = undefined;
    history.persist(moved(220), []);
    history.undo();
    history.beginGesture();
    history.persist(moved(330), []);
    history.endGesture();
    expect(schedule).not.toHaveBeenCalled();
  });

  it("상한 정리도 끝난 뒤의 모습으로 남긴다", () => {
    for (let index = 1; index <= 200; index++) history.persist(moved(index), []);
    history.beginGesture();
    history.persist(moved(500), []);
    expect(last()[1].undo).toHaveLength(201);
    history.endGesture();
    expect(last()[1].undo).toHaveLength(200);
  });

  it("끌기를 버리면 걷은 단계가 보존 기록에서도 빠지고 다시 하기는 남는다 — 저장이 더 없는 순서도", () => {
    history.persist(moved(220), []);
    history.undo();
    history.beginGesture();
    history.persist(moved(330), []);
    history.persist(moved(0), []); // 제자리로 돌아와 저장
    const calls = schedule.mock.calls.length;
    history.persist(moved(0), [], [], { discard: true }); // 값이 같아 저장 없이 끝난다
    expect(schedule.mock.calls.length).toBe(calls);
    history.endGesture();
    expect(schedule.mock.calls.length).toBe(calls + 1);
    expect(last()[1].undo).toEqual([]);
    expect(last()[1].redo).toHaveLength(1);
  });

  it("끌기를 버려 기록이 완전히 비면 빈 기록으로 옛 기록을 밀어낸다", () => {
    history.beginGesture();
    history.persist(moved(330), []);
    history.persist(moved(0), []);
    history.persist(moved(0), [], [], { discard: true });
    history.endGesture();
    expect(last()[1]).toMatchObject({ undo: [], redo: [] });
    expect(last()[4]).toBe(true);
  });

  it("씬을 바꾸며 끝나는 끌기는 옛 씬의 기록으로 남는다 — 세션이 sceneIdRef 를 옮기기 전에 끝맺는다", () => {
    let session!: ReturnType<typeof useCanvasSession>;
    const scene = (id: string) => ({ id, name: id, created_at: 1, edges: [], cards: [card("a", 110)] }) as Scene;
    function Session({ source }: { source: Scene }) {
      const [, setCards] = useState(source.cards);
      const [, setEdges] = useState<SceneEdge[]>([]);
      const [, setGroups] = useState<SceneGroup[]>([]);
      const sceneIdRef = useRef(source.id), cardsRef = useRef(source.cards), edgesRef = useRef<SceneEdge[]>([]), groupsRef = useRef<SceneGroup[]>([]);
      const frozenRef = useRef(false), layerMoveRef = useRef(null);
      session = useCanvasSession({ sceneId: source.id, initialSnapshot: { cards: source.cards, edges: [], groups: [] }, sourceScene: source,
        sceneIdRef, cardsRef, edgesRef, groupsRef, setCards, setEdges, setGroups, frozenRef, layerMoveRef,
        clearSelection: () => {}, onChange: () => receipt });
      return null;
    }
    const a = scene("A");
    act(() => root.render(<Session source={a} />));
    const first = session.gestures.beginCardMove(["a"], []);
    act(() => { first.preview({ positions: { a: { x: 200, y: 0 } } }); first.finish(); });
    act(() => session.undo());
    schedule.mockClear();
    const held = session.gestures.beginCardMove(["a"], []);
    act(() => { held.preview({ positions: { a: { x: 300, y: 0 } } }); session.commit({ type: "setNodeColor", cardId: "a", color: "#123456" }); });
    expect(last()[1].redo).toHaveLength(1);
    act(() => root.render(<Session source={scene("B")} />));
    expect(last()[0]).toBe("A");
    expect(last()[1].redo).toEqual([]);
  });
});

// 2026-10-12 조작 점검 17회차(Codex 전수 검토): 값이 같은데도 저장을 내는 조작(같은 이름으로 끝낸 그룹 이름 · 최솟값에서 누른 글씨 크기 ·
//  같은 색 다시 고르기 · 대상이 없는 그룹 색)이 빈 단계를 쌓고 다시 하기를 지웠다. 부르는 곳마다 막지 않고 저장의 입구 한 곳에서 본다.
it("바뀐 것이 없는 사용자 저장은 단계를 쌓지 않고 다시 하기도 지우지 않는다 — 값이 같은 새 객체도 '안 바뀜'이다", () => {
  history.persist(moved(220), []); // 한 단계
  history.undo();
  const before = saved.length;
  // 값이 같은 새 객체들 — { ...card, fontSize: 같은 값 } · 없는 키에 undefined 를 넣은 것({ ...group, color: undefined })
  history.persist(state.cards.map((item) => ({ ...item, color: undefined })), [], []);
  expect(saved.length).toBe(before); // 부모에 쓰지 않았다
  history.redo(); // 다시 하기가 살아 있다
  expect(xs()).toEqual([330, 880]);
  history.undo();
  history.undo(); // 빈 단계가 없다
  expect(xs()).toEqual([110, 660]);
});

it("진짜로 바뀐 것은 전처럼 쌓인다 — 더한 키 · 뺀 키 · 줄어든 수 · 늘어난 수", () => {
  const steps = () => { let count = 0; while (saved.length !== (history.undo(), saved.length)) count += 1; return count; };
  const added = state.cards.map((item) => ({ ...item, comfyCfg: {} })) as SceneCard[];
  history.persist(added, []); // 키를 더했다
  const removed = added.map(({ comfyCfg: _comfyCfg, ...rest }) => rest) as SceneCard[];
  history.persist(removed, []); // 키를 뺐다
  history.persist(removed.slice(0, 1), []); // 한 장을 지웠다 — 남은 카드는 같은 객체다
  history.persist([removed[0], card("c", 900)], []); // 한 장을 더했다 — 앞의 카드는 같은 객체다
  expect(saved).toHaveLength(4);
  expect(steps()).toBe(4); // 넷 다 한 단계씩
  expect(saved[saved.length - 1].cards!.map((item) => [item.id, item.text, item.comfyCfg])).toEqual([["a", "a", undefined], ["b", "b", undefined]]);
});

it("카드가 그대로여도 소속을 빼거나 붙인 저장은 쌓는다 · 파생 저장은 이 검사와 무관하다", () => {
  const same = () => state.cards.map((item) => ({ ...item }));
  history.persist(same(), [], [], { removedForward: [{ cardId: "a", genIds: ["g1"] }] });
  history.undo();
  expect(links.revive).toHaveBeenCalledWith("S", "a", ["g1"]);
  const before = saved.length;
  history.persist(same(), [], [], { undo: false }); // 파생 저장 — 전처럼 부모에 쓴다
  expect(saved.length).toBe(before + 1);
});

it("끌기 묶음 안에서는 같아 보여도 쌓는다 — 끄는 중의 파생 저장이 이미 마지막 자리를 적어 놓았으면 놓을 때의 저장은 '안 바뀜'으로 보인다", () => {
  const origins = { a: { x: 110, y: 0 }, b: { x: 660, y: 0 } };
  history.beginGesture((snapshot) => rewindSceneMove(snapshot, origins, new Map()));
  history.persist(moved(220), [], [], { undo: false }); // 끄는 중의 파생 저장 — 좌표는 이미 옮겨져 있다
  history.persist(moved(220), []); // 더 움직이지 않고 놓았다
  history.endGesture();
  history.undo();
  expect(xs()).toEqual([110, 660]); // 끌기는 되돌려진다
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
