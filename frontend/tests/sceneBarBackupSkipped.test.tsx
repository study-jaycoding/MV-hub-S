// @vitest-environment jsdom
// Jay 결정 7A(10-15) — DB 백업에서 빠진 씬(5MB 초과)은 탭 이름 뒤에 호박색 '백업 안 됨'이 계속 보인다(전엔 2.5초 알림뿐이라
//  알림을 놓치면 탭으로는 알 수 없었다). 이 표시 때문에 이름이 잘리면 '⚠' 하나만 — 한 번 줄이면 그 이름 동안 그대로(깜빡이지 않게).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { SceneBar } from "../src/components/scene/SceneBar";
import type { Scene } from "../src/lib/scenes";

const scene = (id: string, name: string): Scene => ({ id, name, cards: [], edges: [], created_at: 0 });

let host: HTMLDivElement;
let root: Root;
let truncated = false; // 탭 이름 칸이 잘렸는가 — jsdom 은 배치를 안 하므로 이름 칸의 폭만 흉내 낸다
const real = {
  scroll: Object.getOwnPropertyDescriptor(Element.prototype, "scrollWidth")!,
  client: Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")!,
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(Element.prototype, "scrollWidth", {
    configurable: true,
    get() { return this.classList?.contains("scene-tab-name") && truncated ? 120 : 80; },
  });
  Object.defineProperty(Element.prototype, "clientWidth", { configurable: true, get: () => 80 });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  Object.defineProperty(Element.prototype, "scrollWidth", real.scroll);
  Object.defineProperty(Element.prototype, "clientWidth", real.client);
  truncated = false;
  vi.unstubAllGlobals();
});

function render(scenes: Scene[], skipped: ReadonlySet<string>) {
  act(() => {
    root.render(
      <SceneBar
        scenes={scenes}
        activeId={scenes[0]?.id ?? null}
        workspaceContext={{ scope: "personal", id: null, name: null }}
        onSelect={vi.fn()}
        onAdd={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onReorder={vi.fn()}
        onAssignWorkspace={vi.fn()}
        backupSkippedIds={skipped}
      />,
    );
  });
  return [...host.querySelectorAll<HTMLElement>(".scene-tab")].map((tab) => tab.querySelector(".scene-tab-backup")?.textContent ?? null);
}

it("빠진 씬의 탭에만 '백업 안 됨' — 마우스를 올리면 까닭과 할 일", () => {
  expect(render([scene("a", "오프닝"), scene("big", "e035 콘티")], new Set(["big"]))).toEqual([null, "백업 안 됨"]);
  expect(host.querySelector(".scene-tab-backup")!.getAttribute("title")).toContain("[전체 내보내기]");
  expect(render([scene("a", "오프닝"), scene("big", "e035 콘티")], new Set())).toEqual([null, null]); // 풀리면 사라진다
});

it("이 표시 때문에 이름이 잘리면 '⚠' 하나만 — 이름이 다시 들어가도 늘리지 않고, 이름이 바뀌면 다시 잰다", () => {
  truncated = true;
  expect(render([scene("big", "e035 콘티 아주 긴")], new Set(["big"]))).toEqual(["⚠"]);
  truncated = false; // ⚠ 로 줄이자 이름이 다 들어갔다
  expect(render([scene("big", "e035 콘티 아주 긴")], new Set(["big"]))).toEqual(["⚠"]);
  expect(render([scene("big", "짧게")], new Set(["big"]))).toEqual(["백업 안 됨"]);
});
