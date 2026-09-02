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

  it("같은 세션에서 올린 씬을 삭제하면 서버 백업도 즉시 삭제한다", async () => {
    const { scenes, backup } = await boot();
    scenes.saveScenes(null, [JSON.parse(sceneJson("s1", "잠시 만든 씬"))]);
    await backup.initSceneBackup();
    await vi.advanceTimersByTimeAsync(2500); // 첫 reconcile → 서버 upsert
    expect(puts().length).toBe(1);
    expect(putBody(puts()[0]).upserts.map((u: { id: string }) => u.id)).toEqual(["s1"]);

    scenes.saveScenes(null, []); // 같은 페이지를 유지한 채 방금 올린 씬 삭제
    await vi.advanceTimersByTimeAsync(2500);
    expect(puts().length).toBe(2);
    expect(putBody(puts()[1]).upserts).toEqual([]);
    expect(putBody(puts()[1]).deleted_ids).toEqual(["s1"]);
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

  it("백그라운드 복구도 구독자에게 통지된다 — 로그인 후 열린 캔버스가 즉시 갱신(코덱스 P1)", async () => {
    let fail = true;
    getFull = () => (fail ? Promise.reject(new Error("401")) : Promise.resolve({
      items: [{ id: "a", data: sceneJson("a"), data_hash: "x" }],
    }));
    getMeta = () => (fail ? Promise.reject(new Error("401")) : Promise.resolve({
      items: [{ id: "a", data_hash: "x" }],
    }));
    const { backup } = await boot();
    const notified: number[] = [];
    backup.subscribeSceneRestore(() => notified.push(1));
    await backup.initSceneBackup(); // 401 — 복구 실패(retry)
    expect(notified.length).toBe(0);
    fail = false; // 로그인 됨
    await vi.advanceTimersByTimeAsync(35_000); // 백오프 재시도 → 백그라운드 복구
    expect(notified.length).toBe(1); // 화면 갱신 경로가 불렸다
  });

  it("chunkUpserts — UTF-8 바이트 기준 분할(멀티바이트 씬이 서버 총량 400 에 영구 걸리지 않게)", async () => {
    const { backup } = await boot();
    // '가'=UTF-8 3바이트. JS length 4 짜리 두 항목 — 바이트로는 12 씩이라 상한 20 에서 갈라져야 한다.
    const a = { id: "a", data: "가가가가" };
    const b = { id: "b", data: "가가가가" };
    const chunks = backup.chunkUpserts([a, b], 200, 20);
    expect(chunks.length).toBe(2); // length 기준(8)이면 한 청크로 뭉쳤을 것
    expect(chunks[0][0].id).toBe("a");
    expect(chunks[1][0].id).toBe("b");
  });

  it("삭제 미러 — 이 세션에서 본 씬을 지우면 서버에서도 지우고, 대량이면 분할된다", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `d${i}`);
    getMeta = () => Promise.resolve({ items: ids.map((id) => ({ id, data_hash: "h" })) });
    getFull = () => Promise.resolve({ items: ids.map((id) => ({ id, data: sceneJson(id) })) });
    const { scenes, backup } = await boot();
    await backup.initSceneBackup(); // 버킷 없음 → 복구 → 이 세션이 501건을 '본다'
    await vi.advanceTimersByTimeAsync(2500);
    expect(puts().length).toBe(0); // 복구 직후엔 올릴 것도 지울 것도 없다
    scenes.saveScenes(null, []); // 사용자가 전부 지웠다
    await vi.advanceTimersByTimeAsync(2500);
    expect(puts().length).toBe(2); // 500 + 1 분할(서버 상한과 동일)
    expect(putBody(puts()[0]).deleted_ids.length).toBe(500);
    expect(putBody(puts()[1]).deleted_ids.length).toBe(1);
  });

  // ★회귀(2026-09-02): 앱 전용 브라우저 프로필 도입으로 한 PC 에 프로필이 여럿 생겼다. 종전 계약
  //  ('서버에만 있는 id 는 전부 삭제')이면 프로필을 번갈아 열 때마다 서로의 백업을 지운다.
  it("이 세션이 본 적 없는 서버 백업은 지우지 않는다 — 프로필이 갈려도 서로를 안 지운다", async () => {
    getMeta = () => Promise.resolve({ items: [{ id: "other", data_hash: "h" }] }); // 다른 프로필이 올린 것
    const { scenes, backup } = await boot();
    scenes.saveScenes(null, [JSON.parse(sceneJson("mine"))]); // 이 프로필엔 내 씬만 있다(버킷 존재)
    await backup.initSceneBackup();
    await vi.advanceTimersByTimeAsync(2500);
    expect(puts().length).toBe(1);
    expect(putBody(puts()[0]).deleted_ids).toEqual([]); // 'other' 는 건드리지 않는다
    expect(putBody(puts()[0]).upserts.map((u: { id: string }) => u.id)).toEqual(["mine"]);
  });

  // 명시적 가져오기 — 자동 복구는 '버킷 키가 없을 때'만 돌아서, 이 브라우저에 씬이 하나라도
  // 있으면 다른 프로필이 올려 둔 백업에 영영 닿지 못한다. 그 자리를 여는 사용자 조작.
  it("가져오기 — 로컬을 덮지 않고 DB 에만 있는 씬만 더한다", async () => {
    getMeta = () =>
      Promise.resolve({ items: [{ id: "mine", data_hash: "h" }, { id: "other", data_hash: "h" }] });
    getFull = () =>
      Promise.resolve({
        items: [
          { id: "mine", data: sceneJson("mine", "서버가 아는 옛 이름") },
          { id: "other", data: sceneJson("other") },
        ],
      });
    const { scenes, backup } = await boot();
    scenes.saveScenes(null, [{ ...JSON.parse(sceneJson("mine", "내가 지금 쓰는 이름")) }]);
    expect(await backup.countBackupOnlyScenes()).toBe(1); // 'other' 하나만 가져올 게 있다
    expect(await backup.importFromBackup()).toBe(1);
    const got = scenes.listScenes(null);
    expect(got.map((s) => s.id)).toEqual(["mine", "other"]);
    expect(got[0].name).toBe("내가 지금 쓰는 이름"); // ★같은 id 는 로컬이 이긴다(덮어쓰기 금지)
    expect(await backup.importFromBackup()).toBe(0); // 두 번 눌러도 중복되지 않는다
  });

  // ★회귀(코덱스 P1): 가져오는 동안 sync 가 돌면, sync 가 '가져오기 전' 로컬 목록으로 삭제를
  //  계산해 방금 가져온 씬을 서버에서 지운다. 가져오기 중엔 sync 를 들이지 않아야 한다.
  it("가져오는 중에는 sync 가 끼어들지 못하고, 끝난 뒤 한 번 돈다", async () => {
    getMeta = () => Promise.resolve({ items: [{ id: "other", data_hash: "h" }] });
    getFull = () => Promise.resolve({ items: [{ id: "other", data: sceneJson("other") }] });
    let release: (() => void) | null = null;
    getFull = () =>
      new Promise((res) => {
        release = () => res({ items: [{ id: "other", data: sceneJson("other") }] });
      });
    const { scenes, backup } = await boot();
    scenes.saveScenes(null, [JSON.parse(sceneJson("mine"))]); // 버킷 있음 → 자동 복구는 'clean'
    await backup.initSceneBackup();
    await vi.advanceTimersByTimeAsync(2500); // 'mine' 업로드 — 'other' 는 안 지운다(본 적 없음)
    const before = calls.length;

    const job = backup.importFromBackup(); // 응답을 붙잡아 둔다
    scenes.saveScenes(null, [JSON.parse(sceneJson("mine", "가져오는 중 편집"))]); // 디바운스 예약
    await vi.advanceTimersByTimeAsync(5000); // 그 타이머가 발화해도
    expect(calls.length).toBe(before + 1); // ★가져오기 GET 하나뿐 — sync 는 한 번도 못 들어왔다

    release!();
    expect(await job).toBe(1);
    expect(scenes.listScenes(null).map((s) => s.id)).toEqual(["mine", "other"]);
    await vi.advanceTimersByTimeAsync(2500); // 가져오기가 이어준 schedule()
    expect(puts().length).toBeGreaterThan(0);
    for (const p of puts()) expect(putBody(p).deleted_ids).toEqual([]); // 가져온 씬을 되지우지 않는다
  });

  it("가져오기 — 백업이 손상됐으면 아무것도 적용하지 않는다", async () => {
    getFull = () => Promise.resolve({ items: [{ id: "ok", data: sceneJson("ok") }, { id: "bad", data: "{{" }] });
    const { scenes, backup } = await boot();
    scenes.saveScenes(null, [JSON.parse(sceneJson("mine"))]);
    await expect(backup.importFromBackup()).rejects.toThrow(/손상/);
    expect(scenes.listScenes(null).map((s) => s.id)).toEqual(["mine"]); // 부분 적용 없음
  });

  // ★회귀: 조회 중 사용자가 씬을 만들면 종전엔 복구를 통째로 포기했다(빈 프로필에서 씬 하나만
  //  만들어도 DB 백업을 영영 못 가져옴). 이제 합집합으로 가져오고 같은 id 는 로컬이 이긴다.
  it("복구 조회 중 만든 씬이 있어도 DB 백업을 합쳐서 가져온다", async () => {
    let created: (() => void) | null = null;
    getFull = () =>
      Promise.resolve({ items: [{ id: "fromdb", data: sceneJson("fromdb") }] }).then((r) => {
        created?.(); // 응답 직전에 사용자가 새 씬을 만든 상황
        return r;
      });
    const { scenes, backup } = await boot();
    created = () => scenes.saveScenes(null, [JSON.parse(sceneJson("justmade"))]);
    await backup.initSceneBackup();
    expect(scenes.listScenes(null).map((s) => s.id)).toEqual(["justmade", "fromdb"]);
  });
});
