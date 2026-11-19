// @vitest-environment jsdom
// 모델 선택 목록의 계열 아이콘 타일(Jay 2026-11-19 C안) — 이미지는 2계열 타일 + 줄 아이콘, 영상은 타일 없이 줄 아이콘, 오디오는 그대로.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SpotlightOptionsBar } from "../src/components/spotlight/SpotlightOptionsBar";
import { modelFamily, rowFamily } from "../src/components/spotlight/ModelFamilyIcon";
import { ALLOWED, inferModelType, MODEL_DISPLAY_NAMES } from "../src/lib/useModels";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const m = (job_set_type: string, display_name: string) => ({ job_set_type, display_name, type: "image" });
const IMAGE_MODELS = [
  m("nano_banana_flash", "Nano Banana 2"), m("nano_banana_2_1", "Nano Banana 2.1"),
  m("nano_banana_2_lite", "Nano Banana 2 Lite"), m("nano_banana_pro", "Nano Banana Pro"),
  m("gpt_image_2_5", "GPT Image 2.5"), m("gpt_image_2", "GPT Image 2"),
];

function bar(type: "image" | "video" | "audio", model: string, models: ReturnType<typeof m>[], onPickModel = vi.fn()) {
  act(() => root.render(
    <SpotlightOptionsBar type={type} setType={() => {}} model={model} setModel={() => {}} onPickModel={onPickModel}
      modelName={model} typeModels={models as never} constraints={{}} optionValues={{}} setOptionValues={vi.fn() as never}
      setOpt={vi.fn()} open="model" setOpen={() => {}} tunable={[]} />));
  return onPickModel;
}
const rowNames = () => [...host.querySelectorAll(".sl-dropdown .sl-dd-item")].map((b) => b.getAttribute("aria-label"));
const tabs = () => [...host.querySelectorAll<HTMLButtonElement>(".sl-fam-tab")];

it("계열 판정은 모델 코드 앞부분으로, 모르는 모델은 null", () => {
  expect(modelFamily("nano_banana_flash")).toBe("nano");
  expect(modelFamily("gpt_image_2_5")).toBe("gpt");
  expect(modelFamily("seedance_2_0_mini")).toBe("seedance");
  expect(modelFamily("seedream_5_5")).toBe("seedream");
  expect(modelFamily("kling4_0")).toBe("kling");
  expect(modelFamily("kling_4_0_flash")).toBe("kling");
  expect(modelFamily("gemini_omni_flash_1_2")).toBe("gemini");
  expect(modelFamily("wan3_0_prime")).toBe("wan");
  expect(modelFamily("minimax_h3_max")).toBe("minimax");
  expect(modelFamily("flux_kontext")).toBeNull();
  expect(modelFamily("")).toBeNull();
});

it("이미지: 타일 2개(글씨 없음)·고른 모델 계열이 먼저 열리고, 타일을 누르면 그 계열 줄만 보이며, 줄을 누르면 그 모델이 골라진다", () => {
  const onPick = bar("image", "nano_banana_flash", IMAGE_MODELS);
  expect(tabs().map((t) => t.getAttribute("aria-label"))).toEqual(["Nano Banana", "GPT Image"]);
  expect(tabs().every((t) => t.textContent === "")).toBe(true); // 아이콘만 — 글씨 없음
  expect(tabs()[0].classList.contains("on")).toBe(true);
  expect(rowNames()).toEqual(["Nano Banana 2", "Nano Banana 2.1", "Nano Banana 2 Lite", "Nano Banana Pro"]);
  expect(host.querySelectorAll(".sl-dropdown .sl-dd-item.has-ic svg.sl-fam-ic")).toHaveLength(4);
  expect(host.querySelector(".sl-dd-item.sel")!.getAttribute("aria-label")).toBe("Nano Banana 2");
  expect(host.querySelector(".sl-chip svg.sl-chip-ic")).not.toBeNull(); // 칩의 점 자리에 아이콘

  act(() => tabs()[1].click());
  expect(tabs()[1].classList.contains("on")).toBe(true);
  expect(rowNames()).toEqual(["GPT Image 2.5", "GPT Image 2"]);
  act(() => [...host.querySelectorAll<HTMLButtonElement>(".sl-dd-item")].find((b) => b.getAttribute("aria-label") === "GPT Image 2")!.click());
  expect(onPick).toHaveBeenCalledWith("gpt_image_2", {});
});

function barWith(model: string, optionValues: Record<string, string>) {
  const tunable = [
    { name: "resolution", type: "string", default: "1k", enum: ["1k", "2k", "4k"] },
    { name: "output_format", type: "string", default: "png", enum: ["png", "jpeg", "webp", "gif", "svg"] },
  ];
  act(() => root.render(
    <SpotlightOptionsBar type="image" setType={() => {}} model={model} setModel={() => {}} onPickModel={() => {}}
      modelName={model} typeModels={[m(model, model)] as never} constraints={{}} optionValues={optionValues} setOptionValues={vi.fn() as never}
      setOpt={vi.fn()} open={null} setOpen={() => {}} tunable={tunable as never} />));
}

