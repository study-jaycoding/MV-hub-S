// @vitest-environment jsdom
// Comfy 워크플로를 잇달아 넣으면 나중 것이 이긴다(조작 규칙 39 — 12회차, Codex 설계 검토·코드 리뷰).
//  파싱은 드롭다운 후보를 채우느라 Comfy 서버를 조회한다(backend comfy.py `_enrich_choices` → `/object_info`, 캐시가 없으면 최대 30초).
//  먼저 넣은 A 가 그 조회를 기다리는 동안 넣은 B 가 먼저 끝나면, 늦게 끝난 A 가 B 를 덮었다 — 카드 쪽은 그대로 저장까지 됐다.
//  규칙: 순번은 파일을 읽기 전에 잡고, **이미 반영된 것보다 앞선 것만** 버린다(나중 것이 실패하면 아직 돌던 앞의 것은 들어온다).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Scene } from "../src/lib/scenes";

const mocks = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("../src/lib/comfyApi", async (orig) => {
  const actual = await orig<typeof import("../src/lib/comfyApi")>();
  return { ...actual, comfyApi: { ...actual.comfyApi, parse: mocks.parse } };
});

import { SceneBoard } from "../src/components/scene/SceneBoard";
import { SceneComfyModal } from "../src/components/scene/SceneComfyModal";

