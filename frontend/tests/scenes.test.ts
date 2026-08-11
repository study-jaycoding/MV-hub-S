// scenes 순수 헬퍼 특성화 — 변형 id·지문(양방향 동기화 안정성 근거).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  variantIds,
  preserveRepresentatives,
  sceneRefFingerprint,
  settleComfyRunning,
  cardBatch,
  listScenes,
  saveScenes,
  getActiveSceneId,
  parseSceneImport,
  SCENE_EXPORT_FORMAT,
  SCENE_EXPORT_VERSION,
  type Scene,
} from "../src/lib/scenes";
import { saveJSON, saveString } from "../src/lib/storage";
import { STORAGE_KEYS } from "../src/lib/storageKeys";
import { setAccountScope } from "../src/lib/accountScope";

// node 환경엔 localStorage 가 없어 인메모리 목을 심는다(계정 네임스페이스·이관 검증용).
function storageMock(): Storage {
  const store: Record<string, string> = {};
  return {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() { return Object.keys(store).length; },
  } as Storage;
}
function installStorageMocks() {
  (globalThis as { localStorage?: Storage }).localStorage = storageMock();
  (globalThis as { sessionStorage?: Storage }).sessionStorage = storageMock();
}
const mkScene = (id: string): Scene => ({ id, name: id, cards: [], edges: [], created_at: 1 });

describe("scenes 계정 네임스페이스", () => {
  beforeEach(installStorageMocks);
  afterEach(() => {
    delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
  });

  it("계정별로 씬이 분리된다(전환해도 안 섞임, 되돌아오면 복원)", () => {
    saveString(STORAGE_KEYS.activeAccount, "a@x.com");
    setAccountScope("a@x.com");
    saveScenes(null, [mkScene("A1")]);
    expect(listScenes(null).map((s) => s.id)).toEqual(["A1"]);

    saveString(STORAGE_KEYS.activeAccount, "b@x.com"); // 계정 전환
    setAccountScope("b@x.com");
    expect(listScenes(null)).toEqual([]); // A 씬 안 보임
    saveScenes(null, [mkScene("B1")]);

    saveString(STORAGE_KEYS.activeAccount, "a@x.com"); // 되돌아옴
    setAccountScope("a@x.com");
    expect(listScenes(null).map((s) => s.id)).toEqual(["A1"]); // A 씬 복원
  });

  it("네임스페이스 이전(레거시 _none) 씬을 현재 계정으로 1회 이관하고 옛 키는 제거", () => {
    saveJSON(STORAGE_KEYS.scenes, { _none: [mkScene("OLD")] }); // 옛 데이터
    saveString(STORAGE_KEYS.activeAccount, "a@x.com");
    setAccountScope("a@x.com");
    expect(listScenes(null).map((s) => s.id)).toEqual(["OLD"]); // 현재 계정으로 이관돼 보임

    // 다른 계정은 이관된 옛 씬을 다시 가져가지 않는다(옛 키 제거됨).
    saveString(STORAGE_KEYS.activeAccount, "b@x.com");
    setAccountScope("b@x.com");
    expect(listScenes(null)).toEqual([]);
  });

  it("로그인 없음(AUTH off 로컬)은 local 네임스페이스로 유지", () => {
    saveJSON(STORAGE_KEYS.scenes, { _none: [mkScene("LOCAL")] });
    // activeAccount 없음
    expect(listScenes(null).map((s) => s.id)).toEqual(["LOCAL"]); // 로컬도 옛 씬 유지(이관)
    expect(getActiveSceneId(null)).toBeNull();
  });

  it("다른 탭의 로그인으로 activeAccount가 바뀌어도 현재 탭의 씬 범위는 유지", () => {
    saveString(STORAGE_KEYS.activeAccount, "a@x.com");
    setAccountScope("a@x.com");
    saveScenes(null, [mkScene("A1")]);

    // 다른 탭이 B로 로그인하면 공유 localStorage 마커는 B가 되지만 이 탭 인증은 여전히 A다.
    saveString(STORAGE_KEYS.activeAccount, "b@x.com");
    expect(listScenes(null).map((s) => s.id)).toEqual(["A1"]);
    saveScenes(null, [mkScene("A2")]);

    setAccountScope("b@x.com"); // 이 탭도 실제로 B 인증이 확인된 뒤에만 전환
    expect(listScenes(null)).toEqual([]);
    setAccountScope("a@x.com");
    expect(listScenes(null).map((s) => s.id)).toEqual(["A2"]);
  });
});

describe("cardBatch", () => {
  it("기본값 1, 정상값 유지", () => {
    expect(cardBatch(undefined)).toBe(1);
    expect(cardBatch({})).toBe(1);
    expect(cardBatch({ batchCount: 3 })).toBe(3);
  });
  it("범위·비정상값 안전화(1~4 정수)", () => {
    expect(cardBatch({ batchCount: 99 })).toBe(4); // 손상/임포트 상한 clamp
    expect(cardBatch({ batchCount: 0 })).toBe(1);
    expect(cardBatch({ batchCount: 2.9 })).toBe(2); // 정수화
    expect(cardBatch({ batchCount: NaN })).toBe(1);
    expect(cardBatch({ batchCount: "x" as unknown as number })).toBe(1);
  });
});

