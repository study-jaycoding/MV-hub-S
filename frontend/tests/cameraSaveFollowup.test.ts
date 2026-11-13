// 카메라만 바뀐 저장의 뒤처리(2026-11-10, docs/status/캔버스_카메라저장뒤처리_2026-11-10.md) — 화면 반영 판정과 반복 계산만 고쳤다.
//  R2 저장소 바깥 알림은 씬이 실제로 달라진 확정에만 · R3 같은 글자 정본은 객체 보존 · R4 지문 기억 · R5 applyExternal 같은 목록이면 그대로.
//  R1(공책 결과의 visibleChanged)은 가짜 허브가 있는 sceneNotebook.test.ts 에서 본다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sha = vi.hoisted(() => ({ calls: [] as string[], gate: null as Promise<void> | null }));
vi.mock("../src/lib/editShare", async (original) => {
  const real = await original<typeof import("../src/lib/editShare")>();
  return { ...real, sha256Hex: async (text: string) => { sha.calls.push(text); if (sha.gate) await sha.gate; return real.sha256Hex(text); } };
});

import { setHubFeatures } from "../src/lib/hubFeatures";
import { setAccountScope } from "../src/lib/accountScope";
import {
  absorbLegacyScenes, applySceneOp, initSceneStore, readConfirmedBucket, sceneStoreConflicts, setSceneWriteGate,
  settleSceneStoreForTest, subscribeSceneStoreExternal, writeScenesStore,
} from "../src/lib/sceneStore";
import {
  joinSceneNotebook, notebookHashMemoForTest, replaceNotebookSceneIfUnchanged, readSceneNotebook, writeNotebookProgress,
  setSceneNotebookTokenProvider, syncSceneNotebook, type SceneBase,
} from "../src/lib/sceneNotebook";
import { mergeExternalSceneList } from "../src/lib/useSceneCoordination";
import type { Scene, ScenesByProject } from "../src/lib/scenes";

const bucket = "local::_none";
const scene = (id = "s", name = id, extra: Partial<Scene> = {}): Scene => ({ id, name, cards: [], edges: [], created_at: 1, ...extra });
const base = (rev = 1, hash = `hash-${rev}`): SceneBase => ({ history: "h", rev, hash });
const edit = (fn: (all: ScenesByProject) => void) => applySceneOp((all) => { fn(all); return { write: true, value: null }; });
async function stateOf(id = "s") {
  const r = await readSceneNotebook("local");
  if (!r.ok) throw new Error("snapshot failed");
  return r.value.buckets[bucket].states[id];
}

beforeEach(() => { setHubFeatures(["scene_writer_v1"]); setSceneWriteGate(() => false); setAccountScope(null); sha.calls.length = 0; });
afterEach(async () => { await settleSceneStoreForTest(); setHubFeatures([]); setAccountScope(null); vi.unstubAllGlobals(); });

describe("R2 저장소 바깥 알림 — 씬이 실제로 달라진 확정에만", () => {
  it("공책 진행 기록만 쓴 확정은 알리지 않고, 씬 내용이 바뀐 확정은 알린다", async () => {
    await writeScenesStore({ [bucket]: [scene()] });
    const seen = vi.fn();
    const off = subscribeSceneStoreExternal(seen);
    expect(await writeNotebookProgress("local", "write", null, { id: "w1" })).toBe(true); // 메타(nw)만
    await settleSceneStoreForTest();
    expect(seen).not.toHaveBeenCalled();
    expect(await replaceNotebookSceneIfUnchanged(bucket, await stateOf(), scene("s", "다른 브라우저에서 고침"), base(2))).toBe(true);
    await settleSceneStoreForTest();
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });

  it("첫 합류가 씬 차이 없이 충돌 목록만 바꿔도 알린다", async () => {
    const legacy = { [bucket]: [scene()] };
    await initSceneStore(() => legacy, null, () => true);
    edit((all) => { all[bucket] = [scene("s", "local change")]; });
    await settleSceneStoreForTest();
    await absorbLegacyScenes({ [bucket]: [scene("s", "legacy change")] });
    expect(sceneStoreConflicts()).toHaveLength(1);
    edit((all) => { all[bucket] = []; }); // 화면 목록은 비우고 충돌만 남긴다
    await settleSceneStoreForTest();
    const seen = vi.fn();
    const off = subscribeSceneStoreExternal(seen);
    expect(await joinSceneNotebook("local", "book", "h", { [bucket]: { scenes: [], bases: {}, order: { history: "h", rev: 1 } } }, undefined, "restore-1")).toBe(true);
    await settleSceneStoreForTest();
    expect(sceneStoreConflicts()).toEqual([]);
    expect(seen).toHaveBeenCalled();
    off();
  });
});

