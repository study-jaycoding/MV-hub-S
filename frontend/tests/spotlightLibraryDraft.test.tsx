// @vitest-environment jsdom
// Jay 결정 5B(10-15): 라이브러리 프롬프트에 쓰다 만 글·트레이 참조를 같은 브라우저에 담아 두고 다시 열면 되살린다(묻지 않는다).
//  계정마다 따로 · 씬 카드 글은 담지 않음 · 캔버스 탭으로 켜도 빈 글로 덮지 않음 · 보낸 뒤(글이 비면) 바로 지움(Codex C17·C18).
// 실제 SpotlightPrompt·트레이 훅을 통과한다.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { deferred, installPromptBoundaryMocks, mountPrompt, required, settle, type PromptProps } from "./seedanceRenderHarness";

let view: Awaited<ReturnType<typeof mountPrompt>> | undefined;
let key = "";
let boundary: ReturnType<typeof installPromptBoundaryMocks>;

const editor = () => required(view!.container, '[contenteditable="true"]');
const typeText = (text: string) => act(() => {
  editor().textContent = text;
  editor().dispatchEvent(new Event("input", { bubbles: true }));
});
const stored = () => localStorage.getItem(key);
const wait = (ms: number) => act(async () => { await new Promise((done) => setTimeout(done, ms)); });
const sceneBinding = (prompt = ""): NonNullable<PromptProps["trayBinding"]> => ({
  key: "scene:card-a", promptKey: null, prompt, refs: [], modelKey: null, model: null,
} as unknown as NonNullable<PromptProps["trayBinding"]>);
const draft = (text: string, trayRefs: unknown[] = []) =>
  JSON.stringify({ v: 1, parts: [{ t: "text", v: text }], trayRefs });

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  boundary = installPromptBoundaryMocks();
  Object.assign(boundary.api, { assetThumbUrl: (project: string, path: string) => `/thumb/${project}/${path}`,
    assetFileUrl: (project: string, path: string) => `/file/${project}/${path}`,
    assetTree: vi.fn().mockResolvedValue({ children: [] }) });
  key = (await import("../src/lib/libraryPromptDraft")).libraryDraftKey();
});
afterEach(() => {
  view?.dispose();
  view = undefined;
  vi.unstubAllGlobals();
});

it("라이브러리에서 쓰다 만 글은 0.5초 뒤 담기고, 다시 열면 되살아난다", async () => {
  view = await mountPrompt();
  typeText("해 질 녘 방파제");
  expect(stored()).toBeNull(); // 아직 기다리는 중
  await wait(600);
  expect(JSON.parse(stored()!).parts).toEqual([{ t: "text", v: "해 질 녘 방파제" }]);
  view.dispose();
  view = await mountPrompt();
  expect(editor().textContent).toBe("해 질 녘 방파제");
});

it("트레이 참조도 되살린다(라이브러리 트레이에, 새 고유키로)", async () => {
  localStorage.setItem(key, draft("글", [{ file_path: "https://fixture.invalid/a.png", type: "image", name: "a" }]));
  view = await mountPrompt();
  await settle();
  expect(view.container.querySelectorAll(".sl-reftray-item").length).toBe(1);
  expect(editor().textContent).toBe("글");
});

it("글을 다 지우면(보내기 성공과 같은 길) 기다리던 쓰기를 버리고 바로 지운다", async () => {
  localStorage.setItem(key, draft("보낼 글"));
  view = await mountPrompt();
  typeText("보낼 글 고침");
  typeText(""); // 0.5초 안에 비었다 — 앞 예약이 나중에 다시 적으면 안 된다
  expect(stored()).toBeNull();
  await wait(600);
  expect(stored()).toBeNull();
});

it("캔버스 탭(씬 카드)으로 켜면 담아 둔 글을 빈 글로 덮지 않고, 씬에서 나오면 되살린다 — 씬 안 글은 담지 않는다", async () => {
  localStorage.setItem(key, draft("라이브러리 글"));
  view = await mountPrompt({ trayBinding: sceneBinding() });
  typeText("씬 카드 글");
  await wait(600);
  expect(JSON.parse(stored()!).parts).toEqual([{ t: "text", v: "라이브러리 글" }]);
  await view.render({ trayBinding: null });
  expect(editor().textContent).toBe("라이브러리 글");
});

