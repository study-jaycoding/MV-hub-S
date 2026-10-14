// @vitest-environment jsdom
// Jay 결정 5B(10-15): 라이브러리 프롬프트에 쓰다 만 글·트레이 참조를 같은 브라우저에 담아 두고 다시 열면 되살린다(묻지 않는다).
//  계정마다 따로 · 씬 카드 글은 담지 않음 · 캔버스 탭으로 켜도 빈 글로 덮지 않음 · 보낸 뒤(글이 비면) 바로 지움(Codex C17·C18).
// 실제 SpotlightPrompt·트레이 훅을 통과한다.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { installPromptBoundaryMocks, mountPrompt, required, settle, type PromptProps } from "./seedanceRenderHarness";

let view: Awaited<ReturnType<typeof mountPrompt>> | undefined;
let key = "";

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
  installPromptBoundaryMocks();
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
