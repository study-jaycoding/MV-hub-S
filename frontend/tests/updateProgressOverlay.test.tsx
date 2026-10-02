// 업데이트 진행 덮개 — 시작 신호·단계 표시·완료·실패(2026-09-28).
// 가짜는 바깥 경계(jsonFetch)에만 둔다 — 그래야 releaseUpdate 모듈의 실제 계약이 함께 검증된다.
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateProgressOverlay } from "../src/components/UpdateProgressOverlay";
import {
  UPDATE_WAIT_VERSION_KEY,
  startReleaseUpdate,
  updateStageIndex,
  type ReleaseUpdateState,
  type ReleaseUpdateStatus,
} from "../src/lib/releaseUpdate";

const mocks = vi.hoisted(() => ({ jsonFetch: vi.fn() }));
vi.mock("../src/lib/http", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  jsonFetch: (...args: unknown[]) => mocks.jsonFetch(...args),
}));

const status = (over: Partial<ReleaseUpdateStatus> = {}): ReleaseUpdateStatus => ({
  state: "downloading",
  message: "",
  install_mode: "release",
  current_version: "2026.09.28-1303",
  latest_version: "2026.09.28-1438",
  can_update: true,
  generation_active: 0,
  comfy_active: 0,
  resolve_active: 0,
  active_total: 0,
  updated_at: "",
  ...over,
});

let host: HTMLDivElement;
let root: Root;

const mount = () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<UpdateProgressOverlay />));
};

/** 폴링은 promise 체인이라 act 한 번으로는 화면에 닿지 않는다 — microtask 를 몇 번 흘린다. */
const settle = async (times = 5) => {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

const veil = () => document.querySelector(".upd-veil");
const text = () => veil()?.textContent ?? "";

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.jsonFetch.mockReset();
  window.sessionStorage.clear();
});

afterEach(() => {
  act(() => root?.unmount()); // 모듈 전역 구독을 반드시 푼다 — 안 풀면 다음 시험이 같이 뜬다
  host?.remove();
  vi.useRealTimers();
});

describe("단계 계산", () => {
  it("실행기가 지나가는 순서대로 번호를 매기고, complete 는 전부 끝난 것으로 본다", () => {
    const at = (s: ReleaseUpdateState) => updateStageIndex(s);
    expect(at("starting")).toBe(0); // 실행기 준비 — 첫 단계 진행 중으로 본다
    expect(at("checking")).toBe(0);
    expect(at("downloading")).toBe(1);
    expect(at("installing")).toBe(2);
    expect(at("restarting")).toBe(3);
    expect(at("complete")).toBe(4);
  });
});

