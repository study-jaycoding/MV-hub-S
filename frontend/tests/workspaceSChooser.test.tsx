// @vitest-environment jsdom
// 워크스페이스·캔버스 S 선택 창(Jay 2026-10-30) — 창의 자리, 항목 규칙(lib/generationReview), 캔버스 쪽 처리(useSceneCardLibraryActions).
//  카드 화면 흐름은 tests/generationReviewUI.test.tsx, 노드 창은 tests/generationConfirm.test.tsx. 기록 = docs/status/S_선택창_떠있는창_2026-10-30.md
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pickerPosition } from "../src/components/generation/ReviewPicker";
import { canOpenWorkspaceReview, workspaceReviewAllowed, workspaceReviewOptions, type ReviewAction } from "../src/lib/generationReview";
import { useSceneCardLibraryActions } from "../src/lib/useSceneCardLibraryActions";
import type { Generation } from "../src/types";

const gen = (over: Partial<Generation> = {}) => ({ id: "g", shared: false, is_mine: true, is_final: false, is_held: false, ...over }) as Generation;

it.each([
  ["일반", {}, ["shared", "unshared"]],
  ["쉐어", { shared: true }, ["final", "unshared"]],
  ["보류", { shared: true, is_held: true }, ["final", "unshared"]],
  ["최종", { shared: true, is_final: true }, ["shared", "unshared"]],
] as const)("%s 카드의 항목과 순서", (_name, over, options) => {
  expect(workspaceReviewOptions(gen(over))).toEqual(options);
});

it("창을 여는 카드 = 바꿀 수 있는 카드", () => {
  expect(canOpenWorkspaceReview(gen(), false)).toBe(true); // 내 일반 카드
  expect(canOpenWorkspaceReview(gen({ is_mine: false }), true)).toBe(false); // 남의 비공유
  expect(canOpenWorkspaceReview(gen({ is_mine: false, shared: true }), false)).toBe(false); // 남의 공유 · 권한 없음
  expect(canOpenWorkspaceReview(gen({ is_mine: false, shared: true }), true)).toBe(true); // 남의 공유 · 슈퍼바이저
  expect(canOpenWorkspaceReview(gen({ shared: true, is_final: true }), false)).toBe(false); // 내 최종 · 권한 없음
  expect(canOpenWorkspaceReview(gen({ shared: true, is_final: true }), true)).toBe(true);
  expect(workspaceReviewAllowed(false).final).toBe(false);
  expect(workspaceReviewAllowed(true).final).toBe(true);
});

it("창의 자리: S 오른쪽 · 첫 칸 가운데 = S 가운데 · 오른쪽이 모자라면 S 왼쪽 · 화면 아래로 넘치면 위로", () => {
  const s = { left: 100, right: 126, top: 200, height: 26 }; // 가운데 213
  expect(pickerPosition(s, 78, 88, 1000, 800)).toEqual({ left: 132, top: 192 }); // 첫 칸 높이 42 → 위 192
  expect(pickerPosition({ ...s, height: 22 }, 78, 88, 1000, 800).top).toBe(190); // 작은 카드의 S(22)도 가운데가 맞는다
  expect(pickerPosition({ ...s, left: 920, right: 946 }, 78, 88, 1000, 800).left).toBe(836); // 왼쪽으로
  expect(pickerPosition({ ...s, top: 760 }, 78, 134, 1000, 800).top).toBe(662); // 아래 여백 4 를 남기고 위로
  expect(pickerPosition({ ...s, top: 2 }, 78, 88, 1000, 800).top).toBe(4); // 위로도 화면 안
  expect(pickerPosition({ ...s, left: 30, right: 56 }, 78, 88, 100, 800).left).toBe(4); // 양쪽 다 모자라면 화면 안
});

