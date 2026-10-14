// @vitest-environment jsdom
// 모달의 초점(lib/keyGate '모달의 초점') — 공통 장치.
// 2026-10-11 실측: 막이 있는 창이 떠 있어도 Tab 이 뒤 화면으로 나가 그 자리의 Enter·Space 가 뒤 단추를 눌렀다.
//  ① 열릴 때 초점을 영역의 뿌리로 ② Tab 은 영역 안에서 돈다 ③ 닫힐 때 열기 전의 자리로.
import { act, StrictMode, useRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { closeModal, focusCameByTab, nextLayerSeq, openModal, useModalFocus } from "../src/lib/keyGate";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const el = (id: string) => document.getElementById(id) as HTMLElement;
const activeId = () => (document.activeElement === document.body ? "BODY" : (document.activeElement as HTMLElement | null)?.id ?? "");
const focus = (id: string) => act(() => el(id).focus());

// 브라우저의 Tab — keydown 을 보내고, 아무도 막지 않았으면 문서 순서의 다음(이전) 자리로 초점을 옮긴다(jsdom 에는 이 기본 동작이 없다).
//  뒤 화면의 단추도 그대로 선다 — 가두지 않으면 창 밖으로 나가는 것이 보인다.
const stops = () => [...document.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, summary, [tabindex]")]
  .filter((item) => item.tabIndex >= 0 && !item.matches(":disabled") && !item.closest("[inert]"));
function tab(shift = false, init: KeyboardEventInit = {}): KeyboardEvent {
  const active = (document.activeElement ?? document.body) as HTMLElement;
  const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey: shift, bubbles: true, cancelable: true, ...init });
  act(() => { active.dispatchEvent(event); });
  if (event.defaultPrevented) return event;
  const all = stops();
  const at = all.indexOf(active);
  let next: HTMLElement | undefined;
  if (at >= 0) next = all[at + (shift ? -1 : 1)];
  else if (active === document.body) next = shift ? all[all.length - 1] : all[0];
  else if (shift) next = all.filter((item) => active.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_PRECEDING && !item.contains(active)).pop();
  else next = all.find((item) => active.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING);
  act(() => { if (next) next.focus(); else active.blur(); });
  return event;
}
const walk = (count: number, shift = false) => Array.from({ length: count }, () => { tab(shift); return activeId(); });

function Modal({ id, open = true, children }: { id: string; open?: boolean; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref, open);
  return open ? <div id={id} ref={ref}>{children}</div> : null;
}
// 뒤 화면: 상단바 단추 · (창) · 떠 있는 선택 막대 · 접힌 프롬프트의 상태 줄 단추
const page = (modal: ReactNode, extra?: ReactNode) => (
  <>
    <button id="top">상단바</button>
    <input id="search" />
    {modal}
    <button id="bar">선택 막대</button>
    <button id="dock">프롬프트</button>
    {extra}
  </>
);
const three = <><button id="m1">1</button><button id="m2">2</button><button id="m3">3</button></>;

it("열리면 뒤에 있던 초점이 창의 뿌리로 온다 — 첫 단추가 아니다(연 직후의 Enter 가 아무것도 누르지 않게)", () => {
  act(() => root.render(page(null)));
  focus("top");
  act(() => root.render(page(<Modal id="win">{three}</Modal>)));
  expect(activeId()).toBe("win");
  expect(el("win").tabIndex).toBe(-1);
  expect(el("win").style.outline).toBe("none"); // 창 둘레에 초점 테두리를 그리지 않는다
});

it("뿌리가 제 tabindex 를 갖고 있으면 건드리지 않는다", () => {
  function Own() {
    const ref = useRef<HTMLDivElement>(null);
    useModalFocus(ref);
    return <div id="win" ref={ref} tabIndex={0}>{three}</div>;
  }
  act(() => root.render(page(<Own />)));
  expect(activeId()).toBe("win");
  expect(el("win").tabIndex).toBe(0);
  expect(el("win").style.outline).toBe("");
});

it("창이 스스로 초점을 준 칸(autoFocus)이 있으면 그대로 둔다 — 닫으면 그래도 연 자리로 돌아간다", () => {
  act(() => root.render(page(null)));
  focus("top");
  act(() => root.render(page(<Modal id="win"><button id="m1">1</button><input id="pw" autoFocus /></Modal>)));
  expect(activeId()).toBe("pw");
  expect(el("win").hasAttribute("tabindex")).toBe(false);
  act(() => root.render(page(null)));
  expect(activeId()).toBe("top"); // 연 자리는 렌더에서 적는다 — effect 에서는 이미 autoFocus 가 옮긴 뒤다
});

