// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 씬의 모델 노드를 열면 **저장된 모델 그대로** 떠야 한다.
//
// ★왜(2026-09-13, 코덱스가 실제 Chrome 조작으로 재현): 영상 레시피의 모델 카드를 더블클릭하면
//  `Image / Nano Banana 2 / 1:1 / 1k` 로 열렸다. 저장된 모델은 `seedance_2_0_mini`(영상)였다.
//
// ★기전: 레시피(`recipeScene.ts:98`)가 `type` 을 안 넣는다 → 모달이 훅의 기본 타입(image)을
//  그대로 둔다 → 자동 선택(`useModels.ts:387`)이 "이 타입의 모델이 아니다" 라며 **첫 이미지
//  모델로 갈아치운다**. 그 상태로 **저장 버튼이 눌렸다** — 누르면 영상 모델이 사라진다.
//
// ★고친 곳은 **복원 지점뿐**이다. 공용 자동 선택 effect 를 건드리면 사용자가 탭을 눌러
//  타입을 바꾸는 것까지 되돌아간다(코덱스 반례) — 아래 '반대 탭' 시험이 그것을 지킨다.
//
// ★시험마다 `vi.resetModules()` 로 모듈을 새로 들인다 — `paramsCache`·`costCache` 와
//  모델 목록 캐시가 **모듈 전역**이라, 안 그러면 앞 시험의 성공 응답이 남아 실패 시험이 헛돈다
//  (처음에 그래서 7건이 가짜로 깨졌다).
//
// ★`save()` 안의 가드는 **시험으로 관측할 수 없다.** React 는 버튼의 `disabled` 를 DOM 속성이
//  아니라 fiber props 로 판단해, DOM 에서 벗겨도 클릭이 핸들러에 닿지 않는다. 그래서 그 줄은
//  '지금은 없는 다른 호출 경로' 를 위한 이중 방어이고, 되돌려 확인으로 검출되지 않는다 —
//  검출됐다고 적지 않는다.

const modelParams = vi.fn();

vi.mock("../src/api", () => ({
  api: {
    models: () =>
      Promise.resolve([
        { display_name: "Nano Banana 2", job_set_type: "nano_banana_flash", type: "image" },
        { display_name: "Seedance 2.0 Mini", job_set_type: "seedance_2_0_mini", type: "video" },
        { display_name: "Seedance 2.5", job_set_type: "seedance_2_5", type: "video" },
      ]),
    modelParams: (...args: unknown[]) => modelParams(...args),
    estimateCost: () => Promise.resolve({ credits: 1 }),
  },
}));
vi.mock("../src/lib/modelPolicy", () => ({
  useModelPolicy: () => ({ status: "ready", ready: true, allowed: new Set<string>(), key: "k" }),
}));

let container: HTMLDivElement;
let root: Root;
let saved: Record<string, unknown>[] = [];

/** 모듈을 새로 들여 모달을 띄운다(모듈 전역 캐시를 비우기 위해). */
async function mount(initial: Record<string, unknown> | undefined) {
  vi.resetModules();
  const { SceneModelModal } = await import("../src/components/scene/SceneModelModal");
  act(() => {
    root.render(
      <SceneModelModal
        initial={initial as never}
        onSave={(cfg) => saved.push(cfg as Record<string, unknown>)}
        onClose={() => {}}
      />,
    );
  });
  await settle();
}

/** 대기 중인 약속·타이머를 흘려보낸다(카탈로그·파라미터 응답). */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** 지금 고른 모델의 표시명 — 마크업은 `.sl-chip-label`. */
function shownModel(): string {
  return (container.querySelector(".sl-chip-label")?.textContent || "").trim();
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (b) => (b.textContent || "").trim() === label,
  );
  if (!found) {
    const all = [...container.querySelectorAll("button")].map((b) => (b.textContent || "").trim());
    throw new Error(`'${label}' 버튼을 못 찾았다: ${all.join(" | ")}`);
  }
  return found as HTMLButtonElement;
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  saved = [];
  modelParams.mockReset();
  modelParams.mockResolvedValue({ params: [], constraints: {} });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("모델 키로 타입을 판정한다", () => {
  it("한쪽 목록에만 있을 때만 확정한다", async () => {
    const { inferModelType } = await import("../src/lib/useModels");
    expect(inferModelType("seedance_2_0_mini")).toBe("video");
    expect(inferModelType("nano_banana_flash")).toBe("image");
    expect(inferModelType("seedream_v5_pro")).toBeUndefined(); // 양쪽에 없음(옛/특수 키)
    expect(inferModelType("")).toBeUndefined();
    expect(inferModelType(null)).toBeUndefined();
    expect(inferModelType(undefined)).toBeUndefined();
  });
});

