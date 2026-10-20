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
import { setAuthToken } from "../src/lib/http";
import { setAccountScope } from "../src/lib/accountScope";
import { clearGenerationReadModels, getGenerationReadModel } from "../src/features/library/readModels";

const api = vi.hoisted(() => ({ setTags: vi.fn(), setGenAutoTags: vi.fn(), setTagsBatch: vi.fn() }));
vi.mock("../src/api", () => ({ api }));

let generation: Generation;
const flash = vi.fn();
const reload = vi.fn(async () => {});
const settled = vi.fn();
const libraryChanged = vi.fn();
let actions!: ReturnType<typeof useGenerationTagActions>;
let root: Root;
let host: HTMLDivElement;
let selected: Set<string>;
const peerMessages: unknown[] = [];
class TagChannel {
  postMessage(value: unknown) { peerMessages.push(value); }
  close() {}
}

function Harness() {
  actions = useGenerationTagActions({
    flash, reload, onTagNamesAdded: () => {}, setGens: () => {},
    gensRef: useRef([generation]), selectedRef: useRef(selected),
  });
  return null;
}
const settle = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((done) => setTimeout(done, 0)); });
const deferred = () => { let finish!: () => void; const promise = new Promise<void>((done) => { finish = done; }); return { promise, finish }; };

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear(); sessionStorage.clear(); setAccountScope(""); setAuthToken(null); clearGenerationReadModels();
  generation = { id: "g1", tags: [], auto_tags: [] } as unknown as Generation;
  selected = new Set();
  reload.mockImplementation(async () => {});
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  peerMessages.length = 0;
  vi.stubGlobal("BroadcastChannel", TagChannel);
  window.addEventListener(APP_EVENTS.generationTagsSettled, settled);
  window.addEventListener(APP_EVENTS.libraryChanged, libraryChanged);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<Harness />));
});

it("broadcasts the exact settled change to peer tabs after reconciliation without broad notification", async () => {
  api.setTags.mockResolvedValue({});
  act(() => { actions.onSetTags(generation, ["peer-tag"]); });
  await settle();
  expect(peerMessages).toHaveLength(1);
  expect(peerMessages[0]).toMatchObject({ event: APP_EVENTS.generationTagsSettled,
    change: settled.mock.calls[0][0].detail.change });
  expect(libraryChanged).not.toHaveBeenCalled();
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
  act(() => { actions.onSetTags(generation, ["x"]); });
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
  act(() => { actions.onSetTags(generation, ["a"]); });
  await settle();
  expect(reload).toHaveBeenCalledTimes(1); // 복구 조회 대기 중
  act(() => { actions.onSetTags(generation, ["b"]); });
  await settle();
  expect(api.setTags).toHaveBeenCalledTimes(1); // B 는 복구가 끝나야 나간다
  recovery.finish();
  await settle();
  expect(settled).toHaveBeenCalledTimes(1);
  expect(api.setTags).toHaveBeenCalledTimes(2); // B 저장됨 → B 의 정리 조회 대기 중
  act(() => { actions.onSetTags(generation, ["c"]); });
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

// 81회차 실측 2 M2-6: 태그 저장은 한 줄로 차례를 선다 — 저장이 남은 채 새로고침(F5)·창 닫기(Ctrl+W)를 하면 브라우저가 묻지 않아,
//  아직 출발하지 못한 저장이 경고 없이 사라졌다. 기존 종료 보호(lib/unloadGuard)에 '태그 저장 안 끝남'을 건다.
const leave = () => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented; // 참 = 브라우저가 '떠날까요?'를 묻는다
};
it("태그 저장이 남아 있는 동안 새로고침·창 닫기를 하면 묻는다 — 저장이 다 끝나면(실패도) 묻지 않는다", async () => {
  const first = deferred();
  const second = deferred();
  api.setTags.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise).mockResolvedValue({});
  expect(leave()).toBe(false);
  act(() => {
    actions.onSetTags(generation, ["a"]);
    actions.onSetTags(generation, ["a", "b"]);
    actions.onSetTags(generation, ["a", "b", "c"]);
  });
  await settle();
  expect(api.setTags).toHaveBeenCalledTimes(1); // 뒤의 둘은 아직 출발도 못 했다
  expect(leave()).toBe(true);
  first.finish();
  await settle();
  expect(api.setTags).toHaveBeenCalledTimes(2); // 둘째 저장 중 — 셋째는 아직 줄에
  expect(leave()).toBe(true); // 중간 저장이 끝나도 남은 저장이 있으면 계속 묻는다(Codex 리뷰 P3)
  second.finish();
  await settle();
  expect(api.setTags).toHaveBeenCalledTimes(3);
  expect(leave()).toBe(false);
  api.setTags.mockRejectedValueOnce(new Error("500: boom"));
  act(() => { actions.onSetTags(generation, ["x"]); });
  expect(leave()).toBe(true);
  await settle();
  expect(leave()).toBe(false); // 실패도 끝이다 — 안내는 실패 알림이 한다
});

