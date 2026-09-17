// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HistoryBoardNode } from "../src/components/history/HistoryBoardNode";
import { HistoryBoard } from "../src/components/HistoryBoard";
import type { Generation } from "../src/types";

const fixture = vi.hoisted(() => ({ graph: null as unknown }));
vi.mock("../src/components/history/useHistoryGraph", () => ({ useHistoryGraph: () => ({ graph: fixture.graph, err: null }) }));
let host: HTMLDivElement;
let root: Root;
const noop = () => {};
const gen = (patch: Partial<Generation> = {}) => ({ id: "g", prompt: "test", status: "done", created_at: "2026-09-17",
  shared: false, is_held: false, is_final: false, is_mine: false, deleted: false,
  tags: [], auto_tags: [], assets: [], references: [], comment_count: 0, ...patch } as Generation);
function props(generation: Generation): ComponentProps<typeof HistoryBoardNode> {
  return { generation, x: 0, y: 0, width: 180, height: 180, isRoot: false, isSelected: false,
    onLine: false, offLine: false, fill: true, disabled: false, typeFilter: "all", sharedOnly: false,
    commentOnly: false, finalOnly: false, sConfirm: null, onSClick: vi.fn(), onSDouble: vi.fn(),
    onSConfirmYes: noop, onSConfirmNo: noop, onPreview: noop, onInfo: noop, onRegenerate: noop };
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  localStorage.clear(); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const cases = ["unshared", "shared", "held", "final"].flatMap(state => [false, true].flatMap(mine =>
  [false, true].map(may => ({ state, mine, may }))));
it.each(cases)("$state mine=$mine may=$may: action visibility preserves the separate status badge", ({ state, mine, may }) => {
  const p = props(gen({ is_mine: mine, shared: state !== "unshared", is_held: state === "held", is_final: state === "final" }));
  act(() => root.render(<HistoryBoardNode {...p} {...{ mayFinalize: may }} />));
  const button = [...host.querySelectorAll<HTMLButtonElement>(".linb-ov-top button")].find(el => ["S", "★"].includes(el.textContent || ""));
  const expected = mine || state === "held" || state === "final" || (state === "shared" && may);
  expect(!!button).toBe(expected);
  expect(!!host.querySelector(".linb-sf")).toBe(state !== "unshared");
  expect(host.querySelector(".linb-node")!.classList.contains("sf-readonly")).toBe(state !== "unshared" && !button);
  if (button) { act(() => button.click()); expect(p.onSClick).toHaveBeenCalledExactlyOnceWith(p.generation); }
  else expect(p.onSClick).not.toHaveBeenCalled();
});
it.each(["pending", "running", "failed"])("%s keeps the existing no-action condition", status => {
  act(() => root.render(<HistoryBoardNode {...props(gen({ status, is_mine: true }))} {...{ mayFinalize: true }} />));
  expect([...host.querySelectorAll(".linb-ov-top button")].some(el => el.textContent === "S")).toBe(false);
});
it.each(["pending", "running", "failed"])("shared %s retains its read-only badge without an action", status => {
  act(() => root.render(<HistoryBoardNode {...props(gen({ status, shared: true }))} mayFinalize />));
  expect(host.querySelector(".linb-sf")?.textContent).toBe("S");
  expect(host.querySelector(".linb-node")!.classList.contains("sf-readonly")).toBe(true);
});
it("HistoryBoard passes the current per-generation permission and reacts when it changes", () => {
  const g = gen({ shared: true }); fixture.graph = { nodes: [g], edges: [], root_ids: [g.id] };
  const p = { focusId: g.id, onPreview: noop, onInfo: noop, onRegenerate: noop,
    onPublish: noop, onUnpublish: noop, onFinalize: noop, onUnfinalize: noop };
  const share = () => [...host.querySelectorAll(".linb-ov-top button")].filter(el => el.textContent === "S");
  act(() => root.render(<HistoryBoard {...p} canFinalize={() => false} />));
  expect(host.querySelector(".linb-node")).not.toBeNull(); expect(share()).toHaveLength(0);
  expect(host.querySelector(".linb-node")!.classList.contains("sf-readonly")).toBe(true);
  act(() => root.render(<HistoryBoard {...p} canFinalize={() => true} />));
  expect(share()).toHaveLength(1); expect(host.querySelector(".linb-sf")?.textContent).toBe("S");
  expect(host.querySelector(".linb-node")!.classList.contains("sf-readonly")).toBe(false);
});
