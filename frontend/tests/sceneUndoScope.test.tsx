// @vitest-environment jsdom
// 되돌리기(Ctrl+Z)·다시 하기가 되돌리는 범위 — 실제 SceneBoard 로 본다(조작 규칙 44. 2026-10-12 조작 점검 17회차, Codex 전수 검토).
//  ① 글을 끝낸 직후의 되돌리기 ② 파생 저장이 치던 글의 단계를 삼키는 것 ③ 크기 조절 중의 되돌리기 ④ 바뀐 것이 없는 조작의 빈 단계
//  ⑤ 되돌린 뒤에 남는 그룹 선택.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SceneGenDataApi } from "../src/lib/useSceneGenData";

const fixture = vi.hoisted(() => ({ data: null as unknown as SceneGenDataApi }));
vi.mock("../src/lib/useSceneGenData", () => ({ useSceneGenData: () => fixture.data }));
const mocks = vi.hoisted(() => ({ parse: vi.fn(), run: vi.fn(), save: vi.fn() }));
vi.mock("../src/lib/comfyApi", async (orig) => {
  const actual = await orig<typeof import("../src/lib/comfyApi")>();
  return { ...actual, comfyApi: { ...actual.comfyApi, parse: mocks.parse, run: mocks.run, saveToLibrary: mocks.save } };
});

import { SceneBoard } from "../src/components/scene/SceneBoard";

const noop = () => {};
let host: HTMLDivElement;
let root: Root;
let frames: FrameRequestCallback[] = [];
let patches: Record<string, unknown>[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("Unexpected socket in isolated UI test"); } });
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected network in isolated UI test"))));
  frames = []; patches = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames[id - 1] = noop; });
  localStorage.clear();
  sessionStorage.clear();
  mocks.parse.mockReset(); mocks.run.mockReset(); mocks.save.mockReset();
  fixture.data = {
    genData: {}, genDataRef: { current: {} }, setGenData: noop, missingIds: new Set(), disabledIds: new Set(), refParents: {},
    colors: { begin: () => null, end: noop, isLive: () => false, currentIds: () => [], applyRecovered: () => [] }, // 색 키가 읽는 장부(비어 있다)
  } as unknown as SceneGenDataApi;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

type SavedCard = { id: string; text?: string; w?: number; h?: number };
type SavedGroup = { id: string; name: string; rect?: { w: number; h: number } };
let rerender: () => void = noop; // 씬은 그대로 두고 보드만 다시 그린다 — 목록 밖 자료(생성 결과)가 도착했을 때처럼
function Shell({ scene }: { scene: never }) {
  const [, bump] = useState(0);
  rerender = () => bump((n) => n + 1);
  return <SceneBoard scene={scene} onChange={(patch) => patches.push(patch as Record<string, unknown>)} />;
}
const show = (cards: object[], groups: object[] = [], edges: object[] = []) => act(async () => {
  root.render(<Shell scene={{ id: "S", name: "S", created_at: 0, edges, cards, groups } as never} />);
});
const savedCards = () => ([...patches].reverse().find((patch) => "cards" in patch)?.cards ?? []) as SavedCard[];
const savedCard = (id: string) => savedCards().find((item) => item.id === id);
const savedGroups = () => ([...patches].reverse().find((patch) => "groups" in patch)?.groups ?? []) as SavedGroup[];
const key = (init: KeyboardEventInit, target: EventTarget = document.body) => act(async () => {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
});
const undo = () => key({ key: "z", code: "KeyZ", ctrlKey: true });
const redo = () => key({ key: "Z", code: "KeyZ", ctrlKey: true, shiftKey: true });
const dbl = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
const type = (area: HTMLTextAreaElement, text: string) => act(async () => {
  setValue.call(area, text);
  area.dispatchEvent(new Event("input", { bubbles: true }));
});
// 보드의 카드 고르기 = 누르고(mousedown) 떼기(window mouseup)
const pick = (id: string) => act(async () => {
  host.querySelector<HTMLElement>(`.scene-card[data-id="${id}"]`)!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
});
const settle = () => act(async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
// 끄는 중의 mousemove 는 실제 브라우저처럼 buttons 를 싣는다(0 이면 끌기 세션이 놓친 mouseup 으로 읽는다 — lib/sceneDragSession)
const press = (el: Element, x: number, y: number) => act(async () => {
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
});
const dragTo = (x: number, y: number) => act(async () => {
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, buttons: 1 }));
  frames.splice(0).forEach((cb) => cb(0));
});
const release = (x: number, y: number) => act(async () => {
  window.dispatchEvent(new MouseEvent("mouseup", { button: 0, clientX: x, clientY: y }));
});

