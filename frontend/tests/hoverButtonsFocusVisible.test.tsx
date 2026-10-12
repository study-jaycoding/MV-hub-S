// @vitest-environment jsdom
// 호버 때만 보이는 단추들(조작 규칙 51 — 24회차, Codex 전수 검토): opacity:0 은 Tab 순서에서 빠지지 않는다 — 안 보이는 ↻(재생성)에 Tab 으로
//  닿아 Enter 를 누르면 보이지도 않는 채 재생성 요청이 나갔다. 키보드 초점이 들어오면(:focus-within / :focus) 호버 때처럼 보인다.
//  진짜 CSS 를 올려 계산된 값을 본다 — 라이브러리 카드의 오버레이·S·C 단추, 계보 노드의 오버레이, 코멘트 줄의 답글·수정·삭제.
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";

const css = (name: string) => readFileSync(new NodeURL(`../src/styles/${name}.css`, import.meta.url), "utf8");
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

// jsdom 은 계산된 스타일을 문서 단위로 캐시하고 **속성·구조가 바뀔 때만** 비운다 — 초점이 옮겨 간 것으로는 안 비워져, 초점 전에 한 번 읽었으면
//  그 뒤로 :focus 규칙이 계산에 반영되지 않는다. 읽기 전에 속성을 하나 건드려 캐시를 비운다.
let tick = 0;
const fresh = (selector: string) => { document.body.setAttribute("data-tick", String(++tick)); return getComputedStyle(host.querySelector(selector)!); };
const opacity = (selector: string) => fresh(selector).opacity;
const pointer = (selector: string) => fresh(selector).pointerEvents;
const focus = (selector: string) => act(() => host.querySelector<HTMLElement>(selector)!.focus());
const blur = () => act(() => (document.activeElement as HTMLElement | null)?.blur());

it("라이브러리 카드: 오버레이의 단추(↻ 등)에 초점이 들어오면 오버레이가 보이고, 나가면 다시 숨는다", () => {
  act(() => root.render(<><style>{css("generations")}</style>
    <div className="card"><div className="card-thumb"><div className="thumb-overlay"><button className="ov-icon" title="재생성">↻</button></div></div></div></>));
  expect(opacity(".thumb-overlay")).toBe("0");
  focus(".ov-icon");
  expect(opacity(".thumb-overlay")).toBe("1"); // 전엔 0 — 초점이 있어도 보이지 않았다
  blur();
  expect(opacity(".thumb-overlay")).toBe("0");
});

it("라이브러리 카드: 좌상단 S·C 단추에 초점이 들어오면 보이고 누를 수 있다", () => {
  act(() => root.render(<><style>{css("generations")}</style>
    <div className="card"><div className="card-tl"><button className="card-sf">S</button><button className="card-cm">C</button></div></div></>));
  expect([opacity(".card-sf"), pointer(".card-sf")]).toEqual(["0", "none"]);
  focus(".card-sf");
  expect([opacity(".card-sf"), pointer(".card-sf")]).toEqual(["1", "auto"]);
  expect(opacity(".card-cm")).toBe("0"); // 초점이 든 단추만
  focus(".card-cm");
  expect([opacity(".card-cm"), pointer(".card-cm")]).toEqual(["1", "auto"]);
});

it("계보 노드: 오버레이의 단추에 초점이 들어오면 오버레이가 보이고 단추가 눌린다", () => {
  act(() => root.render(<><style>{css("history")}</style>
    <div className="linb-node"><div className="linb-ov"><button className="linb-ov-btn" title="재생성">↻</button></div></div></>));
  expect([opacity(".linb-ov"), pointer(".linb-ov-btn")]).toEqual(["0", "none"]);
  focus(".linb-ov-btn");
  expect([opacity(".linb-ov"), pointer(".linb-ov-btn")]).toEqual(["1", "auto"]);
});

it("코멘트 줄: 답글·수정·삭제에 초점이 들어오면 보인다", () => {
  act(() => root.render(<><style>{css("assets")}</style>
    <div className="cmt-item"><div className="cmt-meta"><div className="cmt-acts"><button>답글</button><button>삭제</button></div></div></div></>));
  expect(opacity(".cmt-acts")).toBe("0");
  focus(".cmt-acts button:last-child");
  expect(opacity(".cmt-acts")).toBe("1");
});
