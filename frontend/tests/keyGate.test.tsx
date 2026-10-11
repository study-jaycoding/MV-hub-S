// @vitest-environment jsdom
// 떠 있는 것이 키의 주인(lib/keyGate) · Esc 한 번에 한 겹(lib/useEscapeClose).
// 2026-10-10 실측에서 나온 것들: 크게 보기·정보·재생 창 뒤로 단축키가 먹음(카드 색·Delete), 같은 Esc 에 두 겹이 함께 닫힘
// (프로젝트 대화상자 + 달력, 설정 + 옆 패널, 폴더 창 + 뒤의 컷 선택).
import { act, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: { setColorsBatch: vi.fn(async () => ({ failed: [] })) } }));
vi.mock("../src/lib/deactivated", () => ({ toggleDisabledGen: vi.fn() }));

import { toggleDisabledGen } from "../src/lib/deactivated";
import { backgroundKeysBlocked, dropFocusAfterPress, isTypingTarget, pressStartedCovered, useKeyOwner, useModalFocus, usePageSelectAllGuard } from "../src/lib/keyGate";
import { useGenerationSelection } from "../src/lib/useGenerationSelection";
import { markKeyHandled } from "../src/lib/keyHandled";
import { useBackgroundEscape, useEscapeClose } from "../src/lib/useEscapeClose";
import { useOutsideDragSelect } from "../src/lib/useOutsideDragSelect";
import { useOutsideMouseDown } from "../src/lib/useOutsideMouseDown";
import { useGenerationKeyboardActions } from "../src/lib/useGenerationKeyboardActions";
import { matchShortcut } from "../src/lib/shortcuts";
import { useSceneKeyboardShortcuts } from "../src/lib/useSceneKeyboardShortcuts";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

const press = (key: string, target: EventTarget = document.body, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
};

function Layer({ onClose, enabled = true, capture = false, consume = false }: { onClose: () => void; enabled?: boolean; capture?: boolean; consume?: boolean }) {
  useEscapeClose(onClose, enabled, capture, consume);
  return null;
}

it("둘 다 버블 겹(관리자 창 + 안쪽 대화상자)이어도 Esc 는 안쪽만 닫는다", () => {
  const onOuter = vi.fn(); const onInner = vi.fn();
  function Outer() { useEscapeClose(onOuter); return <Layer onClose={onInner} />; } // 같은 렌더에 뜬 부모·자식 — 자식이 위
  act(() => root.render(<Outer />));
  press("Escape");
  expect(onInner).toHaveBeenCalledTimes(1);
  expect(onOuter).not.toHaveBeenCalled();
});

it("나중에 연 겹이 위다 — 형제 순서(먼저 그려지는 쪽)와 무관하게 나중에 켜진 것만 닫힌다", () => {
  const onFirst = vi.fn(); const onSecond = vi.fn();
  // 트리에서는 second 가 먼저 그려지지만, first 가 나중에 켜졌다.
  act(() => root.render(<><Layer onClose={onSecond} /><Layer onClose={onFirst} enabled={false} /></>));
  act(() => root.render(<><Layer onClose={onSecond} /><Layer onClose={onFirst} /></>));
  press("Escape");
  expect(onFirst).toHaveBeenCalledTimes(1);
  expect(onSecond).not.toHaveBeenCalled();
});

it("위 겹을 닫은 Esc 로 다시 켜진 아래 겹은 그 Esc 를 또 쓰지 않는다(컷 정보 + 크게 보기)", () => {
  const onParent = vi.fn();
  function Parent() {
    const [childOpen, setChildOpen] = useState(true);
    useEscapeClose(onParent, !childOpen); // 위에 무엇이 떠 있으면 꺼 두는 옛 호출 꼴
    // 위 겹은 캡처 단계에서 닫힌다 → 다시 켜진 아래 겹의 버블 리스너가 **같은 Esc 의 버블 단계**에 불린다(표시가 없으면 또 닫는다).
    return childOpen ? <Layer capture onClose={() => flushSync(() => setChildOpen(false))} /> : null;
  }
  act(() => root.render(<Parent />));
  press("Escape");
  expect(onParent).not.toHaveBeenCalled();
  press("Escape");
  expect(onParent).toHaveBeenCalledTimes(1);
});