// ── ① 글을 끝낸 직후 ──
const headScene = () => show([{ id: "h", kind: "head", x: 0, y: 0, text: "처음" }]);
async function editHead(text: string, endKey: "Enter" | "Escape") {
  await dbl(host.querySelector(".scene-headnode-text")!);
  const area = host.querySelector<HTMLTextAreaElement>("textarea.scene-headnode-edit")!;
  await type(area, text);
  await key({ key: endKey }, area);
  expect(host.querySelector("textarea.scene-headnode-edit")).toBeNull(); // 편집이 끝났다
}

it.each(["Enter", "Escape"] as const)("제목 카드 — %s 로 끝내는 순간 쓴 글이 확정된다: 바로 누른 Ctrl+Z 는 그 글만 되돌린다", async (endKey) => {
  await headScene();
  await editHead("새 제목", endKey);
  // 전엔 400ms 뒤에야 저장됐다 — 그 안의 Ctrl+Z 는 방금 쓴 글을 건너뛰어 그 앞의 편집을 되돌렸다(앞이 카드 만들기면 카드가 사라졌다)
  expect(savedCard("h")?.text).toBe("새 제목");
  await undo();
  expect(savedCard("h")?.text).toBe("처음");
  await redo();
  expect(savedCard("h")?.text).toBe("새 제목");
});

// ── ② 파생 저장이 치던 글의 단계를 삼키지 않는다 ──
it("치는 중에 파생 저장(Comfy 다시 읽기의 응답)이 끼어도 그 글은 되돌리기 한 단계다", async () => {
  const parses: Array<(value: { node_count: number; candidates: never[] }) => void> = [];
  mocks.parse.mockImplementation(() => new Promise((resolve) => { parses.push(resolve); }));
  await show([
    { id: "t", kind: "text", x: 0, y: 0, text: "처음" },
    { id: "c", kind: "comfy", x: 440, y: 0, comfyCfg: { name: "wf", content: '{"wf":1}', nodeCount: 1 } },
  ]);
  await settle();
  await act(async () => { host.querySelector<HTMLButtonElement>('.scene-comfynode-act[title^="현재 워크플로우 다시 읽기"]')!.click(); });
  await settle();
  expect(parses).toHaveLength(1); // 다시 읽기가 도는 중
  await dbl(host.querySelector(".scene-textview-inline")!);
  const area = host.querySelector<HTMLTextAreaElement>("textarea.scene-textnode")!;
  await type(area, "치던 글"); // 아직 저장 전(400ms 디바운스)
  parses[0]({ node_count: 7, candidates: [] }); // 응답 — 노드 수를 파생 저장으로 적는다
  await settle();
  expect(savedCard("c")).toMatchObject({ comfyCfg: { nodeCount: 7 } });
  await act(async () => { area.blur(); }); // 편집 끝
  await undo();
  // 전엔 파생 저장이 치던 글까지 '저장된 것'으로 삼아, 그 글의 단계가 없었다 — Ctrl+Z 가 아무것도 되돌리지 못했다(앞에 편집이 있었으면 그것이 되돌려졌다)
  expect(savedCard("t")?.text).toBe("처음");
  await redo();
  expect(savedCard("t")?.text).toBe("치던 글");
});