describe("R3 같은 글자 정본은 씬 객체를 바꾸지 않는다", () => {
  it("글자가 같으면 기존 객체를 두고 기준만 갱신, 다르면 교체", async () => {
    await writeScenesStore({ [bucket]: [scene("s", "same", { camera: { z: 0.5, x: 1, y: 2 } })] });
    const before = readConfirmedBucket(bucket)[0];
    const sameText = JSON.parse(JSON.stringify(before)) as Scene; // 허브 정본 = 방금 올린 글자(새 객체)
    expect(await replaceNotebookSceneIfUnchanged(bucket, await stateOf(), sameText, base(3))).toBe(true);
    await settleSceneStoreForTest();
    expect(readConfirmedBucket(bucket)[0]).toBe(before);
    expect((await stateOf()).base).toEqual(base(3));
    expect(await replaceNotebookSceneIfUnchanged(bucket, await stateOf(), scene("s", "remote"), base(4))).toBe(true);
    await settleSceneStoreForTest();
    expect(readConfirmedBucket(bucket)[0]).not.toBe(before);
    expect(readConfirmedBucket(bucket)[0].name).toBe("remote");
  });

  it("조건 검사는 그대로 — 기대 상태가 다르면 글자가 같아도 반영하지 않는다", async () => {
    await writeScenesStore({ [bucket]: [scene()] });
    const stale = { ...(await stateOf()), base: base(9) };
    expect(await replaceNotebookSceneIfUnchanged(bucket, stale, scene(), base(10))).toBe(false);
    expect((await stateOf()).base).toBeNull();
  });
});