// Codex 5B 리뷰(10-15): 읽은 계정과 쓰는 계정이 갈리면 안 된다 · 되살리기만 한 오래된 탭이 다른 탭의 새 초안을 덮으면 안 된다 · Esc 로 지운 검색어가 되살아나면 안 된다.
it("켤 때의 계정 키에만 쓴다 — 그 뒤 이 탭의 계정 범위가 바뀌어도 앞 계정의 글을 새 계정 키에 적지 않는다", async () => {
  view = await mountPrompt();
  sessionStorage.setItem("ch.accountScope", "b@example.test"); // 로그인으로 범위가 바뀌었다(새로 고치기 전)
  typeText("A 계정에서 쓰던 글");
  await wait(600);
  expect(JSON.parse(stored()!).parts).toEqual([{ t: "text", v: "A 계정에서 쓰던 글" }]);
  expect(localStorage.getItem("mvhub.libraryPromptDraft:acct:b@example.test")).toBeNull();
  sessionStorage.removeItem("ch.accountScope");
});

it("되살리기만 하고 고치지 않은 탭은 담지 않는다 — 다른 탭이 그사이 담은 새 초안을 덮지 않는다", async () => {
  localStorage.setItem(key, draft("옛 글"));
  view = await mountPrompt();
  expect(editor().textContent).toBe("옛 글");
  localStorage.setItem(key, draft("다른 탭의 새 글")); // 다른 탭이 담았다
  await act(async () => { await view!.render({ armedAutoTags: [] }); }); // 다시 그려져도
  await wait(600);
  expect(JSON.parse(stored()!).parts).toEqual([{ t: "text", v: "다른 탭의 새 글" }]);
  typeText("옛 글 고침"); // 이 탭에서 실제로 고치면 그때는 담는다
  await wait(600);
  expect(JSON.parse(stored()!).parts).toEqual([{ t: "text", v: "옛 글 고침" }]);
});

it("트레이가 있는 초안도 되살리기만 하면 담지 않는다(트레이가 상태에 들어오기 전 판정을 고친 것으로 오인하지 않는다)", async () => {
  localStorage.setItem(key, draft("옛 글", [{ file_path: "https://fixture.invalid/a.png", type: "image", name: "a" }]));
  view = await mountPrompt();
  await settle();
  expect(view.container.querySelectorAll(".sl-reftray-item").length).toBe(1);
  localStorage.setItem(key, draft("다른 탭의 새 글")); // 다른 탭이 담았다
  await wait(600);
  expect(JSON.parse(stored()!).parts).toEqual([{ t: "text", v: "다른 탭의 새 글" }]);
});

it("다른 계정의 초안·손상된 초안은 읽지 않는다", async () => {
  localStorage.setItem("mvhub.libraryPromptDraft:acct:other@example.test", draft("남의 글"));
  view = await mountPrompt();
  expect(editor().textContent).toBe("");
  view.dispose();
  localStorage.setItem(key, "{망가짐");
  view = await mountPrompt();
  expect(editor().textContent).toBe("");
});

const syncReceipt = {
  asset_content_id: `sha256:${"a".repeat(64)}`, project_id: "p", owner_uid: "owner", storage_id: "storage",
  root_revision: "root", server_origin: "http://storage.test", state: "ready",
  file_path: "asset-sync:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", location_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};
const localReference = { file_path: "asset:captures|a.png", type: "image", name: "캡처", role: "@Image1", thumb: "",
  asset_content_id: syncReceipt.asset_content_id, target_project_id: "p" };
const previousReference = () => ({ ...localReference, file_path: syncReceipt.file_path, server_location: {
  location_id: syncReceipt.location_id, project_id: syncReceipt.project_id, owner_uid: syncReceipt.owner_uid,
  storage_id: syncReceipt.storage_id, root_revision: syncReceipt.root_revision, server_origin: syncReceipt.server_origin,
} });
const movedReceipt = { ...syncReceipt, location_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  file_path: "asset-sync:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", root_revision: "root-2",
  supersedes_location_id: syncReceipt.location_id };