// 파생 저장의 나머지 두 길도 같다 — 늦게 온 생성 결과가 연결 레퍼런스를 채우는 맞춤 · Comfy 결과를 내 작업에 저장한 뒤의 반영
// 글 카드 하나 + 연결된 생성 카드 둘(src → dst). src 의 생성 결과(g1)는 나중에 도착한다 — 도착하면 dst 의 연결 레퍼런스가 채워진다(파생 저장).
const refScene = () => show(
  [{ id: "t", kind: "text", x: 0, y: 0, text: "처음" }, { id: "src", kind: "generation", x: 110, y: 330, genId: "g1", genIds: ["g1"] }, { id: "dst", kind: "generation", x: 660, y: 330 }],
  [],
  [{ id: "e1", from: "src", to: "dst" }],
);
const refsOf = (id: string) => ((savedCard(id) as { refs?: unknown[] } | undefined)?.refs ?? []);
const resultArrives = () => act(async () => {
  const g1 = {
    id: "g1", status: "done", prompt: "g1", tags: [], auto_tags: [], references: [], shared: false, deleted: false, is_mine: true,
    comment_count: 0, has_unread: false, created_at: "2026-10-12 00:00:00", sort_ts: 1,
    assets: [{ id: "asset-g1", generation_id: "g1", type: "image", file_path: "/g1.png", thumbnail_path: null, source_url: null, cached: true }],
  };
  fixture.data = { ...fixture.data, genData: { g1 }, genDataRef: { current: { g1 } } } as unknown as SceneGenDataApi;
  rerender();
});
const editText = async (text: string, finish = true) => {
  await dbl(host.querySelector(".scene-textview-inline")!);
  const area = host.querySelector<HTMLTextAreaElement>("textarea.scene-textnode")!;
  await type(area, text);
  if (finish) await act(async () => { area.blur(); });
  return area;
};

it("치는 중에 늦게 온 생성 결과가 연결 레퍼런스를 채워도(파생 저장) 그 글은 되돌리기 한 단계다", async () => {
  await refScene();
  const area = await editText("치던 글", false);
  expect(patches).toHaveLength(0); // 아직 저장 전
  await resultArrives();
  expect(refsOf("dst")).toHaveLength(1);
  await act(async () => { area.blur(); });
  await undo();
  expect(savedCard("t")?.text).toBe("처음");
});

// ── 되돌린 뒤에도 파생 값은 지금의 연결·생성물로 맞춘다 ──
it("되돌린 스냅샷이 생성 결과가 오기 전의 것이어도 연결 레퍼런스는 남는다 — 그 카드를 고르기만 해도 다시 하기가 지워지던 것", async () => {
  await refScene();
  await editText("편집"); // 한 단계 — 이때의 스냅샷에는 dst 의 연결 레퍼런스가 아직 없다
  await resultArrives();
  expect(refsOf("dst")).toHaveLength(1);
  await undo();
  expect(savedCard("t")?.text).toBe("처음");
  expect(refsOf("dst")).toHaveLength(1); // 전엔 되살린 스냅샷의 것(비어 있다)으로 남았다 — 다시 맞출 계기가 없었다
  const before = patches.length;
  await pick("dst"); // 고르기만 한다 — 전엔 선택 쪽이 빈 레퍼런스를 '사용자 저장'으로 고치며 다시 하기를 지웠다
  expect(patches.length).toBe(before);
  await redo();
  expect(savedCard("t")?.text).toBe("편집");
  expect(refsOf("dst")).toHaveLength(1);
});

it("다시 하기로 되살린 스냅샷이 생성 결과가 오기 전의 것이어도 연결 레퍼런스가 맞춰진다", async () => {
  await refScene();
  await editText("편집");
  await undo(); // 다시 하기에 실린 스냅샷에는 연결 레퍼런스가 없다
  await resultArrives();
  expect(refsOf("dst")).toHaveLength(1);
  await redo();
  expect(savedCard("t")?.text).toBe("편집");
  expect(refsOf("dst")).toHaveLength(1);
});

it("치는 중에 Comfy 결과가 내 작업에 저장돼 카드에 반영돼도(파생 저장) 그 글은 되돌리기 한 단계다", async () => {
  let finishSave!: (value: { saved: { url: string; generation_id: string }[] }) => void;
  mocks.run.mockResolvedValue({ outputs: [{ kind: "image", url: "/out.png" }] });
  mocks.save.mockImplementation(() => new Promise((resolve) => { finishSave = resolve; }));
  await show([
    { id: "t", kind: "text", x: 0, y: 0, text: "처음" },
    { id: "c", kind: "comfy", x: 440, y: 0, comfyCfg: { name: "wf", content: '{"wf":1}', nodeCount: 1 } },
  ]);
  await settle();
  await pick("c"); // 실행 단추는 고른 카드 밑에 뜬다
  await act(async () => { host.querySelector<HTMLButtonElement>(".scene-cardgen-go")!.click(); }); // 실행 — 요청은 가짜가 받는다
  await settle();
  expect(mocks.save).toHaveBeenCalledTimes(1); // 결과를 내 작업에 저장하는 중
  await dbl(host.querySelector(".scene-textview-inline")!);
  const area = host.querySelector<HTMLTextAreaElement>("textarea.scene-textnode")!;
  await type(area, "치던 글");
  finishSave({ saved: [{ url: "/out.png", generation_id: "gen1" }] });
  await settle();
  expect(savedCard("c")).toMatchObject({ genIds: ["gen1"] }); // 결과가 카드에 반영됐다
  await act(async () => { area.blur(); });
  await undo();
  expect(savedCard("t")?.text).toBe("처음");
  expect(savedCard("c")).toMatchObject({ genIds: ["gen1"] }); // 결과는 되돌리기로 사라지지 않는다
});

