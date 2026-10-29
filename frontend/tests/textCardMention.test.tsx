// @vitest-environment jsdom
// 캔버스 텍스트 노드 @ 고르기(Jay 2026-10-29) — 편집 중 @ 를 치면 이 노드에 이어진 레퍼런스(알약과 같은 번호)를 @ 자리 바로 위에.
//  고르면 '@image2 ' 를 그 자리에 넣고 캐럿은 그 뒤 · Esc 는 목록만 닫음 · 시작·끝(@simage)은 목록에 없음.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TextCard } from "../src/components/scene/cards/TextCard";
import type { SceneCard, SceneEdge, SceneRef } from "../src/lib/scenes";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

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
const ta = () => host.querySelector<HTMLTextAreaElement>("textarea")!;
// 사용자가 친 것처럼 — 글을 바꾸고 캐럿을 pos 에(기본 끝) 두고 input 을 보낸다
const typeTo = (value: string, pos = value.length) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta(), value);
  ta().setSelectionRange(pos, pos);
  ta().dispatchEvent(new Event("input", { bubbles: true }));
});
const key = (k: string) => act(() => { ta().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
const pop = () => host.querySelector(".scene-textmention");
const tokens = () => [...host.querySelectorAll(".scene-textmention .sl-mention-name")].map((t) => [t.textContent, t.className]);

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

it("@ 뒤 글자로 거르고, ↓·Enter 로 고르면 '@image2 ' 가 들어가고 목록이 닫힌다", () => {
  const view = mount();
  typeTo("@im");
  expect(tokens().map(([t]) => t)).toEqual(["@image1", "@image2"]);
  key("ArrowDown"); key("Enter");
  expect(view.text()).toBe("@image2 ");
  expect(pop()).toBeNull();
  expect(host.querySelector(".scene-card")!.hasAttribute("data-pop-open")).toBe(false);
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
  expect(document.activeElement).not.toBe(ta());
});

it("메일 주소 같은 @ 는 목록 없음 · 이어진 레퍼런스가 없으면 안내 한 줄 · 편집 중이 아니면 없음", () => {
  mount();
  typeTo("me@image");
  expect(pop()).toBeNull();
  act(() => root.unmount()); root = createRoot(host);
  mount("", false);
  typeTo("@");
  expect(host.querySelector(".scene-textmention .sl-mention-empty")!.textContent).toBe("이 텍스트 노드에 이어진 레퍼런스가 없습니다");
  act(() => root.unmount()); root = createRoot(host);
  mount("@", true, false);
  expect(host.querySelector("textarea")).toBeNull();
  expect(pop()).toBeNull();
});
