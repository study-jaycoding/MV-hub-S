// @vitest-environment jsdom
// 생성물의 다운로드 이름은 허브가 정한다 — `<프로젝트>_<폴더>_<work|share|fin>_<작업자>_<번호>`(docs/EXPORT_SYNC_DESIGN.md §7).
// 2026-10-13(Jay): 카드에서 받은 파일의 이름이 저장·Resolve 보내기의 이름 규칙과 달랐다(`vid-<id 8자>.mp4`).
// 여기서 고정하는 것: 받을 때만 이름을 묻는다 · 이름을 묻는 동안의 연타는 하나로 모인다 · 번호를 못 받아도 다운로드는 된다(알린다).
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ jsonFetch: vi.fn(), saveToDownloadDir: vi.fn(), flashMsg: vi.fn() }));
vi.mock("../src/lib/http", async (original) => ({ ...(await original<typeof import("../src/lib/http")>()), jsonFetch: mocks.jsonFetch }));
vi.mock("../src/lib/assetBroadcast", () => ({ postAssetsUpdated: vi.fn() }));
vi.mock("../src/lib/downloadDir", () => ({ saveToDownloadDir: mocks.saveToDownloadDir }));
vi.mock("../src/lib/flash", () => ({ flashMsg: mocks.flashMsg }));

import { downloadGeneration, generationDownloadNames, nameGenerationItems } from "../src/lib/download";

const NAME = "뻘뻘뻘_e035_C0050_share_리버_001.mp4";
const flashes = () => mocks.flashMsg.mock.calls.map((call) => String(call[0]));
const saved = () => mocks.saveToDownloadDir.mock.calls.map((call) => String(call[0]));
const asked = () => mocks.jsonFetch.mock.calls.map((call) => [call[0], JSON.parse(String((call[1] as RequestInit).body)).gen_ids]);

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.saveToDownloadDir.mockResolvedValue(true);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, blob: async () => new Blob(["x"]) })));
});
afterEach(() => vi.unstubAllGlobals());

it("카드 다운로드 — 허브가 정한 이름으로 받고, 이름을 묻는 동안 다시 눌러도 요청도 파일도 하나다", async () => {
  let answer!: (value: unknown) => void;
  mocks.jsonFetch.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
  const first = downloadGeneration("/media/a.mp4", "g1", "vid-g1.mp4");
  const second = downloadGeneration("/media/a.mp4", "g1", "vid-g1.mp4"); // 연타 — 이름도 아직 못 받았다
  expect(flashes()).toEqual(["1개 다운로드 시작…", "이미 받는 중입니다…"]); // 누르자마자 알린다(이름을 기다리지 않는다)
  expect(asked()).toEqual([["/api/download/names", ["g1"]]]); // 생성물 id 만 보낸다 — 이름·종류는 허브가 정한다
  answer({ names: { g1: { name: NAME, numbered: true } } });
  expect(await Promise.all([first, second])).toEqual([true, true]);
  expect(saved()).toEqual([NAME]);
  expect(flashes()).toHaveLength(2); // 번호를 받았으면 더 알릴 것이 없다
  mocks.jsonFetch.mockResolvedValue({ names: { g1: { name: NAME, numbered: true } } });
  await downloadGeneration("/media/a.mp4", "g1", "vid-g1.mp4"); // 다 받은 뒤의 다시 누름 = 다시 받는다(같은 이름)
  expect([saved(), asked().length]).toEqual([[NAME, NAME], 2]);
});

it("번호를 못 받아도 다운로드는 된다 — 임시 이름·옛 이름으로 받고 알린다", async () => {
  mocks.jsonFetch.mockResolvedValueOnce({ names: { g1: { name: "뻘뻘뻘_work_리버_x1a2b3c4d.mp4", numbered: false } } });
  expect(await downloadGeneration("/media/a.mp4", "g1", "vid-g1.mp4")).toBe(true);
  mocks.jsonFetch.mockRejectedValueOnce(new Error("허브 응답 없음"));
  expect(await downloadGeneration("/media/b.mp4", "g2", "vid-g2.mp4")).toBe(true);
  mocks.jsonFetch.mockResolvedValueOnce({ names: {} }); // 볼 수 없거나 없는 생성물은 응답에서 빠진다
  expect(await downloadGeneration("/media/c.mp4", "g3", "vid-g3.mp4")).toBe(true);
  expect(saved()).toEqual(["뻘뻘뻘_work_리버_x1a2b3c4d.mp4", "vid-g2.mp4", "vid-g3.mp4"]);
  expect(flashes().filter((text) => text.includes("번호를 받지 못해"))).toHaveLength(3);
  expect(flashes().every((text) => !/^\d+개는/.test(text))).toBe(true); // 한 개일 때는 개수를 붙이지 않는다
});