it("밀린 입력이 없으면 파생 저장 앞에서 아무것도 확정하지 않는다 — Comfy 실행 중의 상태 저장이 되돌리기 단계를 쌓지 않는다", async () => {
  // 실행 중 표시는 화면 전용이라(저장본에는 완료형으로 적힌다) 실행하는 동안 손에 든 카드와 저장본이 다르다 — 그 차이는 사용자 편집이 아니다
  let fail!: (reason: Error) => void;
  mocks.run.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  await show([{ id: "c", kind: "comfy", x: 0, y: 0, comfyCfg: { name: "wf", content: '{"wf":1}', nodeCount: 1 } }]);
  await settle();
  await pick("c"); // 실행 단추는 고른 카드 밑에 뜬다
  await act(async () => { host.querySelector<HTMLButtonElement>(".scene-cardgen-go")!.click(); }); // 실행 — 요청은 시험이 쥔다(서버로 가지 않는다)
  await settle();
  expect(mocks.run).toHaveBeenCalledTimes(1);
  fail(new Error("Comfy 서버에 닿지 않습니다")); // 실패로 끝난다 → 상태를 파생 저장으로 적는다
  await settle();
  expect(savedCard("c")).toMatchObject({ comfyCfg: { status: "failed" } });
  const before = patches.length;
  await undo(); // 사용자가 한 편집이 없다 — 되돌릴 단계도 없다
  expect(patches.length).toBe(before);
  expect(savedCard("c")).toMatchObject({ comfyCfg: { status: "failed" } });
});

// ── ③ 크기 조절도 끌기다 ──
const textOnly = (size: object = {}) => [{ id: "t", kind: "text", x: 0, y: 0, text: "t", ...size }];
const cardGrip = () => host.querySelector<HTMLElement>('.scene-card[data-id="t"] .scene-resize')!;
const cardWidth = () => savedCard("t")?.w;
const grouped = (rect = { x: 66, y: 44, w: 330, h: 330 }) => [{ id: "g", name: "G", cardIds: ["a"], rect }];
const groupCards = () => [{ id: "a", kind: "text", x: 110, y: 110, text: "a" }];
const groupGrip = () => host.querySelector<HTMLElement>(".scene-group-resize")!;
const groupWidth = () => savedGroups()[0]?.rect?.w;
// 단추를 다 뗀 채 움직인다 — mouseup 은 오지 않았다(창 밖에서 뗌). 끌기 세션이 여기서 끝낸다(lib/sceneDragSession)
const hoverTo = (x: number, y: number) => act(async () => {
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, buttons: 0 }));
  frames.splice(0).forEach((cb) => cb(0));
});
/** Comfy 다시 읽기를 걸어 두고, 부르면 그 응답(파생 저장)을 끝내는 함수를 돌려준다. */
async function heldDerivedSave() {
  const parses: Array<(value: { node_count: number; candidates: never[] }) => void> = [];
  mocks.parse.mockImplementation(() => new Promise((resolve) => { parses.push(resolve); }));
  await act(async () => { host.querySelector<HTMLButtonElement>('.scene-comfynode-act[title^="현재 워크플로우 다시 읽기"]')!.click(); });
  await settle();
  return async () => { parses[0]({ node_count: 7, candidates: [] }); await settle(); };
}
const comfyCard = { id: "c", kind: "comfy", x: 880, y: 0, comfyCfg: { name: "wf", content: '{"wf":1}', nodeCount: 1 } };

