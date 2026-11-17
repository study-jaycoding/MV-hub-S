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
import { draftRequestKey } from "../src/lib/seedanceDraft";
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
    const attempt = requests.begin("parent", "remote-job", "1080p", scope)!;
    requests.accept(attempt, child("pending"));
  });
  expect(requests.pending.has(draftRequestKey("parent", "remote-job", "1080p"))).toBe(true);
  draw([child("failed")]);
  expect(requests.pending.has(draftRequestKey("parent", "remote-job", "1080p"))).toBe(false);
  act(() => { expect(requests.begin("parent", "remote-job", "1080p", scope)).not.toBeNull(); });
});

it("기존 완료 감시가 끝난 경우에만 자식을 조회하고 확정 실패 후 잠금을 푼다", async () => {
  mocks.getGeneration.mockResolvedValue(child("failed"));
  act(() => requests.accept(requests.begin("parent", "remote-job", "1080p", scope)!, child("running")));
  expect(mocks.getGeneration).not.toHaveBeenCalled();
  await settled();
  expect(mocks.getGeneration).toHaveBeenCalledExactlyOnceWith("child");
  expect(requests.pending.has(draftRequestKey("parent", "remote-job", "1080p"))).toBe(false);
});

it("acceptance_unknown은 자식 확인 없이 잠금을 풀거나 재제출하지 않는다", async () => {
  act(() => { requests.begin("parent", "remote-job", "1080p", scope); });
  await settled();
  expect(mocks.getGeneration).not.toHaveBeenCalled();
  expect(requests.pending.has(draftRequestKey("parent", "remote-job", "1080p"))).toBe(true);
  expect(requests.begin("parent", "remote-job", "1080p", scope)).toBeNull();
});

it("실패 상태여도 외부 제출 확인이 필요한 자식은 재제출을 막는다", () => {
  act(() => requests.accept(requests.begin("parent", "remote-job", "1080p", scope)!, child("pending")));
  draw([{ ...child("failed"), execution_phase: "recovery_required" }]);
  expect(requests.pending.has(draftRequestKey("parent", "remote-job", "1080p"))).toBe(true);
  expect(requests.begin("parent", "remote-job", "1080p", scope)).toBeNull();
});

it("계정 변경 전 조회가 늦게 와도 새 계정의 같은 원본 잠금을 풀지 않는다", async () => {
  let finish!: (generation: Generation) => void;
  mocks.getGeneration.mockReturnValue(new Promise<Generation>((resolve) => { finish = resolve; }));
  let active = true;
  act(() => requests.accept(requests.begin("parent", "remote-job", "1080p", { isCurrent: () => active })!, child("running")));
  await settled();
  active = false;
  act(() => { requests.begin("parent", "remote-job", "1080p", scope); });
  await act(async () => { finish(child("failed")); await Promise.resolve(); });
  expect(requests.pending.has(draftRequestKey("parent", "remote-job", "1080p"))).toBe(true);
  expect(requests.begin("parent", "remote-job", "1080p", scope)).toBeNull();
});

it("완료 후 다시 생성하고 이전 응답은 새 잠금을 해제하지 못한다", () => {
  let previous!: ReturnType<typeof requests.begin>;
  act(() => { previous = requests.begin("parent", "remote-job", "1080p", scope); requests.accept(previous!, child("done")); });
  act(() => { expect(requests.begin("parent", "remote-job", "1080p", scope)).not.toBeNull(); });
  act(() => { requests.accept(previous!, child("failed")); requests.release(previous!); });
  expect(requests.pending.has(draftRequestKey("parent", "remote-job", "1080p"))).toBe(true);
});

it("화질과 원격 job은 독립이며 같은 조합 연속 클릭만 막는다", () => {
  act(() => {
    expect(requests.begin("parent", "job", "1080p", scope)).not.toBeNull();
    expect(requests.begin("parent", "job", "1080p", scope)).toBeNull();
    expect(requests.begin("parent", "job", "4k", scope)).not.toBeNull();
    expect(requests.begin("parent", "new-job", "1080p", scope)).not.toBeNull();
  });
  expect(requests.pending.size).toBe(3);
});

it("접수 불명 재확인은 저장한 의도만 실행하며 겹치지 않는다", async () => {
  let finish!: () => void;
  const retry = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  act(() => {
    const attempt = requests.begin("parent", "job", "4k", scope)!;
    requests.retain(attempt, retry);
  });
  const key = draftRequestKey("parent", "job", "4k");
  expect(requests.uncertain.has(key)).toBe(true);
  expect(requests.pending.has(key)).toBe(false);
  let first!: Promise<boolean>;
  act(() => { first = requests.recheck("parent", "job", "4k"); void requests.recheck("parent", "job", "4k"); });
  expect(retry).toHaveBeenCalledTimes(1);
  expect(requests.pending.has(key)).toBe(true);
  await act(async () => { finish(); await first; });
  expect(requests.uncertain.has(key)).toBe(true);
  expect(requests.begin("parent", "job", "4k", scope)).toBeNull();
});

it("문맥이 바뀌면 옛 접수 재확인을 실행하지 않는다", async () => {
  let active = true;
  const retry = vi.fn();
  act(() => requests.retain(requests.begin("parent", "job", "4k", { isCurrent: () => active })!, retry));
  active = false;
  await act(async () => { expect(await requests.recheck("parent", "job", "4k")).toBe(false); });
  expect(retry).not.toHaveBeenCalled();
});

it("목록 누락과 조회 실패로 잠금을 풀지 않고 명시적 진행 단계를 우선한다", async () => {
  mocks.getGeneration.mockRejectedValue(new Error("offline"));
  act(() => requests.accept(requests.begin("parent", "remote-job", "1080p", scope)!, child("pending")));
  draw([]); await settled();
  draw([{ ...child("done"), execution_phase: "tracking" }]);
  expect(requests.pending.has(draftRequestKey("parent", "remote-job", "1080p"))).toBe(true);
});


it("접수는 준비 중과 pending 열쇠가 같아도 표시 갱신 세대를 올린다", () => {
  let attempt!: ReturnType<typeof requests.begin>;
  act(() => { attempt = requests.begin("parent", "job", "4k", scope); });
  const revision = requests.revision;
  act(() => requests.accept(attempt!, child("pending")));
  expect(requests.revision).toBeGreaterThan(revision);
  expect(requests.pending.has(draftRequestKey("parent", "job", "4k"))).toBe(true);
});
