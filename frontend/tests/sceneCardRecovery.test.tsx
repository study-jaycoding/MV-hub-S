// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSceneCardRecovery } from "../src/lib/useSceneCardRecovery";
import type { CardHistoryCursor } from "../src/lib/canvasDetached";
import type { Generation } from "../src/types";
import type { SceneCard } from "../src/lib/scenes";

let host: HTMLDivElement;
let root: Root;
let recovery: ReturnType<typeof useSceneCardRecovery>;
const history = vi.fn();
const claim = vi.fn(async () => {});
const load = vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, { id } as Generation])));
const options = { sceneId: "s", cardsRef: { current: [] as SceneCard[] }, genDataRef: { current: {} }, setGenData: vi.fn(), commitDocument: vi.fn(() => true),
  isDocumentCurrent: () => true,
  flushPendingRef: { current: vi.fn() }, onCanvasCardHistory: history, onLoadGenerations: load,
  onCanvasRecoveryClaim: claim,
  readLocalScenes: vi.fn(() => [] as never[] | null), onCanvasRecoveryCandidates: vi.fn(async () => [] as Generation[]) };
function Harness() { recovery = useSceneCardRecovery(options); return null; }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  history.mockReset(); load.mockClear(); claim.mockClear(); options.setGenData.mockClear(); options.commitDocument.mockClear();
  options.flushPendingRef.current.mockClear();
  options.sceneId = "s"; options.isDocumentCurrent = () => true;
  options.cardsRef.current = [{ id: "c", kind: "generation", x: 0, y: 0 }];
  options.readLocalScenes.mockReturnValue([]); options.onCanvasRecoveryCandidates.mockResolvedValue([]);
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  act(() => root.render(<Harness />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const link = (id: string) => ({ generation_id: id, scene_id: "s", card_id: "c" });

it("5쪽 상한의 커서를 남기고 다음 조회는 같은 범위를 이어 읽은 뒤 다른 씬으로 확장한다", async () => {
  let page = 0;
  history.mockImplementation(async (_scene: string, scope: string) => {
    if (scope === "other") return { links: [link("other")], next: null };
    page += 1;
    return { links: [link(`g${page}`)], next: page <= 5 ? { ts: page, id: `g${page}`, scene: "s", card: "c" } : null };
  });
  await act(async () => { recovery.openCanvasRecovery("c"); });
  expect(history).toHaveBeenCalledTimes(5);
  expect(recovery.canvasRecovery).toMatchObject({ detachedTotal: 5, detachedNext: { scope: "scene", cursor: { id: "g5" } } });
  await act(async () => { await recovery.loadMoreDetached(); });
  const cursor: CardHistoryCursor = { ts: 5, id: "g5", scene: "s", card: "c" };
  expect(history.mock.calls[5]).toEqual(["s", "scene", cursor]);
  expect(recovery.canvasRecovery).toMatchObject({ detachedTotal: 6, detachedNext: null, otherScenes: "idle" });
  await act(async () => { await recovery.loadMoreDetached(); });
  expect(history.mock.calls[6]).toEqual(["s", "other", null]);
  expect(recovery.canvasRecovery).toMatchObject({ detachedTotal: 7, otherScenes: "done" });
  expect(options.flushPendingRef.current).toHaveBeenCalledTimes(3);
});
it("후보 목록이 늦어도 지난 카드 기록은 따로 표시하고 후보 응답 뒤 두 칸을 유지한다", async () => {
  let release!: (items: Generation[]) => void;
  options.onCanvasRecoveryCandidates.mockImplementationOnce(() => new Promise((done) => { release = done; }));
  history.mockResolvedValue({ links: [link("detached")], next: null });
  await act(async () => { recovery.openCanvasRecovery("c"); });
  expect(recovery.canvasRecovery).toMatchObject({ loadingItems: true, loadingDetached: false, detachedTotal: 1 });
  await act(async () => { release([{ id: "unclaimed" } as Generation]); });
  expect(recovery.canvasRecovery).toMatchObject({ loadingItems: false, detachedTotal: 1, items: [{ id: "unclaimed" }] });
});
it("로컬 씬을 읽지 못하면 떨어진 것으로 오인하지 않고 본문 요청도 보내지 않는다", async () => {
  options.readLocalScenes.mockReturnValue(null);
  history.mockResolvedValue({ links: [link("detached")], next: null });
  await act(async () => { recovery.openCanvasRecovery("c"); });
  expect(recovery.canvasRecovery).toMatchObject({ detachedStatus: "unreadable", detached: [] });
  expect(load).not.toHaveBeenCalled();
});

it.each(["unmount", "scene-return", "account", "deleted"].flatMap(change => [[change, true], [change, false]] as const))(
  "첫 복구 쪽을 기다리다 %s이면 다음 API를 시작하지 않는다(next=%s)", async (change, hasNext) => {
  let release!: (value: { links: ReturnType<typeof link>[]; next: CardHistoryCursor | null }) => void;
  let originalCurrent = true;
  options.isDocumentCurrent = () => originalCurrent;
  act(() => root.render(<Harness />));
  history.mockImplementationOnce(() => new Promise(done => { release = done; }));
  history.mockResolvedValue({ links: [], next: null });
  act(() => recovery.openCanvasRecovery("c"));
  expect(history).toHaveBeenCalledTimes(1);
  if (change === "unmount") act(() => root.unmount());
  else if (change === "deleted") options.cardsRef.current = [];
  else if (change === "scene-return") {
    options.sceneId = "other"; act(() => root.render(<Harness />));
    options.sceneId = "s"; act(() => root.render(<Harness />));
  } else {
    originalCurrent = false;
    options.isDocumentCurrent = () => true; // 새 렌더의 판정으로 옛 작업을 되살리면 안 된다.
    act(() => root.render(<Harness />));
  }
  await act(async () => { release({ links: [link("old")], next: hasNext ? { ts: 1, id: "old", scene: "s", card: "c" } : null }); });
  expect(history).toHaveBeenCalledTimes(1);
  expect(load).not.toHaveBeenCalled();
});

it("새 문서에서 옛 복구 열기·더 찾기·담기 함수를 호출해도 외부 요청을 시작하지 않는다", async () => {
  let originalCurrent = true;
  options.isDocumentCurrent = () => originalCurrent;
  act(() => root.render(<Harness />));
  history.mockResolvedValue({ links: [], next: null });
  await act(async () => { recovery.openCanvasRecovery("c"); });
  const old = recovery;
  history.mockClear(); options.onCanvasRecoveryCandidates.mockClear();
  originalCurrent = false; options.isDocumentCurrent = () => true;
  act(() => root.render(<Harness />));
  await act(async () => { old.openCanvasRecovery("c"); await old.loadMoreDetached(); await old.claimCanvasRecovery({ id: "g" } as Generation); });
  expect(history).not.toHaveBeenCalled(); expect(options.onCanvasRecoveryCandidates).not.toHaveBeenCalled();
  expect(claim).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled();
});

it("같은 문서의 담기는 유지하며 기다리는 사이 문서가 바뀌면 결과 반영은 멈춘다", async () => {
  let originalCurrent = true;
  options.isDocumentCurrent = () => originalCurrent;
  act(() => root.render(<Harness />));
  history.mockResolvedValue({ links: [], next: null });
  await act(async () => { recovery.openCanvasRecovery("c"); });
  await act(async () => { await recovery.claimCanvasRecovery({ id: "current" } as Generation); });
  expect(claim).toHaveBeenCalledTimes(1); expect(options.commitDocument).toHaveBeenCalledTimes(1);
  await act(async () => { recovery.openCanvasRecovery("c"); });
  let release!: () => void;
  claim.mockImplementationOnce(() => new Promise<void>(done => { release = done; }));
  let pending!: Promise<void>;
  act(() => { pending = recovery.claimCanvasRecovery({ id: "late" } as Generation); });
  originalCurrent = false; options.isDocumentCurrent = () => true;
  act(() => root.render(<Harness />));
  await act(async () => { release(); await pending; });
  expect(claim).toHaveBeenCalledTimes(2); expect(options.commitDocument).toHaveBeenCalledTimes(1);
  expect(options.setGenData).toHaveBeenCalledTimes(1);
});

it("창을 다시 열면 옛 순번의 다음 쪽은 보내지 않고 새 창 응답은 받는다", async () => {
  let release!: (value: { links: ReturnType<typeof link>[]; next: CardHistoryCursor }) => void;
  history.mockImplementationOnce(() => new Promise(done => { release = done; }));
  history.mockResolvedValue({ links: [link("new")], next: null });
  act(() => recovery.openCanvasRecovery("c"));
  await act(async () => { recovery.openCanvasRecovery("c"); });
  await act(async () => { release({ links: [link("old")], next: { ts: 1, id: "old", scene: "s", card: "c" } }); });
  expect(history).toHaveBeenCalledTimes(2);
  expect(load).toHaveBeenCalledTimes(1);
  expect(recovery.canvasRecovery?.detachedLinks.map(item => item.generation_id)).toEqual(["new"]);
});

it("같은 문서의 늦은 응답은 다음 쪽과 본문 조회를 정상적으로 이어 간다", async () => {
  let release!: (value: { links: ReturnType<typeof link>[]; next: CardHistoryCursor }) => void;
  history.mockImplementationOnce(() => new Promise(done => { release = done; }));
  history.mockResolvedValue({ links: [link("second")], next: null });
  act(() => recovery.openCanvasRecovery("c"));
  await act(async () => { release({ links: [link("first")], next: { ts: 1, id: "first", scene: "s", card: "c" } }); });
  expect(history).toHaveBeenCalledTimes(2);
  expect(load).toHaveBeenCalledTimes(1);
  expect(recovery.canvasRecovery?.detachedTotal).toBe(2);
});
