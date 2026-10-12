// @vitest-environment jsdom
// Assets 의 📋 복사(조작 규칙 52 — 25회차, Codex 전수 검토): 완료 표시(✓)를 1.5초 뒤에 끄는 타이머가 다음 복사를 시작할 때 거둬지지 않아, 두 번째
//  복사가 그 타이머보다 오래 걸리면 아직 복사 중인데 표시가 사라지고 busy 도 풀려 세 번째 요청을 받았다. 새 복사를 시작하면 앞 타이머부터 거둔다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssetCell } from "../src/components/assets/AssetCell";
import type { AssetMeta, AssetNode } from "../src/types";

vi.mock("../src/api", () => ({ api: {
  assetFileUrl: (project: string, path: string) => `/files/${project}/${path}`, assetThumbUrl: (project: string, path: string) => `/thumbs/${project}/${path}`,
  revealAsset: vi.fn(),
} }));
vi.mock("../src/lib/flash", () => ({ flashMsg: vi.fn() }));
vi.mock("../src/lib/modelCatalog", () => ({ useModelDisplayName: () => (name: string) => name }));

const noop = () => {};
const node: AssetNode = { name: "clip.mp4", path: "folder/clip.mp4", type: "video" }; // 영상 = OS 파일 클립보드(onCopyFiles)
const meta: AssetMeta = { is_source: false, source_name: null, tags: [], comment: null, color: null, comment_count: 0, has_unread: false };
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  for (const method of ["load", "pause"] as const) vi.spyOn(HTMLMediaElement.prototype, method).mockImplementation(() => {});
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const copyButton = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => ["📋", "…", "✓", "⚠"].includes(button.textContent?.trim() || ""))!;
const state = () => copyButton().textContent?.trim();

it("앞 복사의 완료 표시 타이머가 다음 복사의 '복사 중'을 지우지 않는다", async () => {
  const pending: ((value: { copied: number; asked: number }) => void)[] = [];
  const onCopyFiles = vi.fn(() => new Promise<{ copied: number; asked: number }>((resolve) => { pending.push(resolve); }));
  act(() => root.render(<AssetCell project="fixture" node={node} idx={0} layout="grid" scale={1} fit="contain" selected={false} focused={false} meta={meta} editingTag={false}
    onS={noop} onT={noop} onC={noop} onTagsReplace={noop} onBulkTagAdd={noop} onBulkTagRemove={noop} onTagCancel={noop} onInfo={noop} onExportDrag={noop} onCopyFiles={onCopyFiles} />));
  expect(state()).toBe("📋");
  await act(async () => { copyButton().click(); });
  expect(state()).toBe("…");
  await act(async () => { pending[0]({ copied: 1, asked: 1 }); });
  expect(state()).toBe("✓"); // 1.5초 뒤에 꺼진다
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  await act(async () => { copyButton().click(); }); // 1.5초 안에 다시 복사 — 이번 것은 오래 걸린다
  expect(state()).toBe("…");
  expect(onCopyFiles).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); }); // 앞 타이머의 시각이 지났다
  expect(state()).toBe("…"); // 전엔 📋(idle)로 돌아가, 아직 복사 중인데 세 번째 누름을 받았다
  await act(async () => { copyButton().click(); });
  expect(onCopyFiles).toHaveBeenCalledTimes(2); // 복사 중에는 받지 않는다
  await act(async () => { pending[1]({ copied: 1, asked: 1 }); });
  expect(state()).toBe("✓");
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(state()).toBe("📋");
});
