// @vitest-environment jsdom
// 공유 탭 카드(Jay 2026-10-30): 공유 S 는 호버 때만(최종 ★·보류 표는 그대로), 호버·선택 때 ⓘ 에 덮이는 작업자 이름표는 숨긴다.
//  진짜 CSS 를 올려 계산된 값을 본다. 워크스페이스 칸과 편집 탭 카드(.gen-cell 밖 — 편집 탭도 tab="team")는 그대로여야 한다.
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThumbnailGrid } from "../src/components/ThumbnailGrid";
import type { Generation } from "../src/types";

vi.mock("virtua", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return { Virtualizer: forwardRef((props: { data: unknown[]; children: (row: unknown) => React.ReactNode }, ref) => {
    useImperativeHandle(ref, () => ({ scrollToIndex: () => {} }));
    return <>{props.data.map(props.children)}</>;
  }) };
});
vi.mock("../src/api", () => ({ api: { thumbOrRaw: (path: string) => path, mediaUrl: (path: string) => path } }));
vi.mock("../src/lib/useGenerationViewsSynced", () => ({ useGenerationViewsSynced: () => ({ card: {}, asset: {} }) }));
vi.mock("../src/lib/modelCatalog", () => ({ useModelDisplayName: () => (name: string) => name }));
vi.mock("../src/lib/i18n", () => ({ t: (value: string) => value, useT: () => (value: string) => value }));
vi.mock("../src/components/MediaThumbnail", () => ({ MediaThumbnail: () => <span>thumbnail</span> }));

const css = readFileSync(new NodeURL("../src/styles/generations.css", import.meta.url), "utf8");
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  HTMLElement.prototype.scrollTo = vi.fn();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

let tick = 0; // jsdom 계산값 캐시를 비운다(hoverButtonsFocusVisible.test 와 같은 까닭)
const fresh = (selector: string) => { document.body.setAttribute("data-tick", String(++tick)); return getComputedStyle(host.querySelector(selector)!); };

const card = (mark = "", selected = false) => (
  <div className={"card" + (selected ? " selected" : "")}>
    <div className="card-thumb">
      <span className="creator-badge">리버</span>
      <div className="card-tl"><button className={"card-sf on" + mark}>S</button></div>
    </div>
  </div>
);
const show = (cell: string, inner = card()) =>
  act(() => root.render(<><style>{css}</style><div className={cell}>{inner}</div></>));

it("공유 탭 칸: 공유 S 는 숨고, 최종 ★·보류 표는 그대로 보인다", () => {
  show("gen-cell team");
  expect(fresh(".card-sf").opacity).toBe("0");
  show("gen-cell team", card(" final"));
  expect(fresh(".card-sf").opacity).toBe("1");
  show("gen-cell team", card(" held"));
  expect(fresh(".card-sf").opacity).toBe("1");
});

it("공유 탭 칸: Tab 으로 S 에 닿으면 보인다", () => {
  show("gen-cell team");
  act(() => host.querySelector<HTMLElement>(".card-sf")!.focus());
  expect(fresh(".card-sf").opacity).toBe("1");
});

it("공유 탭 칸: 고른 카드는 작업자 이름표를 숨기고, 안 고른 카드는 보인다", () => {
  show("gen-cell team");
  expect(fresh(".creator-badge").display).not.toBe("none");
  show("gen-cell team", card("", true));
  expect(fresh(".creator-badge").display).toBe("none");
});

it("워크스페이스 칸·편집 탭 카드(.gen-cell 밖): S 도 이름표도 그대로다", () => {
  for (const cell of ["gen-cell", "ed-card"]) {
    show(cell, card("", true));
    expect(fresh(".card-sf").opacity).toBe("1");
    expect(fresh(".creator-badge").display).not.toBe("none");
  }
});

it("격자: 공유 탭 칸에만 team 표시가 붙는다", () => {
  const noop = () => {};
  const gen = { id: "g1", model: "test", prompt: "test", status: "done", created_at: "2026-10-01T12:00:00Z", shared: true,
    assets: [{ id: "a1", type: "image", file_path: "/g1.png" }], tags: [], auto_tags: [], references: [], is_mine: true, params: {} } as unknown as Generation;
  const draw = (tab: "my" | "team") => act(() => root.render(
    <ThumbnailGrid generations={[gen]} tab={tab} scale={1} fill layout="grid" groupByDate={false}
      selectedIds={new Set()} onSelectedChange={noop} onToggleSelect={noop} onSetSource={noop} onSetTags={noop} onOpenComments={noop}
      onRegenerate={noop} onPublish={noop} onUnpublish={noop} onFinalize={noop} onUnfinalize={noop} onImport={noop} onRestore={noop}
      dimDeleted={false} onInfo={noop} onPreview={noop} />,
  ));
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
  draw("team");
  expect(host.querySelector(".gen-cell")!.classList.contains("team")).toBe(true);
  draw("my");
  expect(host.querySelector(".gen-cell")!.classList.contains("team")).toBe(false);
});

it("호버: S 가 다시 뜨는 조건과 이름표를 숨기는 조건이 CSS 에 있다(jsdom 은 :hover 를 못 켠다)", () => {
  expect(css).toContain(".gen-cell.team .card:not(:hover) .card-sf.on:not(.held):not(.final):not(:focus) { opacity: 0; }");
  expect(css).toContain(".gen-cell.team .card-thumb:hover .creator-badge");
});