it("닫지 않는 겹(적용 중인 확인 창)도 맨 위면 Esc 를 갖는다 — 아래 겹으로 새지 않는다", () => {
  const onOuter = vi.fn();
  act(() => root.render(<><Layer onClose={onOuter} /><Layer onClose={() => {}} /></>));
  press("Escape");
  expect(onOuter).not.toHaveBeenCalled();
});

it("겹이 떠 있는 동안 뒤 화면의 키는 막힌다 — 닫히면 풀린다. Esc 없는 덮개는 useKeyOwner 로 올린다", () => {
  function Owner({ active }: { active: boolean }) { useKeyOwner(active); return null; }
  expect(backgroundKeysBlocked()).toBe(false);
  act(() => root.render(<Layer onClose={() => {}} />));
  expect(backgroundKeysBlocked()).toBe(true);
  act(() => root.render(<Layer onClose={() => {}} enabled={false} />));
  expect(backgroundKeysBlocked()).toBe(false);
  act(() => root.render(<Owner active />));
  expect(backgroundKeysBlocked()).toBe(true);
  act(() => root.render(<Owner active={false} />));
  expect(backgroundKeysBlocked()).toBe(false);
});

it("뒤 화면의 Esc 는 위에 겹이 있으면 쉬고, 한 Esc 는 뒤 화면에서도 한 번만 쓰인다", () => {
  const first = vi.fn(); const second = vi.fn(); const onLayer = vi.fn();
  function Back({ layer, firstUses = true }: { layer?: boolean; firstUses?: boolean }) {
    useBackgroundEscape(() => { first(); return firstUses ? undefined : false; });
    useBackgroundEscape(second);
    return layer ? <Layer onClose={onLayer} capture consume /> : null;
  }
  act(() => root.render(<Back layer />));
  press("Escape");
  expect(onLayer).toHaveBeenCalledTimes(1);
  expect(first).not.toHaveBeenCalled();

  act(() => root.render(<Back />));
  press("Escape");
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).not.toHaveBeenCalled(); // 앞의 것이 썼다

  act(() => root.render(<Back firstUses={false} />));
  press("Escape");
  expect(second).toHaveBeenCalledTimes(1); // 앞의 것이 '안 썼다'(false)고 하면 다음이 받는다
});

it("버블 겹이 떠 있을 때도 뒤 화면의 Esc 는 쉰다 — 뒤 리스너가 먼저 등록돼 먼저 돌아도(정보 창 + 선택 해제)", () => {
  const onBack = vi.fn(); const onLayer = vi.fn();
  function Back({ layer }: { layer: boolean }) { useBackgroundEscape(onBack); return layer ? <Layer onClose={onLayer} /> : null; }
  act(() => root.render(<Back layer={false} />)); // 뒤 화면 리스너가 먼저 걸린다
  act(() => root.render(<Back layer />));
  press("Escape");
  expect(onLayer).toHaveBeenCalledTimes(1);
  expect(onBack).not.toHaveBeenCalled();
});

it("글자를 치는 자리만 양보 대상이다 — 체크박스·슬라이더는 아니다", () => {
  const make = (html: string) => { host.innerHTML = html; return host.firstElementChild!; };
  expect(isTypingTarget(make('<input type="text">'))).toBe(true);
  expect(isTypingTarget(make("<input>"))).toBe(true);
  expect(isTypingTarget(make("<textarea></textarea>"))).toBe(true);
  expect(isTypingTarget(make("<select></select>"))).toBe(true);
  expect(isTypingTarget(make('<input type="checkbox">'))).toBe(false);
  expect(isTypingTarget(make('<input type="range">'))).toBe(false);
  expect(isTypingTarget(make("<button></button>"))).toBe(false);
  expect(isTypingTarget(null)).toBe(false);
  host.innerHTML = "";
});