it("창은 항목 수대로 칸을 나누고, 좁은 칸은 글자만 남긴다", () => {
  const css = readFileSync(new NodeURL("../src/styles/generations.css", import.meta.url), "utf8");
  expect(css).toMatch(/\.review-options \{[^}]*grid-auto-rows: minmax\(30px, 1fr\)/);
  expect(css).not.toMatch(/\.review-options \{[^}]*repeat\(3/);
  const narrow = css.slice(css.indexOf("@container (max-width: 71px)"));
  expect(narrow).toMatch(/\.review-option-icon \{ display: none; \}/);
  expect(narrow).toMatch(/\.review-confirm \.cs-final-actions button \{ min-width: 0; padding: 0; \}/);
});

describe_canvas();

function describe_canvas() {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

  const setup = (start: Generation, canFinalize = () => true) => {
    const spies = { onPublish: vi.fn(), onUnpublish: vi.fn(), onFinalize: vi.fn(), onUnfinalize: vi.fn(), onReview: vi.fn() };
    const refresh = vi.fn();
    let actions!: ReturnType<typeof useSceneCardLibraryActions>;
    let data!: Record<string, Generation>;
    function Harness() {
      const [genData, setGenData] = useState<Record<string, Generation>>({ [start.id]: start });
      data = genData;
      actions = useSceneCardLibraryActions({ cardsRef: { current: [] }, selectedRef: { current: new Set() }, genDataRef: { current: genData },
        setGenData, refreshGenerationAfter: refresh, variantTargetIds: () => [], canFinalize, ...spies } as never);
      return null;
    }
    act(() => root.render(<Harness />));
    return { spies, refresh, actions: () => actions, data: () => data[start.id] };
  };

  it.each([
    ["일반 → 공유", gen(), "shared", "onPublish", { shared: true }],
    ["쉐어 → 해제", gen({ shared: true, is_held: true }), "unshared", "onUnpublish", { shared: false, is_held: false }],
    ["쉐어 → 최종", gen({ shared: true, is_held: true }), "final", "onFinalize", { is_final: true, shared: true, is_held: false }],
    ["공유 행 없는 옛 최종 → 공유", gen({ shared: false, is_final: true }), "shared", "onUnfinalize", { is_final: false, is_held: false }],
  ] as const)("캔버스 %s: 먼저 뒤집어 보이고 쓰던 처리가 끝나면 다시 맞춘다", (_name, start, action, handler, expected) => {
    const { spies, refresh, actions, data } = setup(start);
    act(() => actions().onNodeSClick(start));
    expect(actions().sConfirm).toEqual({ id: "g" });
    act(() => actions().onNodeSConfirmYes(start, action as ReviewAction));
    expect(actions().sConfirm).toBeNull();
    expect(spies[handler]).toHaveBeenCalledExactlyOnceWith(start);
    expect(data()).toMatchObject(expected);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("캔버스 최종 → 공유도 한 번의 전환이다 — 공유로 보이고 보류로 돌아가지 않는다", () => {
    const start = gen({ shared: true, is_final: true });
    const { spies, refresh, actions, data } = setup(start);
    act(() => actions().onNodeSConfirmYes(start, "shared"));
    expect(spies.onReview).toHaveBeenCalledExactlyOnceWith(start, "shared");
    expect(spies.onUnfinalize).not.toHaveBeenCalled();
    expect(data()).toMatchObject({ shared: true, is_final: false, is_held: false });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("캔버스 최종 → 해제는 한 번의 전환이다", () => {
    const start = gen({ shared: true, is_final: true });
    const { spies, refresh, actions, data } = setup(start);
    act(() => actions().onNodeSConfirmYes(start, "unshared"));
    expect(spies.onReview).toHaveBeenCalledExactlyOnceWith(start, "unshared");
    expect(spies.onUnfinalize).not.toHaveBeenCalled(); expect(spies.onUnpublish).not.toHaveBeenCalled();
    expect(data()).toMatchObject({ shared: false, is_final: false, is_held: false });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("캔버스: 열린 창은 S 를 다시 누르면 닫힌다", () => {
    const start = gen();
    const { actions } = setup(start);
    act(() => actions().onNodeSClick(start));
    expect(actions().sConfirm).toEqual({ id: "g" });
    act(() => actions().onNodeSClick(start));
    expect(actions().sConfirm).toBeNull();
  });

  it("캔버스: 바꿀 수 없는 카드는 눌러도 창이 안 뜬다", () => {
    const start = gen({ is_mine: false, shared: true });
    const { actions } = setup(start, () => false);
    act(() => actions().onNodeSClick(start));
    expect(actions().sConfirm).toBeNull();
  });
}