describe("덮개", () => {
  it("평소에는 뜨지 않고 상태를 묻지도 않는다", () => {
    mount();
    expect(veil()).toBeNull();
    expect(mocks.jsonFetch).not.toHaveBeenCalled();
  });

  it("업데이트를 시작하면 뜨고, 지금 단계와 퍼센트를 보여준다", async () => {
    mount();
    mocks.jsonFetch
      .mockResolvedValueOnce(status()) // start 응답
      .mockResolvedValue(status({ state: "installing", percent: 78 })); // 이후 폴링
    await act(async () => {
      await startReleaseUpdate();
    });
    await settle();

    expect(veil()).not.toBeNull();
    expect(text()).toContain("업데이트 중입니다");
    expect(text()).toContain("78%");
    expect(text()).toContain("검증 후 설치");
    // 끝난 단계는 done, 지금 단계는 now — 목록 표시가 상태를 따라간다
    expect(document.querySelectorAll(".upd-stages li.done")).toHaveLength(2);
    expect(document.querySelector(".upd-stages li.now")?.textContent).toContain("검증 후 설치");
    // 대기 표시가 남아야 업데이트가 앱을 다시 띄워도 덮개가 이어진다
    expect(window.sessionStorage.getItem(UPDATE_WAIT_VERSION_KEY)).toBe("2026.09.28-1438");
  });

  it("새 버전으로 바뀌면 대기 표시를 지운다(그 뒤 새 화면을 연다)", async () => {
    mount();
    mocks.jsonFetch
      .mockResolvedValueOnce(status())
      .mockResolvedValue(status({ state: "complete", current_version: "2026.09.28-1438", percent: 100 }));
    await act(async () => {
      await startReleaseUpdate();
    });
    await settle();

    expect(window.sessionStorage.getItem(UPDATE_WAIT_VERSION_KEY)).toBeNull();
  });

  it("실패하면 경고 문구 대신 실패를 알리고 닫기를 내준다", async () => {
    mount();
    mocks.jsonFetch
      .mockResolvedValueOnce(status())
      .mockResolvedValue(status({ state: "failed", message: "download failed" }));
    await act(async () => {
      await startReleaseUpdate();
    });
    await settle();

    expect(text()).toContain("업데이트하지 못했습니다");
    expect(text()).toContain("download failed");
    expect(text()).not.toContain("프로그램을 끄거나"); // 끝난 일에 대고 겁주지 않는다
    const close = document.querySelector(".upd-close") as HTMLButtonElement | null;
    expect(close).not.toBeNull();
    act(() => close!.click());
    expect(veil()).toBeNull();
  });

  it("실패 화면의 강제 업데이트를 누르면 force 로 다시 시작하고 덮개가 진행으로 돌아온다", async () => {
    mount();
    mocks.jsonFetch
      .mockResolvedValueOnce(status())
      .mockResolvedValue(status({ state: "failed", message: "download failed" }));
    await act(async () => {
      await startReleaseUpdate();
    });
    await settle();
    expect(text()).toContain("업데이트하지 못했습니다");

    mocks.jsonFetch.mockReset();
    mocks.jsonFetch
      .mockResolvedValueOnce(status({ state: "starting" })) // 강제 시작 응답
      .mockResolvedValue(status({ state: "downloading", percent: 12 }));
    const forceBtn = document.querySelector(".upd-force") as HTMLButtonElement | null;
    expect(forceBtn).not.toBeNull();
    // 첫 누름은 묻기만 한다 — 강제는 진행 중인 작업을 확인하지 않고 앱을 종료한다.
    act(() => forceBtn!.click());
    expect(text()).toContain("처음부터 다시 설치");
    expect(mocks.jsonFetch).not.toHaveBeenCalled();
    await act(async () => {
      (document.querySelector(".upd-force") as HTMLButtonElement).click();
    });
    await settle();

    const startCall = mocks.jsonFetch.mock.calls.find(
      (c) => String(c[0]).includes("/release-update/start"),
    );
    expect(String((startCall?.[1] as { body?: unknown })?.body)).toContain('"force":true');
    expect(text()).toContain("업데이트 중입니다"); // 실패 화면이 걷히고 다시 진행으로
    expect(text()).toContain("12%");
  });

  it("강제 업데이트를 서버가 거절하면 그 이유를 그대로 보여준다", async () => {
    mount();
    mocks.jsonFetch
      .mockResolvedValueOnce(status())
      .mockResolvedValue(status({ state: "failed", message: "download failed" }));
    await act(async () => {
      await startReleaseUpdate();
    });
    await settle();

    mocks.jsonFetch.mockReset();
    mocks.jsonFetch.mockRejectedValue(new Error("업데이트를 방금 시작했습니다. 잠시 기다린 뒤 다시 시도하세요"));
    act(() => (document.querySelector(".upd-force") as HTMLButtonElement).click()); // 확인 열기
    await act(async () => {
      (document.querySelector(".upd-force") as HTMLButtonElement).click();
    });
    await settle();

    expect(text()).toContain("방금 시작했습니다");
    expect(document.querySelector(".upd-force")).not.toBeNull(); // 다시 누를 수 있어야 한다
  });

  it("대기 표시가 남았는데 업데이트가 아니면 덮개를 걷는다(앱이 강제 종료된 뒤)", async () => {
    // 이걸 안 하면 이미 끝난 업데이트 때문에 5분 동안 화면이 막힌다.
    vi.useFakeTimers(); // 폴링이 1.5초 간격이라 두 번째 응답까지 시계를 돌려야 한다
    window.sessionStorage.setItem(UPDATE_WAIT_VERSION_KEY, "2026.09.28-1438");
    mocks.jsonFetch.mockResolvedValue(status({ state: "available", can_update: true }));
    mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(veil()).toBeNull();
    expect(window.sessionStorage.getItem(UPDATE_WAIT_VERSION_KEY)).toBeNull();
  });

  it("상태 요청이 끝나지 않아도 5분이 지나면 멈추고 닫기를 내준다 — 늦은 응답은 버리고 타이머도 남기지 않는다(2026-10-03 점검 CXF-6)", async () => {
    vi.useFakeTimers();
    window.sessionStorage.setItem(UPDATE_WAIT_VERSION_KEY, "2026.09.28-1438");
    let answer: (value: ReleaseUpdateStatus) => void = () => {};
    mocks.jsonFetch.mockReturnValue(new Promise<ReleaseUpdateStatus>((resolve) => { answer = resolve; }));
    mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
    });

    expect(document.querySelector(".upd-close")).not.toBeNull();
    expect(text()).toContain("자동 확인 시간이 초과");
    expect(window.sessionStorage.getItem(UPDATE_WAIT_VERSION_KEY)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      answer(status({ state: "downloading", percent: 40 }));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(text()).not.toContain("40%"); // 늦게 온 응답이 화면을 되돌리지 않는다
    expect(document.querySelector(".upd-close")).not.toBeNull();
  });

  it("업데이트가 앱을 다시 띄워도 대기 표시가 있으면 이어서 뜬다", async () => {
    window.sessionStorage.setItem(UPDATE_WAIT_VERSION_KEY, "2026.09.28-1438");
    mocks.jsonFetch.mockResolvedValue(status({ state: "restarting", percent: 95 }));
    mount();
    await settle();

    expect(veil()).not.toBeNull();
    expect(text()).toContain("95%");
  });
});
