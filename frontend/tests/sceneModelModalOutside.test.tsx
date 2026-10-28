// @vitest-environment jsdom
// 캔버스 모델 설정 창(Jay 2026-10-28): Set 등 칩 목록이 떠 있을 때 창 안 다른 곳을 누르면 목록만 닫힌다(생성창과 같은 규칙).
//  뒤 캔버스(막)를 눌러도 그 누름은 목록만 닫고 창은 남긴다 — 목록이 없을 때 막을 누르면 전처럼 창이 닫힌다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({
  api: {
    models: () => Promise.resolve([{ display_name: "Seedance 2.5", job_set_type: "seedance_2_5", type: "video" }]),
    modelParams: () => Promise.resolve({ job_set_type: "seedance_2_5", type: "video", saved_at: Date.now() / 1000, params: [
      { name: "mode", type: "string", default: "t2v", enum: ["t2v", "omni_reference", "video_edit", "video_extension"] },
      { name: "bitrate_mode", type: "string", default: "standard", enum: ["standard", "high"] },
    ] }),
    estimateCost: () => Promise.resolve({ credits: 1 }),
  },
}));
vi.mock("../src/lib/modelPolicy", () => ({ useModelPolicy: () => ({ status: "ready", ready: true, allowed: new Set(), key: "k" }) }));
import { SceneModelModal } from "../src/components/scene/SceneModelModal";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const settle = () => act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
const press = (el: Element) => act(() => {
  el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
});
const openSet = () => act(() => { [...host.querySelectorAll("button")].find((b) => b.title.startsWith("고급 옵션"))!.click(); });
const pop = () => host.querySelector(".sl-adv-pop");

it("목록이 떠 있으면 창 안 다른 곳·뒤 막을 눌러도 목록만 닫고, 목록이 없을 때 막을 누르면 창이 닫힌다", async () => {
  const onClose = vi.fn();
  act(() => root.render(<SceneModelModal initial={{ type: "video", model: "seedance_2_5", params: {} } as never} onSave={vi.fn()} onClose={onClose} />));
  await settle();
  openSet();
  expect(pop()).not.toBeNull();
  press(pop()!.querySelector(".sl-adv-opt")!); // 목록 안 — 그대로
  expect(pop()).not.toBeNull();
  press(host.querySelector(".scene-modelmodal-hd")!); // 창 안 다른 곳
  expect(pop()).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  openSet();
  press(host.querySelector(".scene-modelmodal-backdrop")!); // 뒤 막 — 목록만
  expect(pop()).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  press(host.querySelector(".scene-modelmodal-backdrop")!); // 목록이 없으면 전처럼 창을 닫는다
  expect(onClose).toHaveBeenCalledTimes(1);
});
