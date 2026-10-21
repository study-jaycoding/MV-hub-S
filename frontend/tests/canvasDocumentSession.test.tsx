// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCanvasSession } from "../src/features/canvas/useCanvasSession";
import type { SceneCard, SceneEdge, SceneGroup } from "../src/lib/scenes";
import type { SceneLayerMove } from "../src/lib/useSceneCardMove";
import { clearSceneHistory } from "../src/lib/sceneUndoStore";

let root: Root, host: HTMLDivElement;
let session: ReturnType<typeof useCanvasSession>;
let readCards: () => SceneCard[];
const changed = vi.fn();
const initial: SceneCard[] = [{ id: "card", kind: "generation", x: 0, y: 0, prompt: "before" },
  { id: "comfy", kind: "comfy", x: 0, y: 1, comfyCfg: { content: "{}" } }];
function Harness({ sceneId }: { sceneId: string }) {
  const [cards, setCards] = useState(initial);
  const [edges, setEdges] = useState<SceneEdge[]>([]);
  const [groups, setGroups] = useState<SceneGroup[]>([]);
  const sceneIdRef = useRef(sceneId); sceneIdRef.current = sceneId;
  const cardsRef = useRef(cards); cardsRef.current = cards;
  const edgesRef = useRef(edges); edgesRef.current = edges;
  const groupsRef = useRef(groups); groupsRef.current = groups;
  const frozenRef = useRef(false);
  const layerMoveRef = useRef<SceneLayerMove | null>(null);
  session = useCanvasSession({ sceneId, initialSnapshot: { cards: initial, edges: [], groups: [] },
    sceneIdRef, cardsRef, edgesRef, groupsRef, setCards, setEdges, setGroups,
    frozenRef, layerMoveRef, clearSelection: vi.fn(), onChange: changed });
  readCards = () => cardsRef.current;
  return null;
}
const show = (sceneId: string) => act(() => root.render(<Harness sceneId={sceneId} />));
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); sessionStorage.clear(); localStorage.clear();
  clearSceneHistory("session-a"); clearSceneHistory("session-b"); changed.mockClear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("문서 세션은 외부에 저장 모드와 Undo 엔진을 공개하지 않는다", () => {
  show("session-a");
  for (const name of ["persist", "applyCards", "commitDerivedState", "scheduleInputPersist",
    "beginGesture", "endGesture", "pruneGenIdsFromHistory", "propagateGenIdsToHistory",
    "propagateAssetRelinkToHistory", "syncCommitBaseline", "persistSceneHistory", "restoreSceneHistory"]) {
    expect(session, name).not.toHaveProperty(name);
  }
});

it("T08: 열린 A→B→A 문서 세대가 다르면 옛 async commit은 폐기한다", () => {
  show("session-a"); const old = session;
  show("session-b"); show("session-a");
  expect(session.target.openEpoch).not.toBe(old.target.openEpoch);
  act(() => { expect(old.commit({ type: "editCardPrompt", cardId: "card", prompt: "late" })).toBe(false); });
  expect(readCards()[0].prompt).toBe("before"); expect(changed).not.toHaveBeenCalled();
});

it("T09: 사용자 입력 다음 실행상태 반영이 입력 Undo를 소비하지 않는다", () => {
  show("session-a");
  act(() => { session.commit({ type: "editCardPrompt", cardId: "card", prompt: "typed" }); });
  act(() => { session.commit({ type: "updateComfyRuntime", cardId: "comfy", patch: { status: "done" } }); });
  expect(readCards()[0].prompt).toBe("typed");
  act(() => { session.undo(); }); expect(readCards()[0].prompt).toBe("before");
  act(() => { session.redo(); }); expect(readCards()[0].prompt).toBe("typed");
});

