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
let putReply: (body: { upserts: { id: string; data: string; base_hash?: string }[] }) => unknown = () => ({ ok: true }); // 옛 허브 꼴(결과 칸 없음)
vi.mock("../src/lib/http", () => ({
  jsonFetch: (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (init?.method === "PUT") {
      // 실제 서버(repo/scenes_backup.py)와 같게: 씬 하나라도 상한을 넘으면 그 요청 전체를 거절한다.
      const body = JSON.parse(String(init.body)) as { upserts: { id: string; data: string }[] };
      const tooBig = body.upserts.some((u) => new TextEncoder().encode(u.data).byteLength > SERVER_MAX_SCENE_BYTES);
      return tooBig ? Promise.reject(new Error("400 씬이 너무 큼")) : Promise.resolve(putReply(body));
    }
    if (url.includes("include_data")) return getFull();
    return getMeta();
  },
}));


const SERVER_MAX_SCENE_BYTES = 5 * 1024 * 1024;
const puts = () => calls.filter((c) => c.init?.method === "PUT");
const putBody = (c: Call) => JSON.parse(String(c.init?.body));

let acctSeq = 0;
async function boot() {
  vi.resetModules(); // 모듈 상태(scope·lastPushed·타이머 플래그) 초기화
  const scenes = await import("../src/lib/scenes");
  const backup = await import("../src/lib/sceneBackup");
  // 쓰기는 화면 값에 먼저 반영되고 저장소 확정은 뒤따른다. 복구 판정·미러는 **확정본**을 보므로,
  // "이미 저장돼 있던 상태"를 만들려면 확정까지 기다린다(settle).
  const store = await import("../src/lib/sceneStore");
  return { scenes, backup, settle: store.settleSceneStoreForTest };
}

function sceneJson(id: string, name = "씬") {
  return JSON.stringify({ id, name, cards: [], edges: [], created_at: 1 });
}