it("앱 루트와 같은 StrictMode(effect 가 두 번 돈다)에서도 들이고 돌려준다", () => {
  act(() => root.render(<StrictMode>{page(null)}</StrictMode>));
  focus("top");
  act(() => root.render(<StrictMode>{page(<Modal id="win">{three}</Modal>)}</StrictMode>));
  expect(activeId()).toBe("win");
  expect(walk(4)).toEqual(["m1", "m2", "m3", "m1"]);
  act(() => root.render(<StrictMode>{page(null)}</StrictMode>));
  expect(activeId()).toBe("top");
});

it("같이 뜬 모달은 안쪽(자식)이 위다 — Esc 겹과 같은 순서", () => {
  function Outer() {
    const ref = useRef<HTMLDivElement>(null);
    useModalFocus(ref);
    return <div id="outer" ref={ref}><button id="o1">1</button><Modal id="inner"><button id="i1">1</button><button id="i2">2</button></Modal></div>;
  }
  act(() => root.render(page(<Outer />)));
  expect(activeId()).toBe("inner");
  expect(walk(4)).toEqual(["i1", "i2", "i1", "i2"]);
});

it("Tab 30번 · Shift+Tab 10번이 창 안에서만 돈다 — 접힌 프롬프트·떠 있는 선택 막대가 문서에서 창 뒤에 있어도", () => {
  act(() => root.render(page(null)));
  focus("top");
  act(() => root.render(page(<Modal id="win">{three}</Modal>)));
  expect(tab().defaultPrevented).toBe(false); // 뿌리 → 첫 자리: 창 안의 이동은 브라우저에 맡긴다
  expect(tab().defaultPrevented).toBe(false);
  expect(activeId()).toBe("m2");
  act(() => el("win").focus());
  const forward = walk(30);
  expect(forward.slice(0, 4)).toEqual(["m1", "m2", "m3", "m1"]);
  expect(new Set(forward)).toEqual(new Set(["m1", "m2", "m3"]));
  const backward = walk(10, true);
  expect(backward.slice(0, 3)).toEqual(["m2", "m1", "m3"]); // 30번 뒤 초점은 m3 — 첫 자리에서 뒤로 가면 끝 자리
  expect(new Set(backward)).toEqual(new Set(["m1", "m2", "m3"]));
});

it("뿌리에 놓인 초점에서 Shift+Tab 은 끝 자리로 간다(뒤 화면의 앞 단추가 아니라)", () => {
  act(() => root.render(page(<Modal id="win">{three}</Modal>)));
  expect(activeId()).toBe("win");
  expect(tab(true).defaultPrevented).toBe(true); // 가로챈다 — 뒤 화면의 단추에 초점이 잠깐이라도 놓였다 돌아오는 것이 아니다
  expect(activeId()).toBe("m3");
});

it("초점이 창 밖에 있으면(BODY·뒤 단추) Tab 이 창 안으로 들인다", () => {
  act(() => root.render(page(<Modal id="win">{three}</Modal>)));
  act(() => (document.activeElement as HTMLElement).blur());
  expect(activeId()).toBe("BODY");
  tab();
  expect(activeId()).toBe("m1");
  focus("dock"); // 프로그램이 뒤 화면에 초점을 줬다
  tab(true);
  expect(activeId()).toBe("m3");
  focus("top");
  tab();
  expect(activeId()).toBe("m1");
});

it("끝 자리가 꺼져 있거나(disabled) 가려져 있으면(inert) 건너뛰고 그 앞에서 돈다. 숨은 자리도 서지 않는다", () => {
  act(() => root.render(page(
    <Modal id="win">
      <button id="m1">1</button><button id="m2">2</button>
      <button id="off" disabled>꺼짐</button>
      <div {...{ inert: "" }}><button id="veiled">가림</button></div>
      <input type="hidden" id="hid" />
      <span id="skip" tabIndex={-1}>누르면 초점만 받는 자리</span>
    </Modal>,
  )));
  expect(walk(5)).toEqual(["m1", "m2", "m1", "m2", "m1"]);
  // 브라우저가 '안 보인다'고 한 자리(display:none 등)
  Object.assign(el("m2"), { checkVisibility: () => false });
  tab();
  expect(activeId()).toBe("m1"); // m1 이 끝 자리가 됐다 — 제자리에서 돈다
});

