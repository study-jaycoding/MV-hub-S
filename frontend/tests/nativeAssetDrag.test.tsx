// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AssetCell } from "../src/components/assets/AssetCell";
import { nativeDragBrowserSupported, startNativeAssetDrag } from "../src/components/assets/exportDrag";
import { api } from "../src/api";
import { flashMsg } from "../src/lib/flash";
import { setApiPause } from "../src/lib/http";
import { loadString, saveString } from "../src/lib/storage";
import { STORAGE_KEYS } from "../src/lib/storageKeys";
import type { AssetMeta } from "../src/types";

vi.mock("../src/api", () => ({ api: {
  nativeAssetDrag: vi.fn(), assetFileUrl: () => "/original.png", assetThumbUrl: () => "/thumb.png",
} }));
vi.mock("../src/lib/flash", () => ({ flashMsg: vi.fn() }));
vi.mock("../src/lib/modelCatalog", () => ({ useModelDisplayName: () => (name: string) => name }));

const items = ["c.png", "a.png", "b.png"].map((path) => ({ project: "P", path, name: path, type: "image" }));
const noop = () => {};
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); setApiPause(null); localStorage.clear(); });

it.each([
  ["127.0.0.1", "Windows Chrome/135", true],
  ["localhost", "Windows Edg/135", true],
  ["[::1]", "Windows Chromium/135", true],
  ["192.0.2.7", "Windows Chrome/135", false],
  ["localhost", "Linux Chrome/135", false],
  ["localhost", "Windows Firefox/135", false],
])("native browser gate: %s / %s", (hostname, userAgent, expected) => {
  vi.stubGlobal("location", { hostname });
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
  expect(nativeDragBrowserSupported()).toBe(expected);
});

it("image body starts one export, not another bubbled export on its parent", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const onExportDrag = vi.fn();
  const meta: AssetMeta = { is_source: false, source_name: null, tags: [], comment: null, color: null, comment_count: 0, has_unread: false };
  act(() => root.render(<AssetCell project="P" node={{ name: "a.png", path: "a.png", type: "image" }} idx={0}
    layout="grid" scale={1} fit="contain" selected focused selectedCount={3} meta={meta} editingTag={false}
    onS={noop} onT={noop} onC={noop} onTagsReplace={noop} onBulkTagAdd={noop} onBulkTagRemove={noop}
    onTagCancel={noop} onInfo={noop} onExportDrag={onExportDrag} />));
  const event = new Event("dragstart", { bubbles: true, cancelable: true });
  act(() => host.querySelector("img")!.dispatchEvent(event));
  expect(onExportDrag).toHaveBeenCalledTimes(1);
  expect(onExportDrag.mock.calls[0][1].nativeEvent).toBe(event);
  act(() => root.unmount()); host.remove();
});

it("native transfer sends three original paths in order, without ZIP, then clears only its selection", async () => {
  let finish!: (value: { dropped: boolean }) => void;
  vi.mocked(api.nativeAssetDrag).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const event = { preventDefault: vi.fn() } as unknown as React.DragEvent;
  startNativeAssetDrag(event, "P", items);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(api.nativeAssetDrag).toHaveBeenLastCalledWith("P", ["c.png", "a.png", "b.png"], expect.any(Number), expect.any(AbortSignal));
  expect(JSON.parse(loadString(STORAGE_KEYS.assetsDrag))).toEqual(items);
  const calls = vi.mocked(api.nativeAssetDrag).mock.calls.length;
  startNativeAssetDrag(event, "P", items);
  expect(vi.mocked(api.nativeAssetDrag).mock.calls.length).toBe(calls);
  saveString(STORAGE_KEYS.assetsDrag, "newer-selection");
  finish({ dropped: true });
  await vi.waitFor(() => expect(loadString(STORAGE_KEYS.assetsDrag)).toBe("newer-selection"));
  await new Promise((resolve) => setTimeout(resolve, 0));
});