describe("R4 지문 기억", () => {
  let fake: { rows: { id: string; data: string; deleted_at: null; base: { history_id: string; rev: number; hash: string } }[] };
  beforeEach(() => {
    vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => {} });
    vi.stubGlobal("crypto", {});
    setSceneNotebookTokenProvider(() => ({ account: "local", token: "t", generation: "g" }));
  });
  afterEach(() => { setSceneNotebookTokenProvider(() => null); });

  it("같은 글자는 다시 해싱하지 않고, 다른 글자는 계산하며, 계정이 바뀌면 비운다", async () => {
    const { createHash } = await import("node:crypto");
    const digest = (s: string) => createHash("sha256").update(s).digest("hex");
    const data = JSON.stringify(scene("s", "big".repeat(1000)));
    fake = { rows: [{ id: "s", data, deleted_at: null, base: { history_id: "h", rev: 1, hash: digest(data) } }] };
    const http = await import("../src/lib/http");
    const spy = vi.spyOn(http, "jsonFetch").mockImplementation(async (path: string) => {
      if (path.includes("notebook?")) return structuredClone({ restore_generation: "restore-1", notebook_id: "book", history_id: "h", items: fake.rows, order: { ids: ["s"], rev: 1, history_id: "h" } }) as never;
      if (path.endsWith("/writer")) return { ok: true } as never;
      throw new Error(`unexpected ${path}`);
    });
    await writeScenesStore({ [bucket]: [] });
    await joinSceneNotebook("local", "book", "h", { [bucket]: { scenes: [JSON.parse(data)], bases: { s: { history: "h", rev: 1, hash: digest(data) } }, order: { history: "h", rev: 1 } } }, undefined, "restore-1");
    await syncSceneNotebook();
    const first = sha.calls.filter((t) => t === data).length;
    expect(first).toBe(1); // 행 대조·로컬 지문이 같은 글자 — 한 번만 계산
    await syncSceneNotebook();
    expect(sha.calls.filter((t) => t === data).length).toBe(first); // 두 번째 동기화: 재계산 0
    expect(notebookHashMemoForTest().size).toBeGreaterThan(0);
    setSceneNotebookTokenProvider(() => ({ account: "local", token: "t2", generation: "g2" })); // 계정·쓰기 세대 교체
    expect(notebookHashMemoForTest()).toEqual({ size: 0, chars: 0 });
    await syncSceneNotebook();
    expect(sha.calls.filter((t) => t === data).length).toBe(first + 1); // 비운 뒤 다시 계산
    spy.mockRestore();
  });

  it("비우기(계정·쓰기 세대 교체) 전에 시작한 지문 계산은 끝나도 새 기억에 넣지 않는다", async () => {
    const { createHash } = await import("node:crypto");
    const data = JSON.stringify(scene("s", "late"));
    const digest = createHash("sha256").update(data).digest("hex");
    const http = await import("../src/lib/http");
    const spy = vi.spyOn(http, "jsonFetch").mockImplementation(async (path: string) => {
      if (path.includes("notebook?")) return structuredClone({ restore_generation: "restore-1", notebook_id: "book", history_id: "h", items: [{ id: "s", data, deleted_at: null, base: { history_id: "h", rev: 1, hash: digest } }], order: { ids: ["s"], rev: 1, history_id: "h" } }) as never;
      return { ok: true } as never;
    });
    await writeScenesStore({ [bucket]: [] });
    await joinSceneNotebook("local", "book", "h", { [bucket]: { scenes: [JSON.parse(data)], bases: { s: { history: "h", rev: 1, hash: digest } }, order: { history: "h", rev: 1 } } }, undefined, "restore-1");
    let release!: () => void;
    sha.gate = new Promise<void>((resolve) => { release = resolve; });
    const run = syncSceneNotebook();
    await vi.waitFor(() => expect(sha.calls).toContain(data)); // 계산이 시작됐다(아직 안 끝남)
    setSceneNotebookTokenProvider(() => ({ account: "local", token: "t3", generation: "g3" })); // 비운다
    sha.gate = null;
    release();
    await run;
    expect(notebookHashMemoForTest()).toEqual({ size: 0, chars: 0 });
    spy.mockRestore();
  });

  it("잘못된 허브 해시는 기억과 상관없이 여전히 거부한다", async () => {
    const data = JSON.stringify(scene("s"));
    const http = await import("../src/lib/http");
    const spy = vi.spyOn(http, "jsonFetch").mockImplementation(async (path: string) => {
      if (path.includes("notebook?")) return structuredClone({ restore_generation: "restore-1", notebook_id: "book", history_id: "h", items: [{ id: "s", data, deleted_at: null, base: { history_id: "h", rev: 1, hash: "0".repeat(64) } }], order: { ids: ["s"], rev: 1, history_id: "h" } }) as never;
      return { ok: true } as never;
    });
    await writeScenesStore({ [bucket]: [] });
    await joinSceneNotebook("local", "book", "h", { [bucket]: { scenes: [JSON.parse(data)], bases: { s: { history: "h", rev: 1, hash: "x" } }, order: { history: "h", rev: 1 } } }, undefined, "restore-1");
    const r = await syncSceneNotebook();
    expect(r.status).toBe("retry");
    expect(r.reason).toBe("invalid_notebook_hash");
    spy.mockRestore();
  });
});

describe("R5 applyExternal 합치기 — 같은 목록이면 이전 목록 그대로", () => {
  it("길이·순서·객체가 같으면 prev 를 돌려주고 내용 비교·안내를 하지 않는다", () => {
    const a = scene("a"), b = scene("b");
    const notify = vi.fn();
    const prev = [a, b];
    expect(mergeExternalSceneList(prev, [a, b], "a", false, notify)).toBe(prev);
    expect(mergeExternalSceneList(prev, [a, b], "a", true, notify)).toBe(prev); // 다른 창에 떠 있을 때도
    expect(notify).not.toHaveBeenCalled();
  });

  it("다른 객체면 지금처럼 비교·안내하고, 활성 씬은 화면의 것을 지킨다", () => {
    const mine = scene("a", "화면"), b = scene("b");
    const notify = vi.fn();
    const merged = mergeExternalSceneList([mine, b], [scene("a", "다른 탭"), scene("b", "새 b")], "a", false, notify);
    expect(merged[0]).toBe(mine);
    expect(merged[1].name).toBe("새 b");
    expect(notify).toHaveBeenCalledWith("다른 탭에서 이 씬이 변경됐습니다 — 새로고침하면 반영됩니다.");
    const deleted = vi.fn();
    const prev = [mine, b];
    expect(mergeExternalSceneList(prev, [b], "a", false, deleted)).toBe(prev);
    expect(deleted).toHaveBeenCalledWith("다른 탭에서 이 씬이 삭제됐습니다 — 새로고침하면 반영됩니다.");
  });
});
