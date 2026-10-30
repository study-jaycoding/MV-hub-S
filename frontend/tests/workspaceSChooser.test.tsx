// @vitest-environment jsdom
// 워크스페이스·캔버스 S 선택 창(Jay 2026-10-30) — 항목 규칙(lib/generationReview)과 캔버스 쪽 처리(useSceneCardLibraryActions).
//  카드 화면 흐름은 tests/generationReviewUI.test.tsx, 노드 창은 tests/generationConfirm.test.tsx. 기록 = docs/status/워크스페이스_S_선택창_2026-10-30.md
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
    ["최종 → 공유", gen({ shared: true, is_final: true }), "shared", "onUnfinalize", { is_final: false, shared: true }],
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

  it("캔버스 최종 → 해제는 한 번의 전환이다", () => {
    const start = gen({ shared: true, is_final: true });
    const { spies, refresh, actions, data } = setup(start);
    act(() => actions().onNodeSConfirmYes(start, "unshared"));
    expect(spies.onReview).toHaveBeenCalledExactlyOnceWith(start, "unshared");
    expect(spies.onUnfinalize).not.toHaveBeenCalled(); expect(spies.onUnpublish).not.toHaveBeenCalled();
    expect(data()).toMatchObject({ shared: false, is_final: false, is_held: false });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("캔버스: 바꿀 수 없는 카드는 눌러도 창이 안 뜬다", () => {
    const start = gen({ is_mine: false, shared: true });
    const { actions } = setup(start, () => false);
    act(() => actions().onNodeSClick(start));
    expect(actions().sConfirm).toBeNull();
  });
}
