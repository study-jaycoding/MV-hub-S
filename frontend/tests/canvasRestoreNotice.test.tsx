// @vitest-environment jsdom
// 첫 공책 전환 복구 동선(docs/status/공책첫전환복구동선_2026-11-15.md) — 보관 묶음(nr)의 행 판정·되살리기·카드 소속 표식·캔버스 알림·설정 다시 찾기.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CanvasRestoreNotice, markSeen, restoreRows } from "../src/components/scene/CanvasRestoreNotice";
import { CanvasArchiveSection } from "../src/components/settings/CanvasArchiveSection";
import { restoreArchiveRows, restoreArchiveText } from "../src/lib/sceneArchive";
import * as sceneNotebook from "../src/lib/sceneNotebook";
import { joinSceneNotebook, setSceneNotebookTokenProvider, syncSceneNotebook, writeNotebookProgress, type RestoreArchive } from "../src/lib/sceneNotebook";
import * as sceneStore from "../src/lib/sceneStore";
import { abortSceneStoreWritesForTest, applySceneOp, dumpSceneStore, notebookKey, readWorkingBucket, sceneNotebookTransaction, setSceneWriteGate, settleSceneStoreForTest, writeScenesStore } from "../src/lib/sceneStore";
import { setAccountScope } from "../src/lib/accountScope";
import * as accountScope from "../src/lib/accountScope";
import { setHubFeatures } from "../src/lib/hubFeatures";
import * as sceneWriter from "../src/lib/sceneWriter";
import * as sceneCardLinks from "../src/lib/sceneCardLinks";
import { readStoredScene, type Scene } from "../src/lib/scenes";
import { sceneBodySum } from "../src/lib/sceneAbsorb";
import { setLang } from "../src/lib/i18n";

const request = vi.hoisted(() => vi.fn());
const flash = vi.hoisted(() => vi.fn());
const windowState = vi.hoisted(() => ({ canvasWindow: false, floating: false }));
vi.mock("../src/lib/http", async (original) => ({ ...await original<typeof import("../src/lib/http")>(), jsonFetch: request }));
vi.mock("../src/lib/download", () => ({ downloadText: vi.fn() }));
vi.mock("../src/lib/flash", () => ({ flashMsg: flash }));
vi.mock("../src/lib/popupWindows", async (original) => ({
  ...await original<typeof import("../src/lib/popupWindows")>(),
  isCanvasWindow: () => windowState.canvasWindow, isCanvasFloating: () => windowState.floating,
  useCanvasFloating: () => windowState.floating, useCanvasFollower: () => false,
}));

const bucket = "local::_none";
const scene = (id: string, name = id, extra: Partial<Scene> = {}): Scene => ({ id, name, cards: [], edges: [], created_at: 1, ...extra });
const genCard = (id: string, genIds: string[]) => ({ id, kind: "generation", x: 0, y: 0, w: 100, h: 100, genId: genIds[0], genIds }) as unknown as Scene["cards"][number];
const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");
const archive = (id: string, scenes: Record<string, Scene[]>, createdAt = "2026-11-15T10:00:00.000Z", extra: Partial<RestoreArchive> = {}): RestoreArchive =>
  ({ id, createdAt, notebookId: "", fromGeneration: null, toGeneration: "new", scenes, conflicts: [], controls: {}, ...extra });
const emptyBook = () => ({ restore_generation: "new", notebook_id: null, history_id: "h", items: [], order: { ids: [], rev: 0, history_id: "h" } });
let root: Root | undefined, host: HTMLDivElement;