it("단건이 이름을 묻는 중에 일괄이 같은 생성물을 물으면 한 답을 같이 쓴다 — 같은 파일을 두 이름으로 받지 않는다", async () => {
  const answers: Array<(value: unknown) => void> = [];
  mocks.jsonFetch.mockImplementation(() => new Promise((resolve) => { answers.push(resolve); }));
  const single = downloadGeneration("/media/a.mp4", "g1", "vid-g1.mp4");
  const bulk = nameGenerationItems([{ url: "/media/a.mp4", name: "vid-g1.mp4", genId: "g1" }, { url: "/media/b.mp4", name: "vid-g2.mp4", genId: "g2" }]);
  await Promise.resolve();
  expect(asked()).toEqual([["/api/download/names", ["g1"]], ["/api/download/names", ["g2"]]]); // g1 은 다시 묻지 않는다
  answers[0]({ names: { g1: { name: NAME, numbered: true } } });
  answers[1]({ names: {} }); // 두 번째 요청은 번호를 못 받았다 — 따로 물었다면 g1 이 여기서 옛 이름이 됐다
  expect(await single).toBe(true);
  expect((await bulk).items.map((item) => item.name)).toEqual([NAME, "vid-g2.mp4"]);
});

it("허브가 답하지 않으면 기다리다 옛 이름으로 받는다 — 이름 요청에 제한 시간이 있다", async () => {
  vi.useFakeTimers();
  try {
    mocks.jsonFetch.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted"))); // NAS 가 멎은 허브 — 끊어야만 끝난다
    }));
    const pending = downloadGeneration("/media/a.mp4", "g1", "vid-g1.mp4");
    await vi.advanceTimersByTimeAsync(9_000);
    expect(saved()).toEqual([]); // 아직 기다린다
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toBe(true);
    expect(saved()).toEqual(["vid-g1.mp4"]);
    expect(flashes().at(-1)).toContain("번호를 받지 못해");
  } finally {
    vi.useRealTimers();
  }
});

it("일괄 다운로드의 이름 — 200개씩 묻고, 번호를 못 받은 것만 옛 이름으로 두고 몇 개인지 알린다", async () => {
  const items = Array.from({ length: 201 }, (_, i) => ({ url: `/media/${i}.mp4`, name: `vid-${i}.mp4`, genId: `g${i}` }));
  mocks.jsonFetch.mockImplementation(async (_url: string, init: RequestInit) => {
    const ids: string[] = JSON.parse(String(init.body)).gen_ids;
    return { names: Object.fromEntries(ids.filter((id) => id !== "g7").map((id) => [id, { name: `P_c1_work_w_${id}.mp4`, numbered: id !== "g9" }])) };
  });
  const named = await nameGenerationItems(items);
  expect(asked().map(([, ids]) => (ids as string[]).length)).toEqual([200, 1]);
  expect([named.items[0], named.items[7].name, named.items[9].name, named.items[200].name])
    .toEqual([{ url: "/media/0.mp4", name: "P_c1_work_w_g0.mp4", genId: "g0" }, "vid-7.mp4", "P_c1_work_w_g9.mp4", "P_c1_work_w_g200.mp4"]);
  expect(named.notice).toContain("2개는 번호를 받지 못해"); // g7(이름 없음) · g9(임시 이름)
  mocks.jsonFetch.mockResolvedValue({ names: { g0: { name: "a.mp4", numbered: true } } });
  expect((await nameGenerationItems(items.slice(0, 1))).notice).toBeNull();
  expect(await generationDownloadNames([])).toEqual({}); // 받을 것이 없으면 묻지도 않는다
  expect(asked()).toHaveLength(3);
});
