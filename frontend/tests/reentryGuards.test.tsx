// @vitest-environment jsdom
// 처리 중인 일은 다시 받지 않는다(조작 규칙 39).
// 2026-10-12(조작 점검 12회차, Codex 전수 검토): 단추·키를 응답 전에 한 번 더 누르면 같은 일이 겹쳐 실행됐다 — 히스토리 열기는 응답마다 씬 탭이
//  하나씩 생기고, 다운로드는 같은 파일의 사본이 생기고, Assets 반입은 서버가 이름을 _2 로 피해 사본을 만들었다(재생성은 tests/regenerateReentry).
//  누르면 안 되는 단추들이라(다운로드·업로드) 격리 실측으로는 못 본다 — 응답을 시험이 쥐고 있다가 늦게 돌려준다.
//  같은 규칙의 다른 절반('누르고 있다' 표식은 뗀 것을 놓쳐도 내린다 — 순서 손잡이)은 tests/handleRelease 가 본다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ history: vi.fn(), uploadAssets: vi.fn(), saveToDownloadDir: vi.fn(), flashMsg: vi.fn() }));
vi.mock("../src/api", () => ({ api: { history: mocks.history, uploadAssets: mocks.uploadAssets } }));
vi.mock("../src/lib/assetBroadcast", () => ({ postAssetsUpdated: vi.fn() }));
vi.mock("../src/lib/downloadDir", () => ({ saveToDownloadDir: mocks.saveToDownloadDir }));
vi.mock("../src/lib/flash", () => ({ flashMsg: mocks.flashMsg }));

import { useAssetDropImport } from "../src/components/assets/useAssetDropImport";
import { downloadMany, downloadOne } from "../src/lib/download";
import { useGenerationUtilityActions } from "../src/lib/useGenerationUtilityActions";
import type { Generation } from "../src/types";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.saveToDownloadDir.mockResolvedValue(true); // 지정 폴더에 저장된 것으로 — 브라우저 다운로드(a[download])를 타지 않는다
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const generation = (id: string) => ({ id, model: "m", prompt: "p", status: "done", params: {}, assets: [{ id: `a-${id}`, type: "image", file_path: `/media/${id}.png` }] }) as unknown as Generation;
/** 시험이 쥐고 있는 응답들 — 부를 때마다 하나씩 쌓이고, 시험이 골라서 끝낸다. */
function held<T>() {
  const waiting: Array<{ resolve: (value: T) => void; reject: (reason: unknown) => void }> = [];
  return { waiting, next: () => new Promise<T>((resolve, reject) => { waiting.push({ resolve, reject }); }) };
}
const settle = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

it("히스토리 열기 — 조회가 끝나기 전의 다시 누름은 씬 탭을 더 만들지 않는다. 끝난 뒤(실패 뒤에도)에는 다시 받는다", async () => {
  const lookups = held<{ target: { params: unknown } }>();
  mocks.history.mockImplementation(() => lookups.next());
  const openRecipe = vi.fn();
  let actions!: ReturnType<typeof useGenerationUtilityActions>;
  function Host() { actions = useGenerationUtilityActions({ flash: () => {}, openRecipe }); return null; }
  act(() => root.render(<Host />));
  const g = generation("g1");
  const first = actions.onShowHistory(g);
  await actions.onShowHistory(g); // 조회 중에 한 번 더(h 를 두 번, 단추 연타)
  void actions.onShowHistory(generation("g2")); // 다른 생성물은 따로다
  expect(mocks.history).toHaveBeenCalledTimes(2);
  lookups.waiting[0].resolve({ target: { params: {} } });
  await first;
  expect(openRecipe).toHaveBeenCalledTimes(1);
  const failing = actions.onShowHistory(g); // 끝난 뒤의 누름 = 전처럼 새 탭
  expect(mocks.history).toHaveBeenCalledTimes(3);
  lookups.waiting[2].reject(new Error("offline"));
  await failing;
  void actions.onShowHistory(g);
  expect(mocks.history).toHaveBeenCalledTimes(4);
});