async function putArchives(list: RestoreArchive[]) {
  const out = await sceneNotebookTransaction([notebookKey("nr", "local")], (_all, meta) => {
    meta[notebookKey("nr", "local")] = list;
    return { changed: true, value: null };
  });
  expect(out.ok).toBe(true);
}
const flush = async (times = 4) => { for (let i = 0; i < times; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const render = async (node: React.ReactNode) => { root ??= createRoot(host); await act(async () => { root!.render(node); }); await flush(); };
const notice = () => host.querySelector(".canvas-restore-notice");

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); sessionStorage.clear(); request.mockReset(); flash.mockReset();
  windowState.canvasWindow = false; windowState.floating = false;
  setAccountScope(null); setHubFeatures(["scene_writer_v1"]); setSceneWriteGate(() => false);
  setSceneNotebookTokenProvider(() => ({ account: "local", token: "token", generation: "lease" }));
  await writeScenesStore({ [bucket]: [] });
  const base = [scene("a"), scene("b")];
  await joinSceneNotebook("local", "book", "h", { [bucket]: { scenes: base, bases: Object.fromEntries(base.map((s) => [s.id, { history: "h", rev: 1, hash: hash(JSON.stringify(s)) }])), order: { history: "h", rev: 1 } } }, undefined, "old");
  request.mockImplementation(async (_path, init) => { if (init?.method && init.method !== "GET") throw Error("unexpected write"); return emptyBook(); });
  host = document.createElement("div"); document.body.append(host);
});
afterEach(async () => {
  if (root) act(() => root!.unmount()); root = undefined; host.remove();
  vi.restoreAllMocks();
  abortSceneStoreWritesForTest(false); await settleSceneStoreForTest();
  setSceneNotebookTokenProvider(() => null); setSceneWriteGate(() => false); setHubFeatures([]); setAccountScope(null);
  setLang("ko");
});

async function firstStartNotice() {
  await writeScenesStore({ [bucket]: [scene("mine", "local raw")] });
  await sceneNotebookTransaction([], (_all, meta) => { delete meta[notebookKey("nj", "local")]; return { changed: true, value: null }; });
  expect((await syncSceneNotebook()).reason).toBe("start_confirmation");
  await render(<CanvasRestoreNotice />);
}
it("first start shows the exact prompt, folds Later and reopens without a merge picker or uploads", async () => {
  await firstStartNotice();
  expect(notice()?.textContent).toContain("이 캔버스를 다른 브라우저에서도 쓸까요?");
  expect(notice()?.textContent).toContain("지금 보이는 캔버스(씬 1개)가 이 PC 의 어느 브라우저에서 열어도 그대로 보이게 됩니다. 전에 저장돼 있던 캔버스는 따로 보관됩니다.");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  const button = (label: string) => [...host.querySelectorAll("button")].find((item) => item.textContent === label)!;
  await act(async () => button("나중에").click());
  expect(notice()?.textContent).toContain("이 브라우저에만 저장 중");
  await act(async () => button("다른 브라우저와 같이 쓰기").click());
  expect(notice()?.textContent).toContain("이 캔버스로 쓰기");
  expect(readWorkingBucket(bucket)).toEqual([scene("mine", "local raw")]);
  expect(request.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
});
it("first start button forwards that offer once, becomes busy, then shows a dismissible success notice", async () => {
  await firstStartNotice();
  const offer = sceneNotebook.getNotebookStartNotice()!;
  let finish!: () => void;
  const start = vi.spyOn(sceneWriter, "startSceneNotebook").mockImplementation(async () => { await new Promise<void>((resolve) => { finish = resolve; }); });
  await act(async () => (host.querySelector('[data-notebook-action="start"]') as HTMLButtonElement).click());
  expect(start).toHaveBeenCalledWith(offer.id);
  expect((host.querySelector('[data-notebook-action="start"]') as HTMLButtonElement).disabled).toBe(true);
  await act(async () => finish());
  // 실제 성공 알림은 공책 거래가 발행한다.
  request.mockImplementation(async (path, init) => {
    if (path.endsWith("/start")) return {};
    const started = request.mock.calls.some(([p, i]) => p.endsWith("/start") && JSON.parse(String(i?.body)).commit);
    return started ? { ...emptyBook(), notebook_id: "started", items: [{ id: "mine", data: JSON.stringify(scene("mine", "local raw")), deleted_at: null,
      base: { history_id: "h", rev: 1, hash: hash(JSON.stringify(scene("mine", "local raw"))) } }], order: { ids: ["mine"], rev: 1, history_id: "h" } } : emptyBook();
  });
  const approval = await sceneNotebook.prepareNotebookStart(offer.id, async () => true);
  await act(async () => { await syncSceneNotebook({ startApproval: approval! }); });
  expect(host.textContent).toContain("이제 이 PC 의 어느 브라우저에서 열어도 같은 캔버스가 보입니다.");
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "닫기")!.click());
  expect(host.querySelector(".canvas-notebook-start")).toBeNull();
});
it("first start follows the i18n dictionary and account isolation", async () => {
  await firstStartNotice();
  await act(async () => setLang("en"));
  expect(notice()?.textContent).toContain("Use this canvas in other browsers?");
  expect(notice()?.textContent).toContain("1 scenes");
  setAccountScope("other"); await render(<CanvasRestoreNotice />);
  expect(host.querySelector(".canvas-notebook-start")).toBeNull();
});

