// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SceneBar } from "../src/components/scene/SceneBar";
import type { Scene } from "../src/lib/scenes";
import type { WorkspaceContext } from "../src/types";

// 씬 탭은 **긴 이름을 12자에서 자른다**(Jay 2026-09-14).
//
// ★왜 폭(px)이 아니라 글자 수인가: 같은 max-width 190px 에 한글은 13자, 숫자는 22자가 들어간다
//  (실측 — 한글 12.0px/자, 숫자 6.9px/자). 그래서 `test111111111111111111…` 처럼 숫자 이름은
//  20자 넘게 그대로 보였다. CSS 로는 '12자'를 만들 수 없다.
//
// ★이 시험이 지키는 것은 **연결부**다. `shortSceneName` 자체의 경계·이모지는
//  `sceneWorkspace.test.ts` 가 본다. 여기서는 탭이 그 함수를 실제로 쓰는지, 그리고 자른 뒤에도
//  전체 이름을 title 로 볼 수 있는지를 본다 — 둘 중 하나만 빠져도 이름을 확인할 길이 사라진다.

const LONG = "test111111111111111111dfdfdfdsfdfdfdfd";
const SHORT = "base01";

const scene = (id: string, name: string): Scene => ({
  id,
  name,
  cards: [],
  edges: [],
  created_at: 0,
});

const personal: WorkspaceContext = { scope: "personal", id: null, name: null };

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** 탭의 **이름 부분** — 표식(워크스페이스 첫 글자)이 같은 버튼 안에 있어 textContent 로는 섞인다. */
const nameOf = (tab: HTMLElement) => tab.querySelector(".scene-tab-name")!.textContent;

function render(scenes: Scene[]) {
  act(() => {
    root.render(
      <SceneBar
        scenes={scenes}
        activeId={scenes[0]?.id ?? null}
        workspaceContext={personal}
        onSelect={vi.fn()}
        onAdd={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onReorder={vi.fn()}
        onAssignWorkspace={vi.fn()}
      />,
    );
  });
  return Array.from(host.querySelectorAll<HTMLElement>(".scene-tab"));
}

describe("씬 탭 — 긴 이름은 12자에서 자른다", () => {
  it("12자를 넘으면 잘라서 보여준다", () => {
    const [tab] = render([scene("s1", LONG)]);
    expect(nameOf(tab)).toBe("test11111111…");
    expect(nameOf(tab)).not.toContain("dfdf");
  });

  it("자른 뒤에도 전체 이름을 title 로 볼 수 있다", () => {
    const [tab] = render([scene("s1", LONG)]);
    expect(tab.title.split("\n")[0]).toBe(LONG);
  });

  it("짧은 이름은 그대로 둔다", () => {
    const [tab] = render([scene("s1", SHORT)]);
    expect(nameOf(tab)).toBe(SHORT);
  });
});