describe("sceneBackup (DB 미러·복구)", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    calls = [];
    mem.clear();
    acctSeq += 1;
    localStorage.setItem("ch.activeAccount", `user${acctSeq}@test`);
    getMeta = () => Promise.resolve({ items: [] });
    getFull = () => Promise.resolve({ items: [] });
    putReply = () => ({ ok: true });
  });

  afterEach(() => {
    // 이전 테스트 모듈 인스턴스의 잔여 타이머(디바운스·백오프)가 다음 테스트에서 발화해
    // 같은 fetch 목으로 중복 PUT 을 만들지 않게 — 모듈 리셋과 별개로 타이머 큐를 비운다.
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // 81회차 F-A-02: 다른 브라우저 프로필에서 계정을 바꾸면 옛 화면의 자동 백업이 새 계정 DB 에 쓰였다 — 모든 백업 요청에 이 탭의 계정을
  //  싣고(허브가 고정한 계정과 다르면 409), 409 를 받으면 로컬 씬·미전송 변경(올릴 것·지울 것)을 그대로 둔 채 다음 재시도로 넘긴다.
  it("모든 백업 요청에 이 탭의 계정(X-MVHub-Expect-Account)을 싣고, 409(그사이 계정 바뀜)는 로컬 씬·미전송 상태를 보존한다", async () => {
    vi.stubGlobal("crypto", {}); // 진짜 지문 계산은 가짜 타이머 밖에서 끝난다 — 해시 없는 창으로(바뀐 씬을 그대로 올린다)
    const { HttpError } = await vi.importActual<typeof import("../src/lib/http")>("../src/lib/http");
    const { scenes, backup } = await boot();
    const scope = `acct:user${acctSeq}@test`;
    scenes.saveScenes(null, [JSON.parse(sceneJson("s1", "남길 씬")), JSON.parse(sceneJson("s2", "지울 씬"))]);
    await backup.initSceneBackup();
    await vi.advanceTimersByTimeAsync(2500); // 첫 미러 — s1·s2 올림
    expect(putBody(puts()[0]).upserts.map((u: { id: string }) => u.id)).toEqual(["s1", "s2"]);

    getMeta = () => Promise.resolve({ items: [{ id: "s1", data_hash: "x" }, { id: "s2", data_hash: "y" }] }); // 서버에 올라간 둘
    // 허브가 실제로 던지는 오류 그대로 — 제품 jsonFetch 의 HttpError(409)
    putReply = () => Promise.reject(new HttpError(409, "409: 그사이 이 PC 의 계정이 바뀌어 씬 백업을 하지 않았습니다", "그사이 이 PC 의 계정이 바뀌어 씬 백업을 하지 않았습니다"));
    scenes.saveScenes(null, [JSON.parse(sceneJson("s1", "고친 씬"))]); // s1 고침 + s2 지움
    await vi.advanceTimersByTimeAsync(2500);
    expect(puts()).toHaveLength(2);
    expect(scenes.listScenes(null).map((s) => [s.id, s.name])).toEqual([["s1", "고친 씬"]]); // 로컬은 그대로
    await vi.advanceTimersByTimeAsync(30_000); // 30초 뒤 재시도 — 같은 미전송 변경을 다시 보낸다
    expect(puts()).toHaveLength(3);
    const again = putBody(puts()[2]);
    expect([again.upserts.map((u: { id: string; data: string }) => [u.id, JSON.parse(u.data).name]), again.deleted_ids])
      .toEqual([[["s1", "고친 씬"]], ["s2"]]);
    // 복구 판정 GET·메타 GET·PUT 모두 시작 때 잡은 이 탭의 계정을 싣는다
    expect(calls.map((c) => (c.init?.headers as Record<string, string> | undefined)?.["X-MVHub-Expect-Account"])).toEqual(calls.map(() => scope));
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
    const { scenes, backup, settle } = await boot();
    scenes.saveScenes(null, []); // 버킷 키는 존재(내용만 빈 배열)
    await settle();
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
    const { scenes, backup, settle } = await boot();
    scenes.saveScenes(null, [JSON.parse(sceneJson("mine"))]); // 버킷 있음 → 자동 복구는 'clean'
    await settle();
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

  // 서버는 씬 1개가 5MiB(UTF-8)를 넘으면 그 요청 전체를 거절한다. 그대로 보내면 같은 묶음을 영영 다시 보내고,
  // 같은 묶음·뒤 묶음의 멀쩡한 씬도 백업되지 않는다(Codex 설계 검토 P1). 넘는 씬만 빼고 보내고, 알린다.
  it("너무 큰 씬 하나가 다른 씬의 백업을 막지 않는다 — 그 씬만 빼고 알리고, 작아지면 다시 올린다", async () => {
    // 해시 대조(crypto.subtle)는 진짜 비동기라 가짜 타이머로 넘길 수 없다 — http LAN 처럼 해시가 없는 환경으로
    // 돌린다(그때는 바뀐 씬을 그대로 올린다). 이 시험이 보는 것은 '무엇을 보내는가'다.
    vi.stubGlobal("crypto", {});
    // 서버에는 그 씬의 예전(작던 때) 사본이 있다 — 지우면 안 된다. 이 프로필이 그때 서버와 맞췄다(판 = "old", 1A 장부).
    getMeta = () => Promise.resolve({ items: [{ id: "big", data_hash: "old" }] });
    localStorage.setItem(`mvhub.sceneBackupBase:acct:user${acctSeq}@test:big`, JSON.stringify({ b: "old" }));
    const { scenes, backup, settle } = await boot();
    const skipped: string[][] = [];
    backup.subscribeSceneBackupSkipped((names) => skipped.push(names));
    const big = {
      ...JSON.parse(sceneJson("big", "큰 씬")),
      cards: [{ id: "t", kind: "text", x: 0, y: 0, text: "가".repeat(1_800_000) }], // 약 5.4MB(한글은 글자당 3바이트)
    };
    scenes.saveScenes(null, [JSON.parse(sceneJson("a")), big, JSON.parse(sceneJson("b"))]);
    await settle();
    await backup.initSceneBackup();
    await vi.advanceTimersByTimeAsync(2500);
    expect(puts().length).toBe(1);
    expect(putBody(puts()[0]).upserts.map((u: { id: string }) => u.id)).toEqual(["a", "b"]);
    expect(putBody(puts()[0]).deleted_ids).toEqual([]); // 서버의 옛 사본을 지우지 않는다
    expect(skipped).toEqual([["큰 씬"]]);

    // 다른 씬을 고치면 그것만 올라간다 — 큰 씬 때문에 다시 막히지 않고, 같은 알림을 또 띄우지도 않는다.
    scenes.updateScene(null, "a", { name: "고침" });
    await settle();
    await vi.advanceTimersByTimeAsync(2500);
    expect(puts().length).toBe(2);
    expect(putBody(puts()[1]).upserts.map((u: { id: string }) => u.id)).toEqual(["a"]);
    expect(skipped).toHaveLength(1);

    // 줄이면 다시 올라간다(올린 것으로 적어 두지 않았으므로).
    scenes.updateScene(null, "big", { cards: [] });
    await settle();
    await vi.advanceTimersByTimeAsync(2500);
    expect(puts().length).toBe(3);
    expect(putBody(puts()[2]).upserts.map((u: { id: string }) => u.id)).toEqual(["big"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(puts().length).toBe(3); // 실패 재시도가 돌고 있지 않다
  });

  it("상한은 UTF-8 바이트로, 서버와 같은 경계다 — 딱 5MiB 는 올리고 1바이트 넘으면 뺀다", async () => {
    const { scenes, backup, settle } = await boot();
    const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    const padded = (id: string, bytes: number) => {
      const scene = { ...JSON.parse(sceneJson(id)), cards: [{ id: "t", kind: "text", x: 0, y: 0, text: "" }] };
      scene.cards[0].text = "x".repeat(bytes - byteLength(scene));
      expect(byteLength(scene)).toBe(bytes);
      return scene;
    };
    scenes.saveScenes(null, [padded("edge", backup.MAX_SCENE_BYTES), padded("over", backup.MAX_SCENE_BYTES + 1)]);
    await settle();
    await backup.initSceneBackup();
    await vi.advanceTimersByTimeAsync(2500);
    expect(puts().length).toBe(1);
    expect(putBody(puts()[0]).upserts.map((u: { id: string }) => u.id)).toEqual(["edge"]);
  });

  // Jay 결정 7A — 빠진 씬은 탭에 계속 보인다. 표시는 확정본 크기로 정한다: 백업 서버가 안 닿아도(동기화가 일찍 끝나도) 맞아야 한다(C19).
  it("7A — 상한을 넘은 씬은 확정되자마자 '빠짐', 줄이거나 지우면 풀린다(서버가 안 닿아도) · 범위가 바뀌면 비운다", async () => {
    getMeta = () => Promise.reject(new Error("offline"));
    getFull = () => Promise.reject(new Error("offline"));
    const { scenes, backup, settle } = await boot();
    await backup.initSceneBackup().catch(() => false);
    const seen: string[][] = [];
    backup.subscribeSceneBackupSkippedIds(() => seen.push([...backup.getSceneBackupSkippedIds()]));
    const big = { ...JSON.parse(sceneJson("big", "큰 씬")), cards: [{ id: "t", kind: "text", x: 0, y: 0, text: "가".repeat(1_800_000) }] };
    scenes.saveScenes(null, [JSON.parse(sceneJson("a")), big]);
    await settle();
    expect([...backup.getSceneBackupSkippedIds()]).toEqual(["big"]);
    scenes.updateScene(null, "big", { cards: [] });
    await settle();
    scenes.saveScenes(null, [JSON.parse(sceneJson("a")), big]);
    await settle();
    scenes.saveScenes(null, [JSON.parse(sceneJson("a"))]); // 지웠다
    await settle();
    scenes.saveScenes(null, [JSON.parse(sceneJson("a")), big]);
    await settle();
    localStorage.setItem("ch.activeAccount", `other${acctSeq}@test`); // 다른 계정 — 그 범위엔 큰 씬이 없다
    await backup.initSceneBackup().catch(() => false);
    expect(seen).toEqual([["big"], [], ["big"], [], ["big"], []]);
  });
});

// ── Jay 결정 1A(10-15): 오래 안 쓴 창이 씬 백업을 옛 내용으로 덮지 않게 — 판 장부·옛 창 건너뛰기·사본(갈래) ──
// 진짜 crypto.subtle 은 가짜 타이머 밖에서 끝난다 — 마이크로태스크로 끝나는 결정적 지문으로 바꿔 둔다(판 비교만 본다).
function fakeHex(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h.toString(16).padStart(8, "0").repeat(8);
}
let holdDigest: { match: string; until: Promise<void> } | null = null; // 이 글자를 담은 씬의 지문은 until 까지 끝나지 않는다
function stubDigest() {
  vi.stubGlobal("crypto", {
    subtle: {
      digest: async (_algo: string, data: Uint8Array) => {
        const text = new TextDecoder().decode(data);
        if (holdDigest && text.includes(holdDigest.match)) await holdDigest.until;
        return Uint8Array.from(fakeHex(text).match(/../g)!.map((b) => parseInt(b, 16))).buffer;
      },
    },
  });
}
const ledgerKey = (id: string) => `mvhub.sceneBackupBase:acct:user${acctSeq}@test:${id}`;

describe("sceneBackup — 판(1A)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    mem.clear();
    acctSeq += 1;
    localStorage.setItem("ch.activeAccount", `user${acctSeq}@test`);
    getFull = () => Promise.resolve({ items: [] });
    putReply = () => ({ ok: true });
    holdDigest = null;
    stubDigest();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("바뀐 것 없는 옛 창(지문 == 판)은 서버가 더 새것이면 올리지 않는다", async () => {
    const { scenes, backup, settle } = await boot();
    scenes.saveScenes(null, [JSON.parse(sceneJson("s1", "옛 7장"))]);
    await settle();
    const text = scenes.listPersistedSceneTexts(null)[0].text;
    localStorage.setItem(ledgerKey("s1"), JSON.stringify({ b: fakeHex(text) })); // 이 프로필이 10-11 에 맞춘 판
    getMeta = () => Promise.resolve({ items: [{ id: "s1", data_hash: "새-창-12장" }] }); // 그사이 다른 프로필이 올렸다
    await backup.initSceneBackup();
    await vi.advanceTimersByTimeAsync(2500);
    expect(puts().length).toBe(0); // 전엔 옛 7장으로 덮었다
  });

  it("둘 다 바뀌었으면 판을 실어 보내고, 허브가 사본으로 받으면 그 뒤 편집은 사본 행으로 간다 · 지우면 사본 행을 판과 함께 지운다", async () => {
    const { scenes, backup, settle } = await boot();
    const forked: string[][] = [];
    backup.subscribeSceneBackupForked((names) => forked.push(names));
    scenes.saveScenes(null, [JSON.parse(sceneJson("s1", "고친 옛 창"))]);
    await settle();
    localStorage.setItem(ledgerKey("s1"), JSON.stringify({ b: "옛-판" }));
    getMeta = () => Promise.resolve({ items: [{ id: "s1", data_hash: "새-창" }] });
    putReply = (body) => ({ ok: true, results: body.upserts.map((u) => (u.id === "s1"
      ? { id: "s1", status: "copied", target_id: "bk_copy", hash: "사본-판" }
      : { id: u.id, status: "saved", target_id: u.id, hash: "사본-판2" })) });
    await backup.initSceneBackup();
    await vi.advanceTimersByTimeAsync(2500);
    expect(putBody(puts()[0]).upserts[0]).toMatchObject({ id: "s1", base_hash: "옛-판" });
    expect(forked).toEqual([["고친 옛 창"]]);
    expect(JSON.parse(localStorage.getItem(ledgerKey("s1"))!).fork).toEqual({ id: "bk_copy", b: "사본-판" });

    scenes.updateScene(null, "s1", { name: "더 고침" });
    await settle();
    await vi.advanceTimersByTimeAsync(2500);
    const next = putBody(puts()[1]).upserts[0];
    expect(next).toMatchObject({ id: "bk_copy", base_hash: "사본-판" });
    expect(JSON.parse(next.data)).toMatchObject({ id: "bk_copy", name: "더 고침 (옛 창 사본)", backupForkOf: { id: "s1" } });

    scenes.saveScenes(null, []);
    await settle();
    await vi.advanceTimersByTimeAsync(2500);
    expect(putBody(puts()[2])).toMatchObject({ deleted_ids: ["bk_copy"], delete_bases: { bk_copy: "사본-판2" } });
    expect(localStorage.getItem(ledgerKey("s1"))).toBeNull();
  });

  it("판은 범위에 들어갈 때 한 번만 읽는다 — 그 뒤 다른 탭이 장부를 바꿔도 이 탭은 처음 판으로 보낸다", async () => {
    const { scenes, backup, settle } = await boot();
    scenes.saveScenes(null, [JSON.parse(sceneJson("s1", "이 탭의 옛 글"))]);
    await settle();
    getMeta = () => Promise.resolve({ items: [{ id: "s1", data_hash: "다른-탭-판" }] });
    await backup.initSceneBackup(); // 장부 없음 = '모름'
    localStorage.setItem(ledgerKey("s1"), JSON.stringify({ b: "다른-탭-판" })); // 다른 탭이 그 뒤 맞췄다 — 이 탭이 받은 내용은 아니다
    await vi.advanceTimersByTimeAsync(2500);
    expect(putBody(puts()[0]).upserts[0]).toMatchObject({ id: "s1", base_hash: "" }); // 남의 새 판으로 덮어쓰기 허가를 받지 않는다(Codex C1)
  });

  it("가져오기·개수는 이 탭의 갈래 사본 행을 빼고, 서버에 행이 사라진 씬은 다시 넣는다", async () => {
    const { scenes, backup, settle } = await boot();
    scenes.saveScenes(null, [JSON.parse(sceneJson("s1"))]);
    await settle();
    localStorage.setItem(ledgerKey("s1"), JSON.stringify({ b: "x", fork: { id: "bk_mine", b: "y" } }));
    getMeta = () => Promise.resolve({ items: [{ id: "bk_mine", data_hash: "y" }, { id: "other", data_hash: "z" }] });
    getFull = () => Promise.resolve({ items: [{ id: "bk_mine", data: sceneJson("bk_mine") }, { id: "other", data: sceneJson("other") }] });
    await backup.initSceneBackup();
    expect(await backup.countBackupOnlyScenes()).toBe(1);
    expect(await backup.importFromBackup()).toBe(1);
    expect(scenes.listScenes(null).map((s) => s.id).sort()).toEqual(["other", "s1"]);
  });

  // ── Codex 1A 코드 리뷰(08:40) 넷 — 새 백업을 덮거나 지우던 순서들 ──
  it("#1 앞 씬의 지문을 기다리는 사이 바뀐 씬은 옛 글자로 보내지 않고, 끝나고 새 글자로 보낸다", async () => {
    const { scenes, backup, settle } = await boot();
    scenes.saveScenes(null, [JSON.parse(sceneJson("s1", "하나")), JSON.parse(sceneJson("s2", "둘"))]);
    await settle();
    localStorage.setItem(ledgerKey("s1"), JSON.stringify({ b: "서버1" }));
    localStorage.setItem(ledgerKey("s2"), JSON.stringify({ b: "서버2" }));
    getMeta = () => Promise.resolve({ items: [{ id: "s1", data_hash: "서버1" }, { id: "s2", data_hash: "서버2" }] });
    let release!: () => void;
    holdDigest = { match: '"하나"', until: new Promise<void>((done) => (release = done)) };
    await backup.initSceneBackup();
    await vi.advanceTimersByTimeAsync(2500); // s1 의 지문에서 멈춰 있다
    scenes.updateScene(null, "s2", { name: "둘 고침" }); // 그사이 s2 가 바뀐다
    await settle();
    release();
    await vi.advanceTimersByTimeAsync(2500);
    const sent = puts().map((c) => putBody(c).upserts.map((u: { id: string; data: string }) => [u.id, JSON.parse(u.data).name]));
    expect(sent).toEqual([[["s1", "하나"]], [["s2", "둘 고침"]]]);
  });

  it("#2 지문 계산이 없는 창 — 복구한 씬의 판은 서버가 준 지문이고, 지울 때 그 판을 싣는다", async () => {
    vi.stubGlobal("crypto", {});
    const { scenes, backup, settle } = await boot();
    getFull = () => Promise.resolve({ items: [{ id: "s1", data: sceneJson("s1"), data_hash: "h1" }] });
    getMeta = () => Promise.resolve({ items: [{ id: "s1", data_hash: "h1" }] });
    expect(await backup.initSceneBackup()).toBe(true);
    expect(JSON.parse(localStorage.getItem(ledgerKey("s1"))!)).toEqual({ b: "h1" });
    scenes.saveScenes(null, []);
    await settle();
    await vi.advanceTimersByTimeAsync(2500);
    expect(putBody(puts()[0])).toMatchObject({ deleted_ids: ["s1"], delete_bases: { s1: "h1" } }); // 전엔 판 없이 보내 허브가 무조건 지웠다
  });

  it("#3 저장소를 잃고 복구했는데 옛 장부에 갈래가 남았으면 끊는다 — 복구한 원본을 지워도 사본 씬의 백업은 남는다", async () => {
    const { scenes, backup, settle } = await boot();
    localStorage.setItem(ledgerKey("x"), JSON.stringify({ b: "x0", fork: { id: "bk_f", b: "f0" } }));
    const rows = [{ id: "x", data: sceneJson("x", "원본"), data_hash: "hx" }, { id: "bk_f", data: sceneJson("bk_f", "사본"), data_hash: "hf" }];
    getFull = () => Promise.resolve({ items: rows });
    getMeta = () => Promise.resolve({ items: rows.map(({ id, data_hash }) => ({ id, data_hash })) });
    expect(await backup.initSceneBackup()).toBe(true);
    expect(JSON.parse(localStorage.getItem(ledgerKey("x"))!)).toEqual({ b: "hx" });
    scenes.saveScenes(null, scenes.listScenes(null).filter((s) => s.id !== "x"));
    await settle();
    await vi.advanceTimersByTimeAsync(2500);
    expect(putBody(puts()[0])).toMatchObject({ deleted_ids: ["x"], delete_bases: { x: "hx" } }); // 전엔 bk_f(화면에 남은 사본 씬)를 지웠다
  });

  it("#4 다른 탭에서 받은 씬을 옛 글자로 되돌리면 다시 올린다 — '올린 그대로'로 보고 건너뛰지 않게", async () => {
    const { scenes, backup, settle } = await boot();
    scenes.saveScenes(null, [JSON.parse(sceneJson("s1", "A"))]);
    await settle();
    const textA = scenes.listPersistedSceneTexts(null)[0].text;
    putReply = (body) => ({ ok: true, results: body.upserts.map((u) => ({ id: u.id, status: "saved", target_id: u.id, hash: fakeHex(u.data) })) });
    await backup.initSceneBackup();
    await vi.advanceTimersByTimeAsync(2500);
    expect(puts().length).toBe(1); // A 를 올렸다
    const [{ text: textB }] = await receiveFromOtherTab(scenes, settle, [["s1", "B"]]);
    scenes.saveScenes(null, [JSON.parse(sceneJson("s1", "A"))]); // 사용자가 옛 이름으로 되돌린다
    await settle();
    expect(scenes.listPersistedSceneTexts(null)[0].text).toBe(textA);
    await vi.advanceTimersByTimeAsync(2500);
    expect(puts().length).toBe(2);
    expect(putBody(puts()[1]).upserts[0]).toMatchObject({ id: "s1", base_hash: fakeHex(textB) });
  });

  // ── Codex 1A 재검토(08:56) 셋 — #4 의 다른 순서 ──
  const hashReply = (body: { upserts: { id: string; data: string }[] }) =>
    ({ ok: true, results: body.upserts.map((u) => ({ id: u.id, status: "saved", target_id: u.id, hash: fakeHex(u.data) })) });
  // 같은 브라우저의 다른 탭이 이 씬들을 고쳐 저장하고 서버에 올려 장부를 맞췄다 → 이 탭이 그 알림을 받아 저장소를 다시 읽는다(진짜 길)
  async function receiveFromOtherTab(scenes: typeof import("../src/lib/scenes"), settle: () => Promise<boolean>, list: [string, string][]) {
    const store = await import("../src/lib/sceneStore");
    const texts = list.map(([id, name]) => ({ id, text: sceneJson(id, name) }));
    for (const s of texts) localStorage.setItem(ledgerKey(s.id), JSON.stringify({ b: fakeHex(s.text) }));
    getMeta = () => Promise.resolve({ items: texts.map((s) => ({ id: s.id, data_hash: fakeHex(s.text) })) });
    store.writeSceneStoreAsOtherWindowForTest((all) => {
      all[`acct:user${acctSeq}@test::_none`] = list.map(([id, name]) => JSON.parse(sceneJson(id, name)));
    });
    await store.refreshSceneStoreForTest();
    await settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(scenes.listPersistedSceneTexts(null).map((s) => s.text)).toEqual(texts.map((s) => s.text)); // 받은 글자 = 다른 탭이 올린 글자
    return texts;
  }

  it("재검토 1 — 받음 → 되돌려 올림 → 같은 글자를 또 받음 → 또 되돌림: 마지막 되돌림도 올린다", async () => {
    const { scenes, backup, settle } = await boot();
    scenes.saveScenes(null, [JSON.parse(sceneJson("s1", "A"))]);
    await settle();
    putReply = hashReply;
    await backup.initSceneBackup();
    await vi.advanceTimersByTimeAsync(2500);
    const [b1] = await receiveFromOtherTab(scenes, settle, [["s1", "B"]]);
    scenes.saveScenes(null, [JSON.parse(sceneJson("s1", "A"))]);
    await settle();
    await vi.advanceTimersByTimeAsync(2500);
    expect(puts().length).toBe(2);
    await receiveFromOtherTab(scenes, settle, [["s1", "B"]]);
    scenes.saveScenes(null, [JSON.parse(sceneJson("s1", "A"))]);
    await settle();
    await vi.advanceTimersByTimeAsync(2500);
    expect(puts().length).toBe(3);
    expect(putBody(puts()[2]).upserts[0]).toMatchObject({ id: "s1", base_hash: fakeHex(b1.text) });
  });

  it("재검토 2 — 보내는 사이 다른 탭에서 받은 뒤 늦게 온 응답이 '올린 그대로' 기억을 되살리지 않는다", async () => {
    const { scenes, backup, settle } = await boot();
    scenes.saveScenes(null, [JSON.parse(sceneJson("s1", "A"))]);
    await settle();
    let answer!: () => void;
    putReply = (body) => new Promise((done) => (answer = () => done(hashReply(body))));
    await backup.initSceneBackup();
    await vi.advanceTimersByTimeAsync(2500); // A 를 보내는 중 — 응답이 늦다
    const [b] = await receiveFromOtherTab(scenes, settle, [["s1", "B"]]);
    answer();
    await vi.advanceTimersByTimeAsync(0);
    putReply = hashReply;
    scenes.saveScenes(null, [JSON.parse(sceneJson("s1", "A"))]); // 사용자가 A 로 되돌린다
    await settle();
    await vi.advanceTimersByTimeAsync(2500);
    expect(puts().length).toBe(2);
    expect(putBody(puts()[1]).upserts[0]).toMatchObject({ id: "s1", base_hash: fakeHex(b.text) });
  });

  it("재검토 3 — 지문 계산이 없는 창에서 두 씬을 받으면 둘 다 기억을 무효로 한다(첫 씬에서 멈추지 않는다)", async () => {
    vi.stubGlobal("crypto", {});
    const { scenes, backup, settle } = await boot();
    scenes.saveScenes(null, [JSON.parse(sceneJson("s1", "A1")), JSON.parse(sceneJson("s2", "A2"))]);
    await settle();
    putReply = (body) => ({ ok: true, results: body.upserts.map((u) => ({ id: u.id, status: "saved", target_id: u.id, hash: `h:${JSON.parse(u.data).name}` })) });
    await backup.initSceneBackup();
    await vi.advanceTimersByTimeAsync(2500);
    expect(puts().length).toBe(1);
    await receiveFromOtherTab(scenes, settle, [["s1", "B1"], ["s2", "B2"]]);
    scenes.saveScenes(null, [JSON.parse(sceneJson("s1", "B1")), JSON.parse(sceneJson("s2", "A2"))]); // s2 만 되돌린다
    await settle();
    await vi.advanceTimersByTimeAsync(2500);
    const sent = puts().slice(1).flatMap((c) => putBody(c).upserts.map((u: { id: string; data: string }) => [u.id, JSON.parse(u.data).name]));
    expect(sent).toContainEqual(["s2", "A2"]);
  });

  // ── Codex 1A 3차(09:05) — '다른 탭에서 받았나'를 글자 기억으로 가리는 자리 ──
  it("3차 P1 — 되돌려 보내는 중에 같은 글자를 또 받으면 늦은 응답이 '올린 그대로' 기억을 되살리지 않는다", async () => {
    const { scenes, backup, settle } = await boot();
    scenes.saveScenes(null, [JSON.parse(sceneJson("s1", "A"))]);
    await settle();
    putReply = hashReply;
    await backup.initSceneBackup();
    await vi.advanceTimersByTimeAsync(2500); // A 를 올렸다
    await receiveFromOtherTab(scenes, settle, [["s1", "B"]]);
    let answer!: () => void;
    putReply = (body) => new Promise((done) => (answer = () => done(hashReply(body))));
    scenes.saveScenes(null, [JSON.parse(sceneJson("s1", "A"))]);
    await settle();
    await vi.advanceTimersByTimeAsync(2500); // A 를 다시 보내는 중 — 응답이 늦다
    const [b] = await receiveFromOtherTab(scenes, settle, [["s1", "B"]]);
    answer();
    await vi.advanceTimersByTimeAsync(0);
    putReply = hashReply;
    scenes.saveScenes(null, [JSON.parse(sceneJson("s1", "A"))]);
    await settle();
    await vi.advanceTimersByTimeAsync(2500);
    expect(puts().length).toBe(3);
    expect(putBody(puts()[2]).upserts[0]).toMatchObject({ id: "s1", base_hash: fakeHex(b.text) });
  });

  it("3차 P2 — 다른 탭이 다른 씬만 바꿨으면 보내던 씬의 정상 응답(판)은 그대로 쓴다", async () => {
    const { scenes, backup, settle } = await boot();
    const store = await import("../src/lib/sceneStore");
    scenes.saveScenes(null, [JSON.parse(sceneJson("s1", "A")), JSON.parse(sceneJson("s2", "X"))]);
    await settle();
    getMeta = () => Promise.resolve({ items: [{ id: "s2", data_hash: fakeHex(sceneJson("s2", "X")) }] });
    let answer!: () => void;
    putReply = (body) => new Promise((done) => (answer = () => done(hashReply(body))));
    await backup.initSceneBackup();
    await vi.advanceTimersByTimeAsync(2500); // s1 을 보내는 중
    store.writeSceneStoreAsOtherWindowForTest((all) => {
      all[`acct:user${acctSeq}@test::_none`] = [JSON.parse(sceneJson("s1", "A")), JSON.parse(sceneJson("s2", "Y"))];
    });
    await store.refreshSceneStoreForTest();
    await vi.advanceTimersByTimeAsync(0);
    answer();
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(localStorage.getItem(ledgerKey("s1"))!)).toEqual({ b: fakeHex(sceneJson("s1", "A")) }); // 전엔 첫 알림이 모든 씬을 '받음'으로 세어 버렸다
  });

  it("4차 P1 — 갈래 사본 행을 다른 탭이 별도 씬으로 가져왔으면, 원본을 지워도 그 씬의 백업은 지우지 않는다", async () => {
    const { scenes, backup, settle } = await boot();
    const store = await import("../src/lib/sceneStore");
    scenes.saveScenes(null, [JSON.parse(sceneJson("x", "원본"))]);
    await settle();
    localStorage.setItem(ledgerKey("x"), JSON.stringify({ b: "x0", fork: { id: "bk_f", b: "f0" } }));
    getMeta = () => Promise.resolve({ items: [{ id: "x", data_hash: "남의 새 판" }, { id: "bk_f", data_hash: "f0" }] });
    putReply = hashReply;
    await backup.initSceneBackup();
    await vi.advanceTimersByTimeAsync(2500);
    const forkData = putBody(puts()[0]).upserts[0].data as string; // x 의 편집은 사본 행 bk_f 로 갔다
    expect(putBody(puts()[0]).upserts[0].id).toBe("bk_f");
    // 다른 탭(갈래를 모르던)이 bk_f 를 가져와 이 브라우저의 별도 씬이 됐다
    store.writeSceneStoreAsOtherWindowForTest((all) => {
      all[`acct:user${acctSeq}@test::_none`] = [JSON.parse(sceneJson("x", "원본")), JSON.parse(forkData)];
    });
    await store.refreshSceneStoreForTest();
    await settle();
    scenes.saveScenes(null, scenes.listScenes(null).filter((s) => s.id !== "x")); // 원본만 지운다
    await settle();
    await vi.advanceTimersByTimeAsync(2500);
    const deleted = puts().slice(1).flatMap((c) => putBody(c).deleted_ids as string[]);
    expect(deleted).not.toContain("bk_f"); // 전엔 화면에 남은 사본 씬의 백업을 지웠다
  });

  it("4차 P1 — 갈래 사본 행이 별도 씬이 됐으면 원본의 편집은 그 행이 아니라 제 행으로 간다(두 씬이 한 행을 덮어쓰지 않게)", async () => {
    const { scenes, backup, settle } = await boot();
    const store = await import("../src/lib/sceneStore");
    scenes.saveScenes(null, [JSON.parse(sceneJson("x", "원본"))]);
    await settle();
    localStorage.setItem(ledgerKey("x"), JSON.stringify({ b: "x0", fork: { id: "bk_f", b: "f0" } }));
    getMeta = () => Promise.resolve({ items: [{ id: "x", data_hash: "남의 새 판" }, { id: "bk_f", data_hash: "f0" }] });
    putReply = hashReply;
    await backup.initSceneBackup();
    await vi.advanceTimersByTimeAsync(2500);
    const forkData = putBody(puts()[0]).upserts[0].data as string;
    store.writeSceneStoreAsOtherWindowForTest((all) => {
      all[`acct:user${acctSeq}@test::_none`] = [JSON.parse(sceneJson("x", "원본")), JSON.parse(forkData)];
    });
    await store.refreshSceneStoreForTest();
    await settle();
    scenes.updateScene(null, "x", { name: "원본 고침" });
    await settle();
    await vi.advanceTimersByTimeAsync(2500);
    const sent = puts().slice(1).flatMap((c) => putBody(c).upserts.map((u: { id: string; data: string }) => [u.id, JSON.parse(u.data).name]));
    expect(sent).toContainEqual(["x", "원본 고침"]);
    expect(sent.filter(([id]: string[]) => id === "bk_f")).toEqual([]);
  });

  it("5차 P1 — 갈래를 끊으면 이 씬 내용을 다시 올린다(사본 행 자리는 피하라고 알림) — 사본 씬만 지워도 이 씬 내용의 백업이 남게", async () => {
    const { scenes, backup, settle } = await boot();
    const store = await import("../src/lib/sceneStore");
    scenes.saveScenes(null, [JSON.parse(sceneJson("x", "원본"))]);
    await settle();
    localStorage.setItem(ledgerKey("x"), JSON.stringify({ b: "x0", fork: { id: "bk_f", b: "f0" } }));
    getMeta = () => Promise.resolve({ items: [{ id: "x", data_hash: "남의 새 판" }, { id: "bk_f", data_hash: "f0" }] });
    putReply = hashReply;
    await backup.initSceneBackup();
    await vi.advanceTimersByTimeAsync(2500); // x 의 내용은 bk_f 에 올라갔다
    const forkData = putBody(puts()[0]).upserts[0].data as string;
    store.writeSceneStoreAsOtherWindowForTest((all) => {
      all[`acct:user${acctSeq}@test::_none`] = [JSON.parse(sceneJson("x", "원본")), JSON.parse(forkData)];
    });
    await store.refreshSceneStoreForTest();
    await settle();
    await vi.advanceTimersByTimeAsync(2500);
    const again = puts().slice(1).find((c) => putBody(c).upserts.some((u: { id: string }) => u.id === "x"));
    expect(again).toBeTruthy(); // 전엔 '올린 그대로'로 보고 건너뛰어 x 내용은 bk_f(이제 남의 씬) 에만 있었다
    expect(putBody(again!)).toMatchObject({ fork_avoid: ["bk_f"] });
    expect(putBody(again!).upserts.find((u: { id: string }) => u.id === "x")).toMatchObject({ base_hash: "x0" });
  });

  it("63회차 — 피할 자리는 이번에 올리는 행의 사본만(원본을 모르는 사본은 늘) — 자동 복구로 사본이 많아도 상한(2,000)에 걸려 백업이 멈추지 않게", async () => {
    const { scenes, backup, settle } = await boot();
    const copyOf = (id: string, origin?: string) =>
      ({ ...JSON.parse(sceneJson(id, id)), ...(origin ? { backupForkOf: { id: origin, sum: "s" } } : {}) });
    scenes.saveScenes(null, [JSON.parse(sceneJson("x", "원본")), copyOf("bk_x", "x"), copyOf("bk_y", "y"), copyOf("bk_unknown")]);
    await settle();
    getMeta = () => Promise.resolve({ items: [] });
    putReply = hashReply;
    await backup.initSceneBackup();
    await vi.advanceTimersByTimeAsync(2500);
    const [first] = puts();
    expect(putBody(first).upserts.map((u: { id: string }) => u.id)).toEqual(["x", "bk_x", "bk_y", "bk_unknown"]);
    expect([...putBody(first).fork_avoid].sort()).toEqual(["bk_unknown", "bk_x"]); // y 는 이번에 올리지 않는다 — bk_y 는 피할 까닭이 없다
  });

  it("7A — 허브가 사본이 상한을 넘는다고(too_big) 하면 그 씬도 '빠짐'이고, 원본 크기를 다시 세도 그대로 · 다음에 올라가면 풀린다", async () => {
    const { scenes, backup, settle } = await boot();
    scenes.saveScenes(null, [JSON.parse(sceneJson("x", "원본"))]);
    await settle();
    let refuse = true;
    putReply = (body) => (refuse
      ? { ok: true, results: body.upserts.map((u) => ({ id: u.id, status: "too_big", target_id: "bk_t", hash: null })) }
      : hashReply(body));
    await backup.initSceneBackup();
    await vi.advanceTimersByTimeAsync(2500);
    expect([...backup.getSceneBackupSkippedIds()]).toEqual(["x"]);
    scenes.saveScenes(null, [JSON.parse(sceneJson("x", "원본")), JSON.parse(sceneJson("y"))]); // 다른 씬 확정 — 원본 크기를 다시 센다
    await settle();
    expect([...backup.getSceneBackupSkippedIds()]).toEqual(["x"]);
    refuse = false;
    scenes.updateScene(null, "x", { name: "원본 고침" });
    await settle();
    await vi.advanceTimersByTimeAsync(2500);
    expect([...backup.getSceneBackupSkippedIds()]).toEqual([]);
  });

  it("7A 리뷰 P1 — 앞 묶음이 사본 초과(too_big)를 받고 뒤 묶음이 실패해도 탭에 보인다", async () => {
    const { scenes, backup, settle } = await boot();
    scenes.saveScenes(null, [JSON.parse(sceneJson("x")), ...Array.from({ length: 200 }, (_, i) => JSON.parse(sceneJson(`s${i}`)))]);
    await settle();
    getMeta = () => Promise.resolve({ items: [] });
    let sent = 0;
    putReply = (body) => (++sent === 1
      ? { ok: true, results: body.upserts.map((u) => (u.id === "x"
        ? { id: u.id, status: "too_big", target_id: "bk_t", hash: null }
        : { id: u.id, status: "saved", target_id: u.id, hash: fakeHex(u.data) })) }
      : Promise.reject(new Error("offline")));
    await backup.initSceneBackup();
    await vi.advanceTimersByTimeAsync(2500);
    expect(sent).toBe(2); // 200개씩 두 묶음 — 둘째가 실패했다
    expect([...backup.getSceneBackupSkippedIds()]).toEqual(["x"]);
  });

  it("7A 리뷰 — 사본 초과였던 씬이 서버 내용과 같아지면 풀린다(같아서 올리지 않는 길)", async () => {
    const { scenes, backup, settle } = await boot();
    scenes.saveScenes(null, [JSON.parse(sceneJson("x", "서버 판"))]);
    await settle();
    const serverText = scenes.listPersistedSceneTexts(null)[0].text;
    scenes.saveScenes(null, [JSON.parse(sceneJson("x", "이 창 판"))]);
    await settle();
    localStorage.setItem(ledgerKey("x"), JSON.stringify({ b: "옛 판" }));
    getMeta = () => Promise.resolve({ items: [{ id: "x", data_hash: fakeHex(serverText) }] });
    putReply = (body) => ({ ok: true, results: body.upserts.map((u) => ({ id: u.id, status: "too_big", target_id: "bk_t", hash: null })) });
    await backup.initSceneBackup();
    await vi.advanceTimersByTimeAsync(2500);
    expect([...backup.getSceneBackupSkippedIds()]).toEqual(["x"]);
    scenes.saveScenes(null, [JSON.parse(sceneJson("x", "서버 판"))]);
    await settle();
    await vi.advanceTimersByTimeAsync(2500);
    expect([...backup.getSceneBackupSkippedIds()]).toEqual([]);
  });

  it("63회차 재검토 — 원본 여럿의 사본 합계가 상한을 넘으면 요청을 나눈다(목록은 자르지 않는다)", async () => {
    const { scenes, backup, settle } = await boot();
    const copies = (origin: string) => Array.from({ length: 700 }, (_, i) =>
      ({ ...JSON.parse(sceneJson(`bk_${origin}_${i}`, "사본")), backupForkOf: { id: origin, sum: "s" } }));
    scenes.saveScenes(null, [
      JSON.parse(sceneJson("x1")), JSON.parse(sceneJson("x2")), JSON.parse(sceneJson("x3")),
      ...copies("x1"), ...copies("x2"), ...copies("x3"),
    ]);
    await settle();
    getMeta = () => Promise.resolve({ items: [] });
    putReply = hashReply;
    await backup.initSceneBackup();
    await vi.advanceTimersByTimeAsync(2500);
    const bodies = puts().map(putBody);
    expect(Math.max(...bodies.map((b) => b.fork_avoid.length))).toBeLessThanOrEqual(2000);
    const sentWith = (id: string) => bodies.find((b) => b.upserts.some((u: { id: string }) => u.id === id));
    for (const origin of ["x1", "x2", "x3"]) {
      expect(sentWith(origin)!.fork_avoid.filter((id: string) => id.startsWith(`bk_${origin}_`))).toHaveLength(700); // 자르지 않았다
    }
  });
});