it("rows: own buckets only, separate rows per bucket, and the five states (camera ignored, copy key like mergeArchiveBucket)", () => {
  // mergeArchiveBucket 이 만드는 사본 표식과 같은 지문(정규화한 보관 씬의 sceneBodySum)
  const copy = scene("cp", "[사본] d", { recoveredFrom: { id: "d", sum: sceneBodySum(readStoredScene(scene("d"))) } });
  const archived = archive("r1", {
    [bucket]: [scene("a", "a", { camera: { x: 9, y: 9, zoom: 2 } } as Partial<Scene>), scene("b", "changed"), scene("x"), scene("d")],
    "local::p1": [scene("x", "x-project")],
    "other::_none": [scene("z")],
  });
  const current = [scene("a"), scene("b"), copy];
  const rows = restoreArchiveRows("local", [archived], current);
  const states = Object.fromEntries(rows.map((row) => [`${row.bucket}/${row.scene.id}`, row.state]));
  expect(states).toEqual({ [`${bucket}/a`]: "same", [`${bucket}/b`]: "differs", [`${bucket}/x`]: "absent", [`${bucket}/d`]: "restored", "local::p1/x": "absent" });
  // 되살리기 글은 지금 캔버스 버킷에, 충돌 기록 없이
  expect(JSON.parse(restoreArchiveText("local", rows.slice(0, 1)))).toMatchObject({ buckets: { [bucket]: [{ id: "a" }] }, conflicts: [] });
  expect(restoreArchiveRows("local", [archive("only-conflicts", {}, undefined, { conflicts: [{ bucket, sceneId: "a", mine: null, theirs: null }] })], current)).toEqual([]);
  expect(restoreArchiveRows("local", [archive("bad", { [bucket]: [{ id: "broken" } as unknown as Scene] })], current).map((row) => row.state)).toEqual(["unreadable"]);
});

it("restore: absent ids keep their id, differing ids become '[사본]', existing scenes, the archive and the conflict list stay; same id from two buckets splits", async () => {
  applySceneOp((all) => { all[bucket] = [scene("a"), scene("b")]; return { write: true, value: null }; });
  await settleSceneStoreForTest();
  const conflictsBefore = (await dumpSceneStore()).conflicts;
  await putArchives([archive("r1", { [bucket]: [scene("a", "a-old"), scene("x", "x", { comfyRuns: [{ id: "run" }] } as unknown as Partial<Scene>)], "local::p1": [scene("x", "x-project")] })]);
  const archives = await sceneNotebook.readRestoreArchives("local");
  if (!archives.ok) throw Error("read failed");
  const rows = restoreArchiveRows("local", archives.value, readWorkingBucket(bucket)).filter((row) => row.state === "differs" || row.state === "absent");
  expect(rows).toHaveLength(3);
  const message = await restoreRows("local", rows);
  expect(message).toBe("캔버스에 3개를 되살렸습니다(사본 2개).");
  const now = readWorkingBucket(bucket);
  expect(now.find((s) => s.id === "a")?.name).toBe("a"); // 기존 씬은 그대로
  expect(now.filter((s) => s.name === "[사본] a-old")).toHaveLength(1);
  expect(now.filter((s) => s.id === "x")).toHaveLength(1); // 같은 ID 두 행 — 하나는 그대로
  expect(now.filter((s) => s.recoveredFrom?.id === "x")).toHaveLength(1); // 하나는 사본
  expect(now.find((s) => s.id === "x")?.comfyRuns).toBeUndefined();
  expect((await dumpSceneStore()).conflicts).toEqual(conflictsBefore); // 충돌 기록을 싣지 않는다
  const after = await sceneNotebook.readRestoreArchives("local");
  expect(after.ok && after.value).toEqual(archives.value); // 보관함은 그대로
});