const readyEvent = async (receipts = [syncReceipt]) => {
  const contexts = await import("../src/app/operationContext");
  contexts.configureOperationContext({ key: "sync", ready: true, serverOrigin: syncReceipt.server_origin, authority: "local" });
  const operation = contexts.captureOperationContext({ scope: "team", id: "w", name: "팀" });
  act(() => window.dispatchEvent(new CustomEvent("ch:asset-sync-ready", {
    detail: { receipts, items: receipts, operation },
  })));
};

it("서버 ready 신호는 입력 글을 보존하면서 인라인 칩과 트레이를 자동 전환·저장한다", async () => {
  localStorage.setItem(key, JSON.stringify({ v: 1, parts: [{ t: "text", v: "내가 쓰던 글 " },
    { t: "chip", ref: localReference }], trayRefs: [localReference] }));
  view = await mountPrompt();
  await settle();
  await readyEvent();
  await wait(600);
  const saved = JSON.parse(stored()!);
  expect(saved.parts[0].v).toBe("내가 쓰던 글 ");
  expect(saved.parts.find((part: { t: string }) => part.t === "chip").ref.file_path).toBe(syncReceipt.file_path);
  expect(saved.trayRefs[0].file_path).toBe(syncReceipt.file_path);
  expect(editor().textContent).toContain("내가 쓰던 글");
});

it("캔버스가 열린 동안 숨겨진 라이브러리 초안도 ready 보관본으로 저장한다", async () => {
  localStorage.setItem(key, draft("숨겨진 글", [localReference]));
  view = await mountPrompt({ trayBinding: sceneBinding("씬 글") });
  await readyEvent();
  await settle();
  expect(JSON.parse(stored()!).trayRefs[0].file_path).toBe(syncReceipt.file_path);
  expect(JSON.parse(stored()!).parts[0].v).toBe("숨겨진 글");
  expect(editor().textContent).toBe("씬 글");
});

it.each([false, true])("타 PC의 씬 없는 Library 참조는 루트 변경 후 트레이·인라인·저장 초안을 재연결한다(숨김=%s)", async (hidden) => {
  const previous = previousReference();
  const moved = movedReceipt;
  const resolveManagedAssets = vi.fn().mockResolvedValue({ items: [moved] });
  Object.assign(boundary.api, { resolveManagedAssets });
  localStorage.setItem(key, JSON.stringify({ v: 1, parts: [{ t: "text", v: "남길 글 " },
    { t: "chip", ref: previous }], trayRefs: [previous] }));
  view = await mountPrompt(hidden ? { trayBinding: sceneBinding("씬 글") } : {});
  await readyEvent([]); // 이 PC의 outbox와 캔버스에는 해당 자료가 없다.
  await settle();
  await wait(600);
  expect(resolveManagedAssets).toHaveBeenCalledWith([syncReceipt.asset_content_id], "p", {
    [syncReceipt.asset_content_id]: [syncReceipt.location_id],
  });
  const saved = JSON.parse(stored()!);
  expect(saved.parts[0].v).toBe("남길 글 ");
  expect(saved.parts.find((part: { t: string }) => part.t === "chip").ref.file_path).toBe(moved.file_path);
  expect(saved.trayRefs[0].file_path).toBe(moved.file_path);
  if (hidden) await view.render({ trayBinding: null });
  const inline = required<HTMLElement>(editor(), ".inline-ref[data-ref]");
  expect(JSON.parse(inline.dataset.ref!).file_path).toBe(moved.file_path);
});

