// @vitest-environment jsdom
// 66회차 격리 실측 — 휠 버튼으로 판을 끌다가 출발한 카드 위에서 놓으면, 놓는 순간의 auxclick 이 그 카드의 정보 창을 열었다
//  (카드의 onAuxClick 에 '움직였으면 무시'가 없었다). 실제로 끌었을 때만 놓는 순간의 auxclick 한 번을 삼킨다 — 가만히 누른 휠 클릭은 정보 그대로.
//  같은 실측: body:has(…) 규칙의 오른쪽 끝이 '아무 요소'(`*`·`:not(…)` 만)면 무엇이 붙을 때마다 크롬이 문서 전체 스타일을 다시 셌다.
import { readFileSync, readdirSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SceneBoard } from "../src/components/scene/SceneBoard";
import type { Scene } from "../src/lib/scenes";
import type { SceneGenDataApi } from "../src/lib/useSceneGenData";
import type { Generation } from "../src/types";

const fixture = vi.hoisted(() => ({ data: null as unknown as SceneGenDataApi }));
vi.mock("../src/lib/useSceneGenData", () => ({ useSceneGenData: () => fixture.data }));

const noop = () => {};
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("Unexpected socket in isolated UI test"); } });
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected network in isolated UI test"))));
  localStorage.clear(); sessionStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("휠 버튼으로 판을 끌다 출발한 카드 위에서 놓아도 정보 창이 안 뜬다 — 가만히 누른 휠 클릭은 정보 창", async () => {
  const g = {
    id: "g1", prompt: "p", status: "done", created_at: "2026-10-15", shared: false, is_held: false, is_final: false, is_mine: true,
    deleted: false, tags: [], auto_tags: [], references: [], comment_count: 0, color: null, project_id: "p1", folder_path: "e035/c0010",
    assets: [{ id: "a", generation_id: "g1", type: "image", file_path: "/g1.png", thumbnail_path: "/g1.png", source_url: null, cached: false }],
  } as unknown as Generation;
  const data = { [g.id]: g };
  fixture.data = { genData: data, genDataRef: { current: data }, setGenData: noop, missingIds: new Set(), disabledIds: new Set(), refParents: {} } as unknown as SceneGenDataApi;
  const scene = { id: "S", name: "S", created_at: 0, edges: [], groups: [], cards: [{ id: "c1", kind: "generation", genId: g.id, x: 110, y: 110 }] } as unknown as Scene;
  const onInfo = vi.fn(); // 정보 창은 App 이 그린다 — 캔버스는 이것을 부른다
  await act(async () => { root.render(<SceneBoard scene={scene} onChange={noop} onInfo={onInfo} />); });
  const node = host.querySelector<HTMLElement>('.scene-card[data-id="c1"] .linb-node')!;
  const press = async (dx: number) => {
    await act(async () => { node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 1, buttons: 4, clientX: 180, clientY: 180 })); });
    if (dx) await act(async () => { window.dispatchEvent(new MouseEvent("mousemove", { button: 1, buttons: 4, clientX: 180 + dx, clientY: 180 })); });
    await act(async () => {
      window.dispatchEvent(new MouseEvent("mouseup", { button: 1, clientX: 180 + dx, clientY: 180 }));
      node.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1, detail: 1, clientX: 180, clientY: 180 })); // 같은 입력 안
    });
  };
  await press(40); // 판을 끌었다 — 끝은 다시 그 카드 위(판이 움직여도 카드는 그 아래에 온다)
  expect(onInfo).not.toHaveBeenCalled();
  await act(async () => { await new Promise((done) => setTimeout(done, 0)); }); // 삼키기는 그 놓기 한 번뿐
  await press(0); // 가만히 휠 클릭 = 정보
  expect(onInfo).toHaveBeenCalledTimes(1);
});

it("body:has(…) 규칙의 오른쪽 끝은 '아무 요소'가 아니다 — 무엇이 붙을 때마다 문서 전체를 다시 세지 않게", () => {
  const dir = new NodeURL("../src/styles/", import.meta.url);
  const offenders: string[] = [];
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".css"))) {
    const css = readFileSync(new NodeURL(name, dir), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [, selectors] of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
      for (const selector of selectors.split(/,(?![^(]*\))/).map((s) => s.trim()).filter((s) => s.startsWith("body:has("))) {
        const last = selector.split(/\s*>\s*|\s+(?![^(]*\))/).pop()!;
        if (/^\*?(:not\([^)]*\))*$/.test(last)) offenders.push(`${name}: ${selector}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