it.each(["debounce", "flush", "maxWait"])("프롬프트 연속 입력은 최신값을 즉시 반영하고 %s에서 Undo 한 단계로 확정한다", mode => {
  vi.useFakeTimers();
  try {
    show("session-a");
    const count = mode === "maxWait" ? 7 : 3;
    for (let i = 0; i < count; i++) {
      act(() => { session.commit({ type: "editCardPrompt", cardId: "card", prompt: `typed-${i}` }); });
      expect(session.snapshot()?.cards[0].prompt).toBe(`typed-${i}`);
      act(() => { vi.advanceTimersByTime(mode === "maxWait" ? 300 : 100); });
    }
    if (mode !== "maxWait") {
      expect(changed).not.toHaveBeenCalled();
      act(() => { if (mode === "flush") session.flush(); else vi.advanceTimersByTime(400); });
    }
    expect(changed).toHaveBeenCalledTimes(1);
    act(() => { session.undo(); });
    expect(readCards()[0].prompt).toBe("before");
    act(() => { session.undo(); });
    expect(readCards()[0].prompt).toBe("before");
    act(() => { session.redo(); });
    expect(readCards()[0].prompt).toBe(`typed-${count - 1}`);
  } finally { vi.useRealTimers(); }
});

it("프롬프트 값이 같은 갱신은 저장이나 Undo 단계를 만들지 않는다", () => {
  vi.useFakeTimers();
  try {
    show("session-a");
    act(() => { session.commit({ type: "editCardPrompt", cardId: "card", prompt: "before" }); vi.advanceTimersByTime(400); });
    expect(changed).not.toHaveBeenCalled();
    act(() => { session.undo(); });
    expect(readCards()[0].prompt).toBe("before");
  } finally { vi.useRealTimers(); }
});

it("dispose 후 수신한 결과는 문서나 Undo를 쓰지 않는다", () => {
  show("session-a"); const old = session;
  act(() => root.unmount());
  expect(old.commit({ type: "editCardPrompt", cardId: "card", prompt: "late" })).toBe(false);
  expect(changed).not.toHaveBeenCalled();
});

it("입력 debounce 전에 내려가도 원래 문서에 한 번 확정한 뒤 세션을 폐기한다", () => {
  vi.useFakeTimers();
  try {
    show("session-a"); const old = session;
    act(() => { session.commit({ type: "editNodeText", cardId: "card", text: "typing" }); });
    expect(changed).not.toHaveBeenCalled();
    act(() => root.unmount());
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed.mock.calls[0][0].cards[0].text).toBe("typing");
    act(() => vi.runAllTimers());
    expect(changed).toHaveBeenCalledTimes(1);
    expect(old.commit({ type: "editNodeText", cardId: "card", text: "late" })).toBe(false);
  } finally { vi.useRealTimers(); }
});

it.each(["flush", "dispose", "unmount"])("그룹 크기만 바꾼 뒤 %s해도 원래 문서에 한 번 저장한다", action => {
  show("session-a");
  const frame = { x: 0, y: 0, w: 100, h: 100 };
  act(() => { session.commit({ type: "createGroup", id: "group", cardIds: ["card"], rect: frame }); });
  changed.mockClear();
  act(() => { session.gestures.beginGroupResize("group", frame).preview({ ...frame, w: 220 }); });
  expect(changed).not.toHaveBeenCalled();
  act(() => {
    if (action === "unmount") root.unmount();
    else if (action === "dispose") session.dispose();
    else session.flush();
  });
  expect(changed).toHaveBeenCalledTimes(1);
  expect(changed.mock.calls[0][0].groups[0].rect.w).toBe(220);
});

it("연결 허용 규칙은 화면을 거치지 않은 문서 명령에도 적용한다", () => {
  show("session-a");
  act(() => { session.commit({ type: "createNode", id: "heading", kind: "head", position: { x: 0, y: 0 } }); });
  act(() => { expect(session.commit({ type: "connectCards", pairs: [["heading", "card"]] })).toBe(false); });
  expect(session.snapshot()?.edges).toEqual([]);
  act(() => { expect(session.commit({ type: "connectCards", pairs: [["comfy", "card"]] })).toBe(true); });
  expect(session.snapshot()?.edges.map(edge => [edge.from, edge.to])).toEqual([["comfy", "card"]]);
});