it("설 자리가 하나도 없는 창 — Tab 은 뿌리에 머문다", () => {
  act(() => root.render(page(<Modal id="win"><p>글만</p></Modal>)));
  expect(walk(3)).toEqual(["win", "win", "win"]);
  focus("bar");
  tab();
  expect(activeId()).toBe("win");
});

it("닫으면 열기 전의 자리로 돌아간다 — 글 칸에서 열었으면 그 글 칸으로(적던 글은 그대로)", () => {
  act(() => root.render(page(null)));
  focus("search");
  (el("search") as HTMLInputElement).value = "적던 글";
  const blurred = vi.fn();
  el("search").addEventListener("blur", blurred);
  act(() => root.render(page(<Modal id="win">{three}</Modal>)));
  expect(blurred).toHaveBeenCalledTimes(1); // 창이 뜬 동안 키는 뒤 글 칸으로 가지 않는다
  expect(activeId()).toBe("win");
  tab();
  act(() => root.render(page(null)));
  expect(activeId()).toBe("search");
  expect((el("search") as HTMLInputElement).value).toBe("적던 글");
});

it("돌아갈 자리가 사라졌거나 · 가려졌거나(inert) · 안 보이면 초점을 그대로 둔다(BODY)", () => {
  const gone = (opener: boolean, open: boolean) => (
    <>
      {opener && <button id="opener">연 단추</button>}
      {open && <Modal id="win">{three}</Modal>}
    </>
  );
  // 사라짐
  act(() => root.render(gone(true, false)));
  focus("opener");
  act(() => root.render(gone(true, true)));
  expect(activeId()).toBe("win");
  act(() => root.render(gone(false, true)));
  act(() => root.render(gone(false, false)));
  expect(activeId()).toBe("BODY");
  // inert
  const veiled = (inert: boolean, open: boolean) => (
    <>
      <div {...(inert ? { inert: "" } : {})}><button id="opener">연 단추</button></div>
      {open && <Modal id="win">{three}</Modal>}
    </>
  );
  act(() => root.render(veiled(false, false)));
  focus("opener");
  act(() => root.render(veiled(false, true)));
  act(() => root.render(veiled(true, true)));
  act(() => root.render(veiled(true, false)));
  expect(activeId()).toBe("BODY");
  // 안 보임
  act(() => root.render(veiled(false, false)));
  focus("opener");
  act(() => root.render(veiled(false, true)));
  Object.assign(el("opener"), { checkVisibility: () => false });
  act(() => root.render(veiled(false, false)));
  expect(activeId()).toBe("BODY");
});

it("닫히는 사이 다른 데로 간 초점은 뺏지 않는다", () => {
  act(() => root.render(page(null)));
  focus("top");
  act(() => root.render(page(<Modal id="win">{three}</Modal>)));
  focus("dock"); // 창을 닫는 동작이 초점을 다른 곳에 줬다
  act(() => root.render(page(null)));
  expect(activeId()).toBe("dock");
});

it("늘 마운트돼 있는 창은 open 으로 — 켜질 때 들이고 꺼질 때 돌려준다", () => {
  act(() => root.render(page(<Modal id="win" open={false}>{three}</Modal>)));
  focus("top");
  tab();
  expect(activeId()).toBe("search"); // 닫혀 있는 동안은 가두지 않는다
  act(() => root.render(page(<Modal id="win">{three}</Modal>)));
  expect(activeId()).toBe("win");
  act(() => root.render(page(<Modal id="win" open={false}>{three}</Modal>)));
  expect(activeId()).toBe("search");
  tab();
  expect(activeId()).toBe("bar");
});

it("겹친 모달은 맨 위만 가둔다 — 위를 닫으면 초점이 아래 창의 연 자리로 돌아오고 Tab 은 아래 창 안에서 돈다", () => {
  const view = (upper: boolean) => page(
    <Modal id="lower"><button id="l1">1</button><button id="l2">2</button></Modal>,
    upper ? <Modal id="upper"><button id="u1">1</button><button id="u2">2</button></Modal> : null,
  );
  act(() => root.render(view(false)));
  focus("l2");
  act(() => root.render(view(true)));
  expect(activeId()).toBe("upper");
  expect(new Set(walk(12))).toEqual(new Set(["u1", "u2"]));
  expect(new Set(walk(6, true))).toEqual(new Set(["u1", "u2"]));
  act(() => root.render(view(false)));
  expect(activeId()).toBe("l2");
  expect(new Set(walk(12))).toEqual(new Set(["l1", "l2"]));
});

