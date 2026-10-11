// @vitest-environment jsdom
// 길게 누른 키(auto-repeat) — 한 번만 일어나야 하는 키(토글·열기/닫기)는 반복 keydown 에 다시 하지 않는다(조작 규칙 38).
// 2026-10-12(조작 점검 11회차, Codex 검토): 색·비활성·고르기·재생/정지·도크 여닫기가 반복마다 뒤집혀, 키를 조금 길게 누르면
//  '안 먹은' 것처럼 보이거나(짝수 번) 놓는 순간에 따라 결과가 달라졌다. 기본 동작은 반복에도 막는다(Space 의 스크롤·Ctrl+K 의 브라우저 검색).
// 격자·재생 창의 같은 시험은 각 화면의 시험 파일에 있다(gridLooseKeys·folderCards·cutWindows·viewTimelineDownload·resolveProjectBrowser).
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ setColorsBatch: vi.fn(), toggleDisabledGen: vi.fn(), setMyPassword: vi.fn() }));
vi.mock("../src/api", () => ({ api: { setColorsBatch: mocks.setColorsBatch, setMyPassword: mocks.setMyPassword } }));
vi.mock("../src/lib/deactivated", async (orig) => ({ ...(await orig<Record<string, unknown>>()), toggleDisabledGen: mocks.toggleDisabledGen }));
vi.mock("../src/lib/releaseUpdate", () => ({ getReleaseUpdateStatus: () => Promise.resolve({}) }));

import { ManageAccount } from "../src/components/ManageAccount";
import { useGenerationKeyboardActions } from "../src/lib/useGenerationKeyboardActions";
import { usePromptDock } from "../src/lib/usePromptDock";
import { useSceneKeyboardShortcuts } from "../src/lib/useSceneKeyboardShortcuts";
import type { Filters, Generation } from "../src/types";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  mocks.setColorsBatch.mockReset().mockResolvedValue({ failed: [] });
  mocks.toggleDisabledGen.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

/** 키를 누르고(첫 keydown) 길게 눌러 반복 keydown 을 times 번 더 보낸다. 반복 이벤트들을 돌려준다. */
function hold(init: KeyboardEventInit, times = 3, target: EventTarget = document.body) {
  const fire = (repeat: boolean) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init, repeat });
    act(() => { target.dispatchEvent(event); });
    return event;
  };
  const first = fire(false);
  return { first, repeats: Array.from({ length: times }, () => fire(true)) };
}

it("격자의 색(r)·비활성(d) — 길게 눌러도 한 번만 바뀌고, 반복에도 기본 동작은 막는다", async () => {
  let gens: Generation[] = [];
  function Harness() {
    const [list, setList] = useState<Generation[]>([{ id: "a", color: null } as unknown as Generation]);
    gens = list;
    const gensRef = useRef(list);
    gensRef.current = list;
    const selectedRef = useRef(new Set(["a"]));
    const filtersRef = useRef({ tab: "my" } as Filters);
    useGenerationKeyboardActions({ clearSelect: () => {}, filtersRef, flash: () => {}, gensRef, reload: () => {}, selectedRef, setGens: setList });
    return null;
  }
  act(() => root.render(<Harness />));
  const red = hold({ key: "r", code: "KeyR" });
  await act(async () => { await Promise.resolve(); });
  expect(gens[0].color).toBeTruthy(); // 칠해진 채다(반복마다 뒤집히면 짝수 번에 다시 지워진다)
  expect(mocks.setColorsBatch).toHaveBeenCalledTimes(1);
  expect([red.first.defaultPrevented, ...red.repeats.map((event) => event.defaultPrevented)]).toEqual([true, true, true, true]);
  hold({ key: "d", code: "KeyD" });
  expect(mocks.toggleDisabledGen).toHaveBeenCalledTimes(1);
});

it("내 계정 창: 새 비밀번호 칸의 Enter 는 길게 눌러도 한 번만 보낸다 — 성공 안내가 반복 Enter 로 덮이지 않는다", async () => {
  let finish!: () => void;
  mocks.setMyPassword.mockReset().mockImplementation(() => new Promise<void>((done) => { finish = done; }));
  act(() => root.render(<ManageAccount provider={null} account={{ name: "나", email: "me@example.com" } as never} onClose={() => {}} onProviderUpdated={() => {}} />));
  const fields = [...host.querySelectorAll<HTMLInputElement>('input[type="password"]')];
  const type = (input: HTMLInputElement, text: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  type(fields[0], "current-fixture");
  type(fields[1], "next-fixture");
  const enter = (repeat: boolean) => act(() => {
    fields[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, repeat }));
  });
  enter(false);
  enter(true); enter(true); // 응답을 기다리는 동안의 반복
  enter(false); // 기다리는 동안 한 번 더 누른 것도 다시 보내지 않는다(처리 중에는 받지 않는다)
  expect(mocks.setMyPassword).toHaveBeenCalledTimes(1);
  await act(async () => { finish(); });
  enter(true); enter(true); // 성공해 두 칸이 비워진 뒤에도 이어지는 반복
  expect(mocks.setMyPassword).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("비밀번호가 변경되었습니다.");
  expect(host.textContent).not.toContain("현재 비밀번호를 입력하세요.");
});

