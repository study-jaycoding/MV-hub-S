// @vitest-environment jsdom
// Set 창 숫자 옵션 = 끌기 막대(Jay 2026-10-28 '듀레이션처럼') — 범위를 아는 것만(Seed Audio·Qwen·ElevenLabs %), 모르는 숫자는 입력 칸 그대로.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: { voices: vi.fn(async () => ({ items: [], cursor: null })) } }));
import { SpotlightOptionsBar } from "../src/components/spotlight/SpotlightOptionsBar";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

let values: Record<string, unknown> = {};
const setOptionValues = vi.fn((next: unknown) => { values = typeof next === "function" ? next(values) : next as Record<string, unknown>; });
const show = (model: string, tunable: object[], optionValues: Record<string, unknown> = {}) => {
  values = { ...optionValues };
  act(() => root.render(
    <SpotlightOptionsBar type="audio" setType={() => {}} model={model} setModel={() => {}} onPickModel={() => {}}
      modelName={model} typeModels={[]} constraints={{}} optionValues={optionValues as never} setOptionValues={setOptionValues as never}
      setOpt={vi.fn()} open="advanced" setOpen={() => {}} tunable={tunable as never} />));
};
const slide = (input: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const ranges = () => [...host.querySelectorAll<HTMLInputElement>('.sl-adv-pop input[type="range"]')];

it("Seed Audio 속도·음높이·음량은 기본값(0) 자리에서 시작하는 막대, 숫자를 누르면 기본값으로", () => {
  const int = (name: string) => ({ name, type: "integer", default: 0 });
  show("seed_audio", [int("loudness_rate"), int("pitch_rate"), int("speech_rate")], { pitch_rate: 6 });
  expect(ranges().map((r) => `${r.getAttribute("aria-label")} ${r.min}~${r.max} step ${r.step} = ${r.value}`)).toEqual([
    "음량 조절 -50~100 step 1 = 0", "음높이 -12~12 step 1 = 6", "말하기 속도 -50~100 step 1 = 0"]);
  const pitch = ranges()[1].closest(".sl-adv-range")!;
  const track = pitch.querySelector<HTMLElement>(".sl-dur-track")!;
  expect([track.style.getPropertyValue("--lo"), track.style.getPropertyValue("--hi")]).toEqual(["0.5", "0.75"]); // 0 ↔ 6 을 채움
  expect(pitch.querySelector(".sl-range-zero")).not.toBeNull();
  expect([...pitch.querySelectorAll(".sl-dur-marks span")].map((s) => s.textContent)).toEqual(["-12", "0", "12"]);
  expect(pitch.querySelector(".sl-adv-range-val")!.textContent).toBe("6");
  slide(ranges()[1], "-3");
  expect(values.pitch_rate).toBe(-3);
  act(() => pitch.querySelector<HTMLButtonElement>(".sl-adv-range-val")!.click());
  expect("pitch_rate" in values).toBe(false); // 대본 모델은 키를 지워 공급자 기본값으로
});

it("Qwen 속도는 0.05 걸음 막대, 범위를 모르는 seed 는 입력 칸 그대로", () => {
  show("qwen_audio_tts", [{ name: "speech_rate", type: "number", default: 1 }, { name: "seed", type: "integer", default: 0 }]);
  expect(ranges().map((r) => `${r.min}~${r.max} step ${r.step}`)).toEqual(["0.5~2 step 0.05"]);
  slide(ranges()[0], "1.35");
  expect(values.speech_rate).toBe(1.35);
  expect(host.querySelector<HTMLInputElement>('.sl-adv-pop input[type="number"]')?.getAttribute("aria-label")).toBe("시드");
});

it("ElevenLabs 안정성(%)은 값이 없으면 'Default'·흐린 손잡이, 끌면 0~1 로 저장", () => {
  show("elevenlabs_v4", [{ name: "stability", type: "number|null", default: null }]);
  const box = host.querySelector(".sl-adv-range")!;
  expect(box.querySelector(".sl-adv-range-val")!.textContent).toBe("Default");
  expect(box.querySelector(".sl-dur-track")!.classList.contains("unset")).toBe(true);
  slide(ranges()[0], "70");
  expect(values.stability).toBe(0.7);
});