it("카드 크기 조절 — 누르고 있는 동안의 Ctrl+Z 는 받지 않는다(끌기와 같다). 놓은 뒤에는 한 번에 한 단계씩 돌아간다", async () => {
  await show(textOnly());
  await press(cardGrip(), 0, 0);
  await dragTo(110, 0);
  await release(110, 0);
  const first = cardWidth()!;
  expect(first).toBeGreaterThan(0);
  await press(cardGrip(), 0, 0);
  await dragTo(110, 0);
  await undo(); // 누르고 있는 동안 — 전엔 앞 단계를 되돌렸고, 다음 걸음이 그 위에 다시 크기를 넣어 다시 하기까지 지웠다
  await dragTo(220, 0);
  await release(220, 0);
  const second = cardWidth()!;
  expect(second).toBeGreaterThan(first);
  await undo();
  expect(cardWidth()).toBe(first);
  await undo();
  expect(cardWidth()).toBeUndefined(); // 처음(크기를 정한 적 없는 카드)
  await redo();
  await redo();
  expect(cardWidth()).toBe(second);
});

it("카드 크기 조절이 끝나면 잠금도 묶음도 닫힌다 — mouseup 을 놓친 끌기 뒤에도 Ctrl+Z 가 듣고, 그 뒤의 편집은 따로 되돌려진다", async () => {
  await show(textOnly());
  await press(cardGrip(), 0, 0);
  await dragTo(110, 0);
  await hoverTo(110, 0); // 놓친 mouseup — 여기서 확정된다
  const first = cardWidth()!;
  expect(first).toBeGreaterThan(0);
  await dbl(host.querySelector(".scene-textview-inline")!);
  const area = host.querySelector<HTMLTextAreaElement>("textarea.scene-textnode")!;
  await type(area, "뒤의 편집");
  await act(async () => { area.blur(); });
  expect(savedCard("t")).toMatchObject({ text: "뒤의 편집", w: first });
  await undo(); // 글만 — 크기 조절의 묶음에 섞여 한꺼번에 돌아가지 않는다
  expect(savedCard("t")).toMatchObject({ text: "t", w: first });
  await undo();
  expect(cardWidth()).toBeUndefined();
});

it("카드 크기 조절 중에 파생 저장이 끼어도 Ctrl+Z 는 끌기 전 크기로 간다 — 그 저장이 굳힌 중간 크기가 아니다", async () => {
  await show([...textOnly(), comfyCard]);
  await settle();
  const finishDerived = await heldDerivedSave();
  await press(cardGrip(), 0, 0);
  await dragTo(110, 0);
  await finishDerived(); // 끄는 중의 파생 저장 — 중간 크기가 '저장된 것'이 된다
  const middle = cardWidth()!;
  await dragTo(220, 0);
  await release(220, 0);
  expect(cardWidth()).toBeGreaterThan(middle);
  await undo();
  expect(cardWidth()).toBeUndefined(); // 전엔 중간 크기(middle)
  expect(savedCard("c")).toMatchObject({ comfyCfg: { nodeCount: 7 } }); // 파생 저장이 넣은 값은 남는다
});

it("카드 크기 손잡이를 누르기만 한 뒤 밖에서 크기가 바뀌면, 되돌리기의 시작점도 그 받은 크기다", async () => {
  await show(textOnly());
  await press(cardGrip(), 0, 0); // 누르기만
  await show(textOnly({ w: 506, h: 308 })); // 밖 갱신(같은 씬의 새 배열) — 카드가 커졌다
  await dragTo(110, 0);
  await release(110, 0);
  expect(cardWidth()).toBeGreaterThan(506);
  await undo();
  expect(cardWidth()).toBe(506); // 누른 순간의 크기(정한 적 없음)로 가지 않는다
});

it("그룹 크기 조절 — 누르고 있는 동안의 Ctrl+Z 는 받지 않는다", async () => {
  await show(groupCards(), grouped());
  await press(groupGrip(), 0, 0);
  await dragTo(110, 0);
  await release(110, 0);
  expect(groupWidth()).toBe(440);
  await press(groupGrip(), 0, 0);
  await dragTo(110, 0);
  await undo();
  await dragTo(220, 0);
  await release(220, 0);
  expect(groupWidth()).toBe(660);
  await undo();
  expect(groupWidth()).toBe(440); // 전엔 330 — 끄는 중의 Ctrl+Z 가 앞 단계를 먹었다
  await undo();
  expect(groupWidth()).toBe(330);
});

