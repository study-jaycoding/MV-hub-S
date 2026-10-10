// @vitest-environment jsdom
// 조작 점검 7회차 — 단축키 창(ShortcutsWindow)이 저장 검증의 결과를 사용자에게 보인다(등록부 쪽 시험은 shortcuts.test.ts).
//  · R43-d 수식키가 붙은 입력기 키(Ctrl+Process)는 지정되지 않고, 한글 입력 상태 안내가 나온다 — 전엔 "Ctrl + Process" 로 지정됐다
//  · R43-c 읽을 때 겹쳐서 걷어 낸 지정은 창을 열 때 알린다 — 말없이 기본값으로 돌아가 있으면 왜 키가 바뀌었는지 알 수 없다
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  vi.resetModules(); // 등록부는 모듈을 읽을 때 저장소를 읽는다 — 시험마다 새로 읽힌다
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); localStorage.clear(); });

async function open(saved?: unknown) {
  if (saved) localStorage.setItem("ch.shortcuts", JSON.stringify(saved));
  const shortcuts = await import("../src/lib/shortcuts");
  const { ShortcutsWindow } = await import("../src/components/ShortcutsWindow");
  act(() => root.render(<ShortcutsWindow onClose={() => {}} />));
  return shortcuts;
}
const row = (label: string) => [...host.querySelectorAll<HTMLElement>(".sc-row")].find((r) => r.querySelector(".sc-label")!.textContent === label)!;
const warn = () => host.querySelector(".sc-warn")?.textContent ?? "";
const press = (init: KeyboardEventInit) =>
  act(() => { document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });
const IME_HINT = "한글 입력 상태에서는 키를 읽을 수 없습니다 — 영문으로 바꾸고 다시 누르세요.";

it("Ctrl+Process 는 지정되지 않고 한글 입력 상태 안내가 나온다 — 수식키 없는 Process 와 같은 안내", async () => {
  const shortcuts = await open();
  act(() => row("컬러 — 빨강").querySelector<HTMLElement>(".sc-edit")!.click());
  for (const init of [
    { key: "Process", code: "Digit1" },
    { key: "Process", code: "Digit1", ctrlKey: true },
    { key: "Process", code: "Digit1", altKey: true, shiftKey: true },
    { key: "Dead", code: "Quote", ctrlKey: true },
    { key: "Unidentified", ctrlKey: true },
  ]) {
    press(init);
    expect(shortcuts.getBinding("colorRed"), JSON.stringify(init)).toBe("r");
    expect(warn(), JSON.stringify(init)).toBe(IME_HINT);
    expect(row("컬러 — 빨강").classList.contains("capturing"), JSON.stringify(init)).toBe(true); // 영문으로 바꾸고 다시 누를 수 있게 계속 기다린다
  }
  expect(localStorage.getItem("ch.shortcuts")).toBeNull();
  // 읽을 수 있는 키가 오면 그대로 지정된다
  press({ key: "1", code: "Digit1", ctrlKey: true });
  expect(shortcuts.getBinding("colorRed")).toBe("mod+1");
  expect(warn()).toBe("");
});

it("읽을 때 겹쳐서 걷어 낸 지정은 창을 열 때 알린다 — 무엇이 무엇과 겹쳐 기본값으로 돌아갔는지", async () => {
  await open({ comment: "enter", showHistory: "c" });
  expect(row("히스토리 (어떻게 만들었나 노드로)").querySelector(".sc-key")!.textContent).toBe("H");
  expect(row("코멘트 열기").querySelector(".sc-key")!.textContent).toBe("C");
  expect(warn()).toBe('저장돼 있던 "히스토리 (어떻게 만들었나 노드로)" 의 지정 "C" 은(는) "코멘트 열기"와(과) 겹쳐 기본값으로 돌렸습니다.');
});

it("걷어 낸 것이 없으면 창은 안내 없이 열린다", async () => {
  await open({ colorRed: "1" });
  expect(host.querySelector(".sc-warn")).toBeNull();
});

it("창을 연 채 다른 탭이 저장소를 바꾸면 겹침 안내도 키 목록과 같이 따라간다 — 처음 열 때만 읽어, 정상 값이 저장된 뒤에도 경고가 남았다", async () => {
  const otherTab = (value: unknown) => act(() => {
    localStorage.setItem("ch.shortcuts", JSON.stringify(value));
    window.dispatchEvent(new StorageEvent("storage", { key: "ch.shortcuts" }));
  });
  const NOTICE = '저장돼 있던 "히스토리 (어떻게 만들었나 노드로)" 의 지정 "C" 은(는) "코멘트 열기"와(과) 겹쳐 기본값으로 돌렸습니다.';
  await open({ comment: "enter", showHistory: "c" });
  expect(warn()).toBe(NOTICE);
  otherTab({ colorRed: "1" }); // 다른 탭이 정상 값으로 저장했다
  expect(row("컬러 — 빨강").querySelector(".sc-key")!.textContent).toBe("1");
  expect(host.querySelector(".sc-warn")).toBeNull();
  otherTab({ comment: "enter", showHistory: "c" }); // 거꾸로: 열려 있는 동안 겹치는 값이 들어오면 그때 알린다
  expect(warn()).toBe(NOTICE);
  // 캡처 중의 안내가 먼저 보이고, 그것이 걷히면 아직 남은 겹침 안내로 돌아온다
  act(() => row("컬러 — 빨강").querySelector<HTMLElement>(".sc-edit")!.click());
  press({ key: "Enter" });
  expect(warn()).toBe('"Enter" 은(는) 이미 쓰이는 고정 키라 지정할 수 없습니다.');
  press({ key: "Escape" });
  expect(warn()).toBe(NOTICE);
  // 이 탭에서 하나를 바꾸면 정리된 것이 저장소에 쓰인다 — 안내도 사라진다
  act(() => row("컬러 — 빨강").querySelector<HTMLElement>(".sc-edit")!.click());
  press({ key: "2", code: "Digit2" });
  expect(JSON.parse(localStorage.getItem("ch.shortcuts")!)).toEqual({ colorRed: "2" });
  expect(host.querySelector(".sc-warn")).toBeNull();
});