type Parsed = { node_count: number; candidates: never[] };
let host: HTMLDivElement;
let root: Root;
let parses: Array<{ resolve: (value: Parsed) => void; reject: (reason: Error) => void }>;
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url.startsWith("/api/generation-views?")) return Promise.resolve(response({ card: {}, last_card_id: null }));
    if (url.startsWith("/api/models")) return Promise.resolve(response([]));
    return Promise.reject(new Error(`Unexpected HTTP in isolated UI test: ${url}`));
  }));
  localStorage.clear();
  sessionStorage.clear();
  parses = [];
  mocks.parse.mockReset().mockImplementation(() => new Promise<Parsed>((resolve, reject) => { parses.push({ resolve, reject }); }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const settle = () => act(async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
/** 파일을 그 자리에 놓는다. jsdom 의 File 에 text() 가 없을 수 있어 읽기를 직접 준다 — 기본은 즉시, read 를 주면 시험이 쥔다. */
async function dropFile(zone: Element, name: string, read?: () => Promise<string>) {
  const file = Object.assign(new File(["{}"], `${name}.json`, { type: "application/json" }), { text: read ?? (async () => `{"${name}":1}`) });
  act(() => { zone.dispatchEvent(Object.assign(new Event("drop", { bubbles: true, cancelable: true }), { dataTransfer: { types: ["Files"], files: [file], items: [] } })); });
  await settle();
}
/** 시험이 쥐고 있는 파일 읽기 — 느린 드라이브. */
function heldRead() {
  let finish!: (text: string) => void, fail!: (reason: Error) => void;
  const promise = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
  return { read: () => promise, finish, fail };
}
const finish = async (index: number, nodeCount: number) => { parses[index].resolve({ node_count: nodeCount, candidates: [] }); await settle(); };
const modal = () => <SceneComfyModal onSave={() => {}} onClose={() => {}} />;
const saveButton = () => document.querySelector<HTMLButtonElement>(".scene-modelmodal-ft button.primary")!;

it("Comfy 워크플로 창 — 불러오는 중에 다른 파일을 넣으면 나중 것이 남는다(늦게 끝난 앞 파싱이 덮지 않는다)", async () => {
  act(() => root.render(modal()));
  const zone = host.querySelector(".scene-comfy-drop")!;
  await dropFile(zone, "first");
  await dropFile(zone, "second");
  expect(mocks.parse).toHaveBeenCalledTimes(2);
  await finish(1, 2); // 나중에 넣은 것이 먼저 끝났다
  expect(zone.textContent).toContain("second · 노드 2개");
  expect(host.textContent).toContain("불러오는 중"); // 앞의 것이 아직 돈다 — 그동안 저장은 잠겨 있다
  expect(saveButton().disabled).toBe(true);
  await finish(0, 9); // 먼저 넣은 것이 늦게 끝났다
  expect(zone.textContent).toContain("second · 노드 2개");
  expect(host.querySelector(".scene-modelmodal-hd")!.textContent).toContain("— second");
  expect(host.textContent).not.toContain("불러오는 중");
  expect(saveButton().disabled).toBe(false);
});

// 19회차(조작 규칙 46): 창을 열 때의 다시 읽기(파싱)가 실패하면 후보가 빈 채였다 — 그대로 [저장]하면 카드의 조절 칸 목록(params)이 빈 것으로
//  덮였다(Comfy 서버가 꺼져 있을 때 창을 열고 저장만 눌러도). 못 읽은 것을 '조절할 것이 없다'로 보이지도 않는다.
it("Comfy 워크플로 창 — 저장된 워크플로를 다시 읽지 못했으면 저장할 수 없다(빈 후보로 카드의 조절 칸을 지우지 않는다). 다시 넣어 읽히면 저장된다", async () => {
  const onSave = vi.fn();
  const initial = { name: "wf", content: '{"wf":1}', nodeCount: 3, paramExposed: ["1|seed"], paramValues: { "1|seed": 7 },
    params: [{ key: "1|seed", label: "seed", type: "int" }], output: null, status: "idle" } as never;
  act(() => root.render(<SceneComfyModal initial={initial} onSave={onSave} onClose={() => {}} />));
  parses[0].reject(new Error("Comfy 서버에 연결하지 못했습니다"));
  await settle();
  expect(host.textContent).toContain("Comfy 서버에 연결하지 못했습니다");
  expect(host.textContent).not.toContain("조절 가능한 파라미터가 없습니다");
  expect(saveButton().disabled).toBe(true);
  act(() => saveButton().click());
  expect(onSave).not.toHaveBeenCalled();

  await dropFile(host.querySelector(".scene-comfy-drop")!, "wf", async () => '{"wf":1}'); // 같은 파일을 다시 넣는다 — 노출 선택은 그대로다
  parses[1].resolve({ node_count: 3, candidates: [{ node_id: "1", field: "seed", label: "seed", type: "int", value: 1, title: "KSampler", curated: true }] as never });
  await settle();
  expect(saveButton().disabled).toBe(false);
  act(() => saveButton().click());
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(onSave.mock.calls[0][0]).toMatchObject({ paramExposed: ["1|seed"], paramValues: { "1|seed": 7 }, params: [{ key: "1|seed", label: "seed", type: "int" }] });
});

it("Comfy 워크플로 창 — 순서대로 끝나면 차례로 보이고, 다 끝날 때까지 '불러오는 중'이다", async () => {
  act(() => root.render(modal()));
  const zone = host.querySelector(".scene-comfy-drop")!;
  await dropFile(zone, "first");
  await dropFile(zone, "second");
  await finish(0, 9);
  expect(zone.textContent).toContain("first · 노드 9개");
  expect(host.textContent).toContain("불러오는 중"); // 뒤의 것이 아직 돈다 — 표시를 먼저 끝난 쪽이 끄지 않는다
  expect(saveButton().disabled).toBe(true);
  await finish(1, 2);
  expect(zone.textContent).toContain("second · 노드 2개");
  expect(host.textContent).not.toContain("불러오는 중");
});

it("Comfy 워크플로 창 — 순번은 파일을 읽기 시작할 때 잡는다: 읽는 중에 넣은 다른 파일이 이기고, 버려진 앞 파일은 파싱하지도 오류를 띄우지도 않는다", async () => {
  act(() => root.render(modal()));
  const zone = host.querySelector(".scene-comfy-drop")!;
  const slow = heldRead();
  await dropFile(zone, "slow", slow.read);
  await dropFile(zone, "second"); // slow.json 을 아직 읽는 중이다
  await finish(0, 2);
  expect(host.textContent).toContain("불러오는 중"); // slow 가 아직 돈다
  slow.finish('{"slow":1}'); // 늦게 읽힌 앞 파일
  await settle();
  expect(mocks.parse).toHaveBeenCalledTimes(1);
  expect(zone.textContent).toContain("second · 노드 2개");
  expect(host.textContent).not.toContain("불러오는 중");

  // 버려진 앞 파싱이 실패로 끝나도 지금 것의 화면에 오류를 띄우지 않는다
  await dropFile(zone, "broken");
  await dropFile(zone, "third");
  await finish(2, 3); // third
  await act(async () => { parses[1].reject(new Error("파싱 실패")); });
  await settle();
  expect(host.querySelector(".scene-comfy-msg.err")).toBeNull();
  expect(zone.textContent).toContain("third · 노드 3개");
  expect(host.textContent).not.toContain("불러오는 중");
});

it("Comfy 워크플로 창 — 나중 것을 읽지 못해도 아직 돌던 앞의 것은 들어오고, '불러오는 중'이 남지 않는다", async () => {
  // Codex 코드 리뷰: '가장 나중에 시작한 것만 받는다'로 하면, 열 때의 재파싱이 도는 중에 넣은 파일이 읽기에 실패했을 때 재파싱까지 버려져
  //  '불러오는 중'과 잠긴 저장 단추가 남았다(새 파일을 넣거나 창을 다시 열어야 풀린다).
  act(() => root.render(<SceneComfyModal initial={{ name: "kept", content: '{"kept":1}' } as never} onSave={() => {}} onClose={() => {}} />));
  await settle();
  expect(mocks.parse).toHaveBeenCalledTimes(1); // 열 때의 재파싱 — 아직 안 끝났다
  const zone = host.querySelector(".scene-comfy-drop")!;
  const unreadable = heldRead();
  await dropFile(zone, "unreadable", unreadable.read);
  await act(async () => { unreadable.fail(new Error("read error")); });
  await settle();
  expect(host.querySelector(".scene-comfy-msg.err")!.textContent).toContain("읽지 못했습니다");
  expect(host.textContent).toContain("불러오는 중"); // 재파싱이 아직 돈다
  await finish(0, 4);
  expect(zone.textContent).toContain("kept · 노드 4개");
  expect(host.textContent).not.toContain("불러오는 중");
  expect(saveButton().disabled).toBe(false);
  expect(host.querySelector(".scene-comfy-msg.err")!.textContent).toContain("읽지 못했습니다"); // 못 읽은 것은 계속 알린다
  await dropFile(zone, "next"); // 새로 시작하면 앞의 오류 글은 지운다
  expect(host.querySelector(".scene-comfy-msg.err")).toBeNull();
});

it("Comfy 워크플로 창 — 잘못된 파일을 놓아 파싱에 실패해도 앞 워크플로의 파라미터 설정은 그대로다(저장해도 지워지지 않는다)", async () => {
  // Codex 코드 리뷰: 전엔 파싱 전에 노출 선택을 비우고 실패 때 후보를 비워, 내용은 앞의 것인데 파라미터 설정이 지워진 채 저장됐다.
  const seed = { node_id: "3", field: "seed", title: "KSampler", label: "seed", type: "number", value: 7 };
  const onSave = vi.fn();
  act(() => root.render(<SceneComfyModal initial={{ name: "kept", content: '{"kept":1}', paramExposed: ["3|seed"] } as never} onSave={onSave} onClose={() => {}} />));
  await settle();
  parses[0].resolve({ node_count: 4, candidates: [seed] as never });
  await settle();
  const checks = () => [...host.querySelectorAll<HTMLInputElement>('.scene-comfy-catalog input[type="checkbox"]')];
  expect(checks().map((input) => input.checked)).toEqual([true]);
  await dropFile(host.querySelector(".scene-comfy-drop")!, "broken"); // 다른 내용 — 받아들이면 노출 선택을 비운다
  await act(async () => { parses[1].reject(new Error("JSON 이 아닙니다")); });
  await settle();
  expect(host.querySelector(".scene-comfy-msg.err")!.textContent).toContain("JSON 이 아닙니다");
  expect(host.querySelector(".scene-comfy-drop")!.textContent).toContain("kept · 노드 4개");
  expect(checks().map((input) => input.checked)).toEqual([true]); // 후보도 선택도 그대로
  await act(async () => { saveButton().click(); });
  expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "kept", content: '{"kept":1}', paramExposed: ["3|seed"] }));
  expect(onSave.mock.calls[0][0].params).toHaveLength(1);
  // 다른 워크플로를 **받아들이면** 그때 노출 선택을 비운다(노드 id 가 겹치기 쉬워 옛 선택이 엉뚱한 노드에 붙는다 — 전부터의 규칙)
  await dropFile(host.querySelector(".scene-comfy-drop")!, "other");
  parses[2].resolve({ node_count: 2, candidates: [seed] as never });
  await settle();
  expect(host.querySelector(".scene-comfy-drop")!.textContent).toContain("other · 노드 2개");
  expect(checks().map((input) => input.checked)).toEqual([false]);
});