const renameGroup = async (name: string) => {
  await dbl(host.querySelector(".scene-group-name")!);
  const input = host.querySelector<HTMLInputElement>(".scene-group-name-input")!;
  input.value = name;
  await key({ key: "Enter" }, input);
};

it("그룹 크기 조절이 끝나면 잠금도 묶음도 닫힌다 — mouseup 을 놓친 끌기 뒤에도 Ctrl+Z 가 듣고, 그 뒤의 편집은 따로 되돌려진다", async () => {
  await show(groupCards(), grouped());
  await press(groupGrip(), 0, 0);
  await dragTo(110, 0);
  await hoverTo(110, 0); // 놓친 mouseup
  expect(groupWidth()).toBe(440);
  await renameGroup("G2");
  expect(savedGroups()[0]).toMatchObject({ name: "G2", rect: { w: 440 } });
  await undo(); // 이름만
  expect(savedGroups()[0]).toMatchObject({ name: "G", rect: { w: 440 } });
  await undo();
  expect(groupWidth()).toBe(330);
});

it("그룹 크기 조절 중에 파생 저장이 끼어도 Ctrl+Z 는 끌기 전 네모로 간다", async () => {
  await show([...groupCards(), comfyCard], grouped());
  await settle();
  const finishDerived = await heldDerivedSave();
  await press(groupGrip(), 0, 0);
  await dragTo(110, 0);
  await finishDerived(); // 중간 네모(440)가 '저장된 것'이 된다
  expect(groupWidth()).toBe(440);
  await dragTo(220, 0);
  await release(220, 0);
  expect(groupWidth()).toBe(550);
  await undo();
  expect(groupWidth()).toBe(330); // 전엔 440
});

it("그룹 크기 손잡이를 누르기만 한 뒤 밖에서 네모가 바뀌면, 되돌리기의 시작점도 그 받은 네모다", async () => {
  await show(groupCards(), grouped());
  await press(groupGrip(), 0, 0); // 누르기만
  await show(groupCards(), grouped({ x: 66, y: 44, w: 550, h: 330 })); // 밖 갱신
  await dragTo(110, 0);
  await release(110, 0);
  expect(groupWidth()).toBe(660);
  await undo();
  expect(groupWidth()).toBe(550); // 누른 순간의 네모(330)로 가지 않는다
});

it("그룹 크기 손잡이를 누르기만 하고 놓으면 — 네모·멤버가 그대로인 그룹은 저장하지 않는다(다시 하기가 남는다)", async () => {
  await show(groupCards(), grouped());
  await renameGroup("G2");
  await undo();
  const before = patches.length;
  await press(groupGrip(), 0, 0);
  await release(0, 0); // 움직이지 않고 놓았다
  expect(patches.length).toBe(before); // 전엔 같은 네모·멤버를 새로 저장해 빈 단계가 쌓였다
  await redo();
  expect(savedGroups()[0].name).toBe("G2");
  await undo(); // 손잡이를 누른 것이 잠금을 남기지 않는다
  expect(savedGroups()[0].name).toBe("G");
});

it("네모 없는 자동 그룹은 크기 손잡이를 누르기만 해도 지금 틀이 수동 네모로 저장된다(전부터의 동작 — 그대로다)", async () => {
  await show(groupCards(), [{ id: "auto", name: "A", cardIds: ["a"] }]);
  await press(groupGrip(), 0, 0);
  await release(0, 0);
  expect(savedGroups()[0]?.rect).toBeTruthy();
});

// ── ④ 바뀐 것이 없는 조작 ──
it("바뀐 것이 없는 조작은 되돌리기 단계를 쌓지 않고 다시 하기도 지우지 않는다 — 같은 이름으로 끝낸 그룹 이름", async () => {
  await show(groupCards(), grouped());
  await renameGroup("G2");
  expect(savedGroups()[0].name).toBe("G2");
  await undo();
  expect(savedGroups()[0].name).toBe("G");
  const before = patches.length;
  await renameGroup("G"); // 열었다가 그대로 Enter
  expect(patches.length).toBe(before); // 저장할 것이 없다
  await redo(); // 전엔 빈 단계가 쌓이며 다시 하기가 지워졌다
  expect(savedGroups()[0].name).toBe("G2");
  await undo();
  await undo(); // 빈 단계가 없다 — 더 되돌릴 것이 없다
  expect(savedGroups()[0].name).toBe("G");
});

