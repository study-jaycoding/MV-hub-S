// @vitest-environment jsdom
// 태그는 화면에 먼저 반영하고 뒤에서 저장한다. 캔버스(씬)는 생성물 사본을 따로 들고 있고 완료 카드는 평소 다시 읽지 않으므로,
// **저장 묶음이 끝날 때마다**(성공·실패 모두, 마지막 저장 뒤 한 번) 같은 창에 알려 그 사본을 서버 값으로 다시 읽게 한다.
// 실패 때만 알리면: 복구 조회를 기다리는 사이에 들어온 다음 편집이, 먼저 끝난 다시 읽기에 옛 값으로 덮인 채 남는다
// (Codex 코드 리뷰 2026-10-07 — 일회성으로 갚는 방식은 같은 순서가 한 단계 뒤에서 또 생겼다).
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { APP_EVENTS } from "../src/lib/appEvents";
import { useGenerationTagActions } from "../src/lib/useGenerationTagActions";
import type { Generation } from "../src/types";

const api = vi.hoisted(() => ({ setTags: vi.fn(), setGenAutoTags: vi.fn(), setTagsBatch: vi.fn() }));
vi.mock("../src/api", () => ({ api }));

const generation = { id: "g1", tags: [], auto_tags: [] } as unknown as Generation;
const flash = vi.fn();
const reload = vi.fn(async () => {});
const settled = vi.fn();
const libraryChanged = vi.fn();
let actions!: ReturnType<typeof useGenerationTagActions>;
let root: Root;
let host: HTMLDivElement;

function Harness() {
  actions = useGenerationTagActions({
    flash, reload, onTagNamesAdded: () => {}, setGens: () => {},
    gensRef: useRef([generation]), selectedRef: useRef(new Set<string>()),
  });
  return null;
}
const settle = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((done) => setTimeout(done, 0)); });
const deferred = () => { let finish!: () => void; const promise = new Promise<void>((done) => { finish = done; }); return { promise, finish }; };

beforeEach(() => {
  vi.resetAllMocks();
  reload.mockImplementation(async () => {});
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.addEventListener(APP_EVENTS.generationTagsSettled, settled);
  window.addEventListener(APP_EVENTS.libraryChanged, libraryChanged);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<Harness />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.removeEventListener(APP_EVENTS.generationTagsSettled, settled);
  window.removeEventListener(APP_EVENTS.libraryChanged, libraryChanged);
  vi.unstubAllGlobals();
});

it("저장 실패 — 목록을 다시 받은 뒤 '태그 저장 끝'을 알린다(씬 사본이 서버 값으로 돌아간다)", async () => {
  api.setTags.mockRejectedValue(new Error("500: boom"));
  act(() => actions.onSetTags(generation, ["x"]));
  await settle();
  expect(reload).toHaveBeenCalledWith(false, false);
  expect(flash).toHaveBeenCalledWith(expect.stringContaining("태그 저장 1건 실패"));
  expect(settled).toHaveBeenCalledTimes(1);
  expect(libraryChanged).not.toHaveBeenCalled(); // 폴더 집계·생성자 목록까지 깨우지 않는다
});

it("저장 성공 — 목록 조회가 끝난 뒤에 알린다 · 연달아 넣은 편집은 마지막 저장 뒤 한 번만", async () => {
  const listReload = deferred();
  reload.mockImplementationOnce(() => listReload.promise);
  api.setTags.mockResolvedValue({});
  act(() => {
    actions.onSetTags(generation, ["a"]);
    actions.onSetTags(generation, ["a", "b"]);
    actions.onSetTags(generation, ["a", "b", "c"]);
  });
  await settle();
  expect(api.setTags).toHaveBeenCalledTimes(3);
  expect(reload).toHaveBeenCalledTimes(1); // 마지막 저장 뒤 한 번
  expect(settled).not.toHaveBeenCalled(); // 조회가 끝나기 전에는 알리지 않는다
  listReload.finish();
  await settle();
  expect(settled).toHaveBeenCalledTimes(1);
});

it("앞선 정리를 기다리는 사이에 들어온 편집 — 그 저장이 끝난 뒤에도 다시 알린다(실패 복구 뒤·성공 정리 뒤 모두)", async () => {
  // A 실패 → 복구 조회(느림) → 그동안 B 편집 → 복구 끝·알림 1 → B 저장 → B 의 정리 조회(느림) → 그동안 C 편집 → 알림 2 → C 저장 → 알림 3.
  //  씬의 다시 읽기가 뒤따르는 저장보다 먼저 끝나 방금 한 편집을 덮더라도, 그 저장 뒤의 알림이 최종 값으로 맞춘다.
  const recovery = deferred();
  const reloadAfterB = deferred();
  const saveC = deferred();
  reload.mockImplementationOnce(() => recovery.promise).mockImplementationOnce(() => reloadAfterB.promise);
  api.setTags.mockRejectedValueOnce(new Error("500: boom")).mockResolvedValueOnce({}).mockImplementationOnce(() => saveC.promise);
  act(() => actions.onSetTags(generation, ["a"]));
  await settle();
  expect(reload).toHaveBeenCalledTimes(1); // 복구 조회 대기 중
  act(() => actions.onSetTags(generation, ["b"]));
  await settle();
  expect(api.setTags).toHaveBeenCalledTimes(1); // B 는 복구가 끝나야 나간다
  recovery.finish();
  await settle();
  expect(settled).toHaveBeenCalledTimes(1);
  expect(api.setTags).toHaveBeenCalledTimes(2); // B 저장됨 → B 의 정리 조회 대기 중
  act(() => actions.onSetTags(generation, ["c"]));
  await settle();
  expect(api.setTags).toHaveBeenCalledTimes(2); // C 는 B 의 정리가 끝나야 나간다
  reloadAfterB.finish();
  await settle();
  expect(settled).toHaveBeenCalledTimes(2);
  expect(api.setTags).toHaveBeenCalledTimes(3); // C 저장 중
  saveC.finish();
  await settle();
  expect(settled).toHaveBeenCalledTimes(3); // C 가 저장된 뒤에도 한 번 — 여기서 씬이 최종 값으로 맞는다
});

// 14회차(조작 규칙 41): 전엔 "서버 상태로 되돌렸습니다"라고 했다. 서버에 닿지 않아 저장이 실패하면 되돌리려던 조회도 실패한다 —
//  화면에는 저장 안 된 태그가 그대로 남고, 그 말을 믿으면 저장된 것으로 읽는다. 되돌렸는지는 여기서 다 확인할 수 없으니 단정하지 않는다.
//  (목록 다시 받기는 실패해도 던지지 않는다 — 자기 안내 "로드 실패"를 띄우고 끝난다. 그래서 이 훅은 조회의 성패를 모른다.)
it("저장 실패 — '되돌렸다'고 단정하지 않는다(되돌리려던 조회까지 실패해도 안내가 거짓이 되지 않는다)", async () => {
  api.setTags.mockRejectedValue(new Error("502: 서버에 닿지 않습니다"));
  act(() => actions.onSetTags(generation, ["x"]));
  await settle();
  expect(flash).toHaveBeenCalledExactlyOnceWith("태그 저장 1건 실패 — 저장되지 않았습니다. 화면에 그 태그가 남아 있으면 새로 고치세요.");
});