it("restore refuses without writing when the account changed, the notebook is off or another writer holds the canvas", async () => {
  await putArchives([archive("r1", { [bucket]: [scene("x")] })]);
  const archives = await sceneNotebook.readRestoreArchives("local");
  if (!archives.ok) throw Error("read failed");
  const rows = restoreArchiveRows("local", archives.value, []);
  await expect(restoreRows("someone-else", rows)).rejects.toThrow("계정이 바뀌었습니다");
  act(() => setHubFeatures([]));
  await expect(restoreRows("local", rows)).rejects.toThrow("캔버스가 이 브라우저에만 저장되는 상태라");
  act(() => setHubFeatures(["scene_writer_v1"]));
  vi.spyOn(sceneWriter, "getSceneWriterView").mockReturnValue({ mode: "away", handed: false, localCount: 0 });
  await expect(restoreRows("local", rows)).rejects.toThrow("다른 브라우저가 쓰는 중");
  windowState.floating = true;
  await expect(restoreRows("local", rows)).rejects.toThrow("다른 창이나");
  expect(readWorkingBucket(bucket).some((s) => s.id === "x")).toBe(false);
});

it("an account switch after the write queues the actual same-id scenes' card links on the starting account (copies and the other account get none)", async () => {
  applySceneOp((all) => { all[bucket] = [scene("a"), scene("b")]; return { write: true, value: null }; });
  await settleSceneStoreForTest();
  // 시작 계정에 같은 소속의 제거 대기가 있으면 되살리기가 상쇄한다
  localStorage.setItem("ch.sceneCardRevives.v1.local", "[]");
  localStorage.setItem("ch.sceneCardRemovals.v1.local", JSON.stringify([{ scene_id: "x", card_id: "c1", generation_id: "g1" }]));
  await putArchives([archive("r1", { [bucket]: [scene("x", "x", { cards: [genCard("c1", ["g1", "g2"])] }), scene("a", "a-old", { cards: [genCard("c9", ["g9"])] })] })]);
  const archives = await sceneNotebook.readRestoreArchives("local");
  if (!archives.ok) throw Error("read failed");
  const rows = restoreArchiveRows("local", archives.value, readWorkingBucket(bucket)).filter((row) => row.state === "absent" || row.state === "differs");
  // 저장이 끝난 직후 이 탭의 계정이 실제로 바뀐다(sceneCardLinks 도 같은 계정 함수를 본다)
  const merge = sceneStore.mergeSceneStoreDump;
  vi.spyOn(sceneStore, "mergeSceneStoreDump").mockImplementation(async (...args) => { const out = await merge(...args); setAccountScope("other"); return out; });
  const revive = vi.spyOn(sceneCardLinks, "reviveCardGenerations");
  await expect(restoreRows("local", rows)).rejects.toThrow("계정이 바뀌어");
  expect(revive).not.toHaveBeenCalled(); // 지금 계정(acct:other)으로는 보내지 않는다
  const queued = JSON.parse(localStorage.getItem("ch.sceneCardRevives.v1.local")!) as { scene_id: string; card_id: string; generation_id: string; restore_generation?: string }[];
  expect(queued.map((link) => `${link.scene_id}|${link.card_id}|${link.generation_id}`).sort()).toEqual(["x|c1|g1", "x|c1|g2"]); // 사본(a)은 없다
  expect(queued.every((link) => link.restore_generation === "old")).toBe(true); // 시작할 때 읽은 그 계정의 세대
  expect(JSON.parse(localStorage.getItem("ch.sceneCardRemovals.v1.local") ?? "[]")).toEqual([]); // 같은 소속 제거 대기는 상쇄
  expect(localStorage.getItem(`ch.sceneCardRevives.v1.${encodeURIComponent("acct:other")}`)).toBeNull();
});

