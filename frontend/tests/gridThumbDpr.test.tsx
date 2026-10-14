// @vitest-environment jsdom
// 51회차(Codex 검토) — 격자의 썸네일 요청 폭은 화면 배율(DPR)을 따른다. 모니터를 옮기면 창 크기는 그대로이고 배율만 바뀌어
//  resize 가 오지 않는다 — 배율 질의(matchMedia resolution)의 알림으로 다시 고른다. 전엔 처음 배율에 머물러 256 을 계속 받았다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Generation } from "../src/types";

vi.mock("virtua", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return { Virtualizer: forwardRef((props: { data: unknown[]; children: (row: unknown) => React.ReactNode }, ref) => {
    useImperativeHandle(ref, () => ({ scrollToIndex: () => {} }));
    return <>{props.data.map(props.children)}</>;
  }) };
});
vi.mock("../src/api", () => ({ api: { thumbOrRaw: (path: string, size: number) => `${path}?w=${size}`, mediaUrl: (path: string) => path } }));
vi.mock("../src/lib/useGenerationViewsSynced", () => ({ useGenerationViewsSynced: () => ({ card: {}, asset: {} }) }));
vi.mock("../src/lib/modelCatalog", () => ({ useModelDisplayName: () => (name: string) => name }));
vi.mock("../src/lib/i18n", () => ({ t: (value: string) => value, useT: () => (value: string) => value }));
const seen: string[] = [];
vi.mock("../src/components/MediaThumbnail", () => ({ MediaThumbnail: (props: { thumb?: string | null }) => { seen.push(String(props.thumb)); return <span>thumbnail</span>; } }));

import { ThumbnailGrid } from "../src/components/ThumbnailGrid";

let host: HTMLDivElement;
let root: Root;
const queries: { media: string; listeners: Set<() => void> }[] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("devicePixelRatio", 1);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} }); // jsdom 에 없다(round7Grid 와 같게)
  HTMLElement.prototype.scrollTo = vi.fn();
  queries.length = 0;
  vi.stubGlobal("matchMedia", (media: string) => {
    const entry = { media, listeners: new Set<() => void>() };
    queries.push(entry);
    return { media, matches: true, addEventListener: (_: string, fn: () => void) => entry.listeners.add(fn), removeEventListener: (_: string, fn: () => void) => entry.listeners.delete(fn) };
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); seen.length = 0; });

const noop = () => {};
const gen = { id: "g1", model: "m", prompt: "p", status: "done", created_at: "2026-10-01T12:00:00Z",
  assets: [{ id: "a1", type: "image", file_path: "/t/g1.png" }], tags: [], auto_tags: [], references: [], shared: false, is_mine: true, params: {} } as unknown as Generation;

it("배율만 바뀌어도(resize 없이) 썸네일을 그 배율에 맞는 폭으로 다시 받는다", () => {
  act(() => root.render(
    <ThumbnailGrid generations={[gen]} tab="my" scale={1} fill layout="grid" groupByDate={false} selectedIds={new Set()} onSelectedChange={noop} onToggleSelect={noop}
      onSetSource={noop} onSetTags={noop} onOpenComments={noop} onRegenerate={noop} onPublish={noop} onUnpublish={noop} onFinalize={noop} onUnfinalize={noop}
      onImport={noop} onRestore={noop} dimDeleted={false} onInfo={noop} onPreview={noop} />,
  ));
  expect(seen.at(-1)).toContain("w=256"); // 180 × 1 ≤ 256
  vi.stubGlobal("devicePixelRatio", 2); // 배율이 큰 모니터로 옮겼다 — 창 크기는 그대로(resize 없음)
  act(() => { for (const query of [...queries]) for (const fn of [...query.listeners]) fn(); });
  expect(seen.at(-1)).toContain("w=512"); // 180 × 2 > 256
});