// ── ⑤ 되돌린 뒤의 그룹 선택 ──
it("되돌린 화면에는 고른 그룹이 없다 — 되돌려 사라진 그룹이 선택에 남지 않고, 다시 하기로 되살아난 그룹도 고른 채로 오지 않는다", async () => {
  await show([{ id: "a", kind: "text", x: 110, y: 110, text: "a" }, { id: "b", kind: "text", x: 330, y: 110, text: "b" }]);
  await key({ key: "a", code: "KeyA", ctrlKey: true });
  await key({ key: "g", code: "KeyG", ctrlKey: true });
  expect(savedGroups()).toHaveLength(1);
  const group = () => host.querySelector<HTMLElement>("[data-group-id][data-selected]");
  expect(group()?.dataset.selected).toBe("true"); // 묶으면 그 그룹이 골라진다
  await undo();
  expect(savedGroups()).toHaveLength(0);
  await redo();
  expect(savedGroups()).toHaveLength(1);
  expect(group()?.dataset.selected).toBe("false"); // 전엔 없는 그룹의 선택이 남아 있다가 그대로 되살아났다(카드 선택은 되돌릴 때 비운다)
  // 없는 그룹이 선택에 남아 있던 동안의 색 키는 그 그룹에 저장을 내 다시 하기를 지웠다 — 이제는 낼 저장이 없다
  await undo();
  const before = patches.length;
  await key({ key: "r", code: "KeyR" });
  expect(patches.length).toBe(before);
  await redo();
  expect(savedGroups()).toHaveLength(1);
});

// ── 부모가 저장한 것을 씬으로 되돌려 주는 길(실제 앱의 저장소) — 위 시험들의 부모는 받은 저장을 쌓기만 한다 ──
function EchoShell({ initial }: { initial: Record<string, unknown> }) {
  const [scene, setScene] = useState(initial);
  const [, bump] = useState(0);
  rerender = () => bump((n) => n + 1);
  return (
    <SceneBoard
      scene={scene as never}
      onChange={(patch) => {
        patches.push(patch as Record<string, unknown>);
        setScene((previous) => ({ ...previous, ...(patch as Record<string, unknown>) }));
      }}
    />
  );
}
const showEcho = (cards: object[], groups: object[] = [], edges: object[] = []) => act(async () => {
  root.render(<EchoShell initial={{ id: "S", name: "S", created_at: 0, edges, cards, groups }} />);
});

it("저장한 것이 씬으로 되돌아오는 부모에서도 같다 — 빈 조작은 단계가 아니고, 되돌린 뒤 고르기만 해서는 다시 하기가 지워지지 않는다", async () => {
  await showEcho(
    [{ id: "t", kind: "text", x: 0, y: 0, text: "처음" }, { id: "src", kind: "generation", x: 110, y: 330, genId: "g1", genIds: ["g1"] }, { id: "dst", kind: "generation", x: 660, y: 330 },
      { id: "a", kind: "text", x: 1100, y: 110, text: "a" }],
    [{ id: "g", name: "G", cardIds: ["a"], rect: { x: 1056, y: 44, w: 330, h: 330 } }],
    [{ id: "e1", from: "src", to: "dst" }],
  );
  await editText("편집"); // 한 단계
  await resultArrives(); // 파생 저장 — dst 의 연결 레퍼런스
  expect(refsOf("dst")).toHaveLength(1);
  await undo();
  expect(savedCard("t")?.text).toBe("처음");
  expect(refsOf("dst")).toHaveLength(1);
  const before = patches.length;
  await pick("dst"); // 고르기만
  await renameGroup("G"); // 같은 이름으로 끝낸다
  expect(patches.length).toBe(before);
  await redo();
  expect(savedCard("t")?.text).toBe("편집");
  await undo();
  await undo(); // 빈 단계가 없다
  expect(savedCard("t")?.text).toBe("처음");
});