it("a write failure that coincides with an account switch queues nothing", async () => {
  await putArchives([archive("r1", { [bucket]: [scene("x", "x", { cards: [genCard("c1", ["g1"])] })] })]);
  const archives = await sceneNotebook.readRestoreArchives("local");
  if (!archives.ok) throw Error("read failed");
  const rows = restoreArchiveRows("local", archives.value, []);
  vi.spyOn(sceneStore, "mergeSceneStoreDump").mockImplementation(async () => { setAccountScope("other"); return null; });
  await expect(restoreRows("local", rows)).rejects.toThrow("저장하지 못했습니다");
  expect(localStorage.getItem("ch.sceneCardRevives.v1.local")).toBeNull();
  expect(localStorage.getItem(`ch.sceneCardRevives.v1.${encodeURIComponent("acct:other")}`)).toBeNull();
});

it("notice: newest unseen archive with selectable rows, ✕ remembers it (pruned to existing archives), next unseen shows", async () => {
  await putArchives([archive("old", { [bucket]: [scene("o1")] }, "2026-11-14T10:00:00.000Z"), archive("new", { [bucket]: [scene("n1"), scene("n2")] }, "2026-11-15T10:00:00.000Z")]);
  localStorage.setItem("mvhub.restoreNoticeSeen:local", JSON.stringify(["gone"]));
  await render(<CanvasRestoreNotice />);
  expect(notice()?.textContent).toContain("씬 2개");
  await act(async () => { (host.querySelector(".canvas-restore-x") as HTMLButtonElement).click(); });
  await flush();
  expect(JSON.parse(localStorage.getItem("mvhub.restoreNoticeSeen:local")!)).toEqual(["new"]); // 없어진 묶음 id 는 버렸다
  expect(notice()?.textContent).toContain("씬 1개"); // 다음 미확인 묶음
  act(() => root!.unmount()); root = undefined;
  await render(<CanvasRestoreNotice />);
  expect(notice()?.textContent).toContain("씬 1개");
});

it("notice stays away on read failure, stale reads, notebook off and in the canvas window", async () => {
  await putArchives([archive("r1", { [bucket]: [scene("x")] })]);
  const read = vi.spyOn(sceneNotebook, "readRestoreArchives").mockResolvedValueOnce({ ok: false });
  await render(<CanvasRestoreNotice />);
  expect(notice()).toBeNull();
  read.mockResolvedValueOnce({ ok: true, value: [archive("r1", { [bucket]: [scene("x")] })], fresh: false });
  window.dispatchEvent(new Event("focus")); await flush();
  expect(notice()).toBeNull();
  read.mockRestore();
  window.dispatchEvent(new Event("focus")); await flush();
  expect(notice()).not.toBeNull();
  act(() => setHubFeatures([])); await flush();
  expect(notice()).toBeNull();
  act(() => setHubFeatures(["scene_writer_v1"])); windowState.canvasWindow = true;
  act(() => root!.unmount()); root = undefined;
  await render(<CanvasRestoreNotice />);
  expect(notice()).toBeNull();
});

it("notice does not read the archive on scene saves; a first-transition archive re-reads and shows it", async () => {
  await render(<CanvasRestoreNotice />);
  expect(notice()).toBeNull();
  const read = vi.spyOn(sceneNotebook, "readRestoreArchives");
  for (let i = 0; i < 5; i++) { applySceneOp((all) => { all[bucket] = [scene("a", `edit-${i}`), scene("b")]; return { write: true, value: null }; }); await settleSceneStoreForTest(); }
  await flush();
  expect(read).not.toHaveBeenCalled();
  // 첫 전환(새 복원 세대) — 로컬 변경이 보관되고 알림이 뜬다
  await writeNotebookProgress("local", "write", null, { id: "old-write", restoreGeneration: "old", requests: [{ restore_generation: "old" }] });
  expect((await syncSceneNotebook()).status).toBe("ready");
  await flush();
  expect(read).toHaveBeenCalled();
  // 이 브라우저는 옛 세대에 합류했던 것이라 묶음에 fromGeneration 이 있다 — '허브 기록이 바뀌어' 문구
  expect(notice()?.textContent).toContain("저장된 캔버스가 백업에서 되돌려져 이 브라우저에만 있던 씬");
});

