// SET·Comfy 노드도 모델 노드처럼 입력이 모두 보이게 카드가 늘어나는가(Jay 2026-10-30) + SET 태그 알약 — 실제 SceneBoard 로 본다.
//  jsdom 은 레이아웃이 없어 높이만 흉내 낸다(modelCardFitBoard 와 같은 방식): 카드 = style.height,
//  SET 본문 = 카드 − 테두리 4 − 막대 22, 내용 = 60 + 태그 알약마다 14 · Comfy 본문 = 카드 − 4, 내용 = 40 + 파라미터 줄마다 22.
// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SceneBoard } from "../src/components/scene/SceneBoard";
import type { Scene, SceneCard, SceneComfyCfg } from "../src/lib/scenes";
import type { SceneGenDataApi } from "../src/lib/useSceneGenData";

const fixture = vi.hoisted(() => ({ data: null as unknown as SceneGenDataApi, cfg: null as unknown as SceneComfyCfg }));
vi.mock("../src/lib/useSceneGenData", () => ({ useSceneGenData: () => fixture.data }));
// 파라미터 창은 고른 값을 onSave 로 넘기고 닫는 것만 흉내 낸다(워크플로 읽기는 이 시험의 범위 밖)
vi.mock("../src/components/scene/SceneComfyModal", () => ({
  SceneComfyModal: ({ onSave, onClose }: { onSave: (cfg: SceneComfyCfg) => void; onClose: () => void }) => (
    <button className="stub-comfy-save" onClick={() => { onSave(fixture.cfg); onClose(); }}>저장</button>
  ),
}));

let host: HTMLDivElement;
let root: Root;
let saved: SceneCard[];
const noop = () => {};
const px = (el: Element) => parseFloat((el as HTMLElement).style.height) || 0;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("requestAnimationFrame", () => 0); vi.stubGlobal("cancelAnimationFrame", noop);
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected network"))));
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.matches(".scene-card") ? px(this) : 0;
  });
  const client = (el: Element) => px(el.closest(".scene-card")!) - 4 - (el.matches(".scene-setnode-body") ? 22 : 0);
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
    return this.matches(".scene-setnode-body, .scene-comfynode-body") ? client(this) : 0;
  });
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
    if (this.matches(".scene-setnode-body")) return Math.max(client(this), 60 + 14 * this.querySelectorAll(".scene-setnode-tag").length);
    if (this.matches(".scene-comfynode-body")) return Math.max(client(this), 40 + 22 * this.querySelectorAll(".scene-comfynode-param").length);
    return 0;
  });
  localStorage.clear(); sessionStorage.clear();
  fixture.data = { genData: {}, genDataRef: { current: {} }, setGenData: noop, missingIds: new Set(), disabledIds: new Set(), refParents: {},
    colors: { begin: () => null, end: noop, isLive: () => false, currentIds: () => [], applyRecovered: () => [] } } as unknown as SceneGenDataApi;
  saved = [];
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// App 처럼 저장받은 값을 복제해 씬으로 다시 내려준다 — 돌려받은 씬이 방금 늘린 높이를 덮는 결함을 보려면 꼭 있어야 한다(modelCardFitBoard 참고).
function Host({ initial }: { initial: Scene }) {
  const [scene, setScene] = useState(initial);
  return (
    <SceneBoard
      scene={scene}
      onChange={(patch) => {
        if (patch.cards) saved = patch.cards;
        const stored = structuredClone(patch);
        setScene((current) => ({ ...current, ...stored }));
      }}
    />
  );
}
const open = (card: SceneCard) => act(async () => {
  root.render(<Host initial={{ id: "fit", name: "S", created_at: 0, edges: [], cards: [card] } as Scene} />);
});
const cardEl = (id: string) => host.querySelector<HTMLElement>(`.scene-card[data-id="${id}"]`)!;
const typeTags = async (text: string) => {
  await act(async () => { cardEl("s").querySelector<HTMLElement>(".scene-setnode-tagview")!.click(); });
  const input = cardEl("s").querySelector<HTMLInputElement>("input.scene-setnode-pill.edit")!;
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { input.blur(); });
};
const tagPills = () => [...cardEl("s").querySelectorAll(".scene-setnode-tag")].map((el) => el.textContent);
const set = (extra: Partial<SceneCard> = {}): SceneCard => ({ id: "s", kind: "set", x: 0, y: 0, w: 160, h: 136, setCfg: { tagsText: "" }, ...extra });

