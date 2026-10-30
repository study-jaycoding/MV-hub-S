// 캔버스 노드 안쪽 통일(Jay 2026-10-30, 최종 모의 그림 '네모 칩') — 레퍼런스 이름표는 위에 뜨는 이름표(이미지·영상·오디오) ·
// 노드 안 알약은 모서리 5px 네모 칩 · 상태는 칩 없이 글만(앞 '●' 없음) · Comfy 값 줄 = 모델 노드 줄 · 이어보기 표시는 앞 '▶' 없이 한 줄.
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url"; // jsdom 이 전역 URL 을 바꿔 둔다 — 파일 주소는 node 의 URL 로
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SceneBoard } from "../src/components/scene/SceneBoard";
import { ViewSequencePreview } from "../src/components/scene/ViewSequencePreview";
import type { TimelineClip } from "../src/components/scene/ViewTimeline";
import type { Scene, SceneCard } from "../src/lib/scenes";
import type { SceneGenDataApi } from "../src/lib/useSceneGenData";

const fixture = vi.hoisted(() => ({ data: null as unknown as SceneGenDataApi }));
vi.mock("../src/lib/useSceneGenData", () => ({ useSceneGenData: () => fixture.data }));

// 주석을 뺀 scene.css 에서 그 선택자가 든 규칙의 선언들(쉼표로 묶인 규칙도 찾는다)
const css = readFileSync(new NodeURL("../src/styles/scene.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sels: m[1].split(",").map((s) => s.trim()), body: m[2] }));
const decl = (sel: string) => rules.filter((r) => r.sels.includes(sel)).map((r) => r.body).join(";");

it("노드 안 알약은 모서리 5px 네모 칩 · 렌더 개수·INPUT/OUTPUT 이름은 높이 20", () => {
  for (const sel of [".scene-multi-badge", ".scene-listrow-badge", ".scene-portnode-val", ".scene-setnode-pill", ".scene-setnode-tag", ".scene-viewseq-badge"]) {
    expect(decl(sel), sel).toMatch(/border-radius: 5px/);
    expect(decl(sel), sel).not.toMatch(/border-radius: 999px/);
  }
  for (const sel of [".scene-listrow-badge", ".scene-portnode-val"]) expect(decl(sel), sel).toMatch(/height: 20px/);
  expect(decl(".scene-multi-badge")).toMatch(/padding: 3px 11px/); // 생성 개수 크기는 그대로(Jay)
});

it("상태 = 칩 없이 글만(같은 11px 굵게) · 이어보기 = 글 폭 한 줄, 좁으면 단어 사이에서만 꺾음", () => {
  expect(decl(".scene-comfynode-status")).toMatch(/font-size: 11px; font-weight: 800/);
  for (const sel of [".scene-card .gen-generating-label", ".scene-genfail-label"]) {
    expect(decl(sel), sel).toMatch(/font-size: 11px; font-weight: 800/);
  }
  for (const sel of [".scene-comfynode-status", ".scene-card .gen-generating-label", ".scene-genfail-label"]) {
    expect(decl(sel), sel).not.toMatch(/background|border/);
  }
  expect(decl(".scene-viewseq-badge")).toMatch(/width: max-content; max-width: calc\(100% - 12px\)/);
  expect(decl(".scene-viewseq-badge")).toMatch(/word-break: keep-all/);
});

it("Comfy 값 줄 = 모델 노드 줄(이름 회색 · 값 오른쪽 · 칸 테두리 투명 · 체크 = 자기 색) · 결과 그림 칸 = 미리보기와 같은 모서리 8", () => {
  expect(decl(".scene-comfynode-param")).toMatch(/border-top: 1px solid rgba\(255, 255, 255, 0\.06\)/);
  expect(decl(".scene-comfynode-param label")).toMatch(/color: var\(--muted\)/);
  expect(decl('.scene-comfynode-param input[type="text"]')).toMatch(/background: transparent; border: 1px solid transparent;.*text-align: right/);
  expect(decl('.scene-comfynode-param input[type="checkbox"]')).toMatch(/accent-color: var\(--pc\)/);
  expect(decl(".scene-comfynode-preview")).toMatch(/border-radius: 8px; overflow: hidden; background: #05060a/);
  expect(decl(".scene-card-ref .scene-card-hd")).toBe(""); // 그림 위에 얹던 옛 이름표 규칙은 없다
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

it("레퍼런스 이름표는 카드 위에 뜨는 이름표(이미지·영상·오디오) · Comfy 상태 글 앞 '●' 없음", async () => {
  const ref = (id: string, type: string, name: string): SceneCard => ({ id, kind: "reference", x: 0, y: 0, refs: [{ file_path: `asset:p|${name}`, type, name }] });
  const cards: SceneCard[] = [
    ref("ri", "image", "a.png"), ref("rv", "video", "b.mp4"), ref("ra", "audio", "c.mp3"),
    { id: "rm", kind: "reference", x: 0, y: 0, refs: [{ file_path: "asset:p|d.mp4", type: "video", name: "d.mp4" }, { file_path: "asset:p|e.mp4", type: "video", name: "e.mp4" }] },
    { id: "c", kind: "comfy", x: 400, y: 0, comfyCfg: { content: "{}", status: "done" } },
  ];
  await act(async () => {
    root.render(<SceneBoard scene={{ id: "inner", name: "S", created_at: 0, edges: [], cards } as Scene} onChange={noop} />);
  });
  const card = (id: string) => host.querySelector<HTMLElement>(`.scene-card[data-id="${id}"]`)!;
  const tag = (id: string) => card(id).querySelector(":scope > .scene-card-hd.scene-card-hd-float")?.textContent;
  expect(["ri", "rv", "ra", "rm"].map(tag)).toEqual(["이미지", "영상", "오디오", "영상 2"]);
  expect(card("ri").querySelector(".scene-card-inner .scene-card-hd")).toBeNull(); // 그림 위에는 없다
  expect(card("c").querySelector(".scene-comfynode-status")?.textContent).toBe("완료");
});

it("미리보기 '이어보기' 글 앞에 '▶' 가 없다", () => {
  const clips = [{ url: "/a.png", type: "image", thumb: "/a.png" }, { url: "/b.png", type: "image", thumb: "/b.png" }] as unknown as TimelineClip[];
  act(() => { root.render(<ViewSequencePreview clips={clips} />); });
  expect(host.querySelector(".scene-viewseq-badge")?.textContent).toBe("2개 이어보기");
});
