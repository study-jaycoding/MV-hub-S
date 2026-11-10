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
const captureChip = { ...capture, file_path: "asset:captures|chip.png", name: "캡처칩", asset_content_id: `sha256:${"d".repeat(64)}` };
const origin = "http://storage.test";
const ready = (asset_content_id: string, location: string) => ({ state: "ready", asset_content_id, original_file_path: "",
  file_path: `asset-sync:${location}`, location_id: location, project_id: "p", owner_uid: "owner", storage_id: "storage",
  root_revision: "root-1", server_origin: origin });
// 원본·캡처 모두 보관 영수증이 준비돼 있다 — 원본은 받으면 안 되고 캡처는 받아야 한다.
const receipts = [ready(cid, "a".repeat(32)), ready(capture.asset_content_id, "c".repeat(32)), ready(captureChip.asset_content_id, "d".repeat(32))];

async function sendSync(eventReceipts: unknown[]) {
  const { configureOperationContext, captureOperationContext } = await import("../src/app/operationContext");
  const { APP_EVENTS, dispatchAppEvent } = await import("../src/lib/appEvents");
  configureOperationContext({ key: "live-sync", serverOrigin: origin, authority: "local", ready: true });
  const operation = captureOperationContext({ scope: "personal", id: null, name: null });
  await act(async () => { dispatchAppEvent(APP_EVENTS.assetSyncReady, { receipts: eventReceipts, items: [], operation }); });
  await settle();
  await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
}

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
  await sendSync([]);

  const registered = boundary.api.registerAssetReference.mock.calls.map((call: unknown[]) => call[0]);
  expect(registered).toEqual(["asset:captures|cap.png"]);
  const resolved = boundary.api.resolveManagedAssets.mock.calls.flatMap((call: unknown[]) => call[0] as string[]);
  expect(resolved).toContain(capture.asset_content_id);
  expect(resolved).not.toContain(cid);
});

it("보관 영수증이 준비돼도 트레이·인라인 칩의 원본 이미지는 그대로 두고 캡처만 보관본으로 바꾼다", async () => {
  const { libraryDraftKey } = await import("../src/lib/libraryPromptDraft");
  localStorage.setItem(libraryDraftKey(), JSON.stringify({ v: 1, parts: [{ t: "text", v: "글 " }, { t: "chip", ref: liveChip },
    { t: "chip", ref: captureChip }], trayRefs: [live, capture] }));
  view = await mountPrompt();
  await sendSync(receipts);

  const traySources = [...view.container.querySelectorAll<HTMLImageElement>(".sl-reftray-item img")].map((img) => img.getAttribute("src"));
  expect(traySources).toContain("/thumb/p/refs/hero.png");
  expect(traySources).toContain(`/api/asset-sync/files/${"c".repeat(32)}`);
  expect(traySources).not.toContain(`/api/asset-sync/files/${"a".repeat(32)}`);
  const chips = [...view.container.querySelectorAll<HTMLElement>(".inline-ref[data-ref]")]
    .map((node) => JSON.parse(node.dataset.ref!) as { file_path: string });
  expect(chips.map((chip) => chip.file_path)).toEqual(["asset:p|refs/side.png", `asset-sync:${"d".repeat(32)}`]);
});

it("씬 카드에 묶인 동안 저장된 Library 초안도 원본 이미지는 그대로, 캡처만 보관본으로 바꿔 적는다", async () => {
  const { libraryDraftKey } = await import("../src/lib/libraryPromptDraft");
  const key = libraryDraftKey();
  localStorage.setItem(key, JSON.stringify({ v: 1, parts: [{ t: "text", v: "글 " }, { t: "chip", ref: liveChip },
    { t: "chip", ref: captureChip }], trayRefs: [live, capture] }));
  view = await mountPrompt({ trayBinding: { key: "scene:card-a", promptKey: null, prompt: "", refs: [], modelKey: null, model: null } as never });
  await sendSync(receipts);

  const saved = JSON.parse(localStorage.getItem(key)!) as { parts: { t: string; ref?: { file_path: string } }[]; trayRefs: { file_path: string }[] };
  expect(saved.trayRefs.map((ref) => ref.file_path)).toEqual(["asset:p|refs/hero.png", `asset-sync:${"c".repeat(32)}`]);
  expect(saved.parts.filter((part) => part.t === "chip").map((part) => part.ref!.file_path))
    .toEqual(["asset:p|refs/side.png", `asset-sync:${"d".repeat(32)}`]);
});
