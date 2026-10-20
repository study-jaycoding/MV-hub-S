// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTimelineSession } from "../src/features/timeline/session";
import { canvasTarget, createCanvasDocumentPort } from "../src/features/canvas/api";
import { clipKey } from "../src/lib/editTimeline";
import type { Scene } from "../src/lib/scenes";
import { setAccountScope } from "../src/lib/accountScope";

const io = vi.hoisted(() => ({ working: [] as Scene[], stored: [] as Scene[], confirmed: Promise.resolve(true) }));
vi.mock("../src/lib/scenes", async original => ({
  ...await original<typeof import("../src/lib/scenes")>(),
  listScenes: () => io.working, listPersistedScenes: () => io.stored,
  confirmSceneWrite: <T,>(run: () => T) => ({ value: run(), confirmed: io.confirmed }),
}));

let root: Root, host: HTMLDivElement;
let session: ReturnType<typeof useTimelineSession>;
let serial = 0;
const key = (name: string) => `mvhub.editDoc:session-test:${serial}:${name}`;
function Timeline({ name }: { name: string }) { session = useTimelineSession(key(name), vi.fn()); return null; }
const show = (name: string) => act(() => root.render(<Timeline name={name} />));
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); serial++;
  localStorage.clear(); sessionStorage.clear(); setAccountScope("account-a");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  io.working = [{ id: "scene", name: "Scene", created_at: 1, cards: [{ id: "card", kind: "generation", x: 0, y: 0, prompt: "old" }], edges: [] }];
  io.stored = io.working; io.confirmed = Promise.resolve(true);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("T08: A→B→A 뒤 옛 세션 명령과 Undo는 새 문서에 적용하지 않는다", () => {
  show("a"); const old = session;
  show("b"); show("a");
  act(() => { expect(old.commit({ type: "toggleMute", args: [] })).toBe("none"); old.undo(); });
  expect(!!session.doc.muted).toBe(false);
  expect(localStorage.getItem(key("a"))).toBeNull();
  act(() => { session.commit({ type: "toggleMute", args: [] }); });
  expect(session.doc.muted).toBe(true);
});

it("T08: 렌더 전 계정 전환도 캡처한 문서 명령을 거절한다", () => {
  show("a"); const old = session;
  setAccountScope("account-b");
  act(() => { expect(old.commit({ type: "toggleMute", args: [] })).toBe("none"); });
  expect(localStorage.getItem(key("a"))).toBeNull();
});

it("dispose 후 늦은 타임라인 명령은 저장하지 않는다", () => {
  show("a"); const old = session;
  act(() => root.unmount());
  expect(old.commit({ type: "toggleMute", args: [] })).toBe("none");
  expect(localStorage.getItem(key("a"))).toBeNull();
});

it("종료 전에 모은 길이만 확정하고 종료 뒤 도착한 길이는 버린다", () => {
  show("a");
  act(() => { session.commit({ type: "placeClip", args: [{ cut: "c", gen: "g", kind: "video", dur: 5 }, 1] }); });
  const clip = session.doc.clips[0], batch = session.collectDurations();
  batch.add(clipKey(clip), 8, true);
  expect(JSON.parse(localStorage.getItem(key("a"))!).clips[0].dur).toBe(5);
  act(() => root.unmount());
  expect(JSON.parse(localStorage.getItem(key("a"))!).clips[0].dur).toBe(8);
  batch.add(clipKey(clip), 12, true); batch.dispose();
  expect(JSON.parse(localStorage.getItem(key("a"))!).clips[0].dur).toBe(8);
});

it("다른 문서로 전환한 뒤 옛 길이 batch 정리는 새 문서를 쓰지 않는다", () => {
  show("a");
  act(() => { session.commit({ type: "placeClip", args: [{ cut: "c", gen: "g", kind: "video", dur: 5 }, 1] }); });
  const batch = session.collectDurations(); batch.add(clipKey(session.doc.clips[0]), 8, true);
  show("b"); batch.dispose();
  expect(JSON.parse(localStorage.getItem(key("a"))!).clips[0].dur).toBe(5);
  expect(localStorage.getItem(key("b"))).toBeNull();
});

it("T09: 길이 정산은 사용자 Undo를 소비하지 않고 확정 길이는 Undo 뒤 유지한다", () => {
  show("a");
  act(() => { session.commit({ type: "placeClip", args: [{ cut: "e070/c1", gen: "g", kind: "video", dur: 5 }, 1] }); });
  const clip = session.doc.clips[0];
  act(() => { session.commit({ type: "toggleMute", args: [] }); });
  act(() => { session.commit({ type: "recordDurations", args: [new Map([[clipKey(clip), 8]]), new Set([clipKey(clip)])] }); });
  act(() => { session.undo(); });
  expect(!!session.doc.muted).toBe(false); expect(session.doc.clips[0].dur).toBe(8);
  act(() => { session.redo(); }); expect(session.doc.muted).toBe(true);
});

it("T10: 큐 접수와 확정 Promise를 나누고 flush 후 최신 입력 위에 표식을 병합한다", async () => {
  let confirm!: (ok: boolean) => void;
  io.confirmed = new Promise(done => { confirm = done; });
  const write = vi.fn((_id, patch) => { io.working = io.working.map(scene => ({ ...scene, ...patch })); return true; });
  const port = createCanvasDocumentPort({ flushPending: () => {
    io.working = io.working.map(scene => ({ ...scene, cards: scene.cards.map(card => ({ ...card, prompt: "latest typed" })) }));
  }, write });
  const target = canvasTarget("scene");
  const receipt = port.commit(target, { type: "reserveGeneration", createdAt: 1,
    links: [{ scene_id: "scene", card_id: "card", attempt_id: "attempt", generation_id: "g" }] });
  expect(receipt.queued).toBe(true); expect(io.stored[0].cards[0].genId).toBeUndefined();
  let settled = false; void receipt.confirmed.then(() => { settled = true; }); await Promise.resolve(); expect(settled).toBe(false);
  expect(io.working[0].cards[0]).toMatchObject({ prompt: "latest typed", genId: "g" });
  io.stored = io.working; confirm(true); expect(await receipt.confirmed).toBe(true);
});

it("T10: 같은 계정의 비활성 씬을 정산하고 다른 계정·삭제 문서는 쓰지 않는다", () => {
  const write = vi.fn((_id, patch) => { io.working = io.working.map(scene => ({ ...scene, ...patch })); return true; });
  const port = createCanvasDocumentPort({ flushPending: vi.fn(), write });
  const target = canvasTarget("scene");
  expect(port.commit(target, { type: "settleGeneration", cardId: "card", generationId: "g" }).queued).toBe(true);
  expect(io.working[0].cards[0].genIds).toEqual(["g"]);
  write.mockClear(); setAccountScope("account-b");
  expect(port.commit(target, { type: "settleGeneration", cardId: "card", generationId: "other" }).queued).toBe(false);
  expect(write).not.toHaveBeenCalled();
  setAccountScope("account-a"); io.working = [];
  expect(port.commit(target, { type: "settleGeneration", cardId: "card", generationId: "other" }).queued).toBe(false);
  expect(write).not.toHaveBeenCalled();
});

it("이미 접수됐으나 저장되지 않은 원문을 flush 확정 성공으로 보고하지 않는다", async () => {
  io.working = io.working.map(scene => ({ ...scene, name: "not persisted" }));
  const port = createCanvasDocumentPort({ flushPending: vi.fn() });
  const receipt = port.flush(canvasTarget("scene"));
  expect(receipt.queued).toBe(true); expect(await receipt.confirmed).toBe(false);
});