it("mouse release is handled by Windows without aborting its pending drop", async () => {
  let finish!: (value: { dropped: boolean }) => void;
  vi.mocked(api.nativeAssetDrag).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  startNativeAssetDrag({ preventDefault: noop } as unknown as React.DragEvent, "P", items);
  const calls = vi.mocked(api.nativeAssetDrag).mock.calls.length;
  window.dispatchEvent(new MouseEvent("mouseup"));
  expect(vi.mocked(api.nativeAssetDrag).mock.lastCall![3].aborted).toBe(false);
  finish({ dropped: true });
  await vi.waitFor(() => expect(loadString(STORAGE_KEYS.assetsDrag)).toBe(""));
  expect(vi.mocked(api.nativeAssetDrag).mock.calls.length).toBe(calls);
});

it.each(["account pause", "owner cleanup"])("%s cancels the owned native request without retry", async (reason) => {
  vi.mocked(api.nativeAssetDrag).mockImplementation((_p, _paths, _time, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")));
  }));
  const cancel = startNativeAssetDrag({ preventDefault: noop } as unknown as React.DragEvent, "P", items);
  expect(cancel).not.toBeNull();
  const calls = vi.mocked(api.nativeAssetDrag).mock.calls.length;
  if (reason === "account pause") setApiPause("hub");
  else cancel!(); // The AssetsView unmount cleanup owns this handle.
  await vi.waitFor(() => expect(loadString(STORAGE_KEYS.assetsDrag)).toBe(""));
  expect(vi.mocked(api.nativeAssetDrag).mock.calls.length).toBe(calls);
});

it("expired preparation asks to drag again instead of silently losing the gesture", async () => {
  vi.mocked(api.nativeAssetDrag).mockResolvedValue({ dropped: false, reason: "expired" });
  startNativeAssetDrag({ preventDefault: noop } as unknown as React.DragEvent, "P", items);
  await vi.waitFor(() => expect(flashMsg).toHaveBeenCalledWith(expect.stringContaining("다시 끌어주세요")));
  expect(flashMsg).toHaveBeenCalledWith(expect.stringContaining("나눠서"));
  await vi.waitFor(() => expect(loadString(STORAGE_KEYS.assetsDrag)).toBe(""));
});

const many = (count: number) => Array.from({ length: count }, (_, index) => (
  { project: "P", path: `${index}.png`, name: `${index}.png`, type: "image" }));

it("thirty cards go out in one native drag, not split (Jay 10-28: 422 over 20)", async () => {
  vi.mocked(api.nativeAssetDrag).mockResolvedValue({ dropped: true });
  const calls = vi.mocked(api.nativeAssetDrag).mock.calls.length;
  startNativeAssetDrag({ preventDefault: noop } as unknown as React.DragEvent, "P", many(30));
  expect(vi.mocked(api.nativeAssetDrag).mock.calls.length).toBe(calls + 1);
  expect(vi.mocked(api.nativeAssetDrag).mock.lastCall![1]).toEqual(many(30).map((item) => item.path));
  await vi.waitFor(() => expect(loadString(STORAGE_KEYS.assetsDrag)).toBe(""));
});

it("over the server limit explains instead of sending, and the next drag still starts", async () => {
  vi.mocked(api.nativeAssetDrag).mockResolvedValue({ dropped: true });
  const calls = vi.mocked(api.nativeAssetDrag).mock.calls.length;
  const event = { preventDefault: vi.fn() } as unknown as React.DragEvent;
  expect(startNativeAssetDrag(event, "P", many(101))).toBeNull();
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(flashMsg).toHaveBeenCalledWith(expect.stringContaining("100장까지"));
  expect(vi.mocked(api.nativeAssetDrag).mock.calls.length).toBe(calls);
  expect(startNativeAssetDrag({ preventDefault: noop } as unknown as React.DragEvent, "P", many(100))).not.toBeNull();
  expect(vi.mocked(api.nativeAssetDrag).mock.calls.length).toBe(calls + 1);
  await vi.waitFor(() => expect(loadString(STORAGE_KEYS.assetsDrag)).toBe(""));
});

it("a paused account cannot start native export", () => {
  setApiPause("shared");
  const calls = vi.mocked(api.nativeAssetDrag).mock.calls.length;
  startNativeAssetDrag({ preventDefault: noop } as unknown as React.DragEvent, "P", items);
  expect(vi.mocked(api.nativeAssetDrag).mock.calls.length).toBe(calls);
});