describe("variantIds", () => {
  it("genIds 가 있으면 그것을(순서 보존)", () => {
    expect(variantIds({ genIds: ["a", "b"], genId: "b" })).toEqual(["a", "b"]);
  });
  it("genIds 없고 genId 만 있으면 [genId]", () => {
    expect(variantIds({ genIds: undefined, genId: "solo" })).toEqual(["solo"]);
  });
  it("둘 다 없으면 빈 배열", () => {
    expect(variantIds({ genIds: undefined, genId: null })).toEqual([]);
  });
});

describe("preserveRepresentatives (대표 undo 제외)", () => {
  const mk = (o: Partial<Scene["cards"][number]>): Scene["cards"][number] =>
    ({ id: "c", kind: "generation", x: 0, y: 0, ...o }) as Scene["cards"][number];
  it("현재 대표(genId)를 복원 대상에 병합 — 대표는 되돌리지 않는다", () => {
    const target = [mk({ id: "c", genIds: ["a", "b"], genId: "a" })]; // 스냅샷 대표=a
    const current = [mk({ id: "c", genIds: ["a", "b"], genId: "b" })]; // 지금 대표=b
    expect(preserveRepresentatives(target, current)[0].genId).toBe("b");
  });
  it("현재 대표가 스냅샷 변형목록에 없으면 목록에 포함시켜 유효화(깨진 참조 방지)", () => {
    const target = [mk({ id: "c", genIds: ["a"], genId: "a" })]; // 스냅샷엔 b 없음
    const current = [mk({ id: "c", genIds: ["a", "b"], genId: "b" })];
    const out = preserveRepresentatives(target, current)[0];
    expect(out.genId).toBe("b");
    expect(out.genIds).toContain("b");
  });
  it("현재 대표가 없거나(빈 카드) 같으면 스냅샷 그대로", () => {
    const target = [mk({ id: "c", genIds: ["a"], genId: "a" })];
    expect(preserveRepresentatives(target, [mk({ id: "c", genId: null })])[0].genId).toBe("a"); // 현재 대표 없음
    expect(preserveRepresentatives(target, [mk({ id: "c", genId: "a" })])[0]).toBe(target[0]); // 같으면 동일 참조
  });
  it("현재 목록에 없는 카드는 스냅샷 그대로", () => {
    const target = [mk({ id: "gone", genIds: ["a"], genId: "a" })];
    expect(preserveRepresentatives(target, [])[0].genId).toBe("a");
  });
  it("comfy 는 워크플로(content) 바뀌면 대표 보존 안 함 — 옛 결과를 새 워크플로에 안 붙임", () => {
    const target = [mk({ id: "c", kind: "comfy", genIds: [], genId: null, comfyCfg: { content: "NEW" } } as Partial<Scene["cards"][number]>)];
    const current = [mk({ id: "c", kind: "comfy", genId: "old", comfyCfg: { content: "OLD" } } as Partial<Scene["cards"][number]>)];
    const out = preserveRepresentatives(target, current)[0];
    expect(out.genId ?? null).toBeNull(); // 옛 워크플로 대표 'old' 를 새 워크플로에 주입하지 않음
    expect(out.genIds ?? []).toEqual([]);
  });
  it("comfy 라도 워크플로 같으면 대표 보존", () => {
    const target = [mk({ id: "c", kind: "comfy", genIds: ["a"], genId: "a", comfyCfg: { content: "SAME" } } as Partial<Scene["cards"][number]>)];
    const current = [mk({ id: "c", kind: "comfy", genIds: ["a", "b"], genId: "b", comfyCfg: { content: "SAME" } } as Partial<Scene["cards"][number]>)];
    expect(preserveRepresentatives(target, current)[0].genId).toBe("b");
  });
});

describe("settleComfyRunning (생성중 박제 방지·치유)", () => {
  const mkComfy = (cfg: Record<string, unknown>): Scene["cards"][number] =>
    ({ id: "c", kind: "comfy", x: 0, y: 0, comfyCfg: cfg }) as Scene["cards"][number];
  it("running + 결과 있음 → done (이전 결과 표시 유지)", () => {
    const out = settleComfyRunning([mkComfy({ status: "running", outputs: [{ kind: "image", url: "u" }] })]);
    expect(out[0].comfyCfg!.status).toBe("done");
  });
  it("running + 결과 없음 → idle", () => {
    const out = settleComfyRunning([mkComfy({ status: "running" })]);
    expect(out[0].comfyCfg!.status).toBe("idle");
  });
  it("running + 레거시 단일 output.url 만 있어도 → done (하위호환)", () => {
    const out = settleComfyRunning([mkComfy({ status: "running", output: { url: "u", kind: "image" } })]);
    expect(out[0].comfyCfg!.status).toBe("done");
  });
  it("keep(실제 실행 중)이면 running 그대로", () => {
    const out = settleComfyRunning([mkComfy({ status: "running" })], () => true);
    expect(out[0].comfyCfg!.status).toBe("running");
  });
  it("running 아닌 카드·비 comfy 카드는 그대로 — 변경 없으면 원본 배열 참조 유지", () => {
    const cards = [
      mkComfy({ status: "done" }),
      { id: "t", kind: "text", x: 0, y: 0, text: "x" } as Scene["cards"][number],
    ];
    expect(settleComfyRunning(cards)).toBe(cards); // 동일 참조(불필요 리렌더 방지)
  });
});