it("notice → picker → restore puts the scene on the canvas, hides the notice and reports local vs hub; account change closes the picker", async () => {
  await putArchives([archive("r1", { [bucket]: [scene("x", "보관 씬")] })]);
  await render(<CanvasRestoreNotice />);
  await act(async () => { (host.querySelector('[data-restore-action="open"]') as HTMLButtonElement).click(); });
  expect(document.querySelector(".canvas-restore-picker")?.textContent).toContain("보관 씬");
  await act(async () => { (document.querySelector('[data-restore-action="restore"]') as HTMLButtonElement).click(); });
  await flush();
  expect(readWorkingBucket(bucket).some((s) => s.id === "x")).toBe(true);
  expect(flash).toHaveBeenCalledWith("캔버스에 1개를 되살렸습니다.");
  expect(notice()).toBeNull();
  expect(document.querySelector(".canvas-restore-picker")).toBeNull();
  // 계정이 바뀌면 열린 창을 닫는다
  await putArchives([archive("r1", { [bucket]: [scene("x", "보관 씬")] }), archive("r2", { [bucket]: [scene("y")] }, "2026-11-16T00:00:00.000Z")]);
  window.dispatchEvent(new Event("focus")); await flush();
  await act(async () => { (host.querySelector('[data-restore-action="open"]') as HTMLButtonElement).click(); });
  expect(document.querySelector(".canvas-restore-picker")).not.toBeNull();
  vi.spyOn(accountScope, "getAccountNamespace").mockReturnValue("other");
  await render(<CanvasRestoreNotice />);
  expect(document.querySelector(".canvas-restore-picker")).toBeNull();
});

it("settings re-entry opens the picker with every archive and blocks restore while another window holds the canvas; seen updates the notice in the same window", async () => {
  await putArchives([archive("old", { [bucket]: [scene("o1")] }, "2026-11-14T10:00:00.000Z"), archive("new", { [bucket]: [scene("n1")] }, "2026-11-15T10:00:00.000Z")]);
  vi.spyOn(sceneStore, "sceneStoreReady").mockReturnValue(true);
  await render(<><CanvasRestoreNotice /><CanvasArchiveSection /></>);
  await flush(8);
  const pick = [...host.querySelectorAll("button")].find((b) => b.textContent === "보관한 씬 고르기") as HTMLButtonElement;
  expect(pick).toBeTruthy();
  // 설정 시안 v3 — 되살리기 단추는 복원 보류 상자의 [자세히] 안에 있다: 누르기 전엔 숨고, 누르면 보인다(실제 동선)
  expect(pick.closest("[hidden]")).not.toBeNull();
  const more = [...host.querySelectorAll("button")].find((b) => b.textContent === "자세히") as HTMLButtonElement;
  await act(async () => { more.click(); });
  expect([pick.closest("[hidden]"), more.textContent, more.getAttribute("aria-expanded")]).toEqual([null, "접기", "true"]);
  await act(async () => { pick.click(); });
  expect(document.querySelector(".canvas-restore-picker")?.textContent).toContain("o1");
  expect(document.querySelector(".canvas-restore-picker")?.textContent).toContain("n1");
  await act(async () => { (document.querySelector(".canvas-restore-picker .settings-action.ghost:last-child") as HTMLButtonElement).click(); });
  act(() => markSeen("local", ["new"], ["old", "new"])); await flush();
  expect(notice()?.textContent).toContain("씬 1개"); // 같은 창의 알림이 바로 다음 묶음으로
  windowState.floating = true;
  act(() => root!.unmount()); root = undefined;
  await render(<CanvasArchiveSection />); await flush(8);
  const blocked = [...host.querySelectorAll("button")].find((b) => b.textContent === "보관한 씬 고르기") as HTMLButtonElement | undefined;
  expect(blocked?.disabled).toBe(true);
});
