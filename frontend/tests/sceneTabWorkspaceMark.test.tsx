// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SceneBar } from "../src/components/scene/SceneBar";
import { workspaceMarkHue } from "../src/components/common/WorkspaceMark";
import type { Scene } from "../src/lib/scenes";
import type { WorkspaceContext } from "../src/types";

// 씬 탭은 지정된 워크스페이스를 **표식(첫 글자 색 사각형)** 으로 보여 준다(Jay 2026-09-14).
//
// ★예전에는 라임 점 하나였다. 점은 '지정됨' 만 말할 뿐 **어느 공간인지**는 못 알려 줘서,
//  탭이 여러 개면 마우스를 올려 title 을 읽어야 했다. 표식은 메뉴·툴바에서 쓰는 것과 같아
//  화면 어디서 보든 같은 공간이 같은 글자·같은 색으로 보인다.

const personal: WorkspaceContext = { scope: "personal", id: null, name: null };

const scene = (id: string, workspace?: { id: string; name: string }): Scene =>
  ({ id, name: id, cards: [], edges: [], created_at: 0, ...(workspace ? { workspace } : {}) }) as Scene;

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

const markIn = (tab: HTMLElement) => tab.querySelector<HTMLElement>(".ws-mark-box");

describe("씬 탭의 워크스페이스 표식", () => {
  it("지정된 공간의 첫 글자를 보여 준다", () => {
    const [tab] = render([scene("s1", { id: "ws-1", name: "뻘뻘뻘" })]);
    expect(markIn(tab)!.textContent).toBe("뻘");
  });

  it("지정이 없으면 표식도 없다", () => {
    const [tab] = render([scene("s1")]);
    expect(markIn(tab)).toBeNull();
  });

  it("같은 공간은 어디서 보든 같은 색, 다른 공간은 다른 색", () => {
    // 색은 id 해시라 목록 순서나 이름이 바뀌어도 흔들리지 않는다.
    const tabs = render([
      scene("s1", { id: "ws-1", name: "뻘뻘뻘" }),
      scene("s2", { id: "ws-1", name: "뻘뻘뻘" }),
      scene("s3", { id: "ws-2", name: "R&D" }),
    ]);
    const hue = (tab: HTMLElement) => markIn(tab)!.style.getPropertyValue("--ws-h");
    expect(hue(tabs[0])).toBe(hue(tabs[1]));
    expect(hue(tabs[0])).not.toBe(hue(tabs[2]));
    expect(hue(tabs[0])).toBe(String(workspaceMarkHue("ws-1")));
  });

  it("한 글자만 다른 id 도 눈에 띄게 다른 색이 된다", () => {
    // 360 으로 바로 나머지를 내면 ws-1→208, ws-2→209 처럼 **바로 옆 색**이 나와 구분이 안 된다.
    const apart = (a: string, b: string) => {
      const d = Math.abs(workspaceMarkHue(a) - workspaceMarkHue(b));
      return Math.min(d, 360 - d); // 색상환은 원형이라 양쪽으로 잰다
    };
    expect(apart("ws-1", "ws-2")).toBeGreaterThan(25);
    expect(apart("ws-2", "ws-3")).toBeGreaterThan(25);
    expect(apart("ws-1", "ws-3")).toBeGreaterThan(25);
  });

  it("탭이 작아지도록 한 치수 작은 변형을 쓴다", () => {
    // 18px 표식을 그대로 쓰면 탭 줄이 두꺼워져 씬 바 전체가 내려앉는다.
    const [tab] = render([scene("s1", { id: "ws-1", name: "뻘뻘뻘" })]);
    expect(markIn(tab)!.className).toContain("sm");
  });
});