it("아래에 모달이 남아 있으면 초점을 그 뒤에 놓지 않는다 — 돌아갈 자리가 아래 창 밖이면 아래 창의 뿌리로", () => {
  const view = (lower: boolean, upper: boolean) => page(
    lower ? <Modal id="lower"><button id="l1">1</button></Modal> : null,
    upper ? <Modal id="upper"><button id="u1">1</button></Modal> : null,
  );
  act(() => root.render(view(false, false)));
  focus("top");
  act(() => root.render(view(false, true))); // 위 창이 먼저 열렸다 — 연 자리는 뒤 화면
  act(() => root.render(view(true, true))); // 그 뒤에 뜬 창이 지금의 맨 위
  expect(activeId()).toBe("lower");
  focus("u1");
  act(() => root.render(view(true, false)));
  expect(activeId()).toBe("lower");
});

it("한 조작 영역이 여러 뿌리면(설정 창 + 옆 패널) 한 영역으로 돈다 — 그 사이에 낀 뒤 화면 단추는 서지 않는다", () => {
  function Settings({ flyout }: { flyout: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    useModalFocus(() => [ref.current, document.getElementById("flyout")]);
    return (
      <>
        <div id="win" ref={ref}><button id="s1">1</button><button id="s2">2</button></div>
        <button id="between">뒤 화면</button>
        {flyout && <aside id="flyout"><button id="f1">1</button><button id="f2">2</button></aside>}
      </>
    );
  }
  act(() => root.render(page(<Settings flyout />)));
  expect(walk(9)).toEqual(["s1", "s2", "f1", "f2", "s1", "s2", "f1", "f2", "s1"]);
  expect(walk(5, true)).toEqual(["f2", "f1", "s2", "s1", "f2"]);
  act(() => root.render(page(<Settings flyout={false} />))); // 옆 패널이 닫혔다 — 초점은 패널과 함께 사라져 BODY
  expect(walk(3)).toEqual(["s1", "s2", "s1"]);
});

it("뿌리 자신이 aria-modal 이어도(부분 수정 창) 여러 뿌리의 영역은 그대로 한 영역이다", () => {
  function Two() {
    const ref = useRef<HTMLDivElement>(null);
    useModalFocus(() => [ref.current, document.getElementById("side")]);
    return <><div id="win" ref={ref} aria-modal="true"><button id="s1">1</button></div><aside id="side"><button id="f1">1</button></aside></>;
  }
  act(() => root.render(page(<Two />)));
  expect(walk(4)).toEqual(["s1", "f1", "s1", "f1"]);
});

it("뿌리를 감싼 겉 요소가 aria-modal 이어도(화면을 덮는 막이 대화상자인 창) 이 영역으로 본다 — 가두기가 꺼지지 않는다", () => {
  function Wrapped() {
    const ref = useRef<HTMLDivElement>(null);
    useModalFocus(ref);
    return <div aria-modal="true"><button id="veil">막에 놓인 단추</button><div id="win" ref={ref}>{three}</div></div>;
  }
  act(() => root.render(page(<Wrapped />)));
  expect(walk(4)).toEqual(["m1", "m2", "m3", "m1"]);
  expect(walk(2, true)).toEqual(["m3", "m2"]);
  // 브라우저에 맡긴 Tab 이 밖으로 나갔을 때의 되돌리기도 같다
  const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  act(() => { el("m2").dispatchEvent(event); });
  focus("bar");
  expect(activeId()).toBe("m1");
  act(() => { el("m2").dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
  focus("veil"); // 겉 요소 안이지만 뿌리 밖 — 남의 대화상자가 아니다
  expect(activeId()).toBe("m1");
});

it("영역 밖의 다른 모달 대화상자(aria-modal — 업데이트 진행 덮개)에 놓인 초점은 건드리지 않는다", () => {
  act(() => root.render(page(
    <Modal id="win">{three}</Modal>,
    <div aria-modal="true"><button id="x1">1</button><button id="x2">2</button></div>,
  )));
  focus("x1");
  expect(tab().defaultPrevented).toBe(false);
  expect(activeId()).toBe("x2");
  expect(tab().defaultPrevented).toBe(false); // 그 대화상자의 끝에서도 — 스스로 가둔다(여기서 돌리면 그쪽 처리와 겹친다)
  focus("x1");
  expect(tab(true).defaultPrevented).toBe(false);
});

it("영역 안의 모달 대화상자(aria-modal — 동시 수정 확인)에 놓인 초점은 그 대화상자 안에서 돈다", () => {
  act(() => root.render(page(
    <Modal id="win">
      <button id="m1">1</button>
      <div aria-modal="true"><button id="d1">1</button><button id="d2">2</button></div>
    </Modal>,
  )));
  focus("d1");
  expect(walk(4)).toEqual(["d2", "d1", "d2", "d1"]);
  expect(walk(2, true)).toEqual(["d2", "d1"]);
});

it("가로챈 Tab 도 'Tab 으로 온 초점'으로 적힌다 — 창이 그 키의 전파를 막아도", () => {
  const swallow = (event: KeyboardEvent) => event.stopPropagation(); // 비교 창의 잡는 단계 리스너
  window.addEventListener("keydown", swallow, true);
  try {
    act(() => root.render(page(<Modal id="win">{three}</Modal>)));
    act(() => { document.dispatchEvent(new Event("pointerdown", { bubbles: true })); }); // 누름 — 표시가 꺼진다
    expect(focusCameByTab()).toBe(false);
    focus("m3");
    expect(tab().defaultPrevented).toBe(true);
    expect(activeId()).toBe("m1");
    expect(focusCameByTab()).toBe(true);
  } finally {
    window.removeEventListener("keydown", swallow, true);
  }
});

it("조합 중(한글)의 Tab 도 끝에서 돈다. 입력기가 삼킨 키(Process)와 Ctrl+Tab 은 지나간다", () => {
  act(() => root.render(page(<Modal id="win"><button id="m1">1</button><input id="last" /></Modal>)));
  focus("last");
  (el("last") as HTMLInputElement).value = "한";
  expect(tab(false, { isComposing: true }).defaultPrevented).toBe(true);
  expect(activeId()).toBe("m1");
  expect((el("last") as HTMLInputElement).value).toBe("한");
  focus("last");
  expect(tab(false, { key: "Process" }).defaultPrevented).toBe(false);
  focus("last");
  expect(tab(false, { ctrlKey: true }).defaultPrevented).toBe(false);
});

// ── 브라우저에 맡긴 Tab 의 뒤처리(focusin) · 영상·오디오의 조작부(2026-10-11 Codex 리뷰) ──
/** Tab 을 누르기만 한다 — 초점을 옮기는 것(브라우저의 기본 동작)은 시험이 따로 흉내 낸다. */
const keydownTab = (shift = false) => {
  const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey: shift, bubbles: true, cancelable: true });
  act(() => { (document.activeElement ?? document.body).dispatchEvent(event); });
  return event;
};
const keyupTab = () => act(() => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keyup", { key: "Tab", bubbles: true })); });

it("조작부가 있는 영상·오디오는 Tab 자리다 — 그 앞 단추에서의 Tab 을 끝 자리로 착각해 돌리지 않는다(tabIndex 읽기에 기대지 않는다)", () => {
  // jsdom 은 <video controls> 의 tabIndex 를 -1 로 읽는다 — 그 값으로 거르면 닫기 단추가 끝 자리가 되어 영상에 Tab 이 닿지 못한다
  act(() => root.render(page(<Modal id="win"><button id="m1">1</button><button id="close">닫기</button><video id="media" controls /></Modal>)));
  focus("close");
  expect(keydownTab().defaultPrevented).toBe(false);
  keyupTab();
  // 오디오도, 맨 앞에 있을 때의 Shift+Tab 도
  act(() => root.render(page(<Modal id="win"><audio id="media" controls /><button id="m1">1</button></Modal>)));
  focus("m1");
  expect(keydownTab(true).defaultPrevented).toBe(false);
  keyupTab();
  // 스스로 tabindex="-1" 을 단 매체는 자리가 아니다
  act(() => root.render(page(<Modal id="win"><button id="m1">1</button><button id="close">닫기</button><video id="media" controls tabIndex={-1} /></Modal>)));
  focus("close");
  expect(keydownTab().defaultPrevented).toBe(true);
  expect(activeId()).toBe("m1");
});

it("영상에 초점이 있을 때의 Tab 은 가로채지 않는다(안쪽 조작부를 도는 동안 초점은 줄곧 그 요소다) — 그 Tab 이 창 밖으로 나가면 안으로 되돌린다", () => {
  // 실제 브라우저에서 조작부가 있는 영상은 초점을 받는다 — jsdom 에서는 tabindex 로 흉내 낸다
  act(() => root.render(page(<Modal id="win"><button id="m1">1</button><button id="m2">2</button><video id="media" controls tabIndex={0} /></Modal>)));
  focus("media");
  expect(keydownTab().defaultPrevented).toBe(false); // 안쪽 조작부로 간 Tab — 초점은 그대로다
  keyupTab();
  expect(activeId()).toBe("media");
  expect(tab().defaultPrevented).toBe(false); // 조작부의 끝에서 나간 Tab — 브라우저가 창 뒤의 단추로 옮긴다
  expect(activeId()).toBe("m1"); // … 첫 자리로 되돌렸다
  // 뒤로: 맨 앞의 영상에서 Shift+Tab 이 창 앞의 뒤 화면으로 나갔다 → 끝 자리로
  act(() => root.render(page(<Modal id="win"><video id="media" controls tabIndex={0} /><button id="m1">1</button><button id="m2">2</button></Modal>)));
  focus("media");
  expect(tab(true).defaultPrevented).toBe(false);
  expect(activeId()).toBe("m2");
});

it("브라우저에 맡긴 Tab 이 초점을 창 밖에 내려놓으면 안으로 되돌린다 — 끝 자리를 잘못 짚은 모든 경우의 보루. Tab 이 아닌 이동은 건드리지 않는다", () => {
  act(() => root.render(page(<Modal id="win">{three}</Modal>)));
  focus("m2");
  expect(keydownTab().defaultPrevented).toBe(false); // 가운데 자리 — 브라우저에 맡겼다
  focus("bar"); // 그런데 브라우저는 창 밖으로 갔다(라디오 묶음·tabindex 양수처럼 여기서 짚은 끝 자리와 브라우저의 순서가 다를 때)
  expect(activeId()).toBe("m1");
  focus("m2");
  keydownTab(true);
  focus("top");
  expect(activeId()).toBe("m3");
  // 그 Tab 의 기본 이동 한 번만 — 창 안으로 간 뒤에 이어진 이동은 그 Tab 의 것이 아니다
  focus("m1");
  keydownTab();
  focus("m2"); // 브라우저가 옮긴 자리(창 안)
  focus("bar"); // 그 뒤에 프로그램이 옮겼다
  expect(activeId()).toBe("bar");
  // 다른 키 뒤의 이동도 프로그램이나 사용자가 다른 뜻으로 한 것이다
  focus("m2");
  keydownTab();
  act(() => { el("m2").dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true })); });
  focus("bar");
  expect(activeId()).toBe("bar");
});

