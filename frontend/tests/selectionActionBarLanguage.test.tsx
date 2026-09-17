// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BoardSelectionActionBar, LibrarySelectionActionBar } from "../src/components/app/SelectionActionBar";
import { setLang } from "../src/lib/i18n";
import type { Generation } from "../src/types";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear(); setLang("ko");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); setLang("ko"); vi.unstubAllGlobals(); });
it.each(["board", "library"] as const)("%s switches all direct action labels/tooltips without changing callback arguments", kind => {
  const selected = [{ id: "g1", deleted: false }, { id: "g2", deleted: true }] as Generation[];
  const p = { projects: [], onShare: vi.fn(), onDownload: vi.fn(), onCompare: vi.fn(), onAssign: vi.fn(),
    onDelete: vi.fn(), onResolveTransfer: vi.fn(), onResolveRetry: vi.fn(), resolveRetryProjectName: "Fixture",
    resolveTransferBusy: true, resolveTransferPendingCount: 3 };
  const onRestore = vi.fn(), onPurge = vi.fn();
  act(() => root.render(kind === "board" ? <BoardSelectionActionBar {...p} selected={selected} />
    : <LibrarySelectionActionBar {...p} selectedCount={2} selectedGenerations={selected} onRestore={onRestore} onPurge={onPurge} />));
  const buttons = () => [...host.querySelectorAll<HTMLButtonElement>(".select-bar > button")];
  const find = (text: string) => buttons().find(b => b.textContent?.trim() === text)!;
  expect(find("⤓ 다운로드").title).toContain("선택한 결과물");
  act(() => setLang("en"));
  for (const b of buttons()) { expect(b.textContent).not.toMatch(/[가-힣]/); expect(b.title).not.toMatch(/[가-힣]/); }
  expect(find("◆ Add to Resolve (3)").title).toContain("3");
  expect(find("↻ Import prepared sources again").title).toContain("Fixture");
  act(() => { find("⤓ Download").click(); find("⊞ Compare").click(); find("🗑 Delete").click();
    find("◆ Add to Resolve (3)").click(); find("↻ Import prepared sources again").click(); });
  expect(p.onDownload).toHaveBeenCalledExactlyOnceWith(selected);
  expect(p.onCompare).toHaveBeenCalledExactlyOnceWith(selected);
  expect(p.onResolveTransfer).toHaveBeenCalledExactlyOnceWith(selected);
  expect(p.onResolveRetry).toHaveBeenCalledTimes(1);
  expect(p.onResolveRetry.mock.calls[0][0]?.type).toBe("click");
  if (kind === "board") expect(p.onDelete).toHaveBeenCalledExactlyOnceWith(selected);
  else { expect(p.onDelete).toHaveBeenCalledTimes(1); expect(p.onDelete.mock.calls[0][0]?.type).toBe("click");
    act(() => { find("↺ Restore").click(); find("⨯ Delete forever").click(); });
    expect(onRestore).toHaveBeenCalledTimes(1); expect(onRestore.mock.calls[0][0]?.type).toBe("click");
    expect(onPurge).toHaveBeenCalledTimes(1); expect(onPurge.mock.calls[0][0]?.type).toBe("click"); }
  act(() => setLang("ko")); expect(find("⤓ 다운로드").title).toContain("선택한 결과물");
});
it.each(["board", "library"] as const)("%s idle Resolve tooltip and default retry project are translated", kind => {
  const selected = [{ id: "g", deleted: false }] as Generation[];
  const noop = () => {};
  const p = { projects: [], onShare: noop, onDownload: noop, onCompare: noop, onAssign: noop, onDelete: noop,
    onResolveTransfer: noop, onResolveRetry: noop, resolveRetryProjectName: "", resolveTransferBusy: false, resolveTransferPendingCount: 0 };
  setLang("en");
  act(() => root.render(kind === "board" ? <BoardSelectionActionBar {...p} selected={selected} />
    : <LibrarySelectionActionBar {...p} selectedCount={1} selectedGenerations={selected} onRestore={noop} onPurge={noop} />));
  for (const b of host.querySelectorAll<HTMLButtonElement>(".select-bar > button")) {
    expect(b.textContent).not.toMatch(/[가-힣]/); expect(b.title).not.toMatch(/[가-힣]/);
  }
  expect(host.querySelectorAll(".sb-resolve")).toHaveLength(2);
});
