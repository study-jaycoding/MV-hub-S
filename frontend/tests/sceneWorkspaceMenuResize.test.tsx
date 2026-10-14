// @vitest-environment jsdom
// 씬 탭 우클릭 메뉴 — 58회차(Codex): 세로 자리를 열 때만 재서, 연 채 창을 줄이면 아래 항목이 화면 밖에 남았다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/lib/workspaceOptionsCache", () => ({ cachedWorkspaceOptions: () => [], fetchWorkspaceOptions: () => new Promise(() => {}) }));

import { SceneWorkspaceMenu } from "../src/components/scene/SceneWorkspaceMenu";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.assign(window, { innerWidth: 1200, innerHeight: 1000 });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("scene-ws-menu") ? 300 : 0;
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("연 채 창 높이가 줄면 자리를 다시 잡는다 — 아래 항목이 화면 밖에 남지 않는다", () => {
  act(() => root.render(<SceneWorkspaceMenu target={{ sceneId: "s1", sceneName: "씬", current: undefined, x: 40, y: 500 }}
    onAssign={() => {}} onRename={() => {}} onClose={() => {}} />));
  const menu = () => host.querySelector<HTMLElement>(".scene-ws-menu")!;
  expect(menu().style.top).toBe("500px"); // 아래로 들어간다(500 + 300 ≤ 992)
  act(() => { Object.assign(window, { innerHeight: 600 }); window.dispatchEvent(new Event("resize")); });
  expect(menu().style.top).toBe("200px"); // 누른 자리 위로 연다(500 − 300) — 전엔 500 그대로라 아래 200px 이 화면 밖이었다
});