it("Comfy 워크플로 창 — A → B → A 가 겹쳐도 마지막 A 는 자기 노출 선택을 들고 온다(B 가 비운 채로 남지 않는다)", async () => {
  // Codex 코드 리뷰: 마지막 A 는 '같은 워크플로'라 선택을 그대로 두려 했는데, 그사이 받아들인 B 가 선택을 비웠다 — 저장하면 A 의 설정이 사라졌다.
  const seed = { node_id: "3", field: "seed", title: "KSampler", label: "seed", type: "number", value: 7 };
  act(() => root.render(<SceneComfyModal initial={{ name: "kept", content: '{"kept":1}', paramExposed: ["3|seed"] } as never} onSave={() => {}} onClose={() => {}} />));
  await settle();
  parses[0].resolve({ node_count: 4, candidates: [seed] as never });
  await settle();
  const zone = host.querySelector(".scene-comfy-drop")!;
  const checks = () => [...host.querySelectorAll<HTMLInputElement>('.scene-comfy-catalog input[type="checkbox"]')].map((input) => input.checked);
  await dropFile(zone, "other"); // B — parses[1]
  await dropFile(zone, "kept", async () => '{"kept":1}'); // 아직 A 가 보일 때 A 를 다시 — parses[2]
  parses[1].resolve({ node_count: 2, candidates: [seed] as never });
  await settle();
  parses[2].resolve({ node_count: 4, candidates: [seed] as never });
  await settle();
  expect(zone.textContent).toContain("kept · 노드 4개");
  expect(checks()).toEqual([true]);
});

