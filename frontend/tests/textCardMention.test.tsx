// @vitest-environment jsdom
// 캔버스 텍스트 노드 편집칸(Jay 2026-10-29) — 쓰는 중에도 이어진 번호는 알약 · @ 를 치면 이어진 레퍼런스(알약과 같은 번호)를 @ 자리 바로 위에.
//  고르면 그 번호 알약 + 띄어쓰기를 그 자리에 넣고 캐럿은 그 뒤 · Esc 는 목록만 닫음 · 시작·끝(@simage)은 목록에 없음 · 저장 글은 친 그대로.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextCard } from "../src/components/scene/cards/TextCard";
import type { SceneCard, SceneEdge, SceneRef } from "../src/lib/scenes";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); window.getSelection()?.removeAllRanges(); });

const ref = (name: string, type: string): SceneRef => ({ type, name, file_path: `/fixtures/${name}`, thumb: type === "audio" ? null : `/fixtures/${name}` });
const noop = () => {};

function mount(initial = "", connected = true, editing = true) {
  const setEditTextId = vi.fn();
  const refsCard: SceneCard = { id: "r", kind: "reference", x: 0, y: 0, refs: [ref("a.png", "image"), ref("b.png", "image"), ref("v.mp4", "video"), ref("s.wav", "audio")] };
  const edges: SceneEdge[] = connected ? [{ id: "e", from: "r", to: "t" }] : [];
  let current = initial;
  function Harness() {
    const [text, setText] = useState(initial);
    current = text;
    const card: SceneCard = { id: "t", kind: "text", x: 0, y: 0, text };
    return (
      <div className="scene-card">
        <TextCard card={card} cardsById={new Map([["t", card], ["r", refsCard]])} resolvedEdges={edges} genData={{}} editing={editing}
          caretPosRef={{ current: new Map() }} setEditTextId={setEditTextId} setSelected={noop} setNodeText={(_, t) => setText(t)}
          flushPending={noop} onOutPortDown={noop} onResizeDown={noop} />
      </div>
    );
  }
  act(() => root.render(<Harness />));
  return { setEditTextId, text: () => current };
}
const ed = () => host.querySelector<HTMLElement>(".scene-textedit")!;
// 사용자가 친 것처럼 — 칸의 글을 바꾸고 캐럿을 글자 pos 에(기본 끝) 두고 input 을 보낸다
const typeTo = (value: string, pos = value.length, inputType = "insertText") => act(() => {
  ed().textContent = value;
  const r = document.createRange();
  r.setStart(ed().firstChild ?? ed(), ed().firstChild ? pos : 0);
  r.collapse(true);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(r);
  ed().dispatchEvent(new InputEvent("input", { bubbles: true, inputType }));
});
const key = (k: string) => act(() => { ed().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
// 브라우저의 insertText — 고른 글을 바꾸고 캐럿을 뒤에 두고 input 을 보낸다(입력 이벤트가 그 자리에서 동기로 온다)
const stubInsertText = () => {
  const execCommand = vi.fn((_name: string, _ui: boolean, value: string) => {
    const range = window.getSelection()!.getRangeAt(0);
    expect(range.toString()).toMatch(/^@/);
    range.deleteContents();
    const text = document.createTextNode(value);
    range.insertNode(text);
    range.setStart(text, text.length);
    range.collapse(true);
    ed().dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    return true;
  });
  Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
  return execCommand;
};
const pop = () => host.querySelector(".scene-textmention");
const tokens = () => [...host.querySelectorAll(".scene-textmention .sl-mention-name")].map((t) => [t.textContent, t.className]);
const pills = () => [...ed().querySelectorAll("[data-tok]")].map((p) => p.textContent);

it("편집칸을 열면 저장된 글의 이어진 번호가 알약 · 이어지지 않은 번호는 글자 · 글은 그대로", () => {
  const view = mount("@image1 과 <<<image2>>> 가 @image9 와");
  expect(pills()).toEqual(["@image1", "<<<image2>>>"]);
  expect(ed().textContent).toContain("@image9");
  expect(view.text()).toBe("@image1 과 <<<image2>>> 가 @image9 와");
  expect(document.activeElement).toBe(ed());
});

it("치는 중인 토큰은 글자, 띄어쓰기를 치면 알약 — 저장 글은 친 그대로", () => {
  const view = mount();
  typeTo("두 팀 @image1");
  expect(pills()).toEqual([]);
  typeTo("두 팀 @image1 이 달린다");
  expect(pills()).toEqual(["@image1"]);
  expect(view.text()).toBe("두 팀 @image1 이 달린다");
});

it("@ 를 치면 이어진 레퍼런스가 알약 종류 클래스로 · 카드는 끝 점 층 위로", () => {
  mount("두 팀이 ");
  typeTo("두 팀이 @");
  expect(tokens()).toEqual([
    ["@image1", "sl-mention-name sl-tok sl-mention-tok sl-tok-image"],
    ["@image2", "sl-mention-name sl-tok sl-mention-tok sl-tok-image"],
    ["@video1", "sl-mention-name sl-tok sl-mention-tok sl-tok-video"],
    ["@audio1", "sl-mention-name sl-tok sl-mention-tok sl-tok-audio"],
  ]);
  expect(host.querySelector(".scene-card")!.hasAttribute("data-pop-open")).toBe(true);
  expect(host.querySelector(".scene-textmention .sl-mention-tags")!.textContent).toBe("a.png");
});

it("@ 뒤 글자로 거르고, ↓·Enter 로 고르면 그 번호 알약 + 띄어쓰기가 들어가고 목록이 닫힌다", () => {
  const view = mount();
  typeTo("@im");
  expect(tokens().map(([t]) => t)).toEqual(["@image1", "@image2"]);
  key("ArrowDown"); key("Enter");
  expect(view.text()).toBe("@image2 ");
  expect(pills()).toEqual(["@image2"]);
  expect(pop()).toBeNull();
  expect(host.querySelector(".scene-card")!.hasAttribute("data-pop-open")).toBe(true); // 쓰는 동안은 큰 창 때문에 계속 위
});

it("글 중간의 @ 도 그 자리만 바꾼다 · 뒤 글은 그대로", () => {
  const view = mount("from  without");
  typeTo("from @vi without", "from @vi".length);
  expect(tokens().map(([t]) => t)).toEqual(["@video1"]);
  key("Tab");
  expect(view.text()).toBe("from @video1  without");
});

it("Esc 는 목록만 닫고 편집은 그대로 — 한 번 더 Esc 면 편집 끝", () => {
  const view = mount();
  typeTo("@");
  key("Escape");
  expect(pop()).toBeNull();
  expect(view.setEditTextId).not.toHaveBeenCalled();
  key("Escape");
  expect(view.setEditTextId).toHaveBeenCalledWith(null);
});

it("알약을 누르면 글자로 풀린다", () => {
  const view = mount("@image1 뒤");
  act(() => { (ed().querySelector("[data-tok]") as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  expect(pills()).toEqual([]); // 캐럿이 그 토큰 끝에 있어 글자로 남는다
  expect(view.text()).toBe("@image1 뒤");
});

it("붙여넣기·줄바꿈은 브라우저에 맡긴다 — 서식 없는 칸이고 가로채지 않아 Ctrl+Z 기록이 남는다(실제 크롬 실측은 작업 기록)", () => {
  mount("글");
  expect(ed().getAttribute("contenteditable")).toBe("plaintext-only");
  const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  act(() => { ed().dispatchEvent(enter); ed().dispatchEvent(paste); });
  expect(enter.defaultPrevented).toBe(false);
  expect(paste.defaultPrevented).toBe(false);
});

describe("되돌리기 — 브라우저 기록 대신 칸의 글을 직접 되돌린다", () => {
  const press = (init: KeyboardEventInit) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    act(() => { ed().dispatchEvent(event); });
    return event;
  };
  const beforeInput = (inputType: string) => {
    const event = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType });
    act(() => { ed().dispatchEvent(event); });
    return event;
  };
  const undoKey = { key: "z", ctrlKey: true };
  const later = () => vi.spyOn(performance, "now");

  it("Ctrl+Z 가 브라우저로 가지 않고 앞 글로 돌아가며 저장도 되돌린다 · Ctrl+Y·Ctrl+Shift+Z 는 다시 앞으로", () => {
    const clock = later().mockReturnValue(1000);
    const view = mount("글");
    typeTo("글자");
    clock.mockReturnValue(5000);
    typeTo("글자 더");
    expect(press(undoKey).defaultPrevented).toBe(true);
    expect(view.text()).toBe("글자");
    press(undoKey);
    expect(view.text()).toBe("글");
    press({ key: "y", ctrlKey: true });
    expect(view.text()).toBe("글자");
    press({ key: "Z", ctrlKey: true, shiftKey: true });
    expect(view.text()).toBe("글자 더");
    expect(ed().textContent).toBe("글자 더");
    clock.mockRestore();
  });

  it("알약이 든 글도 되돌린 자리에서 다시 알약이 된다 · 앞 글은 지워지지 않는다", () => {
    const clock = later().mockReturnValue(1000);
    const view = mount("앞\n");
    typeTo("앞\n@image1 뒤");
    expect(pills()).toEqual(["@image1"]);
    clock.mockReturnValue(5000);
    typeTo("앞\n@image1 뒤끝");
    press(undoKey);
    expect(view.text()).toBe("앞\n@image1 뒤");
    expect(pills()).toEqual(["@image1"]);
    press(undoKey);
    expect(view.text()).toBe("앞\n");
    expect(pills()).toEqual([]);
    clock.mockRestore();
  });

  it("치는 중이던 토큰으로 돌아가면 글자로 둔다 — 이어 친 번호가 저장과 어긋나지 않게", () => {
    const clock = later().mockReturnValue(1000);
    const view = mount();
    typeTo("@image1");
    clock.mockReturnValue(5000);
    typeTo("@image1 ");
    expect(pills()).toEqual(["@image1"]);
    press(undoKey);
    expect(view.text()).toBe("@image1");
    expect(pills()).toEqual([]);
    clock.mockRestore();
  });

  it("우클릭 메뉴의 되돌리기(beforeinput)도 같은 길이고 브라우저 기록은 돌지 않는다", () => {
    const clock = later().mockReturnValue(1000);
    const view = mount("글");
    typeTo("글자");
    expect(beforeInput("historyUndo").defaultPrevented).toBe(true);
    expect(view.text()).toBe("글");
    expect(beforeInput("historyRedo").defaultPrevented).toBe(true);
    expect(view.text()).toBe("글자");
    expect(beforeInput("insertText").defaultPrevented).toBe(false);
    clock.mockRestore();
  });

  it("조합 중에는 칸을 다시 채우지 않고, 조합이 끝난 글은 한 걸음으로 남는다", () => {
    const clock = later().mockReturnValue(1000);
    const view = mount("글");
    typeTo("글자");
    clock.mockReturnValue(5000);
    act(() => { ed().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); });
    typeTo("글자ㅎ");
    expect(beforeInput("historyUndo").defaultPrevented).toBe(true);
    expect(ed().textContent).toBe("글자ㅎ"); // 조합 상태를 깨지 않는다
    clock.mockReturnValue(7000); // 조합 조각은 시간이 벌어져도 기록하지 않는다
    typeTo("글자하");
    clock.mockReturnValue(9000);
    act(() => { ed().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); });
    press(undoKey);
    expect(view.text()).toBe("글자");
    clock.mockRestore();
  });

  it.each([["줄바꿈", "insertLineBreak", "글자\n"], ["붙여넣기", "insertFromPaste", "글자더"], ["잘라내기", "deleteByCut", "글"]])("%s 는 바로 앞 입력과 묶이지 않는다", (_name, inputType, after) => {
    const clock = later().mockReturnValue(1000);
    const view = mount("글");
    typeTo("글자");
    typeTo(after, after.length, inputType);
    press(undoKey);
    expect(view.text()).toBe("글자");
    clock.mockRestore();
  });

  it("@ 목록이 떠 있어도 Ctrl+Z 는 글을 되돌리고 목록은 새 글로 다시 판단한다", () => {
    const clock = later().mockReturnValue(1000);
    const view = mount("앞");
    clock.mockReturnValue(5000);
    typeTo("앞 @");
    expect(pop()).not.toBeNull();
    press(undoKey);
    expect(view.text()).toBe("앞");
    expect(pop()).toBeNull();
    clock.mockRestore();
  });

  it("밖에서 글이 바뀌면 그 글이 새 기준이다 — 지난 기록으로 덮지 않는다", () => {
    const refsCard: SceneCard = { id: "r", kind: "reference", x: 0, y: 0, refs: [] };
    let setOutside: (text: string) => void = noop;
    function Outside() {
      const [text, setText] = useState("처음");
      setOutside = setText;
      const card: SceneCard = { id: "t", kind: "text", x: 0, y: 0, text };
      return (
        <div className="scene-card">
          <TextCard card={card} cardsById={new Map([["t", card], ["r", refsCard]])} resolvedEdges={[]} genData={{}} editing
            caretPosRef={{ current: new Map() }} setEditTextId={noop} setSelected={noop} setNodeText={(_, t) => setText(t)}
            flushPending={noop} onOutPortDown={noop} onResizeDown={noop} />
        </div>
      );
    }
    act(() => root.render(<Outside />));
    typeTo("처음 고침");
    act(() => setOutside("밖에서 바꿈"));
    expect(ed().textContent).toBe("밖에서 바꿈");
    press(undoKey);
    expect(ed().textContent).toBe("밖에서 바꿈");
  });

  it("닫았다 열면 기록이 새로 시작한다 — 지난 편집을 칸 안 Ctrl+Z 로 되살리지 않는다", () => {
    const clock = later().mockReturnValue(1000);
    function Toggle() {
      const [editing, setEditing] = useState(true);
      const [text, setText] = useState("글");
      const card: SceneCard = { id: "t", kind: "text", x: 0, y: 0, text };
      return (
        <div className="scene-card">
          <button id="toggle" onClick={() => setEditing(!editing)} />
          <TextCard card={card} cardsById={new Map([["t", card]])} resolvedEdges={[]} genData={{}} editing={editing}
            caretPosRef={{ current: new Map() }} setEditTextId={noop} setSelected={noop} setNodeText={(_, t) => setText(t)}
            flushPending={noop} onOutPortDown={noop} onResizeDown={noop} />
        </div>
      );
    }
    act(() => root.render(<Toggle />));
    typeTo("글자");
    const toggle = () => act(() => { host.querySelector<HTMLElement>("#toggle")!.click(); });
    toggle();
    toggle();
    press(undoKey);
    expect(ed().textContent).toBe("글자");
    clock.mockRestore();
  });
});