// ── 맡긴 Tab 의 기록은 그 Tab 의 기본 이동 한 번에만 쓴다(2026-10-11 Codex 재검토) ──
//  영상의 안쪽 조작부로 간 Tab 처럼 문서에는 초점 이동이 없는 Tab 이 있다 — 그 기록이 남아 있으면, 그 뒤에 프로그램이 옮긴 초점
//  (새로 뜬 창의 뿌리·autoFocus)을 '밖으로 나간 Tab'으로 보고 이전 창으로 끌고 갔다.
it("맡긴 Tab 의 기록은 다음 작업까지 남지 않는다 — 브라우저의 기본 이동은 그 키와 같은 작업 안에서 끝난다", async () => {
  act(() => root.render(page(<Modal id="win">{three}</Modal>)));
  focus("m2");
  keydownTab(); // 맡겼지만 문서의 초점은 그대로다(영상 안쪽 조작부로 간 Tab 처럼)
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  focus("bar"); // 한참 뒤 프로그램이 준 초점
  expect(activeId()).toBe("bar");
});

it("맡긴 Tab 뒤에 새 창이 떠도 그 창의 초점을 이전 창으로 끌고 가지 않는다 — 뿌리로 간 초점도, 창이 스스로 준 초점(autoFocus)도", () => {
  const view = (upper: ReactNode) => page(<Modal id="lower">{three}</Modal>, upper);
  act(() => root.render(view(null)));
  focus("m2");
  keydownTab();
  act(() => root.render(view(<Modal id="upper"><button id="u1">1</button></Modal>))); // 조회가 끝나 뜬 창(부분 수정 등)
  expect(activeId()).toBe("upper");
  act(() => root.render(view(null)));
  focus("m2");
  keydownTab();
  act(() => root.render(view(<Modal id="upper"><button id="u1">1</button><input id="pw" autoFocus /></Modal>)));
  expect(activeId()).toBe("pw");
  expect(el("upper").hasAttribute("tabindex")).toBe(false);
});