// ── 뒤 화면의 실제 훅 둘 ──
function mountLibrary(overlay: boolean) {
  const clearSelect = vi.fn();
  const args = {
    clearSelect,
    filtersRef: { current: { tab: "my" } },
    flash: vi.fn(),
    gensRef: { current: [] },
    reload: vi.fn(),
    selectedRef: { current: new Set(["g1"]) },
    setGens: vi.fn(),
  } as unknown as Parameters<typeof useGenerationKeyboardActions>[0];
  function Harness() {
    useGenerationKeyboardActions(args);
    return <>{overlay ? <Layer onClose={() => {}} /> : null}<input type="checkbox" className="probe-check" /><input className="probe-text" /></>;
  }
  act(() => root.render(<Harness />));
  return clearSelect;
}

it("라이브러리: 창이 떠 있으면 d(비활성)·Esc(선택 해제)가 뒤 카드에 먹지 않는다", () => {
  const clearSelect = mountLibrary(true);
  press("d");
  press("Escape");
  expect(toggleDisabledGen).not.toHaveBeenCalled();
  expect(clearSelect).not.toHaveBeenCalled();
});

it("라이브러리: 창이 없으면 먹는다 — 체크박스에 초점이 남아 있어도. 글자 입력칸에서는 양보한다", () => {
  const clearSelect = mountLibrary(false);
  press("d", host.querySelector(".probe-text")!);
  expect(toggleDisabledGen).not.toHaveBeenCalled();
  press("d", host.querySelector(".probe-check")!);
  expect(toggleDisabledGen).toHaveBeenCalledTimes(1);
  const esc = press("Escape", host.querySelector(".probe-check")!);
  expect(clearSelect).toHaveBeenCalledTimes(1);
  // 선택을 푼 Esc 는 '쓴 것' — 같은 키로 뒤의 폴더 창·컷 선택까지 건드리지 않는다.
  const onBack = vi.fn();
  function Probe() { useBackgroundEscape(onBack); return null; }
  act(() => root.render(<Probe />));
  act(() => { window.dispatchEvent(esc); }); // 이미 표시된 같은 이벤트
  expect(onBack).not.toHaveBeenCalled();
});

it("라이브러리: 안쪽이 이미 쓴 Esc(격자의 선택 해제)는 다시 쓰지 않는다", () => {
  const clearSelect = mountLibrary(false);
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  markKeyHandled(event);
  act(() => { document.body.dispatchEvent(event); });
  expect(clearSelect).not.toHaveBeenCalled();
});

it("캔버스: 창이 떠 있으면 Delete·Ctrl+Z·Ctrl+A 가 뒤 보드에 먹지 않는다", () => {
  type Actions = Parameters<typeof useSceneKeyboardShortcuts>[0];
  const onDelete = vi.fn(); const onUndo = vi.fn(); const onSelectAll = vi.fn();
  const actions = new Proxy(
    { isTextEditing: () => false, isPopupOpen: () => false, isPickerOpen: () => false, selectionCount: () => 1, onDelete, onUndo, onSelectAll },
    { get: (target, name) => (name in target ? target[name as keyof typeof target] : () => { throw new Error(`unexpected action: ${String(name)}`); }) },
  ) as unknown as Actions;
  function Board({ overlay }: { overlay: boolean }) { useSceneKeyboardShortcuts(actions); return overlay ? <Layer onClose={() => {}} /> : null; }
  act(() => root.render(<Board overlay />));
  press("Delete");
  press("z", document.body, { ctrlKey: true });
  expect(press("a", document.body, { ctrlKey: true }).defaultPrevented).toBe(false);
  expect(onDelete).not.toHaveBeenCalled();
  expect(onUndo).not.toHaveBeenCalled();
  expect(onSelectAll).not.toHaveBeenCalled();

  act(() => root.render(<Board overlay={false} />));
  press("Delete");
  expect(onDelete).toHaveBeenCalledTimes(1);
});