it("SET — 맨 위 막대·빈 알약 문구 · 태그를 치고 벗어나면 태그마다 '#태그' 알약, 저장 값은 친 글 그대로", async () => {
  await open(set());
  expect(cardEl("s").querySelector(".scene-card-hd.setbar")?.textContent).toBe("SET");
  expect([...cardEl("s").querySelectorAll(".scene-setnode-pill.ph")].map((el) => el.textContent)).toEqual(["📁폴더 끌어 놓기", "#태그1, 태그2"]);
  await act(async () => { cardEl("s").querySelector<HTMLElement>(".scene-setnode-tagview")!.click(); });
  expect(cardEl("s").querySelector<HTMLInputElement>("input.scene-setnode-pill.edit")?.placeholder).toBe("#태그1, #태그2");
  await act(async () => { cardEl("s").querySelector<HTMLInputElement>("input.scene-setnode-pill.edit")!.blur(); });
  await typeTags("#캐릭터, 배경, #캐릭터");
  expect(tagPills()).toEqual(["#캐릭터", "#배경"]); // 생성 카드로 넘어가는 태그 그대로(앞 # 떼기·중복 제거)
  expect(cardEl("s").querySelector("input.scene-setnode-pill.edit")).toBeNull();
  expect(saved.find((card) => card.id === "s")?.setCfg?.tagsText).toBe("#캐릭터, 배경, #캐릭터");
  expect(cardEl("s").style.height).toBe("136px"); // 알약 2개는 기본 크기에 들어간다
});

it("SET — 태그가 넘치면 입력을 마칠 때 알약이 모두 보이게 늘어나고 그 높이가 저장된다(돌려받은 씬이 되돌리지 않는다)", async () => {
  await open(set());
  await typeTags("캐릭터, 배경, 밤, 비, 클로즈업");
  // 본문 110(136 − 4 − 22), 내용 60 + 14×5 = 130 → 20 넘침 → 156
  expect(cardEl("s").style.height).toBe("156px");
  expect(saved.find((card) => card.id === "s")).toMatchObject({ h: 156 });
});

it("SET — 이미 넘치던 카드(예전 모양에서 친 태그)는 글을 고치지 않고 들어갔다 나와도 맞춰진다", async () => {
  await open(set({ setCfg: { tagsText: "캐릭터, 배경, 밤, 비, 클로즈업" } }));
  expect(cardEl("s").style.height).toBe("136px"); // 열기만 해서는 바꾸지 않는다
  await act(async () => { cardEl("s").querySelector<HTMLElement>(".scene-setnode-tagview")!.click(); });
  await act(async () => { cardEl("s").querySelector<HTMLInputElement>("input.scene-setnode-pill.edit")!.blur(); });
  expect(cardEl("s").style.height).toBe("156px");
});

it("SET — 넉넉한 카드는 줄이지 않고, 사용자가 줄인 높이는 입력과 상관없는 변경(폴더 지우기)에 바뀌지 않는다", async () => {
  await open(set({ h: 300 }));
  await typeTags("캐릭터, 배경, 밤, 비, 클로즈업");
  expect(cardEl("s").style.height).toBe("300px");
  await act(async () => { root.unmount(); });
  root = createRoot(host);
  await open(set({ h: 80, setCfg: { tagsText: "캐릭터, 배경, 밤", folder: { projectId: "p", projectName: "뻴뻴뻴", path: "S01/C010" } } }));
  await act(async () => { cardEl("s").querySelector<HTMLElement>(".scene-setnode-clear")!.click(); });
  expect(saved.find((card) => card.id === "s")?.setCfg?.folder).toBeUndefined();
  expect(cardEl("s").style.height).toBe("80px");
});

it("Comfy — 빈 노드는 로고와 불러오기만(안내 글 없음) · 파라미터 창에서 고른 줄이 넘치면 모두 보이게 늘어난다", async () => {
  await open({ id: "e", kind: "comfy", x: 400, y: 0, w: 210, h: 190, comfyCfg: { status: "idle" } });
  const empty = cardEl("e").querySelector(".scene-comfynode-empty")!;
  expect(empty.querySelector("img.scene-comfynode-empty-logo")).not.toBeNull();
  expect(empty.textContent).toBe("📂 불러오기");
  await act(async () => { root.unmount(); });
  root = createRoot(host);
  const base: SceneComfyCfg = { name: "wf", content: "{}", nodeCount: 3, params: [], paramValues: {}, paramExposed: [], status: "idle" };
  await open({ id: "c", kind: "comfy", x: 0, y: 0, w: 210, h: 130, comfyCfg: base });
  fixture.cfg = { ...base, params: ["a", "b", "c", "d", "e", "f"].map((key) => ({ key, label: key, type: "text" as const })) };
  await act(async () => { cardEl("c").querySelector<HTMLElement>('button[title="파라미터 선택"]')!.click(); });
  await act(async () => { host.querySelector<HTMLElement>(".stub-comfy-save")!.click(); });
  // 본문 126, 내용 40 + 22×6 = 172 → 46 넘침 → 176
  expect(cardEl("c").style.height).toBe("176px");
  expect(saved.find((card) => card.id === "c")).toMatchObject({ h: 176 });
});
