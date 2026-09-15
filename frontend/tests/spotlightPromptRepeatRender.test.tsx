// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { saveHistory } from "../src/lib/promptEditor";
import type { Generation } from "../src/types";
import {
  click,
  installPromptBoundaryMocks,
  mountPrompt,
  required,
  settle,
  type PromptProps,
} from "./seedanceRenderHarness";

// 실제 SpotlightPrompt의 바인딩 effect → Generate 클릭 → 제출 훅을 통과한다.
// 이 fixture는 App을 대체하므로 App의 그래프 수집이 아니라 컴포넌트 prop 배선을 검증한다.
// 생성·계정·모델 API는 기존 공통 시험 경계로 막고, 예상 밖 fetch는 실패시킨다.
let boundary: ReturnType<typeof installPromptBoundaryMocks>;
let view: Awaited<ReturnType<typeof mountPrompt>> | undefined;
const prompt = "@image1의 두 캐릭터가 파도를 본다.\n@image10의 배경을 유지한다.";

function binding(derived: boolean): NonNullable<PromptProps["trayBinding"]> {
  return {
    key: "repeat-scene:repeat-card",
    promptKey: "unchanged-connected-text",
    promptDerived: derived,
    prompt,
    refs: Array.from({ length: 10 }, (_, index) => ({
      file_path: `https://fixture.invalid/reference-${index}.png`,
      type: "image",
      name: `source-${index}`,
    })),
    modelKey: "repeat-seedance-model",
    model: {
      model: "seedance_2_5",
      type: "video",
      params: { mode: "omni_reference", duration: 30, resolution: "1080p", aspect_ratio: "16:9" },
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  boundary = installPromptBoundaryMocks();
  boundary.api.prepareCreate.mockImplementation((body) => async () => ({
    id: "fixture-generation",
    prompt: body.prompt,
    display_prompt: body.display_prompt || null,
    model: body.model,
    params: body.params,
    status: "pending",
    assets: [],
    references: [],
    tags: [],
    auto_tags: [],
  }) as Generation);
});

afterEach(() => {
  view?.dispose();
  view = undefined;
  expect(boundary.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("실제 SpotlightPrompt: Text 노드 바인딩의 반복 Generate", () => {
  it("바인딩 key가 그대로여도 두 번 클릭한 프롬프트·레퍼런스 10개가 동일하다", async () => {
    const originalBinding = binding(true);
    view = await mountPrompt({ trayBinding: originalBinding });
    expect(view.container.querySelectorAll(".sl-reftray-item")).toHaveLength(10);

    click(required(view.container, "button.sl-gen"));
    await settle();
    expect(boundary.api.prepareCreate).toHaveBeenCalledTimes(1);
    expect(required(view.container, '[contenteditable="true"]').textContent).toContain("두 캐릭터");

    // 결과 도착 등 부모의 일반 재렌더는 발생해도 연결·프롬프트 키는 달라지지 않는다.
    await view.render({ trayBinding: { ...originalBinding } });
    click(required(view.container, "button.sl-gen"));
    await settle();

    expect(boundary.api.prepareCreate).toHaveBeenCalledTimes(2);
    const first = boundary.api.prepareCreate.mock.calls[0][0];
    const second = boundary.api.prepareCreate.mock.calls[1][0];
    expect(first.prompt).toBe("<<<image1>>>의 두 캐릭터가 파도를 본다. <<<image10>>>의 배경을 유지한다.");
    expect(first.display_prompt).toBe(prompt);
    expect(first.references).toHaveLength(10);
    expect(first.params).toMatchObject({ duration: 30, resolution: "1080p", mode: "omni_reference" });
    expect(second).toEqual(first);
    expect(required(view.container, '[contenteditable="true"]').textContent).toContain("두 캐릭터");
  });

  it("파생 표시가 없으면 실제 컴포넌트도 기존 비우기 동작을 유지한다", async () => {
    view = await mountPrompt({ trayBinding: binding(false) });
    click(required(view.container, "button.sl-gen"));
    await settle();
    expect(boundary.api.prepareCreate).toHaveBeenCalledTimes(1);
    expect(required(view.container, '[contenteditable="true"]').textContent).toBe("");
  });

  it("파생 입력을 유지해도 제출 뒤 히스토리 탐색 위치는 초기화한다", async () => {
    saveHistory(["첫 기록", "둘째 기록", "셋째 기록"].map(text => ({ text, parts: [{ t: "text", v: text }] })));
    view = await mountPrompt({ trayBinding: binding(true) });
    const editor = required(view.container, '[contenteditable="true"]');
    const key = (value: string, shiftKey = false) => act(() => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true }));
    });
    key("Backspace", true);
    key("ArrowUp");
    key("ArrowUp");
    expect(editor.textContent).toBe("둘째 기록");
    click(required(view.container, "button.sl-gen"));
    await settle();
    expect(boundary.api.prepareCreate).toHaveBeenCalledTimes(1);
    expect(editor.textContent).toBe("둘째 기록");
    key("ArrowUp");
    expect(editor.textContent).toBe("둘째 기록");
  });
});