it("입력칸 밖의 Ctrl+A 는 언제나 막는다 — 위에 창이 떠 뒤 화면이 쉬는 동안에도 화면 글자를 긁지 않는다. 입력칸에서는 그대로", () => {
  function App() { usePageSelectAllGuard(); return <><Layer onClose={() => {}} /><input className="probe-text" /><input type="checkbox" className="probe-check" /></>; }
  act(() => root.render(<App />));
  expect(press("a", document.body, { ctrlKey: true }).defaultPrevented).toBe(true);
  expect(press("a", document.body, { metaKey: true }).defaultPrevented).toBe(true);
  expect(press("a", host.querySelector(".probe-check")!, { ctrlKey: true }).defaultPrevented).toBe(true);
  expect(press("a", host.querySelector(".probe-text")!, { ctrlKey: true }).defaultPrevented).toBe(false); // 입력한 글자의 전체 선택
  expect(press("a").defaultPrevented).toBe(false); // 그냥 a
});

it("격자 밖에서 시작하는 끌기 선택은 위에 메뉴·창이 떠 있으면 시작하지 않는다 — 그 클릭은 메뉴를 닫는 클릭이다", () => {
  const start = vi.fn();
  function Page({ menu }: { menu: boolean }) {
    useOutsideDragSelect(".probe-grid", start);
    return <>{menu ? <Layer onClose={() => {}} /> : null}<div className="probe-grid" /><span className="probe-blank">빈 곳</span></>;
  }
  const down = () => act(() => { host.querySelector(".probe-blank")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })); });
  act(() => root.render(<Page menu />));
  down();
  expect(start).not.toHaveBeenCalled();
  act(() => root.render(<Page menu={false} />));
  down();
  expect(start).toHaveBeenCalledTimes(1);
});

it("누르는 순간 위에 메뉴가 떠 있었으면, 그 누름이 메뉴를 먼저 닫아도 뒤의 선택은 풀리지 않는다 — 다음 누름부터는 풀린다", () => {
  // 메뉴 몇 개는 mousedown 보다 앞선 pointerdown 에 닫힌다(검토 메뉴·카드의 확인 덮개) — mousedown 에서 보면 이미 떠 있지 않다.
  let select!: ReturnType<typeof useGenerationSelection>;
  function Page({ menu }: { menu: boolean }) {
    select = useGenerationSelection({ resetKey: "k" });
    return <>{menu ? <Layer onClose={() => {}} /> : null}<span className="probe-blank">빈 곳</span></>;
  }
  const blank = () => host.querySelector(".probe-blank")!;
  const fire = (type: string) => act(() => { blank().dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 })); });
  act(() => root.render(<Page menu />));
  act(() => select.setSelected(new Set(["g1", "g2"])));
  fire("pointerdown");
  expect(pressStartedCovered()).toBe(true);
  act(() => root.render(<Page menu={false} />)); // pointerdown 이 메뉴를 닫았다
  expect(backgroundKeysBlocked()).toBe(false);
  fire("mousedown");
  expect(select.selected.size).toBe(2);
  fire("pointerup");
  expect(pressStartedCovered()).toBe(false);
  fire("pointerdown"); fire("mousedown"); // 메뉴가 없는 다음 누름 = 격자 밖 클릭
  expect(select.selected.size).toBe(0);
});

it("조합 중의 Enter(한글 확정)는 입력칸의 키 처리에 닿지 않는다 — 확정 뒤의 진짜 Enter 는 닿는다", () => {
  const onEnter = vi.fn();
  function App() {
    usePageSelectAllGuard();
    return <input className="probe-text" onKeyDown={(e) => { if (e.key === "Enter") onEnter(); }} />;
  }
  act(() => root.render(<App />));
  const input = host.querySelector(".probe-text")!;
  const composing = press("Enter", input, { isComposing: true });
  expect(onEnter).not.toHaveBeenCalled();
  expect(composing.defaultPrevented).toBe(false); // 조합 확정(브라우저의 기본 동작)은 그대로
  const legacy = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  Object.defineProperty(legacy, "keyCode", { value: 229 }); // isComposing 을 안 주는 환경의 표시
  act(() => { input.dispatchEvent(legacy); });
  expect(onEnter).not.toHaveBeenCalled();
  press("Enter", input);
  expect(onEnter).toHaveBeenCalledTimes(1);
});