it("@ 고르기는 브라우저 편집 명령으로 글자를 넣고 알약으로 감싼다 · 고른 범위는 @검색어 뿐이다", () => {
  const view = mount("앞 ");
  typeTo("앞 @im 뒤", "앞 @im".length);
  const execCommand = stubInsertText();
  try {
    key("ArrowDown"); key("Enter");
  } finally {
    Reflect.deleteProperty(document, "execCommand");
  }
  expect(execCommand).toHaveBeenCalledWith("insertText", false, "@image2 ");
  expect(view.text()).toBe("앞 @image2  뒤");
  expect(pills()).toEqual(["@image2"]);
  expect(pop()).toBeNull();
});

it("@ 고르기는 앞뒤 입력과 따로 한 걸음이다 — 바로 이어 쳐도 고르기까지 되돌아가지 않는다", () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
  const view = mount("앞 ");
  typeTo("앞 @im");
  stubInsertText();
  try {
    key("ArrowDown"); key("Enter");
  } finally {
    Reflect.deleteProperty(document, "execCommand");
  }
  expect(view.text()).toBe("앞 @image2 ");
  typeTo("앞 @image2 x"); // 같은 시각 — 0.7초 안의 이어 치기
  const undo = () => act(() => { ed().dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true })); });
  undo();
  expect(view.text()).toBe("앞 @image2 ");
  undo();
  expect(view.text()).toBe("앞 @im");
  undo();
  expect(view.text()).toBe("앞 ");
  clock.mockRestore();
});

