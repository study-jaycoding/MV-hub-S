// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useViewTabs } from "../src/lib/useViewTabs";

type View = { key: string; detail: string };
type Harness = {
  scope: string; enabled: boolean; allowed: boolean; leaveChecks: number; view: View; applied: View[];
  latest: ReturnType<typeof useViewTabs<View>>; host: HTMLDivElement; root: Root; draw: () => void;
};
const harnesses: Harness[] = [];
function mount(enabled = true): Harness {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const h = { scope: "scope-a", enabled, allowed: true, leaveChecks: 0, view: { key: "a", detail: "initial" }, applied: [],
    host, root: createRoot(host) } as unknown as Harness;
  function Probe() {
    h.latest = useViewTabs({ scope: h.scope, enabled: h.enabled, read: () => h.view,
      apply: (view) => { h.view = view; h.applied.push(view); }, canLeave: () => { h.leaveChecks++; return h.allowed; }, keyOf: (view) => view.key });
    return null;
  }
  h.draw = () => act(() => h.root.render(<Probe />));
  h.draw(); harnesses.push(h); return h;
}
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(() => { for (const h of harnesses.splice(0)) { act(() => h.root.unmount()); h.host.remove(); } });

describe("open adds background folder tabs", () => {
  it("captures the current view and adds a target without changing the screen", () => {
    const h = mount();
    h.view = { key: "a", detail: "edited" }; h.draw();
    const active = h.latest.active, view = h.view;
    act(() => expect(h.latest.open({ key: "b", detail: "target" })).toBe(true));
    expect(h.latest.tabs.map((t) => t.view)).toEqual([{ key: "a", detail: "edited" }, { key: "b", detail: "target" }]);
    expect(h.latest.active).toBe(active);
    expect(h.view).toBe(view);
    expect(h.applied).toEqual([]);
    expect(h.leaveChecks).toBe(0);
  });

  it("opening an existing background target preserves its saved view and the active tab", () => {
    const h = mount();
    act(() => h.latest.open({ key: "b", detail: "remembered-b" }));
    const second = h.latest.tabs[1].id;
    act(() => h.latest.select(second));
    h.view = { key: "b", detail: "edited-b" }; h.draw();
    act(() => h.latest.select(h.latest.tabs[0].id));
    h.applied.length = 0;
    const active = h.latest.active, checks = h.leaveChecks;
    act(() => expect(h.latest.open({ key: "b", detail: "ignored-b" })).toBe(false));
    expect(h.latest.tabs).toHaveLength(2);
    expect(h.latest.tabs[1].view.detail).toBe("edited-b");
    expect(h.latest.active).toBe(active);
    expect(h.view).toEqual({ key: "a", detail: "initial" });
    expect(h.applied).toEqual([]);
    expect(h.leaveChecks).toBe(checks);
  });

  it("can add a background tab with unsaved work but guards selecting or closing the active tab", () => {
    const h = mount();
    h.allowed = false;
    const active = h.latest.active;
    act(() => expect(h.latest.open({ key: "b", detail: "b" })).toBe(true));
    expect(h.leaveChecks).toBe(0);
    const second = h.latest.tabs[1].id;
    act(() => expect(h.latest.select(second)).toBe(false));
    act(() => h.latest.close(active));
    expect(h.latest.active).toBe(active);
    expect(h.latest.tabs).toHaveLength(2);
    expect(h.applied).toEqual([]);
    act(() => h.latest.close(second));
    expect(h.latest.tabs).toHaveLength(1);
  });

  it("opening the active key is a complete no-op that preserves its current state", () => {
    const h = mount();
    h.view = { key: "a", detail: "current search and scroll" }; h.draw();
    const before = h.latest.tabs, view = h.view;
    h.allowed = false;
    act(() => expect(h.latest.open({ key: "a", detail: "must be ignored" })).toBe(false));
    expect(h.latest.tabs).toEqual(before);
    expect(h.view).toBe(view);
    expect(h.applied).toEqual([]);
    expect(h.leaveChecks).toBe(0);
  });

  it("does nothing while disabled", () => {
    const h = mount(false);
    act(() => expect(h.latest.open({ key: "b", detail: "b" })).toBe(false));
    expect(h.latest.tabs).toEqual([]);
    expect(h.applied).toEqual([]);
    expect(h.leaveChecks).toBe(0);
    expect(h.view.key).toBe("a");
  });

  it("selecting a background tab explicitly restores it once", () => {
    const h = mount();
    act(() => h.latest.open({ key: "b", detail: "target" }));
    const second = h.latest.tabs[1].id;
    act(() => expect(h.latest.select(second)).toBe(true));
    expect(h.latest.active).toBe(second);
    expect(h.view).toEqual({ key: "b", detail: "target" });
    expect(h.applied).toEqual([{ key: "b", detail: "target" }]);
    act(() => expect(h.latest.select(second)).toBe(true));
    expect(h.applied).toHaveLength(1);
    expect(h.leaveChecks).toBe(1);
  });

  it("keeps the active tab when back navigation made an earlier tab use the same key", () => {
    const h = mount();
    act(() => h.latest.open({ key: "b", detail: "b" }));
    act(() => h.latest.select(h.latest.tabs[1].id));
    const active = h.latest.active;
    h.view = { key: "a", detail: "back navigation with current search and scroll" }; h.draw();
    const applied = h.applied.length, checks = h.leaveChecks, view = h.view;
    act(() => expect(h.latest.open({ key: "a", detail: "must not apply" })).toBe(false));
    expect(h.latest.active).toBe(active);
    expect(h.view).toBe(view);
    expect(h.applied).toHaveLength(applied);
    expect(h.leaveChecks).toBe(checks);
  });

  it("does not reuse another scope's targets or create duplicate keys in the new scope", () => {
    const h = mount();
    act(() => h.latest.open({ key: "b", detail: "scope-a-b" }));
    h.scope = "scope-b"; h.view = { key: "a", detail: "scope-b-a" }; h.draw();
    act(() => h.latest.open({ key: "b", detail: "scope-b-b" }));
    act(() => h.latest.open({ key: "b", detail: "ignored" }));
    expect(h.latest.tabs.map((t) => t.view.detail)).toEqual(["scope-b-a", "scope-b-b"]);
    expect(new Set(h.latest.tabs.map((t) => t.view.key)).size).toBe(2);
    expect(h.view.detail).toBe("scope-b-a");
    expect(h.applied).toEqual([]);
  });
});
