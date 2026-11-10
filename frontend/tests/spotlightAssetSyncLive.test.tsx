// @vitest-environment jsdom
// 2026-11-10 — 하단 프롬프트의 보관 동기화(트레이·인라인 칩·Library 초안)도 프로젝트 원본 이미지는 등록·조회하지 않는다.
//  같은 자리의 캡처 참조는 지금처럼 등록·조회 대상이다(docs/status/레퍼런스덮어쓰기_최신추종_2026-11-10.md).
//  실제 SpotlightPrompt 를 그려 보관 동기화 이벤트를 보낸다.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { installPromptBoundaryMocks, mountPrompt, settle } from "./seedanceRenderHarness";

let view: Awaited<ReturnType<typeof mountPrompt>> | undefined;
let boundary: ReturnType<typeof installPromptBoundaryMocks>;

const cid = `sha256:${"a".repeat(64)}`;
const live = { file_path: "asset:p|refs/hero.png", type: "image", name: "주인공", role: "@Image1", thumb: "",
  asset_content_id: cid, target_project_id: "p" };
const liveChip = { ...live, file_path: "asset:p|refs/side.png", name: "조연" };
const capture = { ...live, file_path: "asset:captures|cap.png", name: "캡처", asset_content_id: `sha256:${"c".repeat(64)}` };

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  boundary = installPromptBoundaryMocks();
  Object.assign(boundary.api, {
    assetThumbUrl: (project: string, path: string) => `/thumb/${project}/${path}`,
    assetFileUrl: (project: string, path: string) => `/file/${project}/${path}`,
    assetTree: vi.fn().mockResolvedValue({ children: [] }),
    registerAssetReference: vi.fn().mockResolvedValue({}),
    resolveManagedAssets: vi.fn().mockResolvedValue({ items: [] }),
  });
});
afterEach(() => {
  view?.dispose();
  view = undefined;
  vi.unstubAllGlobals();
});

it("보관 동기화 이벤트가 와도 트레이·초안 칩의 프로젝트 원본 이미지는 등록·조회하지 않고 캡처만 대상이 된다", async () => {
  const { libraryDraftKey } = await import("../src/lib/libraryPromptDraft");
  localStorage.setItem(libraryDraftKey(), JSON.stringify({ v: 1, parts: [{ t: "text", v: "글 " }, { t: "chip", ref: liveChip }],
    trayRefs: [live, capture] }));
  view = await mountPrompt();
  const { configureOperationContext, captureOperationContext } = await import("../src/app/operationContext");
  const { APP_EVENTS, dispatchAppEvent } = await import("../src/lib/appEvents");
  configureOperationContext({ key: "live-sync", serverOrigin: "http://storage.test", authority: "local", ready: true });
  const operation = captureOperationContext({ scope: "personal", id: null, name: null });
  await act(async () => { dispatchAppEvent(APP_EVENTS.assetSyncReady, { receipts: [], items: [], operation }); });
  await settle();
  await act(async () => { await new Promise((done) => setTimeout(done, 20)); });

  const registered = boundary.api.registerAssetReference.mock.calls.map((call: unknown[]) => call[0]);
  expect(registered).toEqual(["asset:captures|cap.png"]);
  const resolved = boundary.api.resolveManagedAssets.mock.calls.flatMap((call: unknown[]) => call[0] as string[]);
  expect(resolved).toContain(capture.asset_content_id);
  expect(resolved).not.toContain(cid);
});
