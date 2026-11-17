// 업데이트 진행 덮개 — 시작 신호·단계 표시·완료·실패(2026-09-28).
// 가짜는 바깥 경계(jsonFetch)에만 둔다 — 그래야 releaseUpdate 모듈의 실제 계약이 함께 검증된다.
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateProgressOverlay } from "../src/components/UpdateProgressOverlay";
import {
  UPDATE_MAX_MS,
  UPDATE_SILENT_MS,
  UPDATE_STALL_MS,
  UPDATE_WAIT_VERSION_KEY,
  createUpdateWaitClock,
  startReleaseUpdate,
  updateStageIndex,
  type ReleaseUpdateState,
  type ReleaseUpdateStatus,
} from "../src/lib/releaseUpdate";
import { holdUnload } from "../src/lib/unloadGuard";

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

// 덮개·설정 창이 같이 쓰는 시계(2026-11-18, Codex 리뷰 1차 높음·중간의 경계)
describe("자동 확인 시계", () => {
  const same = status({ state: "installing", percent: 70 });

  it("상태가 그대로인 채 정체 기준 직전에 보낸 요청이 답이 없으면 정체가 아니라 응답 없음으로 잰다", () => {
    const clock = createUpdateWaitClock(0);
    clock.asked(0);
    clock.answered(same, 100);
    clock.asked(UPDATE_STALL_MS - 1500); // 이 요청부터 앱이 꺼졌다(교체 시작)
    expect(clock.expired(UPDATE_STALL_MS)).toBe(false);
    expect(clock.expired(UPDATE_STALL_MS - 1500 + UPDATE_SILENT_MS - 1)).toBe(false);
    expect(clock.expired(UPDATE_STALL_MS - 1500 + UPDATE_SILENT_MS)).toBe(true);
  });

  it("앱이 꺼졌다 같은 상태로 다시 답해도 복귀로 보고 정체 시계를 새로 잰다", () => {
    const clock = createUpdateWaitClock(0);
    clock.asked(0);
    clock.answered(same, 100);
    clock.asked(60_000);
    clock.failed(61_000);
    clock.asked(6 * 60_000);
    clock.answered(same, 6 * 60_000 + 100); // 꺼지기 전과 같은 상태
    expect(clock.expired(6 * 60_000 + 200)).toBe(false);
    expect(clock.expired(6 * 60_000 + 100 + UPDATE_STALL_MS)).toBe(true);
  });

  it("실패가 이어지면 처음 실패한 요청을 보낸 때부터 재고, 90초 안내용 시각도 준다", () => {
    const clock = createUpdateWaitClock(0);
    clock.asked(1000);
    clock.failed(5000);
    clock.asked(7000);
    clock.failed(9000);
    expect(clock.failedSince()).toBe(1000);
    expect(clock.expired(1000 + UPDATE_SILENT_MS - 1)).toBe(false);
    expect(clock.expired(1000 + UPDATE_SILENT_MS)).toBe(true);
  });

  it("진행이 계속 바뀌어도 시작부터 전체 상한이 지나면 멈춘다", () => {
    const clock = createUpdateWaitClock(0);
    for (let t = 0; t < UPDATE_MAX_MS; t += 60_000) {
      clock.asked(t);
      clock.answered(status({ state: "downloading", percent: (t / 60_000) % 100 }), t + 10);
    }
    expect(clock.expired(UPDATE_MAX_MS - 1)).toBe(false);
    expect(clock.expired(UPDATE_MAX_MS)).toBe(true);
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

  // 배포 전 검토(2026-10-13, Codex): 저장하지 못한 편집이 있는데 업데이트가 끝나 자동으로 새로고침하면 메모리에만 남은 그 편집이 사라진다.
  //  새 판은 이미 깔렸다 — 알리고 사용자가 고르게 한다(지금 새로고침 / 닫고 편집으로 돌아가기).
  it("저장하지 못한 편집이 있으면 새 버전이 돼도 스스로 새로고침하지 않는다 — 알리고, 새로고침과 닫기를 내준다", async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    vi.stubGlobal("location", { href: "http://localhost:3000/", origin: "http://localhost:3000", protocol: "http:", host: "localhost:3000",
      hostname: "localhost", port: "3000", pathname: "/", search: "", hash: "", reload });
    holdUnload("edit-docs", true); // 편집 탭의 '저장 안 됨' 문서가 쥐고 있다
    window.sessionStorage.setItem(UPDATE_WAIT_VERSION_KEY, "2026.09.28-1438");
    mocks.jsonFetch.mockResolvedValue(status({ state: "complete", current_version: "2026.09.28-1438", percent: 100 }));
    mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(reload).not.toHaveBeenCalled();
    expect(text()).toContain("업데이트가 끝났습니다");
    expect(text()).toContain("저장하지 못한 변경");
    expect(window.sessionStorage.getItem(UPDATE_WAIT_VERSION_KEY)).toBeNull(); // 다시 켜도 덮개가 또 뜨지 않는다
    expect(vi.getTimerCount()).toBe(0); // 상태를 더 묻지 않고, 5분 제한도 걷혔다
    // 닫으면 편집으로 돌아간다(새로고침은 사용자가 나중에)
    act(() => (document.querySelector(".upd-close") as HTMLButtonElement).click());
    expect(veil()).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    holdUnload("edit-docs", false);
    vi.unstubAllGlobals();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  it("그 안내에서 [지금 새로고침]을 누르면 묻지 않고 새로고침한다", async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    vi.stubGlobal("location", { href: "http://localhost:3000/", origin: "http://localhost:3000", protocol: "http:", host: "localhost:3000",
      hostname: "localhost", port: "3000", pathname: "/", search: "", hash: "", reload });
    holdUnload("edit-docs", true);
    window.sessionStorage.setItem(UPDATE_WAIT_VERSION_KEY, "2026.09.28-1438");
    mocks.jsonFetch.mockResolvedValue(status({ state: "complete", current_version: "2026.09.28-1438", percent: 100 }));
    mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    act(() => (document.querySelector(".upd-force") as HTMLButtonElement).click());
    expect(reload).toHaveBeenCalledTimes(1);
    const leaving = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(false); // 문지기를 풀고 새로고침했다 — 브라우저가 다시 묻지 않는다
    vi.unstubAllGlobals();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  // Codex 재검토 3회째: 완료를 확인할 때는 저장돼 있었는데, 새로고침을 예약한 0.6초 사이에 '저장 안 됨'이 생겼다(늦게 온 길이 기록 등).
  //  예약 전에만 보면 브라우저가 묻고, '머무르기'를 고르면 덮개가 5분 제한까지 남았다 — 새로고침하는 그 순간에 다시 본다.
  it("새로고침을 예약한 사이에 저장하지 못한 편집이 생기면 새로고침하지 않고 같은 안내를 띄운다", async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    vi.stubGlobal("location", { href: "http://localhost:3000/", origin: "http://localhost:3000", protocol: "http:", host: "localhost:3000",
      hostname: "localhost", port: "3000", pathname: "/", search: "", hash: "", reload });
    window.sessionStorage.setItem(UPDATE_WAIT_VERSION_KEY, "2026.09.28-1438");
    mocks.jsonFetch.mockResolvedValue(status({ state: "complete", current_version: "2026.09.28-1438", percent: 100 }));
    mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300); // 완료를 확인하고 새로고침을 예약했다(아직 0.6초 전)
    });
    expect(reload).not.toHaveBeenCalled();
    expect(text()).toContain("업데이트 중입니다");
    holdUnload("edit-docs", true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(reload).not.toHaveBeenCalled();
    expect(text()).toContain("업데이트가 끝났습니다");
    expect(vi.getTimerCount()).toBe(0);
    holdUnload("edit-docs", false);
    vi.unstubAllGlobals();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  it("저장하지 못한 편집이 없으면 예약한 대로 새로고침한다", async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    vi.stubGlobal("location", { href: "http://localhost:3000/", origin: "http://localhost:3000", protocol: "http:", host: "localhost:3000",
      hostname: "localhost", port: "3000", pathname: "/", search: "", hash: "", reload });
    window.sessionStorage.setItem(UPDATE_WAIT_VERSION_KEY, "2026.09.28-1438");
    mocks.jsonFetch.mockResolvedValue(status({ state: "complete", current_version: "2026.09.28-1438", percent: 100 }));
    mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(reload).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
    expect(text()).toContain("현재 공개된 판을 설치합니다"); // 먼저 깐 후보보다 옛 판으로 돌아갈 수 있음(2026-10-03)
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

  it("상태 요청이 끝나지 않아도 응답 없음 15분이 지나면 멈추고 닫기를 내준다 — 늦은 응답은 버리고 타이머도 남기지 않는다(2026-10-03 점검 CXF-6)", async () => {
    vi.useFakeTimers();
    window.sessionStorage.setItem(UPDATE_WAIT_VERSION_KEY, "2026.09.28-1438");
    let answer: (value: ReleaseUpdateStatus) => void = () => {};
    mocks.jsonFetch.mockReturnValue(new Promise<ReleaseUpdateStatus>((resolve) => { answer = resolve; }));
    mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14 * 60 * 1000);
    });
    expect(text()).not.toContain("자동 확인 시간이 초과"); // 교체 중 앱이 꺼진 구간일 수 있다 — 15분까지는 기다린다
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
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

  // 2026-11-18 Jay PC 0632→0602: 설치는 07:49:09 에 끝났는데(update.log·update-journal committed) 덮개가 시작부터 고정 5분에
  //  '자동 확인 시간이 초과'와 [강제 업데이트]를 띄웠다. 파일 교체·확인 동안 앱이 약 4분 꺼져 진행을 읽을 수 없다.
  it("앱이 꺼진 교체 구간이 6분 걸려도 끊지 않고, 새 판으로 다시 뜨면 완료로 본다", async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    vi.stubGlobal("location", { href: "http://localhost:3000/", origin: "http://localhost:3000", protocol: "http:", host: "localhost:3000",
      hostname: "localhost", port: "3000", pathname: "/", search: "", hash: "", reload });
    window.sessionStorage.setItem(UPDATE_WAIT_VERSION_KEY, "2026.09.28-1438");
    let phase: "installing" | "down" | "up" = "installing";
    mocks.jsonFetch.mockImplementation(() => (phase === "installing"
      ? Promise.resolve(status({ state: "installing", percent: 70 }))
      : phase === "down"
        ? Promise.reject(new Error("앱이 꺼져 있음"))
        : Promise.resolve(status({ state: "complete", current_version: "2026.09.28-1438", percent: 100 }))));
    mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 1000); // 70% 에서 1분
    });
    phase = "down";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6 * 60 * 1000); // 시작부터 7분 — 옛 고정 5분이면 여기서 끊었다
    });
    expect(text()).not.toContain("자동 확인 시간이 초과");
    phase = "up";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(window.sessionStorage.getItem(UPDATE_WAIT_VERSION_KEY)).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(text()).not.toContain("자동 확인 시간이 초과");
    vi.unstubAllGlobals();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  it("전체 상한 직전에 완료되고 새로고침 예약 사이에 저장 안 됨이 생겨도 시간 초과로 덮지 않고 완료 안내를 띄운다", async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    vi.stubGlobal("location", { href: "http://localhost:3000/", origin: "http://localhost:3000", protocol: "http:", host: "localhost:3000",
      hostname: "localhost", port: "3000", pathname: "/", search: "", hash: "", reload });
    window.sessionStorage.setItem(UPDATE_WAIT_VERSION_KEY, "2026.09.28-1438");
    // 폴링 시각 = 1200 + k·1500 → 완료 응답이 정확히 상한 0.3초 전(MAX−300)에 오고, 새로고침 예약(0.6초)은 상한 뒤(MAX+300)다.
    //  감시는 1초마다라 상한(MAX)에 닿는다 — 옛 코드는 여기서 성공을 시간 초과로 덮고 완료 안내까지 건너뛰었다.
    const t0 = Date.now();
    const doneAt = t0 + UPDATE_MAX_MS - 1000;
    let n = 0;
    mocks.jsonFetch.mockImplementation(() => {
      n += 1;
      if (n === 1) return new Promise((resolve) => window.setTimeout(() => resolve(status({ state: "downloading", percent: 1 })), 1200));
      return Promise.resolve(Date.now() < doneAt
        ? status({ state: "downloading", percent: n % 100 })
        : status({ state: "complete", current_version: "2026.09.28-1438", percent: 100 }));
    });
    mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_MAX_MS - 250); // 완료 응답(MAX−300)을 받은 직후, 예약(MAX+300) 전
    });
    holdUnload("edit-docs", true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(reload).not.toHaveBeenCalled();
    expect(text()).toContain("업데이트가 끝났습니다");
    expect(text()).not.toContain("자동 확인 시간이 초과");
    expect(vi.getTimerCount()).toBe(0);
    holdUnload("edit-docs", false);
    vi.unstubAllGlobals();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  it("진행이 계속 바뀌면 12분이 지나도 끊지 않는다(느린 내려받기)", async () => {
    vi.useFakeTimers();
    window.sessionStorage.setItem(UPDATE_WAIT_VERSION_KEY, "2026.09.28-1438");
    let n = 0;
    mocks.jsonFetch.mockImplementation(() => Promise.resolve(status({ state: "downloading", percent: (n += 1) % 100 })));
    mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12 * 60 * 1000);
    });
    expect(text()).not.toContain("자동 확인 시간이 초과");
    expect(document.querySelector(".upd-close")).toBeNull();
  });

  it("앱이 답하는데 상태가 10분 그대로면 시간 초과로 멈추고 새로 고침 확인을 안내한다", async () => {
    vi.useFakeTimers();
    window.sessionStorage.setItem(UPDATE_WAIT_VERSION_KEY, "2026.09.28-1438");
    mocks.jsonFetch.mockResolvedValue(status({ state: "installing", percent: 70 }));
    mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9.5 * 60 * 1000);
    });
    expect(text()).not.toContain("자동 확인 시간이 초과");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 1000);
    });
    expect(text()).toContain("자동 확인 시간이 초과");
    expect(text()).toContain("새로 고침해 판을 먼저 확인");
    expect(document.querySelector(".upd-close")).not.toBeNull();
    expect(window.sessionStorage.getItem(UPDATE_WAIT_VERSION_KEY)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
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