it("맡긴 Tab 뒤에 그 창이 닫히면 기록은 무효다 — 돌려준 초점을 닫힌 창으로 다시 끌고 가지 않는다", () => {
  function Kept({ open }: { open: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    useModalFocus(ref, open);
    return <div id="win" ref={ref}>{three}</div>; // 닫혀도 그려져 있는 창(늘 마운트)
  }
  act(() => root.render(page(<Kept open={false} />)));
  focus("top");
  act(() => root.render(page(<Kept open />)));
  focus("m2");
  keydownTab();
  act(() => root.render(page(<Kept open={false} />))); // 닫히며 초점을 연 자리로 돌려준다
  expect(activeId()).toBe("top");
});

it("키가 전달되는 동안 프로그램이 옮긴 초점은 그 Tab 의 기본 이동이 아니다 — 되돌리지 않는다", () => {
  act(() => root.render(page(<Modal id="win">{three}</Modal>)));
  focus("m2");
  const move = () => el("bar").focus(); // 같은 키를 듣는 다른 리스너가 초점을 옮긴다
  document.addEventListener("keydown", move);
  try {
    keydownTab();
  } finally {
    document.removeEventListener("keydown", move);
  }
  expect(activeId()).toBe("bar");
});

// ── 뿌리에 놓인 초점의 스크롤 키 ──
//  창을 연 직후 초점은 뿌리에 있다. 그때의 Space·PageDown·방향키는 브라우저가 뿌리의 조상(뒤 화면 — 분리 관리 창의 본문,
//  관리자 창의 본문)을 스크롤한다. 전엔 초점이 뒤 격자에 있어 격자가 막았지만 이제 그 키는 격자에 닿지 않는다.
it("뿌리에 초점이 놓여 있을 때의 스크롤 키는 뒤 화면을 밀지 않는다 — 스스로 스크롤하는 창은 그 창이 민다. 창 안 단추의 Space 는 그대로다", () => {
  const press = (key: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    act(() => { (document.activeElement ?? document.body).dispatchEvent(event); });
    return event.defaultPrevented;
  };
  act(() => root.render(page(<Modal id="win">{three}</Modal>)));
  expect(activeId()).toBe("win");
  expect([" ", "PageDown", "PageUp", "Home", "End", "ArrowDown", "ArrowUp"].map((key) => press(key))).toEqual([true, true, true, true, true, true, true]);
  expect(press(" ", { shiftKey: true })).toBe(true);
  expect(press("a")).toBe(false); // 스크롤 키만
  expect(press("ArrowDown", { altKey: true })).toBe(false);
  // 뿌리가 스스로 스크롤하는 창(설정 창) — 그 창의 스크롤이다
  Object.defineProperty(el("win"), "scrollHeight", { configurable: true, value: 900 });
  Object.defineProperty(el("win"), "clientHeight", { configurable: true, value: 300 });
  el("win").style.overflowY = "auto";
  expect(press(" ")).toBe(false);
  expect(press("PageDown")).toBe(false);
  el("win").style.overflowY = "";
  expect(press(" ")).toBe(true); // 넘쳐도 스크롤하지 않는 뿌리(overflow visible)
  // 창 안의 단추 — Space 는 그 단추를 누르는 키다
  focus("m1");
  expect(press(" ")).toBe(false);
  expect(press("ArrowDown")).toBe(false);
  // 창이 닫히면 관여하지 않는다
  act(() => root.render(page(null)));
  expect(press(" ")).toBe(false);
});

it("되돌릴 때도 다른 모달 대화상자(aria-modal)를 가린다 — 영역 밖의 것에 내려앉은 초점은 두고, 영역 안의 것에서 나간 초점은 그 대화상자로", () => {
  act(() => root.render(page(
    <Modal id="win">
      <button id="m1">1</button>
      <div aria-modal="true"><button id="d1">1</button><button id="d2">2</button><button id="d3">3</button></div>
      <button id="m2">2</button>
    </Modal>,
    <div aria-modal="true"><button id="x1">1</button></div>,
  )));
  focus("m1");
  keydownTab();
  focus("x1"); // 맡긴 Tab 이 영역 밖의 모달 대화상자(업데이트 진행 덮개)에 내려앉았다 — 그쪽이 스스로 가둔다
  expect(activeId()).toBe("x1");
  focus("d2");
  keydownTab();
  focus("m2"); // 안쪽 대화상자에서 맡긴 Tab 이 그 대화상자를 벗어났다(창 안이지만 대화상자의 뒤)
  expect(activeId()).toBe("d1");
});

// 2026-10-11 실측: 비교 창의 그림을 휠(가운데) 단추로 누른 뒤에는 Esc 를 두 번 눌러야 닫혔다(5/5) — 브라우저의 자동 스크롤 모드.
it("모달 안의 휠(가운데) 누름은 기본 동작(자동 스크롤)을 막는다 — 왼쪽·오른쪽 누름, 창 밖의 누름은 그대로다. 누름은 그 자리의 처리에 그대로 닿는다", () => {
  const mouse = (id: string, button: number) => {
    const event = new MouseEvent("mousedown", { button, bubbles: true, cancelable: true });
    act(() => { el(id).dispatchEvent(event); });
    return event.defaultPrevented;
  };
  const reached = vi.fn();
  act(() => root.render(page(null)));
  expect(mouse("bar", 1)).toBe(false); // 떠 있는 창이 없으면 손대지 않는다(보드의 휠 끌기 등은 각자 정한다)
  act(() => root.render(page(<Modal id="win"><button id="m1" onMouseDown={reached}>1</button></Modal>)));
  expect(mouse("m1", 1)).toBe(true);
  expect(reached).toHaveBeenCalledTimes(1); // 전파는 막지 않는다 — 휠 클릭의 기능(auxclick)은 그대로다
  expect(mouse("win", 1)).toBe(true);
  expect(mouse("m1", 0)).toBe(false);
  expect(mouse("m1", 2)).toBe(false);
  expect(mouse("bar", 1)).toBe(false); // 창 밖(막·뒤 화면)
  act(() => root.render(page(null)));
  expect(mouse("bar", 1)).toBe(false);
});

it("StrictMode 에서도 창이 스스로 준 초점(autoFocus)이 남는다 — effect 가 다시 돌 때 뿌리로 옮기지 않는다(개발 화면)", () => {
  act(() => root.render(<StrictMode>{page(null)}</StrictMode>));
  focus("top");
  act(() => root.render(<StrictMode>{page(<Modal id="win"><button id="m1">1</button><input id="pw" autoFocus /></Modal>)}</StrictMode>));
  expect(activeId()).toBe("pw");
  expect(el("win").hasAttribute("tabindex")).toBe(false);
  act(() => root.render(<StrictMode>{page(null)}</StrictMode>));
  expect(activeId()).toBe("top");
});

it("닫았다가 다시 연 창은 지난번 자리가 아니라 뿌리에서 시작한다(effect 가 다시 돈 것과 다르다)", () => {
  function Kept({ open }: { open: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    useModalFocus(ref, open);
    return <div id="win" ref={ref}>{three}</div>; // 닫혀도 그려져 있는 창(늘 마운트)
  }
  act(() => root.render(page(<Kept open={false} />)));
  focus("top");
  act(() => root.render(page(<Kept open />)));
  focus("m2");
  act(() => root.render(page(<Kept open={false} />)));
  expect(activeId()).toBe("top"); // 닫히며 연 자리로 돌아갔다
  act(() => root.render(page(<Kept open />)));
  expect(activeId()).toBe("win");
});

// Codex 조작 점검(2026-10-14) — 모달이 떠 있는 동안 body 에 표(data-modal-open)를 둔다. CSS 가 그 표로 Resolve 결과의 남는 안내를 모달 뒤로
//  내린다: 모달의 Tab 순환은 그 창 안만 돌아, 안내가 위에 보여도 키보드로는 ✕ 에 닿지 못했다.
it("모달이 하나라도 떠 있으면 body 에 data-modal-open 이 붙고 다 닫히면 떼어진다 — 남는 안내의 CSS 가 그 표를 쓴다", () => {
  const first = document.createElement("div"), second = document.createElement("div");
  for (const el of [first, second]) { el.tabIndex = -1; document.body.append(el); }
  const a = {}, b = {};
  expect(document.body.hasAttribute("data-modal-open")).toBe(false);
  openModal(a, nextLayerSeq(), () => [first]);
  openModal(b, nextLayerSeq(), () => [second]);
  expect(document.body.hasAttribute("data-modal-open")).toBe(true);
  closeModal(b, null);
  expect(document.body.hasAttribute("data-modal-open")).toBe(true); // 아래에 하나 남았다
  closeModal(a, null);
  expect(document.body.hasAttribute("data-modal-open")).toBe(false);
  closeModal(a, null); // 이미 닫은 것을 또 닫아도 그대로다
  expect(document.body.hasAttribute("data-modal-open")).toBe(false);
  first.remove();
  second.remove();
  const css = readFileSync(new NodeURL("../src/styles/assets.css", import.meta.url), "utf8");
  expect(css).toMatch(/body\[data-modal-open\] \.resolve-notices\s*\{[^}]*z-index:\s*140/);
  expect(Number(/\n\.resolve-notices\s*\{[^}]*z-index:\s*(\d+)/.exec(css)![1])).toBe(400); // 모달이 없을 때는 알림과 같은 층
});