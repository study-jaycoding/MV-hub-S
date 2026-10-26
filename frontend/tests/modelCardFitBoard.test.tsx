// 모델 설정 저장 → 카드가 설정 줄을 모두 담게 늘어나는가(Jay 2026-10-22) — 실제 SceneBoard 로 본다(저장·Undo 는 실제 코드).
//  jsdom 은 레이아웃이 없어 높이만 흉내 낸다: 카드 = style.height, 본문 = 카드 − 테두리 4, 내용 = 머리 53 + 줄마다 19.
// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SceneBoard } from "../src/components/scene/SceneBoard";
import type { Scene, SceneCard, SceneModelCfg } from "../src/lib/scenes";
import type { SceneGenDataApi } from "../src/lib/useSceneGenData";

const fixture = vi.hoisted(() => ({ data: null as unknown as SceneGenDataApi, cfg: null as unknown as SceneModelCfg }));
vi.mock("../src/lib/useSceneGenData", () => ({ useSceneGenData: () => fixture.data }));
// 설정 창은 고른 값을 onSave 로 넘기고 닫는 것만 흉내 낸다(모델 목록 불러오기는 이 시험의 범위 밖)
vi.mock("../src/components/scene/SceneModelModal", () => ({
  SceneModelModal: ({ onSave, onClose }: { onSave: (cfg: SceneModelCfg) => void; onClose: () => void }) => (
    <button className="stub-save" onClick={() => { onSave(fixture.cfg); onClose(); }}>저장</button>
  ),
}));

const six = { aspect_ratio: "16:9", bitrate: "high", duration: 4, generate_audio: true, mode: "omni_reference", resolution: "480p" };
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
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
    return this.matches(".scene-modelnode-body") ? px(this.closest(".scene-card")!) - 4 : 0;
  });
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
    if (!this.matches(".scene-modelnode-body")) return 0;
    return Math.max(px(this.closest(".scene-card")!) - 4, 53 + 19 * this.querySelectorAll(".scene-modelnode-param").length);
  });
  localStorage.clear(); sessionStorage.clear();
  fixture.data = { genData: {}, genDataRef: { current: {} }, setGenData: noop, missingIds: new Set(), disabledIds: new Set(), refParents: {},
    colors: { begin: () => null, end: noop, isLive: () => false, currentIds: () => [], applyRecovered: () => [] } } as unknown as SceneGenDataApi;
  saved = [];
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// App 처럼 저장받은 값을 복제해(scenes.ts updateScene 의 structuredClone) 씬으로 다시 내려준다(writeBoardSnapshot →
//  patchSceneById). 콜백을 비워 두면 '돌려받은 씬이 방금 늘린 높이를 덮는' 실제 앱의 결함이 안 보인다(Jay 2026-10-22 화면에서만 났다).
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
  root.render(<Host initial={{ id: "model-fit", name: "S", created_at: 0, edges: [], cards: [card] } as Scene} />);
});
const cardEl = () => host.querySelector<HTMLElement>('.scene-card[data-id="m"]')!;
const saveSettings = async (params: SceneModelCfg["params"]) => {
  fixture.cfg = { type: "video", model: "seedance_2_5", modelName: "Seedance 2.5", params };
  await act(async () => { cardEl().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
  await act(async () => { host.querySelector<HTMLElement>(".stub-save")!.click(); });
};
const undo = () => act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", ctrlKey: true, bubbles: true, cancelable: true })); });

it("빈 모델 카드에 설정 6줄을 저장하면 카드가 늘어나 다 보이고, 그 높이가 저장된다", async () => {
  await open({ id: "m", kind: "model", x: 0, y: 0 });
  expect(cardEl().style.height).toBe("130px");
  await saveSettings(six);
  // 내용 53 + 19×6 = 167, 본문 126 → 41 넘침 → 130 + 41
  expect(cardEl().style.height).toBe("171px");
  expect(saved.find((card) => card.id === "m")).toMatchObject({ h: 171, modelCfg: { params: six } });
});

it("이미 넉넉한 카드는 그대로 둔다(줄이지 않는다)", async () => {
  await open({ id: "m", kind: "model", x: 0, y: 0, h: 260 });
  await saveSettings({ aspect_ratio: "16:9" });
  expect(cardEl().style.height).toBe("260px");
});

it("실행 취소 한 번이면 설정과 높이가 함께 저장 전으로 돌아간다", async () => {
  await open({ id: "m", kind: "model", x: 0, y: 0 });
  await saveSettings(six);
  await undo();
  expect(cardEl().style.height).toBe("130px");
  expect(saved.find((card) => card.id === "m")?.modelCfg).toBeUndefined();
});
