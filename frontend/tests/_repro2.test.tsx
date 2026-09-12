// @vitest-environment jsdom
// ★재현 2차 — 코덱스 단서: "65초 넘게 기다린 뒤 열기 = 정상 / 취소 후 즉시 재개방 = 깨짐".
//  65초는 모델 목록 캐시 TTL(60초)과 맞는다. 즉 **캐시 적중**일 때 깨진다.
//  1차 재현이 실패한 이유: 시험마다 `vi.resetModules()` 를 해서 캐시가 늘 비어 있었다.
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CATALOG = [
  { display_name: "Nano Banana 2", job_set_type: "nano_banana_flash", type: "image" },
  { display_name: "Seedance 2.5", job_set_type: "seedance_2_5", type: "video" },
  { display_name: "Seedance 2.0 Mini", job_set_type: "seedance_2_0_mini", type: "video" },
];

vi.mock("../src/api", () => ({
  api: {
    models: () => Promise.resolve(CATALOG),
    modelParams: () => Promise.resolve({ params: [], constraints: {} }),
    estimateCost: () => Promise.resolve({ credits: 1 }),
  },
}));
vi.mock("../src/lib/modelPolicy", () => ({
  useModelPolicy: () => ({ status: "ready", ready: true, allowed: new Set<string>(), key: "k" }),
}));

// ★모듈은 **한 번만** 들인다 — 캐시를 시험 사이에 살려 둔다(그게 이 재현의 핵심).
const { SceneModelModal } = await import("../src/components/scene/SceneModelModal");

let container: HTMLDivElement;
let root: Root;

async function settle(times = 8) {
  await act(async () => {
    for (let i = 0; i < times; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

function shown() {
  return (container.querySelector(".sl-chip-label")?.textContent || "").trim();
}

const CARD = { type: "video", model: "seedance_2_0_mini", params: { resolution: "480p" } };

function open(strict = false) {
  const node = <SceneModelModal initial={CARD as never} onSave={() => {}} onClose={() => {}} />;
  act(() => root.render(strict ? <StrictMode>{node}</StrictMode> : node));
}

function close() {
  act(() => root.render(<div />));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("캐시 적중 재개방", () => {
  it("1) 첫 열기(캐시 없음)", async () => {
    open();
    await settle();
    expect(shown()).toBe("Seedance 2.0 Mini");
  });

  it("2) ★취소 후 즉시 재개방(캐시 적중)", async () => {
    open();
    await settle();
    close();
    await settle(2);
    open();          // 이번엔 캐시 적중 — 카탈로그가 **훨씬 빨리** 온다
    await settle();
    expect(shown()).toBe("Seedance 2.0 Mini");
  });

  it("3) StrictMode 로 재개방", async () => {
    open(true);
    await settle();
    close();
    await settle(2);
    open(true);
    await settle();
    expect(shown()).toBe("Seedance 2.0 Mini");
  });

  it("4) 캐시 적중 + 마운트 직후(응답 정착 전) 상태", async () => {
    open();
    await settle();
    close();
    await settle(2);
    open();
    await settle(1); // 거의 안 기다림
    const early = shown();
    await settle();
    expect({ early, late: shown() }).toEqual({
      early: "Seedance 2.0 Mini",
      late: "Seedance 2.0 Mini",
    });
  });
});