describe("sceneRefFingerprint", () => {
  it("같은 refs 는 같은 지문(안정)", () => {
    const refs = [{ file_path: "a", type: "image", name: "n", thumb: "t", source_gen_id: "g" }];
    expect(sceneRefFingerprint(refs)).toBe(sceneRefFingerprint([...refs]));
  });
  it("빈 값 정규화: name/thumb/source_gen_id 누락은 '' 로", () => {
    const a = sceneRefFingerprint([{ file_path: "a", type: "image" }]);
    const b = sceneRefFingerprint([
      { file_path: "a", type: "image", name: "", thumb: "", source_gen_id: "" },
    ]);
    expect(a).toBe(b);
  });
  it("순서·내용이 다르면 지문 다름", () => {
    const one = sceneRefFingerprint([{ file_path: "a", type: "image" }]);
    const two = sceneRefFingerprint([{ file_path: "b", type: "image" }]);
    expect(one).not.toBe(two);
  });
});

describe("parseSceneImport 방어(#3)", () => {
  const wrap = (cards: unknown[], extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      format: SCENE_EXPORT_FORMAT,
      version: SCENE_EXPORT_VERSION,
      scene: { name: "t", cards, edges: [], ...extra },
    });

  it("손상 카드 필드(refs/genIds/comfyCfg 비배열, 좌표 비수치)를 정규화한다", () => {
    const snap = parseSceneImport(
      wrap([
        { id: "A", kind: "reference", x: "bad", y: null, refs: {}, genIds: {} },
        { id: "B", kind: "comfy", x: 10, y: 20, comfyCfg: { outputs: {}, params: "x", paramValues: [] } },
      ]),
    );
    const a = snap.cards.find((c) => c.id === "A")!;
    expect(a.x).toBe(0); // 비수치 → 0
    expect(a.y).toBe(0);
    expect(a.refs).toBeUndefined(); // 비배열 → 제거
    expect(a.genIds).toBeUndefined();
    const b = snap.cards.find((c) => c.id === "B")!;
    expect(b.comfyCfg!.outputs).toBeUndefined();
    expect(b.comfyCfg!.params).toBeUndefined();
    expect(b.comfyCfg!.paramValues).toBeUndefined();
    expect(b.x).toBe(10); // 정상값 보존
  });

  it("중복 카드 id 는 첫 것만 남긴다", () => {
    const snap = parseSceneImport(
      wrap([
        { id: "A", kind: "text", x: 0, y: 0, text: "first" },
        { id: "A", kind: "text", x: 0, y: 0, text: "dup" },
      ]),
    );
    expect(snap.cards.map((c) => c.id)).toEqual(["A"]);
    expect(snap.cards[0].text).toBe("first");
  });

  it("손상 카메라는 무시(기본 뷰)", () => {
    const ok = parseSceneImport(wrap([], { camera: { x: 1, y: 2, z: 3 } }));
    expect(ok.camera).toEqual({ x: 1, y: 2, z: 3 });
    const bad = parseSceneImport(wrap([], { camera: { x: "a", y: 2, z: 3 } }));
    expect(bad.camera).toBeUndefined();
  });

  it("Set 폴더 경로는 정규화하고 상위 경로 이동은 거부한다", () => {
    const snap = parseSceneImport(
      wrap([
        {
          id: "SET-OK",
          kind: "set",
          x: 0,
          y: 0,
          setCfg: {
            folder: { projectId: " project-1 ", projectName: " 프로젝트 ", path: "ep001\\c0010" },
            tagsText: "night, final",
          },
        },
        {
          id: "SET-BAD",
          kind: "set",
          x: 10,
          y: 10,
          setCfg: {
            folder: { projectId: "project-1", path: "../secret" },
            tagsText: "safe-tag",
          },
        },
      ]),
    );
    expect(snap.cards.find((card) => card.id === "SET-OK")?.setCfg).toEqual({
      folder: { projectId: "project-1", projectName: "프로젝트", path: "ep001/c0010" },
      tagsText: "night, final",
    });
    expect(snap.cards.find((card) => card.id === "SET-BAD")?.setCfg).toEqual({ tagsText: "safe-tag" });
  });

  it("알 수 없는 카드 종류는 여전히 거부", () => {
    expect(() => parseSceneImport(wrap([{ id: "X", kind: "bogus", x: 0, y: 0 }]))).toThrow();
  });
});
