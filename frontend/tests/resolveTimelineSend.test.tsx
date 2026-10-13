// @vitest-environment jsdom
// 타임라인 Resolve 보내기의 줄(lib/useResolveTransferActions) — 클립 보내기와 같은 줄에 서고, 끝나면(실패해도) 결과로 풀린다.
//  단추의 '보내는 중'(timelineBusy)은 앱이 쥔다 — 풀리지 않으면 단추가 영영 잠긴다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Generation } from "../src/types";

const api = vi.hoisted(() => ({ timeline: vi.fn() }));
vi.mock("../src/lib/resolveTransfer", async () => ({
  ...(await vi.importActual<typeof import("../src/lib/resolveTransfer")>("../src/lib/resolveTransfer")),
  createResolveTimeline: api.timeline,
}));

import { HttpError } from "../src/lib/http";
import { useResolveTransferActions } from "../src/lib/useResolveTransferActions";

const gen = (id: string, extra: Partial<Generation> = {}) => ({
  id, status: "done", project_id: "p1", folder_path: "e070/c1", deleted: false,
  assets: [{ id: `a-${id}`, generation_id: id, type: "video", file_path: `/media/${id}.mp4` }], ...extra,
} as unknown as Generation);
const target = { project_id: "rp", project_name: "편집" };
const plan = { name: "P1_e070" };

let host: HTMLDivElement;
let root: Root;
let hook: ReturnType<typeof useResolveTransferActions>;
const flashed: string[] = [];
const flash = (message: string) => { flashed.push(message); };
function Probe() {
  hook = useResolveTransferActions({ flash });
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  api.timeline.mockReset();
  flashed.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Probe />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("보내면 줄에 서고, 끝나면 결과로 풀리며 '보내는 중'이 꺼진다", async () => {
  let finish!: (value: unknown) => void;
  api.timeline.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  let answer: unknown = "대기";
  await act(async () => {
    void hook.sendTimelineToResolve(plan, [gen("a"), gen("b"), gen("a")], target).then((value) => { answer = value; });
  });
  expect(api.timeline).toHaveBeenCalledWith(["a", "b"], target, plan); // 같은 생성물은 한 번만
  expect([hook.timelineBusy, hook.busy]).toEqual([true, true]);
  expect(flashed.at(-1)).toBe("Resolve 로 타임라인 보내는 중 · 편집");
  expect(answer).toBe("대기");

  const result = { transfer: { error_count: 0 }, timeline: { status: "complete", timeline_name: "P1_e070", video: 2, markers_added: 0 } };
  await act(async () => { finish(result); });
  expect(answer).toBe(result);
  expect([hook.timelineBusy, hook.busy]).toEqual([false, false]);
  expect(flashed.at(-1)).toBe("Resolve 에 타임라인 'P1_e070' 을 만들었습니다 · 클립 2");
});

it("요청이 실패해도 풀린다(null) — 단추가 '보내는 중'에 남지 않고, 실패를 알린다", async () => {
  api.timeline.mockRejectedValue(new HttpError(409, "409: 다른 Resolve 프로젝트가 열려 있습니다", "다른 Resolve 프로젝트가 열려 있습니다"));
  let answer: unknown = "대기";
  await act(async () => {
    void hook.sendTimelineToResolve(plan, [gen("a")], target).then((value) => { answer = value; });
  });
  expect(answer).toBeNull();
  expect([hook.timelineBusy, hook.busy]).toEqual([false, false]);
  expect(flashed.at(-1)).toBe("타임라인 보내기 실패: 다른 Resolve 프로젝트가 열려 있습니다"); // 서버가 시작 전에 거절했다 — 만든 것이 없다

  // 끊김·5xx — 서버는 요청이 끊겨도 작업을 끝까지 한다. 만들어졌는지 모르는 채 '실패'라고만 하면 다시 눌러 둘이 된다(Codex 코드 리뷰)
  for (const failure of [new TypeError("Failed to fetch"), new HttpError(502, "502: Bad Gateway", "Bad Gateway")]) {
    api.timeline.mockRejectedValue(failure);
    await act(async () => { void hook.sendTimelineToResolve(plan, [gen("a")], target); });
    expect(flashed.at(-1)).toContain("만들어졌을 수 있습니다. 다시 보내기 전에 Resolve 를 확인하세요");
    expect(hook.timelineBusy).toBe(false);
  }
});

it("보낼 수 없는 것이 섞여 있으면 요청하지 않는다", async () => {
  let answer: unknown = "대기";
  await act(async () => {
    void hook.sendTimelineToResolve(plan, [gen("a"), gen("b", { status: "running" } as Partial<Generation>)], target)
      .then((value) => { answer = value; });
  });
  expect(answer).toBeNull();
  expect(api.timeline).not.toHaveBeenCalled();
  expect(hook.timelineBusy).toBe(false);
  expect(flashed).toEqual(["렌더가 완료된 결과물만 Resolve로 보낼 수 있습니다."]);
});
