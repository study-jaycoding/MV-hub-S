// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 과거 생성물 임포트의 **진행률 폴**이 App 렌더에 끊기지 않는다.
//
// ★왜(2026-09-12, C-17): 그 효과의 의존성이 `[historyImport?.state, onImported]` 였는데
//  `onImported` 는 `App.tsx:1644` 가 넘기는 **인라인 화살표**라 App 이 렌더될 때마다 새 함수다.
//  그때마다 폴 사슬이 끊기고 **600ms 뒤부터 다시 시작**한다. 임포트는 생성물을 넣어
//  라이브러리 갱신을 일으키므로 그 렌더가 잦은 구간이다 — 600ms 보다 자주 렌더되면
//  상태 조회가 **한 번도 못 나가** 진행률이 멈춘다.

const historyImportStatus = vi.fn();

vi.mock("../src/api", () => {
  const stub = vi.fn().mockResolvedValue(null);
  return {
    api: new Proxy(
      { historyImportStatus: (...a: unknown[]) => historyImportStatus(...a) },
      { get: (target, key) => (key in target ? (target as never)[key] : stub) },
    ),
  };
});

const { SettingsPanel } = await import("../src/components/SettingsPanel");

let container: HTMLDivElement;
let root: Root;

function render(onImported: (msg: string) => void) {
  act(() => {
    root.render(<SettingsPanel onClose={() => {}} onImported={onImported} />);
  });
}

function running(processed = 0) {
  return { state: "running", processed, inserted: 0, updated: 0, unchanged: 0 };
}

beforeEach(() => {
  historyImportStatus.mockReset();
  historyImportStatus.mockResolvedValue(running());
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

/** 대기 중인 타이머와 그 사이 뜨는 약속을 함께 진행시킨다. */
async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("임포트 진행률 폴", () => {
  it("임포트가 돌고 있으면 상태를 되풀이해 묻는다", async () => {
    render(() => {});
    await tick(0); // 최초 조회(state=running)를 받는다
    historyImportStatus.mockClear();
    await tick(3_000); // 600ms + 1초 간격
    expect(historyImportStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("★부모가 500ms마다 새 콜백으로 다시 그려도 폴이 계속 나간다", async () => {
    // 종전 코드는 여기서 사슬이 매번 끊겨 **한 번도** 조회하지 못했다(600ms 를 못 넘김).
    render(() => {});
    await tick(0);
    historyImportStatus.mockClear();

    for (let i = 0; i < 8; i++) {
      await tick(500);
      render(() => {}); // App 렌더마다 바뀌는 인라인 화살표와 같은 상황
    }
    expect(historyImportStatus.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("임포트가 끝나면 폴을 멈추고 한 번만 알린다", async () => {
    const told: string[] = [];
    historyImportStatus.mockResolvedValue({
      state: "complete", processed: 3, inserted: 1, updated: 1, unchanged: 1,
    });
    render((msg) => told.push(msg));
    await tick(0);
    historyImportStatus.mockClear();
    await tick(10_000);
    expect(historyImportStatus).not.toHaveBeenCalled();  // 멈췄다
    expect(told).toHaveLength(0); // complete 로 시작했으면 폴이 아예 안 돈다
  });

  it("★완료 알림은 **최신** 콜백으로 간다 — ref 로 바꾸면서 놓치기 쉬운 곳", async () => {
    const first: string[] = [];
    const second: string[] = [];
    render((msg) => first.push(msg));
    await tick(0);                       // running
    render((msg) => second.push(msg));   // 부모가 새 콜백으로 다시 그린다
    historyImportStatus.mockResolvedValue({
      state: "complete", processed: 3, inserted: 2, updated: 0, unchanged: 1,
    });
    await tick(2_000);
    expect(first).toHaveLength(0);
    expect(second.length).toBe(1);
    expect(second[0]).toContain("신규 2");
  });
});