// 14회차(조작 규칙 41): 전엔 "서버 상태로 되돌렸습니다"라고 했다. 서버에 닿지 않아 저장이 실패하면 되돌리려던 조회도 실패한다 —
//  화면에는 저장 안 된 태그가 그대로 남고, 그 말을 믿으면 저장된 것으로 읽는다. 되돌렸는지는 여기서 다 확인할 수 없으니 단정하지 않는다.
//  (목록 다시 받기는 실패해도 던지지 않는다 — 자기 안내 "로드 실패"를 띄우고 끝난다. 그래서 이 훅은 조회의 성패를 모른다.)
it("저장 실패 — '되돌렸다'고 단정하지 않는다(되돌리려던 조회까지 실패해도 안내가 거짓이 되지 않는다)", async () => {
  api.setTags.mockRejectedValue(new Error("502: 서버에 닿지 않습니다"));
  act(() => { actions.onSetTags(generation, ["x"]); });
  await settle();
  expect(flash).toHaveBeenCalledExactlyOnceWith("태그 저장 1건 실패 — 저장되지 않았습니다. 화면에 그 태그가 남아 있으면 새로 고치세요.");
});

it("settled detail contains only operations completed before this reconciliation, including failures", async () => {
  const recovery = deferred();
  reload.mockImplementationOnce(() => recovery.promise);
  api.setTags.mockRejectedValueOnce(new Error("save failed"));
  api.setGenAutoTags.mockResolvedValue({});
  act(() => { actions.onSetTags(generation, ["x"]); });
  await settle();
  act(() => { actions.onSetAutoTags({ ...generation, id: "g2" }, ["later"]); });
  await settle();
  expect(api.setGenAutoTags).not.toHaveBeenCalled();
  recovery.finish();
  await settle();
  expect(settled.mock.calls.map(([event]) => ({ ids: event.detail.ids, fields: event.detail.fields }))).toEqual([
    { ids: ["g1"], fields: ["tags"] },
    { ids: ["g2"], fields: ["auto_tags"] },
  ]);
});

it("one settled burst deduplicates ids and retains both actual tag fields", async () => {
  api.setTags.mockResolvedValue({}); api.setGenAutoTags.mockResolvedValue({});
  act(() => {
    actions.onSetTags(generation, ["a"]);
    actions.onSetTags(generation, ["b"]);
    actions.onSetAutoTags({ ...generation, id: "g2" }, ["c"]);
  });
  await settle();
  expect(settled.mock.calls.map(([event]) => ({ ids: event.detail.ids, fields: event.detail.fields }))).toEqual([
    { ids: ["g1", "g2"], fields: ["tags", "auto_tags"] },
  ]);
});

it("failed reconciliation still announces its captured ids and leaves later saves usable", async () => {
  reload.mockRejectedValueOnce(new Error("read failed"));
  api.setTags.mockResolvedValue({}); api.setGenAutoTags.mockResolvedValue({});
  act(() => { actions.onSetTags(generation, ["a"]); });
  await settle();
  act(() => { actions.onSetAutoTags(generation, ["b"]); });
  await settle();
  expect(settled.mock.calls.map(([event]) => ({ ids: event.detail.ids, fields: event.detail.fields }))).toEqual([
    { ids: ["g1"], fields: ["tags"] }, { ids: ["g1"], fields: ["auto_tags"] },
  ]);
});

it("bulk partial failure announces actual sent ids, not unloaded selection ids", async () => {
  selected.add("g1"); selected.add("unloaded");
  api.setTagsBatch.mockResolvedValue({ succeeded: [], failed: ["g1"] });
  act(() => { actions.onBulkAddAutoTags(generation, ["x"]); });
  await settle();
  expect(api.setTagsBatch).toHaveBeenCalledWith([{ id: "g1", tags: ["x"] }], true, expect.any(Function));
  expect(settled.mock.calls.map(([event]) => ({ ids: event.detail.ids, fields: event.detail.fields }))).toEqual([{ ids: ["g1"], fields: ["auto_tags"] }]);
  expect(reload).toHaveBeenCalledWith(false, false);
});

it("queued old-account saves and notifications cannot run after A to B to A", async () => {
  const first = deferred();
  api.setTags.mockImplementationOnce(() => first.promise);
  act(() => { actions.onSetTags(generation, ["first"]); actions.onSetTags(generation, ["queued"]); });
  await settle(); expect(api.setTags).toHaveBeenCalledTimes(1);
  getGenerationReadModel("B", "lookup"); getGenerationReadModel("", "lookup");
  first.finish(); await settle();
  expect(api.setTags).toHaveBeenCalledTimes(1);
  expect(reload).not.toHaveBeenCalled(); expect(settled).not.toHaveBeenCalled(); expect(flash).not.toHaveBeenCalled();
});

it("captures tag input and discards a reconciliation that crosses account scope", async () => {
  const waiting = deferred(); reload.mockImplementationOnce(() => waiting.promise);
  const tags = ["captured"];
  act(() => { actions.onSetTags(generation, tags); }); tags.push("later");
  await settle(); expect(api.setTags).toHaveBeenCalledWith("g1", ["captured"], expect.any(Function));
  setAuthToken("different-synthetic-account");
  waiting.finish(); await settle();
  expect(settled).not.toHaveBeenCalled(); expect(flash).not.toHaveBeenCalled();
});
