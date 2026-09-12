// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 열린 알림 패널의 **상세 재조회**가 미읽음 수가 바뀌어도 계속 돈다.
//
// ★왜(2026-09-12, C-16): 그 효과의 의존성이 `[open, loadComments]` 였는데 `loadComments` 는
//  `[commentUnreadCount, t]` 에 매인다. 미읽음 수가 바뀌면 함수 식별자가 바뀌고, 효과가 다시 돌아
//  **60초 타이머가 처음부터 다시 시작**했다. 그 수를 바꾸는 배지 폴은 **10초 주기**다
//  (`useCommentBadgePoll` 기본값) — 수가 60초보다 자주 바뀌면 재갱신은 **한 번도 일어나지 않는다.**
//
// ★이 시험을 쓰려고 `jsdom` 을 devDependency 로 더했다(빌드 산출물에는 안 들어간다).
//  React 18.3 의 `act` 와 이미 있던 `react-dom/client` 로 충분해 다른 도구는 안 넣었다.

const notificationComments = vi.fn();

vi.mock("../src/api", () => ({
  api: {
    notificationComments: (...args: unknown[]) => notificationComments(...args),
    markGenCommentSeen: vi.fn().mockResolvedValue(undefined),
    markAllNotificationCommentsSeen: vi.fn().mockResolvedValue(undefined),
    generationStats: vi.fn().mockResolvedValue({ comment_unread: 0, failed: 0 }),
  },
}));
vi.mock("../src/lib/releaseUpdate", () => ({ getReleaseUpdateStatus: vi.fn(() => Promise.reject(new Error("없음"))) }));
vi.mock("../src/lib/sharedApi", () => ({ sharedApi: { sharedServerRelocation: vi.fn(() => Promise.reject(new Error("없음"))) } }));
vi.mock("../src/lib/updateNoticeApi", () => ({ updateNoticeApi: { list: vi.fn(() => Promise.reject(new Error("없음"))) } }));

const { NotificationCenter } = await import("../src/components/NotificationCenter");

let container: HTMLDivElement;
let root: Root;

function render(props: { commentUnreadCount?: number }) {
  act(() => {
    root.render(
      <NotificationCenter
        commentUnreadCount={props.commentUnreadCount}
        hasUnreadComments={false}
        onOpenComment={() => {}}
        onChanged={() => {}}
      />,
    );
  });
}

beforeEach(() => {
  notificationComments.mockReset();
  notificationComments.mockResolvedValue([]);
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function openPanel() {
  const bell = container.querySelector("button");
  if (!bell) throw new Error("종 버튼을 못 찾았다 — 컴포넌트가 안 그려졌다");
  act(() => {
    bell.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("열린 알림 패널의 상세 폴", () => {
  it("패널을 열면 상세를 한 번 받는다", () => {
    render({ commentUnreadCount: 0 });
    expect(notificationComments).not.toHaveBeenCalled(); // 닫혀 있으면 안 받는다
    openPanel();
    expect(notificationComments).toHaveBeenCalledTimes(1);
  });

  it("열어 둔 채 60초가 지나면 다시 받는다", () => {
    render({ commentUnreadCount: 0 });
    openPanel();
    notificationComments.mockClear();
    act(() => vi.advanceTimersByTime(60_000));
    expect(notificationComments).toHaveBeenCalledTimes(1);
  });

  it("★미읽음 수가 10초마다 바뀌어도 60초 재갱신이 살아 있다", () => {
    // 종전 코드는 여기서 타이머가 매번 초기화돼 **한 번도** 재조회하지 않았다.
    render({ commentUnreadCount: 0 });
    openPanel();
    notificationComments.mockClear();

    for (let i = 1; i <= 6; i++) {
      act(() => vi.advanceTimersByTime(10_000));
      render({ commentUnreadCount: i }); // 배지 폴이 새 값을 내려 준 것과 같은 렌더
    }
    // 60초를 지났으니 최소 한 번은 돌았어야 한다
    expect(notificationComments.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("숨은 창에서는 재갱신하지 않는다(기존 계약)", () => {
    render({ commentUnreadCount: 0 });
    openPanel();
    notificationComments.mockClear();
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    act(() => vi.advanceTimersByTime(180_000));
    expect(notificationComments).not.toHaveBeenCalled();
  });

  it("패널을 닫으면 폴이 멈춘다", () => {
    render({ commentUnreadCount: 0 });
    openPanel();
    openPanel(); // 다시 눌러 닫는다
    notificationComments.mockClear();
    act(() => vi.advanceTimersByTime(180_000));
    expect(notificationComments).not.toHaveBeenCalled();
  });
});