it("메뉴의 바깥 누름은 pointerdown 으로도 닫힌다 — 누름을 pointerdown 에서 막아 mousedown 이 안 오는 곳(폭 손잡이)을 눌러도", () => {
  const onOutside = vi.fn();
  function Menu() {
    const ref = useRef<HTMLDivElement>(null);
    useOutsideMouseDown(ref, onOutside);
    return <><div ref={ref} className="probe-menu">메뉴</div><span className="probe-blank">바깥</span></>;
  }
  act(() => root.render(<Menu />));
  const fire = (selector: string, type: string) => act(() => { host.querySelector(selector)!.dispatchEvent(new MouseEvent(type, { bubbles: true })); });
  fire(".probe-menu", "pointerdown");
  expect(onOutside).not.toHaveBeenCalled();
  // 폭 손잡이는 누름의 전파까지 멈춘다(React 의 stopPropagation = 루트에서 멈춤) — document 의 오르는 단계에는 닿지 않는다
  const stop = (event: Event) => event.stopPropagation();
  host.addEventListener("pointerdown", stop);
  fire(".probe-blank", "pointerdown"); // mousedown 은 오지 않는다
  host.removeEventListener("pointerdown", stop);
  expect(onOutside).toHaveBeenCalledTimes(1);
});

it("슬라이더는 마우스 조작이 끝나면 초점을 내려놓는다 — 격자를 품은 창 안이면 그 창으로(캔버스에서 BODY 로 떨어지면 키가 뒤 보드로 간다)", () => {
  const drop = (event: { currentTarget: HTMLElement }) => dropFocusAfterPress(event.currentTarget);
  act(() => root.render(<>
    <input type="range" className="probe-loose" onPointerDown={drop} />
    <section className="folder-peek" tabIndex={-1}>
      <input type="range" className="probe-inside" onPointerDown={drop} />
      <div className="gen-grid" tabIndex={0} />
    </section>
    <section className="scene-varwin" tabIndex={-1}>
      <input type="range" className="probe-empty" onPointerDown={drop} />
    </section>
  </>));
  const use = (selector: string) => {
    const el = host.querySelector<HTMLElement>(selector)!;
    act(() => { el.focus(); el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); });
    expect(document.activeElement).toBe(el); // 끄는 동안은 그대로
    act(() => { window.dispatchEvent(new Event("pointerup")); }); // 놓는 자리가 요소 밖이어도 듣는다
  };
  use(".probe-loose");
  expect(document.activeElement).toBe(document.body);
  use(".probe-inside"); // 격자가 아니라 창 — 목록을 다시 받는 동안 격자는 사라질 수 있다
  expect(document.activeElement).toBe(host.querySelector(".folder-peek"));
  use(".probe-empty");
  expect(document.activeElement).toBe(host.querySelector(".scene-varwin"));
  // Tab 으로 온 초점(누름이 없다)은 건드리지 않는다
  const loose = host.querySelector<HTMLElement>(".probe-loose")!;
  act(() => { loose.focus(); window.dispatchEvent(new Event("pointerup")); });
  expect(document.activeElement).toBe(loose);
});

it("한글 입력 상태의 글자 키는 물리 키의 글자로 읽는다 — 'Process'·자모로 와도 단축키가 먹는다. 입력칸·라틴 글자·글자 아닌 키는 그대로", () => {
  const seen: string[] = [];
  const onKey = (event: KeyboardEvent) => seen.push(event.key);
  window.addEventListener("keydown", onKey);
  act(() => root.render(<><input type="text" className="probe-text" /><div className="probe-blank" tabIndex={0} /></>));
  const fire = (target: EventTarget, init: KeyboardEventInit) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    act(() => { target.dispatchEvent(event); });
    return event;
  };
  try {
    const blank = host.querySelector(".probe-blank")!;
    fire(blank, { key: "Process", code: "KeyR" }); // 윈도: 입력기가 켜진 채
    fire(blank, { key: "ㄱ", code: "KeyR" }); // 맥·리눅스의 한글 자판
    fire(document.body, { key: "Process", code: "KeyD", shiftKey: true });
    expect(seen).toEqual(["r", "r", "D"]);
    expect(matchShortcut(fire(blank, { key: "Process", code: "KeyR" }), "colorRed")).toBe(true);
    seen.length = 0;
    fire(blank, { key: "a", code: "KeyQ" }); // AZERTY — 글자가 왔으면 e.key 가 맞다
    fire(blank, { key: "Process", code: "Digit3" }); // 글자 키가 아니다
    fire(blank, { key: "Process", code: "KeyR", isComposing: true });
    fire(host.querySelector(".probe-text")!, { key: "Process", code: "KeyR" }); // 입력칸에서 조합 중인 글자
    fire(host.querySelector(".probe-text")!, { key: "ㄱ", code: "KeyR" });
    expect(seen).toEqual(["a", "Process", "Process", "Process", "ㄱ"]);
  } finally {
    window.removeEventListener("keydown", onKey);
  }
});