it("프롬프트 도크(Ctrl+K) — 길게 눌러도 한 번만 여닫는다", () => {
  let visible = true;
  const store = { get: (_key: string, fallback: string) => fallback, set: () => {} };
  function Harness() { visible = usePromptDock(store as never).promptVisible; return null; }
  act(() => root.render(<Harness />));
  const held = hold({ key: "k", code: "KeyK", ctrlKey: true }, 3);
  expect(visible).toBe(false); // 한 번 닫혔다(첫 keydown + 반복 3번을 전부 받으면 다시 열려 있다)
  expect(held.repeats.every((event) => event.defaultPrevented)).toBe(true); // 브라우저의 Ctrl+K 는 반복에도 막는다
});

it("캔버스의 Tab(노드 선택기) — 길게 눌러도 한 번만 여닫고, 첫 누름을 캔버스가 썼으면 반복이 초점을 옮기지 않는다", () => {
  type Actions = Parameters<typeof useSceneKeyboardShortcuts>[0];
  const onTogglePicker = vi.fn(() => true);
  const base = { isFrozen: () => false, isTextEditing: () => false, isPopupOpen: () => false, isPickerOpen: () => false, selectionCount: () => 0, onTogglePicker, onCutHeldChange: () => {} };
  const actions = new Proxy(base, {
    get: (target, name) => (name in target ? target[name as keyof typeof target] : () => { throw new Error(`unexpected action: ${String(name)}`); }),
  }) as unknown as Actions;
  function Harness() { useSceneKeyboardShortcuts(actions); return null; }
  act(() => root.render(<Harness />));
  const held = hold({ key: "Tab", code: "Tab" }, 3);
  expect(onTogglePicker).toHaveBeenCalledTimes(1);
  expect(held.repeats.map((event) => event.defaultPrevented)).toEqual([true, true, true]);

  // 캔버스가 쓰지 않은 Tab(마우스가 캔버스 밖 등)이면 반복도 건드리지 않는다 — 평소의 초점 이동이다
  onTogglePicker.mockReset().mockReturnValue(false);
  const free = hold({ key: "Tab", code: "Tab" }, 2);
  expect(onTogglePicker).toHaveBeenCalledTimes(1);
  expect([free.first.defaultPrevented, ...free.repeats.map((event) => event.defaultPrevented)]).toEqual([false, false, false]);

  // 캔버스가 쓴 Tab 의 표식은 그 누름이 끝나면 지워진다 — 남으면 다음에 누른 Tab 의 반복이 막혀 초점 이동이 멎는다.
  const repeatTab = (target: EventTarget = document.body) => {
    const event = new KeyboardEvent("keydown", { key: "Tab", code: "Tab", bubbles: true, cancelable: true, repeat: true });
    act(() => { target.dispatchEvent(event); });
    return event.defaultPrevented;
  };
  const useTab = () => { onTogglePicker.mockReset().mockReturnValue(true); hold({ key: "Tab", code: "Tab" }, 1); };
  // ① 다음 Tab 을 입력 칸에서 눌렀다: 첫 keydown 은 입력 칸에 양보하고(캔버스는 아무것도 안 한다), 초점이 옮겨 간 뒤의 반복도 그대로 둔다
  useTab();
  const input = document.createElement("input");
  host.append(input);
  const typed = hold({ key: "Tab", code: "Tab" }, 0, input);
  expect(typed.first.defaultPrevented).toBe(false);
  expect(repeatTab()).toBe(false);
  expect(onTogglePicker).toHaveBeenCalledTimes(1); // 캔버스가 쓴 그 한 번뿐이다
  // 다른 키는 그 Tab 을 끝내지 않는다 — Tab 을 누른 채 Shift 를 눌렀다 떼도 남은 반복은 캔버스가 막는다(Codex 재검토)
  useTab();
  act(() => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", code: "ShiftLeft", shiftKey: true, bubbles: true, cancelable: true })); });
  act(() => { document.body.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", code: "ShiftLeft", bubbles: true })); });
  expect(repeatTab()).toBe(true);
  // ② 키를 뗐다(keyup)
  useTab();
  act(() => { window.dispatchEvent(new KeyboardEvent("keyup", { key: "Tab", code: "Tab" })); });
  expect(repeatTab()).toBe(false);
  // ③ 누른 채 창을 떠났다(keyup 이 오지 않는다)
  useTab();
  act(() => { window.dispatchEvent(new Event("blur")); });
  expect(repeatTab()).toBe(false);
});
