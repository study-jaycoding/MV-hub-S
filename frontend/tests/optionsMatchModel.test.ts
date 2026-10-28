// 오디오로 넘어갈 때 창이 튀던 것(Jay 2026-10-28): 탭을 바꾼 첫 그림·새 모델 옵션을 받는 동안 옛 모델 칩을 그리지 않는다.
import { expect, it } from "vitest";
import { optionsMatchModel } from "../src/lib/useModels";

it("옵션이 지금 모델 것이고 모델이 다른 탭 목록에 없을 때만 칩을 그린다", () => {
  expect(optionsMatchModel("video", "seedance_2_5", "seedance_2_5")).toBe(true);
  expect(optionsMatchModel("audio", "seedance_2_5", "seedance_2_5")).toBe(false); // Audio 를 누른 첫 그림 — 모델은 아직 Video 것
  expect(optionsMatchModel("audio", "seed_audio", "nano_banana_flash")).toBe(false); // 새 모델 옵션을 받는 중
  expect(optionsMatchModel("audio", "seed_audio", "seed_audio")).toBe(true);
  expect(optionsMatchModel("audio", "voice_change", "voice_change")).toBe(true); // 어느 목록에도 없는 Audio 의 일
});