it("캔버스: 폴더 창이 떠 있는 동안 보드는 키를 받지 않는다 — 초점이 BODY 든 창 밖 단추든. 가위(Y)는 keyup 의 물리 키로도 풀린다", () => {
  type Actions = Parameters<typeof useSceneKeyboardShortcuts>[0];
  const onDelete = vi.fn(); const onCutHeldChange = vi.fn();
  const actions = new Proxy(
    { isTextEditing: () => false, isPopupOpen: () => false, isPickerOpen: () => false, selectionCount: () => 1, onDelete, onCutHeldChange },
    { get: (target, name) => (name in target ? target[name as keyof typeof target] : () => { throw new Error(`unexpected action: ${String(name)}`); }) },
  ) as unknown as Actions;
  function Board({ peek }: { peek: boolean }) {
    useSceneKeyboardShortcuts(actions);
    return <>{peek ? <section className="folder-peek" /> : null}<button className="probe-outside">패널 단추</button></>;
  }
  act(() => root.render(<Board peek />));
  press("Delete"); // 창에서 연 크게 보기를 ✕ 로 닫은 뒤 — 초점은 BODY
  press("Delete", host.querySelector(".probe-outside")!); // 코멘트 패널의 단추에 남은 초점
  expect(onDelete).not.toHaveBeenCalled();
  act(() => root.render(<Board peek={false} />));
  press("Delete");
  expect(onDelete).toHaveBeenCalledTimes(1);
  act(() => { window.dispatchEvent(new KeyboardEvent("keyup", { key: "Process", code: "KeyY" })); }); // 한글 입력 상태의 keyup
  expect(onCutHeldChange).toHaveBeenLastCalledWith(false);
});

it("캔버스의 폴더 창: 초점이 없을 때(BODY)의 d 도 창 안 격자의 것 — 창 밖 단추에서 난 키와, 창이 없을 때는 받지 않는다", () => {
  const args = (active: boolean) => ({
    clearSelect: vi.fn(), filtersRef: { current: { tab: "compose" } }, composeGridActiveRef: { current: active },
    flash: vi.fn(), gensRef: { current: [] }, reload: vi.fn(), selectedRef: { current: new Set(["g1"]) }, setGens: vi.fn(),
  }) as unknown as Parameters<typeof useGenerationKeyboardActions>[0];
  function Harness({ active }: { active: boolean }) {
    useGenerationKeyboardActions(args(active));
    return <button className="probe-outside">밖</button>;
  }
  act(() => root.render(<Harness active />));
  press("d", host.querySelector(".probe-outside")!);
  expect(toggleDisabledGen).not.toHaveBeenCalled();
  press("d");
  expect(toggleDisabledGen).toHaveBeenCalledTimes(1);
  act(() => root.render(<Harness active={false} />)); // 폴더 창이 없다 — 캔버스의 d 는 보드의 것
  press("d");
  expect(toggleDisabledGen).toHaveBeenCalledTimes(1);
});