// ── 캔버스의 Comfy 카드 ──
const comfyScene = () => ({ id: "s", name: "s", created_at: 0, edges: [], cards: [{ id: "comfy", kind: "comfy", x: 0, y: 0 }] }) as unknown as Scene;
async function board() {
  const saved: Scene["cards"][] = [];
  await act(async () => { root.render(<SceneBoard scene={comfyScene()} onChange={(next) => { if (next.cards) saved.push(next.cards); }} />); });
  await settle();
  const names = () => saved.map((cards) => cards.find((card) => card.id === "comfy")?.comfyCfg?.name).filter(Boolean);
  return { names, zone: () => host.querySelector(".scene-comfynode-empty, .scene-comfynode-body")!, label: () => host.querySelector(".scene-comfynode-nametext")!.textContent };
}
const cardButton = (title: string) => host.querySelector<HTMLButtonElement>(`.scene-comfynode-act[title^="${title}"]`)!;

it("캔버스의 Comfy 카드 — 같은 카드에 잇달아 넣은 워크플로는 나중 것이 저장된다", async () => {
  const card = await board();
  await dropFile(card.zone(), "first");
  await dropFile(card.zone(), "second");
  expect(mocks.parse).toHaveBeenCalledTimes(2);
  await finish(1, 2);
  await finish(0, 9); // 늦게 끝난 앞 파싱
  expect(card.names().length).toBeGreaterThan(0);
  expect(new Set(card.names())).toEqual(new Set(["second"])); // 한 번도 first 로 저장되지 않았다
  expect(card.label()).toContain("second · 2노드");
});

it("캔버스의 Comfy 카드 — 순번은 파일을 읽기 전에 잡는다(느린 드라이브의 앞 파일이 늦게 읽혀 나중 것을 덮지 않는다). 나중 것이 실패하면 앞의 것이 들어온다", async () => {
  const card = await board();
  const slow = heldRead();
  await dropFile(card.zone(), "slow", slow.read);
  await dropFile(card.zone(), "second");
  await finish(0, 2);
  expect(card.label()).toContain("second · 2노드");
  slow.finish('{"slow":1}'); // 이제야 읽혔다 — 전엔 이때 더 큰 순번을 받아 second 를 덮었다
  await settle();
  expect(mocks.parse).toHaveBeenCalledTimes(1);
  expect(card.label()).toContain("second · 2노드");
  expect(new Set(card.names())).toEqual(new Set(["second"]));

  // 나중에 넣은 것이 파싱에 실패하면, 아직 돌던 앞의 것은 버리지 않는다
  await dropFile(card.zone(), "third"); // parses[1]
  await dropFile(card.zone(), "broken"); // parses[2]
  await act(async () => { parses[2].reject(new Error("파싱 실패")); });
  await settle();
  await finish(1, 3);
  expect(card.label()).toContain("third · 3노드");
});

