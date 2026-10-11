// @vitest-environment jsdom
// 캔버스의 생성 카드 S(공유) — 보드는 단일/더블클릭 가르기(220ms)를 모든 카드가 같이 쓴다.
// 2026-10-12(조작 점검 10회차, Codex 검토): 앞 카드의 대기 중에 누른 다른 카드의 S 가 '둘째 클릭'으로 버려지고 앞 카드의 확인만 뒤늦게 떴다.
//  계보 보드의 같은 시험은 tests/round7Windows.test.tsx, 훅은 tests/clickSeparation.test.tsx.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SceneBoard } from "../src/components/scene/SceneBoard";
import type { SceneGenDataApi } from "../src/lib/useSceneGenData";
import type { Generation } from "../src/types";

const fixture = vi.hoisted(() => ({ data: null as unknown as SceneGenDataApi }));
vi.mock("../src/lib/useSceneGenData", () => ({ useSceneGenData: () => fixture.data }));

let host: HTMLDivElement;
let root: Root;
const noop = () => {};
const gen = (id: string) => ({
  id, prompt: "p", status: "done", created_at: "2026-10-12", shared: false, is_held: false, is_final: false, is_mine: true,
  deleted: false, tags: [], auto_tags: [], references: [], comment_count: 0,
  assets: [{ id: `${id}-a`, generation_id: id, type: "image", file_path: `/${id}.png`, thumbnail_path: `/${id}.png`, source_url: null, cached: false }],
}) as unknown as Generation;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected network in isolated UI test"))));
  localStorage.clear();
  const genData = { g1: gen("g1"), g2: gen("g2") };
  fixture.data = {
    genData, genDataRef: { current: genData }, setGenData: noop, missingIds: new Set(), disabledIds: new Set(), refParents: {},
  } as unknown as SceneGenDataApi;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("한 카드의 S 를 누르고 곧바로(220ms 안) 다른 카드의 S 를 누르면 나중 카드의 확인이 뜬다", async () => {
  await act(async () => {
    const scene = {
      id: "S", name: "S", created_at: 0, edges: [], groups: [],
      cards: [{ id: "c1", kind: "generation", genId: "g1", x: 110, y: 110 }, { id: "c2", kind: "generation", genId: "g2", x: 440, y: 110 }],
    } as never;
    root.render(<SceneBoard scene={scene} onChange={noop} onPublish={noop} onUnpublish={noop} onFinalize={noop} onUnfinalize={noop} />);
  });
  const card = (id: string) => host.querySelector<HTMLElement>(`.scene-card[data-id="${id}"]`)!;
  const sOf = (id: string) => [...card(id).querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "S")!;
  const confirmOn = () => [...host.querySelectorAll<HTMLElement>(".scene-card")].filter((el) => el.querySelector(".sconfirm")).map((el) => el.dataset.id);
  expect([!!sOf("c1"), !!sOf("c2")]).toEqual([true, true]);
  act(() => { sOf("c1").click(); });
  act(() => { sOf("c2").click(); });
  expect(confirmOn()).toEqual([]); // 아직 더블클릭을 기다리는 중
  await act(async () => { await new Promise((done) => setTimeout(done, 260)); });
  expect(confirmOn()).toEqual(["c2"]);
});