it("Library 위치 조회가 늦게 끝나도 A→B→A 계정 왕복 전의 답은 초안에 적용하지 않는다", async () => {
  const pending = deferred<{ items: typeof movedReceipt[] }>();
  const resolveManagedAssets = vi.fn(() => pending.promise);
  Object.assign(boundary.api, { resolveManagedAssets });
  localStorage.setItem(key, JSON.stringify({ v: 1, parts: [{ t: "chip", ref: previousReference() }],
    trayRefs: [previousReference()] }));
  view = await mountPrompt();
  await readyEvent([]);
  await settle();
  expect(resolveManagedAssets).toHaveBeenCalledTimes(1);
  const contexts = await import("../src/app/operationContext");
  const original = sessionStorage.getItem("ch.accountScope");
  sessionStorage.setItem("ch.accountScope", "other-fixture");
  contexts.invalidateOperationContext();
  if (original === null) sessionStorage.removeItem("ch.accountScope");
  else sessionStorage.setItem("ch.accountScope", original);
  contexts.invalidateOperationContext();
  await act(async () => { pending.resolve({ items: [movedReceipt] }); });
  await settle();
  const inline = required<HTMLElement>(editor(), ".inline-ref[data-ref]");
  expect(JSON.parse(inline.dataset.ref!).file_path).toBe(syncReceipt.file_path);
  expect(JSON.parse(stored()!).trayRefs[0].file_path).toBe(syncReceipt.file_path);
});

it("Library 위치 조회 중 고친 글·지운 칩을 늦은 답으로 되살리지 않는다", async () => {
  const pending = deferred<{ items: typeof movedReceipt[] }>();
  Object.assign(boundary.api, { resolveManagedAssets: vi.fn(() => pending.promise) });
  localStorage.setItem(key, JSON.stringify({ v: 1, parts: [{ t: "chip", ref: previousReference() }],
    trayRefs: [previousReference()] }));
  view = await mountPrompt();
  await readyEvent([]);
  await settle();
  typeText("기다리는 동안 고친 글");
  await act(async () => { pending.resolve({ items: [movedReceipt] }); });
  await settle();
  await wait(600);
  expect(editor().textContent).toBe("기다리는 동안 고친 글");
  expect(editor().querySelector(".inline-ref[data-ref]")).toBeNull();
  expect(JSON.parse(stored()!).parts).toEqual([{ t: "text", v: "기다리는 동안 고친 글" }]);
  expect(JSON.parse(stored()!).trayRefs[0].file_path).toBe(movedReceipt.file_path);
});

it("숨은 Library 초안은 위치 조회를 기다리는 동안 다른 탭이 저장한 최신 글을 보존한다", async () => {
  const pending = deferred<{ items: typeof movedReceipt[] }>();
  Object.assign(boundary.api, { resolveManagedAssets: vi.fn(() => pending.promise) });
  localStorage.setItem(key, draft("옛 글", [previousReference()]));
  view = await mountPrompt({ trayBinding: sceneBinding("현재 씬 글") });
  await readyEvent([]);
  await settle();
  localStorage.setItem(key, draft("다른 탭이 고친 최신 글", [previousReference()]));
  await act(async () => { pending.resolve({ items: [movedReceipt] }); });
  await settle();
  expect(JSON.parse(stored()!).parts).toEqual([{ t: "text", v: "다른 탭이 고친 최신 글" }]);
  expect(JSON.parse(stored()!).trayRefs[0].file_path).toBe(movedReceipt.file_path);
  expect(editor().textContent).toBe("현재 씬 글");
});

it("Library 위치 조회 중 씬으로 전환해도 숨은 초안과 복원될 인라인을 새 위치로 맞춘다", async () => {
  const pending = deferred<{ items: typeof movedReceipt[] }>();
  Object.assign(boundary.api, { resolveManagedAssets: vi.fn(() => pending.promise) });
  localStorage.setItem(key, JSON.stringify({ v: 1, parts: [{ t: "text", v: "Library 글 " },
    { t: "chip", ref: previousReference() }], trayRefs: [previousReference()] }));
  view = await mountPrompt();
  await readyEvent([]);
  await settle();
  await view.render({ trayBinding: sceneBinding("기다리며 연 씬") });
  await act(async () => { pending.resolve({ items: [movedReceipt] }); });
  await settle();
  expect(editor().textContent).toBe("기다리며 연 씬");
  expect(JSON.parse(stored()!).trayRefs[0].file_path).toBe(movedReceipt.file_path);
  await view.render({ trayBinding: null });
  expect(editor().textContent).toContain("Library 글");
  expect(JSON.parse(required<HTMLElement>(editor(), ".inline-ref[data-ref]").dataset.ref!).file_path).toBe(movedReceipt.file_path);
});
