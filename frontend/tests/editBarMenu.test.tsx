// @vitest-environment jsdom
// 좁은 창에서 막대를 밀면 메뉴가 연 자리 좌표에 남아 단추에서 떨어진다 — 밀리면 닫는다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EditTree } from "../src/lib/useEditSequence";

const tree = vi.hoisted(() => ({ state: "ready", complete: true, note: null, roots: [
  { name: "e070", path: "e070", children: [{ name: "c1", path: "e070/c1" }] },
] }));
vi.mock("../src/lib/useEditSequence", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/useEditSequence")>("../src/lib/useEditSequence");
  return {
    ...actual,
    useEditProjects: () => ({ projects: [{ id: "p1", name: "P1" }], projectsState: "ok", tree: tree as EditTree, reload: () => {}, reloadCounts: () => {}, freshByProject: {} }),
    useEditGenerations: () => ({ state: "ok", gens: [], error: null, complete: true, reload: () => {} }),
  };
});

import { api } from "../src/api";
import { EditTab } from "../src/components/timeline/EditTab";
import { HttpError } from "../src/lib/http";

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  localStorage.setItem("ch.editTimeline.last:local", JSON.stringify({ projectId: "p1", seq: "e070" }));
  for (const method of ["load", "pause"] as const) vi.spyOn(HTMLMediaElement.prototype, method).mockImplementation(() => {});
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  vi.spyOn(api, "listEditShares").mockImplementation(async () => []);
  vi.spyOn(api, "getEditShare").mockRejectedValue(new HttpError(404, "없음"));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <EditTab authKey="auth" authReady workspace={{ scope: "team", id: "w1", name: "W" }} keysActive flash={() => {}}
        onOpenCutFolder={() => {}} reloadSignal={0} peekPath={null} onPeekMarks={() => {}} onNotices={() => {}}
        cardMenuRef={{ current: null }} onPreview={() => {}} onCompare={() => {}}
        resolve={{ send: () => {}, busy: false, pendingCount: 0 }} />,
    );
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const list = () => document.querySelector<HTMLButtonElement>(".ed-listbtn")!;
const menu = () => document.querySelector(".ed-tmenu-item");

it("막대가 밀리면 막대에서 연 메뉴가 닫힌다", () => {
  act(() => list().click());
  expect(menu()).not.toBeNull();
  act(() => { document.querySelector(".ed-bar")!.dispatchEvent(new Event("scroll")); });
  expect(menu()).toBeNull();
});

it("밀리지 않으면 메뉴는 그대로다 · 단추를 다시 누르면 닫힌다", () => {
  act(() => list().click());
  expect(menu()).not.toBeNull();
  act(() => { document.querySelector(".ed-tl")?.dispatchEvent(new Event("scroll")); });
  expect(menu()).not.toBeNull();
  act(() => list().click());
  expect(menu()).toBeNull();
});