it("캔버스의 Comfy 카드 — 반영된 순번은 씬마다 따로다: 카드 id 가 같은 다른 씬에 넣은 것이 이 씬의 불러오기를 버리지 않는다", async () => {
  // 같은 씬 파일을 두 번 가져오면 두 씬의 카드 id 가 같다(가져올 때 카드 id 를 유지한다 — Codex 코드 리뷰)
  const show = async (id: string) => {
    await act(async () => { root.render(<SceneBoard scene={{ ...comfyScene(), id, name: id }} onChange={() => {}} />); });
    await settle();
  };
  const label = () => host.querySelector(".scene-comfynode-nametext")?.textContent ?? "";
  await show("x");
  const slow = heldRead();
  await dropFile(host.querySelector(".scene-comfynode-empty")!, "forx", slow.read); // 씬 x 의 카드 — 아직 읽는 중
  await show("y");
  await dropFile(host.querySelector(".scene-comfynode-empty")!, "fory"); // 씬 y 의, id 가 같은 카드
  await finish(0, 2);
  expect(label()).toContain("fory · 2노드");
  await show("x");
  slow.finish('{"forx":1}');
  await settle();
  await finish(1, 5);
  expect(label()).toContain("forx · 5노드"); // 전엔 y 의 순번에 밀려 말없이 버려졌다
});

it("캔버스의 Comfy 카드 — 워크플로 창에서 저장한 것을, 그 전에 카드에 놓아 아직 파싱 중이던 불러오기가 덮지 않는다", async () => {
  const card = await board();
  await dropFile(card.zone(), "base");
  await finish(0, 1); // 카드에 워크플로가 들어 있다(P 단추가 생긴다)
  await dropFile(card.zone(), "inline"); // parses[1] — 파싱 중
  await act(async () => { cardButton("파라미터 선택").click(); });
  await settle(); // 창이 뜨며 지금 워크플로(base)를 다시 파싱한다 — parses[2]
  await dropFile(document.querySelector(".scene-comfy-drop")!, "frommodal"); // parses[3]
  await finish(2, 1);
  await finish(3, 5);
  expect(saveButton().disabled).toBe(false);
  await act(async () => { saveButton().click(); });
  await settle();
  expect(card.label()).toContain("frommodal");
  await finish(1, 9); // 카드에 놓았던 것이 이제 끝났다
  expect(card.label()).toContain("frommodal");
  expect(card.names()).not.toContain("inline");
});

// 위 시험을 쓰다 본 것(2026-10-12): 창의 놓는 자리는 preventDefault 만 하고 전파를 두어, 같은 놓기가 뒤 보드의 onDrop 에도 닿았다.
//  보드는 .json 한 개를 '씬 파일'로 본다 — 워크플로 JSON 을 씬으로 읽으려다 "씬 파일이 아닙니다" 류의 안내를 띄웠다(카드 안의 놓는 자리는 전부터 전파를 막는다).
it("Comfy 워크플로 창에 놓은 .json 은 창의 것이다 — 뒤 보드가 씬 파일로 같이 받지 않는다", async () => {
  const loadScene = vi.fn();
  await act(async () => { root.render(<SceneBoard scene={comfyScene()} onChange={() => {}} onLoadSceneFile={loadScene} />); });
  await settle();
  await dropFile(host.querySelector(".scene-comfynode-empty")!, "base"); // 카드 안의 자리 — 전부터 보드로 안 올라간다
  await finish(0, 1);
  expect(loadScene).not.toHaveBeenCalled();
  await act(async () => { cardButton("파라미터 선택").click(); });
  await settle();
  await dropFile(document.querySelector(".scene-comfy-drop")!, "frommodal");
  expect(mocks.parse).toHaveBeenCalledTimes(3); // 카드 · 창을 열 때의 재파싱 · 창에 놓은 것
  expect(loadScene).not.toHaveBeenCalled();
});

