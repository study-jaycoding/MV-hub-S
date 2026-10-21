// @vitest-environment jsdom
// Jay 2026-10-22 B안 — 씬 탭 × 는 브라우저 기본 확인창 대신 앱 확인창('MV Hub 종료'와 같은 모양). × 는 탭 닫기가 아니라 씬 삭제라
//  문구도 삭제로: 🗑 씬 삭제 · 이름 · 카드·연결이 사라진다는 안내 · [삭제](초점 — Enter = 삭제) [취소] · Esc = 취소.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { SceneBar } from "../src/components/scene/SceneBar";
import { backgroundKeysBlocked } from "../src/lib/keyGate";
import type { Scene } from "../src/lib/scenes";

const scene = (id: string, name: string): Scene => ({ id, name, cards: [], edges: [], created_at: 0 });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(scenes: Scene[], onDelete = vi.fn()) {
  act(() => {
    root.render(
      <SceneBar
        scenes={scenes}
        activeId={scenes[0]?.id ?? null}
        workspaceContext={{ scope: "personal", id: null, name: null }}
        onSelect={vi.fn()}
        onAdd={vi.fn()}
        onRename={vi.fn()}
        onDelete={onDelete}
        onReorder={vi.fn()}
        onAssignWorkspace={vi.fn()}
      />,
    );
  });
  return onDelete;
}

const dialog = () => document.body.querySelector<HTMLElement>('[role="alertdialog"][aria-label="씬 삭제"]');
const pressX = (index: number) => act(() => host.querySelectorAll<HTMLButtonElement>(".scene-del")[index].click());
const buttons = () => [...dialog()!.querySelectorAll<HTMLButtonElement>("button")];

it("× 는 브라우저 확인창 없이 앱 확인창 — 삭제 단추에 초점(Enter = 삭제), 누르면 그 씬만 한 번 지운다", () => {
  const confirm = vi.spyOn(window, "confirm");
  const onDelete = mount([scene("a", "오프닝"), scene("b", "씬 7")]);
  pressX(1);
  expect(confirm).not.toHaveBeenCalled();
  expect(dialog()?.querySelector(".admin-title")?.textContent).toBe("🗑 씬 삭제");
  expect(dialog()?.querySelector(".host-exit-text")?.textContent).toBe("'씬 7' 씬을 삭제할까요?이 씬의 카드·연결이 모두 사라집니다.");
  const [yes, no] = buttons();
  expect([yes.textContent, no.textContent]).toEqual(["삭제", "취소"]);
  expect(yes.classList.contains("danger")).toBe(true);
  expect(document.activeElement).toBe(yes);
  expect(backgroundKeysBlocked()).toBe(true); // 떠 있는 동안 캔버스의 Delete·Enter 등은 쉰다
  act(() => yes.click());
  expect(onDelete).toHaveBeenCalledExactlyOnceWith("b");
  expect(dialog()).toBeNull();
  expect(backgroundKeysBlocked()).toBe(false);
});

it("Esc·취소는 지우지 않고 닫는다", () => {
  const onDelete = mount([scene("a", "오프닝")]);
  pressX(0);
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  expect(dialog()).toBeNull();
  pressX(0);
  act(() => buttons()[1].click());
  expect(dialog()).toBeNull();
  expect(onDelete).not.toHaveBeenCalled();
});

it("떠 있는 동안 그 씬이 다른 창에서 지워지면 확인창도 닫힌다 — 남은 씬을 대신 지우지 않는다", () => {
  const onDelete = mount([scene("a", "오프닝"), scene("b", "씬 7")]);
  pressX(1);
  mount([scene("a", "오프닝")], onDelete);
  expect(dialog()).toBeNull();
  expect(onDelete).not.toHaveBeenCalled();
});
