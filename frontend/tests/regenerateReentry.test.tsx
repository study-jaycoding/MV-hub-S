// @vitest-environment jsdom
// 재생성 — 처리 중인 요청은 다시 받지 않는다(조작 규칙 39).
// 2026-10-12(조작 점검 12회차, Codex 전수 검토): ↻ 를 응답 전에 한 번 더 누르면(더블클릭) 누름마다 요청 키가 새로 만들어져 서버의 중복 제거로도
//  합쳐지지 않고 유료 생성이 둘 나갔다. 누르면 안 되는 단추라 격리 실측으로는 못 본다 — 응답을 시험이 쥐고 있다가 늦게 돌려준다.
//  캔버스 쪽(pending 연결을 만들기 전에 막는 App 의 가드)은 tests/seedanceSceneErrorsRender.test.tsx 가 본다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ prepareRegenerate: vi.fn(), finalize: vi.fn(), unfinalize: vi.fn() }));
vi.mock("../src/api", () => ({ api: { prepareRegenerate: mocks.prepareRegenerate, finalize: mocks.finalize, unfinalize: mocks.unfinalize } }));
vi.mock("../src/lib/modelPolicy", () => ({ modelBlockMessage: () => null }));
vi.mock("../src/lib/workspaceContext", async (orig) => ({ ...(await orig<Record<string, unknown>>()), isGenerationWorkspaceReady: () => true }));
vi.mock("../src/lib/libraryBroadcast", () => ({ postLibraryChanged: vi.fn() }));

import { useGenerationCardActions } from "../src/lib/useGenerationCardActions";
import type { Generation } from "../src/types";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.prepareRegenerate.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const generation = (id: string) => ({ id, model: "m", prompt: "p", status: "done", params: {}, assets: [] }) as unknown as Generation;
const settle = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

it("재생성 — 응답 전의 다시 누름은 요청을 더 만들지 않는다(더블클릭 = 유료 생성 둘). 응답이 오면 목록 갱신을 기다리지 않고 다시 받는다", async () => {
  const waiting: Array<{ resolve: (value: Generation) => void; reject: (reason: unknown) => void }> = [];
  mocks.prepareRegenerate.mockImplementation(() => () => new Promise<Generation>((resolve, reject) => { waiting.push({ resolve, reject }); }));
  const flash = vi.fn();
  const reload = vi.fn(() => new Promise<void>(() => {})); // 목록 갱신은 끝나지 않는다 — 잠금이 여기까지 잡혀 있으면 안 된다
  let actions!: ReturnType<typeof useGenerationCardActions>;
  function Host() {
    actions = useGenerationCardActions({ armedAutoTags: new Set(), bumpBoard: () => {}, canFinalize: () => true, flash, navTab: () => {}, reload,
      workspace: { scope: "personal", id: null, name: null } });
    return null;
  }
  act(() => root.render(<Host />));
  const g = generation("g1");
  void actions.onRegenerate(g);
  const dropLink = vi.fn();
  expect(await actions.onRegenerate(g, undefined, dropLink)).toBeNull(); // 응답 전의 둘째 누름
  expect(mocks.prepareRegenerate).toHaveBeenCalledTimes(1);
  expect(dropLink).toHaveBeenCalledTimes(1); // 캔버스가 이 누름에 만든 pending 연결은 버린다(나가지 않은 것이 확실하다)
  expect(flash).toHaveBeenLastCalledWith(expect.stringContaining("처리 중"));
  void actions.onRegenerate(generation("g2")); // 다른 생성물은 막지 않는다
  expect(mocks.prepareRegenerate).toHaveBeenCalledTimes(2);

  waiting[0].resolve(generation("n1"));
  await settle();
  expect(reload).toHaveBeenCalledTimes(1); // 등록됐고 목록 갱신 중이다
  void actions.onRegenerate(g); // '큐에 등록' 뒤에 일부러 한 번 더 — 새 요청이다
  expect(mocks.prepareRegenerate).toHaveBeenCalledTimes(3);

  waiting[2].reject(new Error("offline")); // 실패해도 풀린다
  await settle();
  void actions.onRegenerate(g);
  expect(mocks.prepareRegenerate).toHaveBeenCalledTimes(4);
});

// Codex 62회차(4B × ↻) — 다른 탭 로그아웃으로 멈춰 보내지 못한 재생성은 '나갔을 수 있는' 것이 아니다. 캔버스의 대기 표식을 남기면
//  보내지 않은 생성이 대기로 남는다. 답을 못 받은 것(TypeError)은 들어갔을 수 있으니 남긴다.
it("재생성 — 멈춤으로 못 보냈거나 서버가 거절(4xx)했으면 캔버스 대기 표식을 버리고, 답을 못 받았으면 남긴다", async () => {
  const { ApiPausedError, HttpError } = await import("../src/lib/http");
  let actions!: ReturnType<typeof useGenerationCardActions>;
  function Host() {
    actions = useGenerationCardActions({ armedAutoTags: new Set(), bumpBoard: () => {}, canFinalize: () => true, flash: () => {}, navTab: () => {},
      reload: async () => {}, workspace: { scope: "personal", id: null, name: null } });
    return null;
  }
  act(() => root.render(<Host />));
  const outcome = async (error: unknown) => {
    mocks.prepareRegenerate.mockImplementationOnce(() => () => Promise.reject(error));
    const dropLink = vi.fn();
    await actions.onRegenerate(generation("g1"), undefined, dropLink);
    return dropLink.mock.calls.length;
  };
  expect(await outcome(new ApiPausedError("paused"))).toBe(1);
  expect(await outcome(new HttpError(409, "충돌"))).toBe(1);
  expect(await outcome(new TypeError("Failed to fetch"))).toBe(0);
  expect(await outcome(new HttpError(429, "많음"))).toBe(0);
});

it("최종 지정·해제가 권한 없음(403)으로 거절되면 최종 권한을 다시 읽으라고 알린다 — 다른 실패는 알리지 않는다(49회차)", async () => {
  const { HttpError } = await import("../src/lib/http");
  const stale = vi.fn();
  window.addEventListener("ch:finalize-roles-stale", stale);
  try {
    let actions!: ReturnType<typeof useGenerationCardActions>;
    function Host() {
      actions = useGenerationCardActions({ armedAutoTags: new Set(), bumpBoard: () => {}, canFinalize: () => true, flash: () => {}, navTab: () => {},
        reload: async () => {}, workspace: { scope: "personal", id: null, name: null } });
      return null;
    }
    act(() => root.render(<Host />));
    mocks.finalize.mockRejectedValueOnce(new HttpError(500, "서버 오류"));
    await actions.onFinalize(generation("g1"));
    expect(stale).not.toHaveBeenCalled();
    mocks.finalize.mockRejectedValueOnce(new HttpError(403, "검수 권한이 없습니다"));
    await actions.onFinalize(generation("g1"));
    mocks.unfinalize.mockRejectedValueOnce(new HttpError(403, "검수 권한이 없습니다"));
    await actions.onUnfinalize(generation("g1"));
    expect(stale).toHaveBeenCalledTimes(2);
  } finally {
    window.removeEventListener("ch:finalize-roles-stale", stale);
  }
});
