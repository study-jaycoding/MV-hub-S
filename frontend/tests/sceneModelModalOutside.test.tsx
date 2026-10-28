// @vitest-environment jsdom
// 캔버스 모델 설정 창(Jay 2026-10-28): Set 등 칩 목록이 떠 있을 때 창 안 다른 곳을 누르면 목록만 닫힌다(생성창과 같은 규칙).
//  뒤 캔버스(막)를 눌러도 그 누름은 목록만 닫고 창은 남긴다 — 목록이 없을 때 막을 누르면 전처럼 창이 닫힌다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({
  api: {
    models: () => Promise.resolve([{ display_name: "Seedance 2.5", job_set_type: "seedance_2_5", type: "video" },
      { display_name: "Seed Audio 1.0", job_set_type: "seed_audio", type: "audio" }]),
    modelParams: () => Promise.resolve({ job_set_type: "seedance_2_5", type: "video", saved_at: Date.now() / 1000, params: [
      { name: "aspect_ratio", type: "string", default: "16:9", enum: ["16:9", "9:16"] },
      { name: "duration", type: "integer", default: 5 },
      { name: "generate_audio", type: "boolean", default: true },
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

it("Audio 면 생성창처럼 TTS·Voice Change·Translate 단추 — 다른 일로 갔다 TTS 로 오면 마지막 대본 모델", async () => {
  act(() => root.render(<SceneModelModal initial={{ type: "audio", model: "seed_audio", params: {} } as never} onSave={vi.fn()} onClose={vi.fn()} />));
  await settle();
  const task = (label: string) => [...host.querySelectorAll<HTMLButtonElement>(".sl-audio-tasks button")].find((b) => b.textContent === label)!;
  expect([...host.querySelectorAll(".sl-audio-tasks button")].map((b) => b.textContent)).toEqual(["Text to Speech", "Voice Change", "Translate"]);
  expect(task("Text to Speech").getAttribute("aria-pressed")).toBe("true");
  act(() => task("Voice Change").click());
  await settle();
  expect(task("Voice Change").getAttribute("aria-pressed")).toBe("true");
  act(() => task("Text to Speech").click());
  await settle();
  expect(task("Text to Speech").getAttribute("aria-pressed")).toBe("true");
  expect(host.querySelector(".sl-chip-label")?.textContent).toContain("Seed Audio");
});

it("줄 배치(시안 b2) — 종류 단추는 머리줄, 옵션은 '이름 | 값' 한 줄씩이고 캡슐·막대·ON/OFF 로 바꾼 값이 저장된다", async () => {
  const onSave = vi.fn();
  act(() => root.render(<SceneModelModal initial={{ type: "video", model: "seedance_2_5", params: {} } as never} onSave={onSave} onClose={vi.fn()} />));
  await settle();
  expect(host.querySelector(".scene-modelmodal-hd .sl-type-btn.active")?.textContent).toBe("Video");
  expect(host.querySelector(".scene-modelmodal-body .sl-type")).toBeNull();
  const names = [...host.querySelectorAll(".sl-rows > .sl-adv-row .sl-adv-name")].map((n) => n.textContent);
  expect(names).toEqual(["Model", "Aspect Ratio", "Duration", "Sound", "Advanced"]);
  const rowOf = (name: string) => [...host.querySelectorAll(".sl-rows > .sl-adv-row")].find((r) => r.querySelector(".sl-adv-name")?.textContent === name)!;
  const capButton = (name: string, text: string) => [...rowOf(name).querySelectorAll<HTMLButtonElement>(".sl-row-cap button")].find((b) => b.textContent === text)!;
  // 비율 — 목록 대신 캡슐에 다 보인다(CLI 에 없는 'auto' 는 앞에 합성)
  expect([...rowOf("Aspect Ratio").querySelectorAll(".sl-row-cap button")].map((b) => b.textContent)).toEqual(["auto", "16:9", "9:16"]);
  act(() => capButton("Aspect Ratio", "9:16").click());
  expect(capButton("Aspect Ratio", "9:16").getAttribute("aria-pressed")).toBe("true");
  // 길이 — 창 안 막대, 화살표 한 번에 1초
  const before = parseInt(rowOf("Duration").querySelector(".sl-dur-inline-val")!.textContent!, 10);
  act(() => { rowOf("Duration").querySelector("input[type=range]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
  expect(rowOf("Duration").querySelector(".sl-dur-inline-val")?.textContent).toBe(`${before + 1}s`);
  act(() => capButton("Sound", "OFF").click());
  expect(rowOf("Advanced").querySelector(".sl-chip-label")?.textContent).toContain("Bitrate");
  act(() => [...host.querySelectorAll<HTMLButtonElement>(".scene-modelmodal-ft button")].find((b) => b.textContent === "저장")!.click());
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(onSave.mock.calls[0][0].params).toMatchObject({ aspect_ratio: "9:16", duration: before + 1, generate_audio: false });
});
