// 캔버스 씬 DB 백업 — 미러·복구의 안전 불변식 고정(코덱스 P1 반영분).
//  핵심: 복구 판정이 끝나기 전(또는 실패·손상 시) sync 가 서버 백업을 지우지 않는다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vitest node 환경 스텁 — localStorage + window(online 리스너용).
const mem = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => void mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  },
};
(globalThis as Record<string, unknown>).window = globalThis;
if (!(globalThis as Record<string, unknown>).addEventListener) {
  (globalThis as Record<string, unknown>).addEventListener = () => {};
}

// jsonFetch 목 — 테스트가 URL 별 응답을 지정한다.
type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
let getMeta: () => Promise<{ items: unknown[] }>; // GET ?project_id=
let getFull: () => Promise<{ items: unknown[] }>; // GET ?project_id=&include_data=1
vi.mock("../src/lib/http", () => ({
  jsonFetch: (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (init?.method === "PUT") return Promise.resolve({ ok: true });
    if (url.includes("include_data")) return getFull();
    return getMeta();
  },
}));

const puts = () => calls.filter((c) => c.init?.method === "PUT");
const putBody = (c: Call) => JSON.parse(String(c.init?.body));

let acctSeq = 0;
async function boot() {
  vi.resetModules(); // 모듈 상태(scope·lastPushed·타이머 플래그) 초기화
  const scenes = await import("../src/lib/scenes");
  const backup = await import("../src/lib/sceneBackup");
  return { scenes, backup };
}

function sceneJson(id: string, name = "씬") {
  return JSON.stringify({ id, name, cards: [], edges: [], created_at: 1 });
}

describe("sceneBackup (DB 미러·복구)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    mem.clear();
    acctSeq += 1;
    localStorage.setItem("ch.activeAccount", `user${acctSeq}@test`);
    getMeta = () => Promise.resolve({ items: [] });
    getFull = () => Promise.resolve({ items: [] });
  });

  afterEach(() => {
    // 이전 테스트 모듈 인스턴스의 잔여 타이머(디바운스·백오프)가 다음 테스트에서 발화해
    // 같은 fetch 목으로 중복 PUT 을 만들지 않게 — 모듈 리셋과 별개로 타이머 큐를 비운다.
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("초기 reconcile — 배포 전부터 있던(수정 안 한) 씬도 1회 미러된다", async () => {
    const { scenes, backup } = await boot();
    scenes.saveScenes(null, [JSON.parse(sceneJson("s1", "기존씬"))]);
    await backup.initSceneBackup();
    await vi.advanceTimersByTimeAsync(2500);
    expect(puts().length).toBe(1);
    const body = putBody(puts()[0]);
    expect(body.upserts.map((u: { id: string }) => u.id)).toEqual(["s1"]);
    expect(body.deleted_ids).toEqual([]);
  });

  it("복구 — 버킷 키가 없으면 DB 전체를 복원하고, 직후 sync 에코(재업로드)가 없다", async () => {
    const items = [
      { id: "a", data: sceneJson("a"), data_hash: "x" },
      { id: "b", data: sceneJson("b"), data_hash: "y" },
    ];
    getFull = () => Promise.resolve({ items });
    getMeta = () => Promise.resolve({ items });
    const { scenes, backup } = await boot();
    const restored = await backup.initSceneBackup();
    expect(restored).toBe(true);
    expect(scenes.listScenes(null).map((s) => s.id)).toEqual(["a", "b"]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(puts().length).toBe(0); // 복구 에코 없음 — lastPushed 가 이미 채워짐
  });

  it("빈 배열 버킷(정상 삭제 결과)은 복구하지 않는다", async () => {
    getFull = () => Promise.resolve({ items: [{ id: "a", data: sceneJson("a") }] });
    const { scenes, backup } = await boot();
    scenes.saveScenes(null, []); // 버킷 키는 존재(내용만 빈 배열)
    const restored = await backup.initSceneBackup();
    expect(restored).toBe(false);
    expect(scenes.listScenes(null)).toEqual([]);
  });

  it("손상 백업 — 부분 복구 없이 전체 포기 + 이 세션 sync 중단(삭제 정합으로 안 지움)", async () => {
    getFull = () =>
      Promise.resolve({
        items: [
          { id: "a", data: sceneJson("a") },
          { id: "bad", data: "{corrupt" },
        ],
      });
    const { scenes, backup } = await boot();
    const restored = await backup.initSceneBackup();
    expect(restored).toBe(false);
    expect(scenes.listScenes(null)).toEqual([]); // 부분 복구 잔재 없음
    await vi.advanceTimersByTimeAsync(60_000);
    expect(puts().length).toBe(0); // 손상 상태에선 서버를 건드리지 않는다
  });

  it("복구 조회 실패(미로그인 등) — sync 차단(전량삭제 사고 방지), 성공 후 백오프로 복구된다", async () => {
    let fail = true;
    getFull = () => (fail ? Promise.reject(new Error("401")) : Promise.resolve({
      items: [{ id: "a", data: sceneJson("a"), data_hash: "x" }],
    }));
    getMeta = () => (fail ? Promise.reject(new Error("401")) : Promise.resolve({
      items: [{ id: "a", data_hash: "x" }],
    }));
    const { scenes, backup } = await boot();
    const restored = await backup.initSceneBackup();
    expect(restored).toBe(false);
    await vi.advanceTimersByTimeAsync(2500); // 초기 sync — 판정 미상이라 서버 변경 없음
    expect(puts().length).toBe(0);
    fail = false; // "로그인 됨"
    await vi.advanceTimersByTimeAsync(31_000); // 백오프 재시도 → 재판정 → 복구
    expect(scenes.listScenes(null).map((s) => s.id)).toEqual(["a"]);
    expect(puts().length).toBe(0); // 복구 에코 없음
  });

  it("삭제 미러 — 로컬에서 지운 씬은 서버 diff 로 삭제되고, 대량이면 분할된다", async () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ id: `d${i}`, data_hash: "h" }));
    getMeta = () => Promise.resolve({ items: many });
    const { scenes, backup } = await boot();
    scenes.saveScenes(null, []); // 버킷 존재(전부 삭제된 상태) → 서버 501건은 diff 삭제 대상
    await backup.initSceneBackup();
    await vi.advanceTimersByTimeAsync(2500);
    expect(puts().length).toBe(2); // 500 + 1 분할(서버 상한과 동일)
    expect(putBody(puts()[0]).deleted_ids.length).toBe(500);
    expect(putBody(puts()[1]).deleted_ids.length).toBe(1);
  });
});