it("다운로드 — 받는 중인 파일을 다시 누르면 받던 것을 같이 기다린다(사본을 만들지 않는다). 일괄이 도는 중의 단건도 같다", async () => {
  const fetches = held<{ ok: boolean; blob: () => Promise<Blob> }>();
  const fetchMock = vi.fn(() => fetches.next());
  vi.stubGlobal("fetch", fetchMock);
  const done = { ok: true, blob: async () => new Blob(["x"]) };
  const first = downloadOne("/media/a.png", "a.png");
  const second = downloadOne("/media/a.png", "a.png"); // 연타
  expect(mocks.flashMsg.mock.calls.map((call) => call[0])).toEqual(["1개 다운로드 시작…", "이미 받는 중입니다…"]);
  const bulk = downloadMany([{ url: "/media/a.png", name: "a.png" }]); // 일괄에 같은 파일이 들어 있다
  void downloadOne("/media/b.png", "b.png"); // 다른 파일은 따로 받는다
  expect(fetchMock).toHaveBeenCalledTimes(2);
  fetches.waiting[0].resolve(done);
  expect(await Promise.all([first, second])).toEqual([true, true]);
  expect(mocks.saveToDownloadDir).toHaveBeenCalledTimes(1); // 저장은 한 번
  vi.useFakeTimers();
  await vi.advanceTimersByTimeAsync(300); // 일괄의 건 사이 쉼(250ms)
  expect(await bulk).toEqual({ ok: 1, failed: 0 }); // 같이 기다린 것도 받은 것으로 센다
  void downloadOne("/media/a.png", "a.png"); // 다 받은 뒤의 다시 누름 = 새로 받는다
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("일괄 다운로드 — 도는 중에 다시 누르면 받지 않고 알린다(두 묶음이 번갈아 돌며 사본을 만들지 않는다)", async () => {
  const fetches = held<{ ok: boolean; blob: () => Promise<Blob> }>();
  const fetchMock = vi.fn(() => fetches.next());
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers();
  const flash = vi.fn();
  let actions!: ReturnType<typeof useGenerationUtilityActions>;
  function Host() { actions = useGenerationUtilityActions({ flash, openRecipe: () => {} }); return null; }
  act(() => root.render(<Host />));
  const list = [generation("g1"), generation("g2")];
  const first = actions.bulkDownload(list);
  await actions.bulkDownload(list); // 도는 중의 다시 누름
  await actions.bulkDownload([generation("g3")]); // 다른 선택이어도 하나씩
  expect(flash.mock.calls.map((call) => String(call[0]))).toEqual(["2개 다운로드 시작…", expect.stringContaining("진행 중"), expect.stringContaining("진행 중")]);
  for (let i = 0; i < 2; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
    fetches.waiting[i].resolve({ ok: true, blob: async () => new Blob(["x"]) });
    await vi.advanceTimersByTimeAsync(300);
  }
  await first;
  expect(fetchMock).toHaveBeenCalledTimes(2); // 파일마다 한 번
  void actions.bulkDownload(list); // 끝난 뒤에는 다시 받는다
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("Assets 반입 — 올리는 중인 같은 파일을 다시 놓으면 올리지 않는다(서버가 _2 로 사본을 만든다). '가져오는 중' 표시는 겹친 반입이 다 끝나야 꺼진다", async () => {
  const uploads = held<{ saved: string[]; skipped: string[] }>();
  mocks.uploadAssets.mockImplementation(() => uploads.next());
  const alert = vi.fn();
  vi.stubGlobal("alert", alert);
  let zone!: ReturnType<typeof useAssetDropImport>;
  function Host() { zone = useAssetDropImport({ dir: "refs", project: "p1", onImported: () => {} }); return null; }
  act(() => root.render(<Host />));
  const file = (name: string, size = 3) => Object.assign(new File(["x".repeat(size)], name, { lastModified: 1 }), {});
  const drop = (files: File[]) => act(() => {
    zone.onZoneDrop({ preventDefault: () => {}, dataTransfer: { types: ["Files"], files, items: [] } } as never);
  });
  const big = file("big.mp4");
  drop([big]);
  expect(zone.importing).toBe(true);
  drop([file("big.mp4")]); // 같은 파일을 다시 놓았다(같은 이름·크기·수정 시각)
  expect(mocks.uploadAssets).toHaveBeenCalledTimes(1);
  expect(alert).toHaveBeenCalledWith(expect.stringContaining("이미 가져오는 중"));
  drop([file("big.mp4"), file("other.png"), file("other.png")]); // 겹친 것만 빼고(같은 묶음 안의 겹침도) 나머지는 받는다
  expect(mocks.uploadAssets).toHaveBeenCalledTimes(2);
  expect((mocks.uploadAssets.mock.calls[1][2] as File[]).map((item) => item.name)).toEqual(["other.png"]);
  await act(async () => { uploads.waiting[1].resolve({ saved: ["other.png"], skipped: [] }); await settle(); });
  expect(zone.importing).toBe(true); // 먼저 끝난 반입이 표시를 지우지 않는다 — 큰 파일이 아직 올라가는 중이다
  await act(async () => { uploads.waiting[0].resolve({ saved: ["big.mp4"], skipped: [] }); await settle(); });
  expect(zone.importing).toBe(false);
  drop([file("big.mp4")]); // 다 올라간 뒤에 다시 놓는 것은 전처럼 받는다
  expect(mocks.uploadAssets).toHaveBeenCalledTimes(3);
});