it("편집을 끝내고 보기로 돌아가면 글이 한 번만 — 편집칸에 넣은 알약이 보기 칸에 남지 않는다(Jay 10-29 겹침)", () => {
  const refsCard: SceneCard = { id: "r", kind: "reference", x: 0, y: 0, refs: [ref("a.png", "image")] };
  function Toggle() {
    const [editing, setEditing] = useState(true);
    const [text, setText] = useState("@image1 과 시합");
    const card: SceneCard = { id: "t", kind: "text", x: 0, y: 0, text };
    return (
      <div className="scene-card">
        <TextCard card={card} cardsById={new Map([["t", card], ["r", refsCard]])} resolvedEdges={[{ id: "e", from: "r", to: "t" }]} genData={{}}
          editing={editing} caretPosRef={{ current: new Map() }} setEditTextId={(id) => setEditing(id === "t")} setSelected={noop}
          setNodeText={(_, t) => setText(t)} flushPending={noop} onOutPortDown={noop} onResizeDown={noop} />
      </div>
    );
  }
  act(() => root.render(<Toggle />));
  expect(pills()).toEqual(["@image1"]);
  // 쓰는 동안 = 노드 위 큰 편집 창(시안 B) · 그 아래 노드는 숨김(노드가 커진 것처럼) · 카드는 위로
  expect(host.querySelector(".scene-textfloat .scene-textedit")).not.toBeNull();
  expect(host.querySelector(".scene-textview-inline")!.classList.contains("is-editing")).toBe(true);
  expect(host.querySelector(".scene-card")!.hasAttribute("data-pop-open")).toBe(true);
  expect(host.querySelector(".scene-card")!.hasAttribute("data-text-editing")).toBe(true);
  key("Escape"); // 편집 끝
  const view = host.querySelector(".scene-textview-inline")!;
  expect(view.textContent).toBe("@image1 과 시합");
  expect(view.querySelectorAll(".scene-inlinetok")).toHaveLength(1);
  expect(view.classList.contains("is-editing")).toBe(false);
  expect(host.querySelector(".scene-textfloat")).toBeNull();
  expect(host.querySelector(".scene-card")!.hasAttribute("data-pop-open")).toBe(false);
  expect(host.querySelector(".scene-card")!.hasAttribute("data-text-editing")).toBe(false);
});

it("메일 주소 같은 @ 는 목록 없음 · 이어진 레퍼런스가 없으면 안내 한 줄 · 편집 중이 아니면 편집칸·목록 없음", () => {
  mount();
  typeTo("me@image");
  expect(pop()).toBeNull();
  act(() => root.unmount()); root = createRoot(host);
  mount("", false);
  typeTo("@");
  expect(host.querySelector(".scene-textmention .sl-mention-empty")!.textContent).toBe("이 텍스트 노드에 이어진 레퍼런스가 없습니다");
  act(() => root.unmount()); root = createRoot(host);
  mount("@", true, false);
  expect(host.querySelector(".scene-textedit")).toBeNull();
  expect(pop()).toBeNull();
});