// ── 모달의 초점(2026-10-11) — 장치 자체는 tests/modalFocus.test.tsx ──
it("모달 영역(useModalFocus)은 초점만 다룬다 — 뒤 화면의 키를 쉬게 하는 것은 여전히 Esc 겹이다. 위아래는 Esc 겹과 같은 번호 줄에서 받는다", () => {
  function Region({ id, layer = false }: { id: string; layer?: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    useModalFocus(ref);
    useEscapeClose(() => {}, layer);
    return <div id={id} ref={ref}><button id={id + "-button"}>단추</button></div>;
  }
  act(() => root.render(<Region id="first" />));
  expect(document.activeElement?.id).toBe("first"); // 초점은 들인다
  expect(backgroundKeysBlocked()).toBe(false); // 영역을 올린 것만으로는 뒤 화면의 키가 쉬지 않는다 — 창은 useEscapeClose 도 켠다
  act(() => root.render(<Region id="first" layer />));
  expect(backgroundKeysBlocked()).toBe(true);
  // 메뉴(겹만 있는 것)가 번호를 받아 간 뒤에 연 모달이 맨 위다 — Tab 은 그 안에서 돈다
  act(() => root.render(<><Region id="first" layer /><Layer onClose={() => {}} /></>));
  act(() => root.render(<><Region id="first" layer /><Layer onClose={() => {}} /><Region id="second" layer /></>));
  expect(document.activeElement?.id).toBe("second");
  act(() => host.querySelector<HTMLElement>("#second-button")!.focus());
  expect(press("Tab", document.activeElement!).defaultPrevented).toBe(true); // 하나뿐인 자리 — 제자리에서 돈다(첫 창으로 가지 않는다)
  expect(document.activeElement?.id).toBe("second-button");
});

it("기본 조작부를 마우스로 쓴 뒤에는 초점을 매체 자체로 돌린다 — 조작부 안의 초점은 키를 페이지로 안 보낸다. 키보드로 쓰는 중이면 두고, 시간 줄·음량에는 손대지 않는다", () => {
  const video = document.createElement("video");
  video.controls = true;
  video.tabIndex = 0;
  const other = document.createElement("button");
  host.append(video, other);
  const focus = vi.spyOn(video, "focus");
  const fire = (type: string) => video.dispatchEvent(new Event(type)); // 매체 이벤트는 버블하지 않는다 — 문서의 잡는 단계에서 듣는다
  document.dispatchEvent(new Event("pointerdown")); // 마우스로 쓰는 중(Tab 기록이 꺼진다)
  other.focus();
  fire("play"); // 초점이 그 매체가 아니다(자동 재생·다른 자리의 초점) — 빼앗지 않는다
  expect(focus).not.toHaveBeenCalled();
  video.focus();
  focus.mockClear();
  fire("play");
  expect(focus).toHaveBeenCalledTimes(1);
  fire("pause");
  expect(focus).toHaveBeenCalledTimes(2);
  // 시간 줄·음량·속도는 둔다 — 마우스로 누른 뒤 방향키로 조금씩 옮기는 길(브라우저 기본)이 남는다
  for (const type of ["seeked", "volumechange", "ratechange"]) fire(type);
  expect(focus).toHaveBeenCalledTimes(2);
  video.controls = false; // 조작부가 없는 매체(썸네일 미리보기)는 대상이 아니다
  fire("play");
  expect(focus).toHaveBeenCalledTimes(2);
  video.controls = true;
  press("Tab"); // Tab 으로 들어와 키보드로 조작부를 쓰는 중 — 초점을 빼면 다음 키가 엉뚱한 곳으로 간다
  fire("pause");
  expect(focus).toHaveBeenCalledTimes(2);
  // 매체 위에서 마우스가 움직인 것만으로는 풀지 않는다 — 키보드로 쓰는 중에 스친 마우스다(누름은 조작부 밖에서만 보인다)
  video.dispatchEvent(new Event("pointermove", { bubbles: true }));
  fire("play");
  expect(focus).toHaveBeenCalledTimes(2);
  document.dispatchEvent(new Event("pointerdown")); // 페이지가 본 누름 — 다시 마우스로 쓰는 중이다(뒤 시험에도 Tab 기록을 남기지 않는다)
  fire("pause");
  expect(focus).toHaveBeenCalledTimes(3);
});