// ── R43-e 본 키가 + 인 지정 · R43-f 기호 키의 Shift ──
const keyOf = (label: string) => row(label).querySelector(".sc-key")!.textContent;
const saved = () => JSON.parse(localStorage.getItem("ch.shortcuts") || "{}");

it("+ 키를 지정해도 창이 무너지지 않는다 — 전엔 저장된 뒤 렌더가 예외를 던져 창이 통째로 사라졌고 열 때마다 되풀이됐다", async () => {
  const shortcuts = await open();
  act(() => row("컬러 — 빨강").querySelector<HTMLElement>(".sc-edit")!.click());
  press({ key: "+", code: "Equal", shiftKey: true }); // Shift+=
  expect(shortcuts.getBinding("colorRed")).toBe("+");
  expect(host.querySelectorAll(".sc-row").length).toBe(shortcuts.SHORTCUTS.length);
  expect(keyOf("컬러 — 빨강")).toBe("+");
  act(() => row("컬러 — 초록").querySelector<HTMLElement>(".sc-edit")!.click());
  press({ key: "+", code: "NumpadAdd", ctrlKey: true });
  expect(keyOf("컬러 — 초록")).toBe("Ctrl/⌘ + +");
  expect(saved()).toEqual({ colorRed: "+", colorGreen: "mod++" });
});

it("이미 저장돼 있는 + 지정으로도 창이 정상으로 뜬다", async () => {
  const shortcuts = await open({ colorRed: "+", colorGreen: "mod++" });
  expect(host.querySelectorAll(".sc-row").length).toBe(shortcuts.SHORTCUTS.length);
  expect(keyOf("컬러 — 빨강")).toBe("+");
  expect(keyOf("컬러 — 초록")).toBe("Ctrl/⌘ + +");
});

it("Ctrl+Shift+1 로 지정하면 Ctrl + ! 로 보이고 그 꼴로 저장된다 — 옛 저장값(mod+!)·dev 가 저장한 값(mod+shift+!)도 같은 모습", async () => {
  await open();
  act(() => row("컬러 — 빨강").querySelector<HTMLElement>(".sc-edit")!.click());
  press({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true });
  expect(keyOf("컬러 — 빨강")).toBe("Ctrl/⌘ + !");
  expect(saved()).toEqual({ colorRed: "mod+!" });
  // 같은 키를 다른 항목에 또 지정하려 하면 충돌로 거절된다(같은 꼴로 견준다)
  act(() => row("컬러 — 초록").querySelector<HTMLElement>(".sc-edit")!.click());
  press({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true });
  expect(warn()).toBe('"Ctrl/⌘ + !" 은(는) 이미 "컬러 — 빨강"에 사용 중입니다.');
  for (const old of ["mod+!", "mod+shift+!"]) {
    vi.resetModules();
    await open({ colorBlue: old });
    expect(keyOf("컬러 — 파랑"), old).toBe("Ctrl/⌘ + !");
  }
});

// 저장값 ↔ 실제 키 이벤트: 등록부를 쓰는 제품 훅(프롬프트 표시/숨김)으로 본다
async function dock(value: unknown) {
  vi.resetModules();
  localStorage.setItem("ch.shortcuts", JSON.stringify(value));
  const { usePromptDock } = await import("../src/lib/usePromptDock");
  const { makeStore } = await import("../src/lib/storage");
  const store = makeStore("round7.");
  function Dock() { return <i className="dock">{usePromptDock(store).promptVisible ? "on" : "off"}</i>; }
  act(() => root.render(<Dock />));
  return () => host.querySelector(".dock")!.textContent;
}

it("저장돼 있는 지정이 실제 키에 듣는다 — + 키 · 옛 Shift+기호(mod+!) · dev 가 저장한 꼴(mod+shift+!)", async () => {
  const cases: [Record<string, string>, KeyboardEventInit][] = [
    [{ focusPrompt: "mod++" }, { key: "+", code: "NumpadAdd", ctrlKey: true }],
    [{ focusPrompt: "mod++" }, { key: "+", code: "Equal", ctrlKey: true, shiftKey: true }],
    [{ focusPrompt: "mod+!" }, { key: "!", code: "Digit1", ctrlKey: true, shiftKey: true }],
    [{ focusPrompt: "mod+shift+!" }, { key: "!", code: "Digit1", ctrlKey: true, shiftKey: true }],
  ];
  for (const [value, init] of cases) {
    const visible = await dock(value);
    expect(visible()).toBe("on");
    press({ key: "1", code: "Digit1", ctrlKey: true }); // Shift 없는 Ctrl+1 은 다른 키다
    press({ key: "k", code: "KeyK", ctrlKey: true }); // 지정이 기본 키를 대신한다
    expect(visible(), JSON.stringify([value, "다른 키"])).toBe("on");
    press(init);
    expect(visible(), JSON.stringify([value, init])).toBe("off");
  }
});