describe("씬 모델 노드 복원", () => {
  it("★type 이 없어도 영상 모델이 그대로 열린다", async () => {
    // 레시피가 만든 카드에는 `type` 이 없다 — 그게 이 버그의 출발점이었다.
    await mount({ model: "seedance_2_0_mini", modelName: "seedance_2_0_mini", params: { duration: 4 } });
    expect(shownModel()).toBe("Seedance 2.0 Mini");
  });

  it("★저장된 type 이 틀려도 모델을 믿는다", async () => {
    await mount({ type: "image", model: "seedance_2_0_mini", params: {} });
    expect(shownModel()).toBe("Seedance 2.0 Mini");
  });

  it("정상 이미지 설정은 그대로 유지된다", async () => {
    await mount({ type: "image", model: "nano_banana_flash", params: {} });
    expect(shownModel()).toBe("Nano Banana 2");
  });

  it("양쪽 목록에 없는 옛 키는 저장된 type 을 쓴다", async () => {
    await mount({ type: "video", model: "seedance_legacy_key", params: {} });
    // 목록 밖 명시 모델은 자동 선택이 건드리지 않는다(기존 계약) — 그대로 남아야 한다
    expect(shownModel()).not.toBe("Nano Banana 2");
  });

  it("저장하면 복원된 모델과 타입이 그대로 나간다", async () => {
    await mount({ model: "seedance_2_0_mini", params: { duration: 4 } });
    click(button("저장"));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ type: "video", model: "seedance_2_0_mini" });
  });

  it("★복원한 **뒤** 사용자가 반대 탭을 누르면 그 선택이 유지된다", async () => {
    // ★이 시험이 이 파일의 필수 반례다(코덱스). 자동 선택 effect 에 타입 보정을 넣었다면
    //  여기서 탭이 되돌아가 사용자가 타입을 못 바꾼다.
    await mount({ model: "seedance_2_0_mini", params: {} });
    expect(shownModel()).toBe("Seedance 2.0 Mini");
    click(button("Image"));
    await settle();
    expect(shownModel()).toBe("Nano Banana 2"); // 사용자가 누른 탭이 이겼다
  });
});

describe("파라미터 조회 실패", () => {
  it("★실패하면 저장을 막는다 — 빈 옵션이 기존 설정을 덮지 않게", async () => {
    modelParams.mockRejectedValue(new Error("502"));
    await mount({ model: "seedance_2_0_mini", params: { duration: 4 } });
    expect(button("저장").disabled).toBe(true);
  });

  it("실패하면 안내가 보인다", async () => {
    modelParams.mockRejectedValue(new Error("502"));
    await mount({ model: "seedance_2_0_mini", params: {} });
    expect(container.textContent).toContain("모델 설정을 불러오지 못했습니다");
  });

  it("실패해도 모델은 그대로 남는다 — 조용히 갈아치우지 않는다", async () => {
    modelParams.mockRejectedValue(new Error("502"));
    await mount({ model: "seedance_2_0_mini", params: {} });
    expect(shownModel()).toBe("Seedance 2.0 Mini");
  });

  it("정상적인 **빈 스키마**는 실패가 아니다 — 저장할 수 있어야 한다", async () => {
    modelParams.mockResolvedValue({ params: [], constraints: {} });
    await mount({ model: "seedance_2_0_mini", params: {} });
    expect(button("저장").disabled).toBe(false);
    expect(container.textContent).not.toContain("모델 설정을 불러오지 못했습니다");
  });
});