it("GPT 2.6 + GIF: 해상도 칸이 288×288 로 바뀌어 잠기고(누를 수 없음), png 로 돌아오면 원래 해상도 칸", () => {
  barWith("gpt_image_2_6", { output_format: "gif", resolution: "1k" });
  const locked = host.querySelector(".sl-chip-locked")!;
  expect(locked.textContent).toContain("288×288");
  expect(locked.tagName).toBe("SPAN"); // 단추가 아니라 눌러도 열리지 않는다
  expect(locked.getAttribute("aria-disabled")).toBe("true");
  expect([...host.querySelectorAll("button")].some((b) => b.textContent?.includes("1k"))).toBe(false); // 1k 칸은 없다
  barWith("gpt_image_2_6", { output_format: "png", resolution: "1k" });
  expect(host.querySelector(".sl-chip-locked")).toBeNull();
  expect([...host.querySelectorAll("button")].some((b) => b.textContent?.includes("1k"))).toBe(true);
  barWith("gpt_image_2_6_flare", { output_format: "gif", resolution: "2k" });
  expect(host.querySelector(".sl-chip-locked")!.textContent).toContain("288×288");
  barWith("gpt_image_2_5", { output_format: "gif", resolution: "2k" }); // 다른 모델은 건드리지 않는다
  expect(host.querySelector(".sl-chip-locked")).toBeNull();
});

it("이미지 목록은 넓히지 않는다(설명이 없는 줄)", () => {
  bar("image", "nano_banana_flash", IMAGE_MODELS);
  expect(host.querySelector(".sl-dropdown")!.classList.contains("sl-dd-wide")).toBe(false);
});

it("이미지 목록(ALLOWED): GPT 2.6·Flare·Seedream 5.5·Pro·Flash·Lite 가 들어 있고, 타일은 3계열", () => {
  expect(ALLOWED.image).toEqual(expect.arrayContaining(["gpt_image_2_6", "gpt_image_2_6_flare", "seedream_5_5", "seedream_v5_pro", "seedream_5_0_flash", "seedream_v5_lite"]));
  expect(ALLOWED.image[0]).toBe("nano_banana_flash"); // 기본 모델은 그대로
  expect(inferModelType("seedream_v5_pro")).toBe("image");
  expect(inferModelType("seedream_5_5")).toBe("image");
  bar("image", "seedream_5_5", ALLOWED.image.map((code) => m(code, MODEL_DISPLAY_NAMES[code] ?? code)));
  expect(tabs().map((t) => t.getAttribute("aria-label"))).toEqual(["Nano Banana", "GPT Image", "Seedream"]);
  expect(tabs()[2].classList.contains("on")).toBe(true); // 고른 모델의 계열
  expect(rowNames()).toEqual(["Seedream 5.5", "Seedream 5.0 Pro", "Seedream 5.0 Flash", "Seedream 5.0 Lite"]);
  act(() => tabs()[1].click());
  expect(rowNames()).toEqual(["GPT Image 2.6", "GPT Image 2.6 Flare", "GPT Image 2.5", "GPT Image 2"]);
});

it("이미지: 고른 모델이 GPT 계열이면 GPT 타일이 먼저 열린다", () => {
  bar("image", "gpt_image_2", IMAGE_MODELS);
  expect(tabs()[1].classList.contains("on")).toBe(true);
  expect(rowNames()).toEqual(["GPT Image 2.5", "GPT Image 2"]);
});

it("영상: 계열이 하나(Seedance)면 타일 없이 줄 아이콘만, 모델 목록은 그대로", () => {
  const video = [m("seedance_2_5", "Seedance 2.5"), m("seedance_2_0", "Seedance 2.0"), m("seedance_2_0_mini", "Seedance 2.0 Mini")];
  bar("video", "seedance_2_5", video);
  expect(tabs()).toHaveLength(0);
  expect(host.querySelectorAll(".sl-dropdown .sl-dd-item.has-ic svg.sl-fam-ic").length).toBe(rowNames().length);
  expect(rowNames()).toContain("Seedance 2.5");
  expect(rowNames()).toContain("Seedance 2.0 Mini");
});

