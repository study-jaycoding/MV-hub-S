// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Generation } from "../src/types";

const mocks = vi.hoisted(() => ({
  getGeneration: vi.fn(), watching: new Set<string>(), listeners: new Set<() => void>(),
}));
vi.mock("../src/api", () => ({ api: { getGeneration: mocks.getGeneration } }));
vi.mock("../src/lib/sceneRecentDoneStore", () => ({
  isWatchingGeneration: (id: string) => mocks.watching.has(id),
  seedPending: (ids: string[]) => { ids.forEach((id) => mocks.watching.add(id)); },
  subscribeRecentDone: (callback: () => void) => {
    mocks.listeners.add(callback);
    return () => mocks.listeners.delete(callback);
  },
}));
import { useDraftRequests } from "../src/lib/useDraftRequests";

let root: Root;
let requests: ReturnType<typeof useDraftRequests>;
function Host({ rows }: { rows: Generation[] }) { requests = useDraftRequests(rows); return null; }
const child = (status: Generation["status"]) => ({ id: "child", status } as Generation);
const draw = (rows: Generation[] = []) => act(() => root.render(<Host rows={rows} />));
const scope = { isCurrent: () => true };
const settled = async () => {
  await act(async () => {
    mocks.watching.delete("child");
    mocks.listeners.forEach((callback) => callback());
    await Promise.resolve();
  });
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.getGeneration.mockReset(); mocks.watching.clear(); mocks.listeners.clear();
  root = createRoot(document.createElement("div")); draw();
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });

it("accepted 자식이 목록에서 실패로 확인되면 원본을 다시 제출할 수 있다", () => {
  act(() => {
    const attempt = requests.begin("parent", scope)!;
    requests.accept(attempt, child("pending"));
  });
  expect(requests.pending.has("parent")).toBe(true);
  draw([child("failed")]);
  expect(requests.pending.has("parent")).toBe(false);
  act(() => { expect(requests.begin("parent", scope)).not.toBeNull(); });
});

it("기존 완료 감시가 끝난 경우에만 자식을 조회하고 확정 실패 후 잠금을 푼다", async () => {
  mocks.getGeneration.mockResolvedValue(child("failed"));
  act(() => requests.accept(requests.begin("parent", scope)!, child("running")));
  expect(mocks.getGeneration).not.toHaveBeenCalled();
  await settled();
  expect(mocks.getGeneration).toHaveBeenCalledExactlyOnceWith("child");
  expect(requests.pending.has("parent")).toBe(false);
});

it("acceptance_unknown은 자식 확인 없이 잠금을 풀거나 재제출하지 않는다", async () => {
  act(() => { requests.begin("parent", scope); });
  await settled();
  expect(mocks.getGeneration).not.toHaveBeenCalled();
  expect(requests.pending.has("parent")).toBe(true);
  expect(requests.begin("parent", scope)).toBeNull();
});

it("실패 상태여도 외부 제출 확인이 필요한 자식은 재제출을 막는다", () => {
  act(() => requests.accept(requests.begin("parent", scope)!, child("pending")));
  draw([{ ...child("failed"), execution_phase: "recovery_required" }]);
  expect(requests.pending.has("parent")).toBe(true);
  expect(requests.begin("parent", scope)).toBeNull();
});

it("계정 변경 전 조회가 늦게 와도 새 계정의 같은 원본 잠금을 풀지 않는다", async () => {
  let finish!: (generation: Generation) => void;
  mocks.getGeneration.mockReturnValue(new Promise<Generation>((resolve) => { finish = resolve; }));
  let active = true;
  act(() => requests.accept(requests.begin("parent", { isCurrent: () => active })!, child("running")));
  await settled();
  active = false;
  act(() => { requests.begin("parent", scope); });
  await act(async () => { finish(child("failed")); await Promise.resolve(); });
  expect(requests.pending.has("parent")).toBe(true);
  expect(requests.begin("parent", scope)).toBeNull();
});

it("1080p 완료 뒤에는 같은 원본 재완성을 허용하지 않고 늦은 실패도 무시한다", () => {
  act(() => requests.accept(requests.begin("parent", scope)!, child("done")));
  draw([child("failed")]);
  expect(requests.pending.has("parent")).toBe(false);
  expect(requests.completed.has("parent")).toBe(true);
  expect(requests.begin("parent", scope)).toBeNull();
});
