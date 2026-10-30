// 새 노드 처음 크기·빈 노드 안내 글(Jay 2026-10-30) — 생성·Comfy = 180×150(안 B), 이미 놓인 카드는 저장된 크기 그대로.
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url"; // jsdom 이 전역 URL 을 바꿔 둔다 — 파일 주소는 node 의 URL 로
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SceneBoard } from "../src/components/scene/SceneBoard";
import { applyCanvasEdit } from "../src/features/canvas/edits";
import type { Scene, SceneCard } from "../src/lib/scenes";
import type { SceneGenDataApi } from "../src/lib/useSceneGenData";

const fixture = vi.hoisted(() => ({ data: null as unknown as SceneGenDataApi }));
vi.mock("../src/lib/useSceneGenData", () => ({ useSceneGenData: () => fixture.data }));

const empty = { cards: [], edges: [], groups: [] };
const made = (command: Parameters<typeof applyCanvasEdit>[1]) => applyCanvasEdit(empty, command, {})?.snapshot.cards[0];

it("새 생성 카드(New·연결해 만들기)와 Comfy 는 180×150, SET 는 기본 노드와 같은 152×130", () => {
  const at = { x: 0, y: 0 };
  expect(made({ type: "createNode", id: "g", kind: "generation", position: at })).toMatchObject({ kind: "generation", w: 180, h: 150, status: "empty" });
  expect(made({ type: "createConnectedGeneration", id: "g2", position: at, sourceIds: [] })).toMatchObject({ kind: "generation", w: 180, h: 150 });
  expect(made({ type: "createNode", id: "c", kind: "comfy", position: at })).toMatchObject({ kind: "comfy", w: 180, h: 150 });
  expect(made({ type: "createNode", id: "s", kind: "set", position: at })).toMatchObject({ kind: "set", w: 152, h: 130 });
});

it("고르면 뜨는 이름표 — 모든 노드가 한 규칙으로 자기 색 알약(종류별 규칙이 바탕을 덮지 않는다)", () => {
  const css = readFileSync(new NodeURL("../src/styles/scene.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const float = css.match(/\.scene-card-hd\.scene-card-hd-float \{([^}]*)\}/)?.[1] ?? "";
  expect(float).toMatch(/background: color-mix\(in srgb, var\(--pc, var\(--accent\)\) 12%/);
  // 떠 있는 이름표를 쓰는 종류 — 뒤에 놓인 종류별 규칙이 background 를 다시 칠하면 그 노드만 모양이 달라진다(전의 Comfy)
  const at = css.indexOf(".scene-card-hd.scene-card-hd-float {");
  for (const kind of ["model", "list", "render", "view", "text", "comfy"]) {
    for (const m of css.matchAll(new RegExp(`\\.scene-card-hd\\.${kind} \\{([^}]*)\\}`, "g"))) {
      if (m.index! > at) expect(m[1], kind).not.toMatch(/background/);
    }
  }
});

let host: HTMLDivElement;
let root: Root;
const noop = () => {};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("requestAnimationFrame", () => 0); vi.stubGlobal("cancelAnimationFrame", noop);
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected network"))));
  localStorage.clear(); sessionStorage.clear();
  fixture.data = { genData: {}, genDataRef: { current: {} }, setGenData: noop, missingIds: new Set(), disabledIds: new Set(), refParents: {},
    colors: { begin: () => null, end: noop, isLive: () => false, currentIds: () => [], applyRecovered: () => [] } } as unknown as SceneGenDataApi;
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("빈 노드 안내 글 — 모델 설정 · 생성/텍스트/레퍼런스 ⏎ 노드 연결 · 생성 노드 연결 · 생성물/텍스트 연결, 놓인 생성 카드 크기는 그대로", async () => {
  const cards: SceneCard[] = [
    { id: "m", kind: "model", x: 0, y: 0 },
    { id: "l", kind: "list", x: 200, y: 0 },
    { id: "r", kind: "render", x: 400, y: 0 },
    { id: "v", kind: "view", x: 600, y: 0 },
    { id: "g", kind: "generation", x: 800, y: 0, status: "empty", refs: [], genId: null }, // 크기 없이 저장된 옛 카드
  ];
  await act(async () => {
    root.render(<SceneBoard scene={{ id: "texts", name: "S", created_at: 0, edges: [], cards } as Scene} onChange={noop} />);
  });
  const card = (id: string) => host.querySelector<HTMLElement>(`.scene-card[data-id="${id}"]`)!;
  expect(card("m").querySelector(".scene-modelnode-empty")?.textContent).toBe("모델 설정");
  const list = card("l").querySelector(".scene-listnode-body")!;
  expect(list.textContent).toBe("생성/텍스트/레퍼런스노드 연결");
  expect(list.querySelectorAll("br")).toHaveLength(1); // 두 줄
  expect(card("r").querySelector(".scene-listnode-body")?.textContent).toBe("생성 노드 연결");
  expect(card("v").querySelector(".scene-viewnode-empty")?.textContent).toBe("생성물/텍스트 연결");
  expect([card("g").style.width, card("g").style.height]).toEqual(["152px", "130px"]);
});