it("영상 목록(ALLOWED): Jay 가 고른 7개가 들어 있고 타일은 5계열, 계열마다 그 모델만 보인다", () => {
  const added = ["kling4_0", "kling_4_0_flash", "gemini_omni_flash_1_2", "wan3_0", "wan3_0_prime", "minimax_h3", "minimax_h3_max"];
  expect(ALLOWED.video).toEqual(expect.arrayContaining(added));
  expect(ALLOWED.video.slice(0, 3)).toEqual(["seedance_2_5", "seedance_2_0", "seedance_2_0_mini"]); // 기본 모델은 그대로
  for (const code of added) expect(inferModelType(code)).toBe("video");
  bar("video", "seedance_2_5", ALLOWED.video.map((code) => m(code, MODEL_DISPLAY_NAMES[code] ?? code)));
  expect(tabs().map((t) => t.getAttribute("aria-label"))).toEqual(["Seedance", "Kling", "Gemini Omni", "Wan", "MiniMax"]);
  expect(rowNames()).toEqual(["Seedance 2.5", "Seedance 2.0", "Seedance 2.0 Fast", "Seedance 2.0 Mini"]); // 2.0 은 Fast 변형 줄이 따로
  const rowsOf = (i: number) => { act(() => tabs()[i].click()); return rowNames(); };
  expect(rowsOf(1)).toEqual(["Kling 4.0", "Kling 4.0 Flash"]);
  expect(rowsOf(2)).toEqual(["Gemini Omni Flash 1.2"]);
  expect(rowsOf(3)).toEqual(["Wan 3.0", "Wan 3.0 Prime"]);
  expect(rowsOf(4)).toEqual(["MiniMax H3", "MiniMax H3 Max"]);
});

it("계열을 모르는 모델이 섞이면 기존 평평한 목록(타일·아이콘 없음)", () => {
  bar("image", "nano_banana_flash", [...IMAGE_MODELS, m("some_new_model", "Some New")]);
  expect(tabs()).toHaveLength(0);
  expect(rowNames()).toHaveLength(7);
});

it("오디오: 모델 코드로 Seed·ElevenLabs·Qwen 계열, Text to Speech 는 엔진(variant)마다 ElevenLabs·MiniMax·Seed 로 가른다", () => {
  expect(modelFamily("seed_audio")).toBe("seed");
  expect(modelFamily("elevenlabs_v4_turbo")).toBe("eleven");
  expect(modelFamily("qwen_audio_tts")).toBe("qwen");
  expect(modelFamily("text2speech_v2")).toBeNull(); // 모델 코드 하나라 줄(엔진)로만 가를 수 있다
  expect(rowFamily("text2speech_v2", "elevenlabs")).toBe("eleven");
  expect(rowFamily("text2speech_v2", "minimax")).toBe("minimax");
  expect(rowFamily("text2speech_v2", "seed_speech")).toBe("seed");
  expect(rowFamily("text2speech_v2", "cozy_voice")).toBeNull(); // 옛 엔진은 아이콘 없음
  expect(rowFamily("elevenlabs_v4")).toBe("eleven");
});

it("오디오 목록: 타일 4개(Seed·ElevenLabs·Qwen·MiniMax), 고른 엔진의 계열이 먼저, 계열마다 그 줄만 보인다", () => {
  const audio = ALLOWED.audio.map((code) => ({ job_set_type: code, display_name: MODEL_DISPLAY_NAMES[code] ?? "Text to Speech V2", type: "audio" }));
  bar("audio", "seed_audio", audio);
  expect(tabs().map((t) => t.getAttribute("aria-label"))).toEqual(["Seed", "ElevenLabs", "Qwen", "MiniMax"]);
  expect(tabs()[0].classList.contains("on")).toBe(true); // 고른 Seed Audio 의 계열
  expect(rowNames()).toEqual(["Seed Audio 1.0", "Seed Speech"]);
  expect(host.querySelectorAll(".sl-dropdown .sl-dd-item.has-ic svg.sl-fam-ic")).toHaveLength(2);
  expect(host.querySelectorAll(".sl-dropdown .sl-model-description")).toHaveLength(2); // 설명 글은 그대로
  expect(host.querySelector(".sl-dropdown")!.classList.contains("sl-dd-wide")).toBe(true); // 오디오 목록은 넓혀 설명이 한 줄에(A안)
  expect(host.querySelectorAll(".sl-dropdown .sl-dd-item .sl-dd-text > small")).toHaveLength(2); // 설명은 이름 아래
  const rowsOf = (i: number) => { act(() => tabs()[i].click()); return rowNames(); };
  expect(rowsOf(1)).toEqual(["ElevenLabs v4", "ElevenLabs v4 Turbo", "ElevenLabs v3"]);
  expect(rowsOf(2)).toEqual(["Qwen Audio 3.0 TTS"]);
  expect(rowsOf(3)).toEqual(["MiniMax Speech 2.8 HD"]);
  expect(host.querySelector(".sl-chip svg.sl-chip-ic")).not.toBeNull(); // 칩에도 고른 모델의 아이콘
});
