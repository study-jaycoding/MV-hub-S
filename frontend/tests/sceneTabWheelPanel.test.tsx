// @vitest-environment jsdom
// 씬 탭 휠 클릭 → 그 탭 밑에 씬 패널(Jay 2026-11-02, 전엔 탭 줄 호버). 기록: docs/status/캔버스_탭패널_휠클릭_2026-11-02.md
//  패널의 여닫기는 SceneBoard 를 그리는 tests/sceneRefServerStatus 에서 본다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { SceneBar } from "../src/components/scene/SceneBar";
import type { Scene } from "../src/lib/scenes";
import { sceneIoPanelLeft } from "../src/lib/sceneViewport";
import { sceneTabTitle } from "../src/lib/sceneWorkspace";
import type { WorkspaceContext } from "../src/types";

const scene = (id: string): Scene => ({ id, name: id, cards: [], edges: [], created_at: 0 });
const personal: WorkspaceContext = { scope: "personal", id: null, name: null };
const onWheelTab = vi.fn();
const onSelect = vi.fn();
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onWheelTab.mockClear();
  onSelect.mockClear();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  act(() => root.render(
    <SceneBar scenes={[scene("s1"), scene("s2")]} activeId="s1" workspaceContext={personal} onSelect={onSelect} onAdd={vi.fn()}
      onRename={vi.fn()} onDelete={vi.fn()} onReorder={vi.fn()} onAssignWorkspace={vi.fn()} onWheelTab={onWheelTab} />,
  ));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const tab = (index: number) => host.querySelectorAll<HTMLElement>(".scene-tab")[index];

it("탭 휠 클릭은 그 씬을 알린다 · 다른 단추의 보조 클릭은 아니다 · 휠 누름의 자동 스크롤은 막는다", () => {
  const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 1 });
  act(() => { tab(1).dispatchEvent(press); });
  expect(press.defaultPrevented).toBe(true);

  act(() => { tab(1).dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 2 })); });
  expect(onWheelTab).not.toHaveBeenCalled();
  act(() => { tab(1).dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 })); });
  expect(onWheelTab.mock.calls).toEqual([["s2"]]);
  expect(onSelect).not.toHaveBeenCalled(); // 씬 전환은 App 이 정한다
});

it("마우스를 올리는 것만으로는 아무 일도 없다", () => {
  act(() => { tab(0).dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
  expect(onWheelTab).not.toHaveBeenCalled();
});

it("탭마다 패널이 자리를 찾을 표식이 있고 설명 글에 휠 클릭 안내가 있다", () => {
  expect([...host.querySelectorAll<HTMLElement>("[data-scene-tab]")].map((element) => element.dataset.sceneTab)).toEqual(["s1", "s2"]);
  expect(sceneTabTitle(scene("s1"), personal, null, false)).toContain("휠 클릭 = Import·Export·레퍼런스 찾기");
});

it("패널 자리 — 탭 왼쪽에 맞추고, 넘치면 탭 오른쪽 끝에 맞추며, 보드 왼쪽 밖으로 나가지 않는다", () => {
  expect(sceneIoPanelLeft(100, 200, 800, 170)).toBe(100);
  expect(sceneIoPanelLeft(700, 790, 800, 170)).toBe(620); // 오른쪽 끝 탭
  expect(sceneIoPanelLeft(100, 120, 200, 170)).toBe(8); // 보드가 패널보다 좁아도 왼쪽 안
  expect(sceneIoPanelLeft(894, 1000, 800, 264)).toBe(528); // 창을 좁혀 탭이 보드 밖이어도 패널은 보드 안(재현값)
});