// 14회차(조작 규칙 41): 읽기·파싱에 실패하면 카드는 그대로 두되 그 사실을 알린다 — 전엔 아무 반응이 없어, 새 파일이 들어간 줄 알고
//  옛 워크플로를 실행할 수 있었다. 낡은 불러오기(그사이 다른 것이 반영됐다)의 실패는 지금 카드와 무관하니 알리지 않는다.
it("캔버스의 Comfy 카드 — 불러오기·다시 읽기에 실패하면 알린다. 낡은 것의 실패는 알리지 않는다", async () => {
  const flashes: string[] = [];
  const onFlash = (event: Event) => { flashes.push((event as CustomEvent<string>).detail); };
  window.addEventListener("ch:flash", onFlash);
  const failParse = async (index: number, why: string) => { await act(async () => { parses[index].reject(new Error(why)); }); await settle(); };
  try {
    const card = await board();
    await dropFile(card.zone(), "broken"); // parses[0]
    await failParse(0, "워크플로 JSON 이 아닙니다");
    expect(flashes).toEqual(["워크플로를 불러오지 못했습니다 — 카드는 그대로입니다. 워크플로 JSON 이 아닙니다"]);
    await dropFile(card.zone(), "slow"); // parses[1] — 도는 중
    await dropFile(card.zone(), "base"); // parses[2]
    await finish(2, 1);
    await failParse(1, "늦은 실패"); // base 가 이미 들어왔다
    expect(flashes).toHaveLength(1);
    expect(card.label()).toContain("base · 1노드");
    // 다시 읽기(↻)
    await act(async () => { cardButton("현재 워크플로우 다시 읽기").click(); }); // parses[3]
    await settle();
    await failParse(3, "Comfy 서버에 닿지 않습니다");
    expect(flashes.slice(1)).toEqual(["워크플로를 다시 읽지 못했습니다. Comfy 서버에 닿지 않습니다"]);
    await act(async () => { cardButton("현재 워크플로우 다시 읽기").click(); }); // parses[4]
    await settle();
    await dropFile(card.zone(), "next"); // parses[5] — 다시 읽는 사이에 다른 워크플로로 바뀌었다
    await finish(5, 3);
    await failParse(4, "늦은 실패");
    expect(flashes).toHaveLength(2);
    // 씬을 떠난 뒤에 온 실패도 알리지 않는다 — 같은 씬 파일을 두 번 가져오면 두 씬의 카드 id·워크플로가 같다
    const loaded = (id: string) => ({ id, name: id, created_at: 0, edges: [],
      cards: [{ id: "comfy", kind: "comfy", x: 0, y: 0, comfyCfg: { name: "same", content: '{"same":1}', nodeCount: 1 } }] }) as unknown as Scene;
    const showScene = async (id: string) => { await act(async () => { root.render(<SceneBoard scene={loaded(id)} onChange={() => {}} />); }); await settle(); };
    await showScene("x");
    const at = parses.length;
    await act(async () => { cardButton("현재 워크플로우 다시 읽기").click(); });
    await settle();
    expect(parses.length).toBe(at + 1);
    await showScene("y");
    await failParse(at, "늦은 실패");
    expect(flashes).toHaveLength(2);
  } finally {
    window.removeEventListener("ch:flash", onFlash);
  }
});

it("캔버스의 Comfy 카드 — 다시 읽기(↻)가 도는 사이에 다른 워크플로로 바뀌면 옛 것의 노드 수를 새것에 적지 않는다", async () => {
  const card = await board();
  await dropFile(card.zone(), "base");
  await finish(0, 1);
  await act(async () => { cardButton("현재 워크플로우 다시 읽기").click(); }); // parses[1] — base 를 다시 읽는 중
  await settle();
  await dropFile(card.zone(), "next"); // parses[2]
  await finish(2, 3);
  expect(card.label()).toContain("next · 3노드");
  await finish(1, 9); // base 의 다시 읽기가 늦게 끝났다
  expect(card.label()).toContain("next · 3노드");
});
