// @vitest-environment jsdom
// 공유 서버 주소가 바뀌었다는 정보 알림(2026-10-02, Jay "업데이트 알림처럼 나한테도") — 공지를 낸 관리자 PC 처럼 이미 새
// 주소를 쓰는 PC 의 알림 센터에도 뜨고, 누르면 읽음만 된다(전환·새로고침 없음).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const relocate = vi.fn();
const reload = vi.fn();
vi.mock("../src/lib/unloadGuard", () => ({ reloadNow: () => reload() }));
vi.mock("../src/api", () => ({
  api: {
    notificationComments: vi.fn().mockResolvedValue([]),
    markGenCommentSeen: vi.fn().mockResolvedValue(undefined),
    markAllNotificationCommentsSeen: vi.fn().mockResolvedValue(undefined),
    generationStats: vi.fn().mockResolvedValue({ comment_unread: 0, failed: 0 }),
  },
}));
const releaseStatus = vi.fn(() => Promise.reject(new Error("없음")));
vi.mock("../src/lib/releaseUpdate", () => ({ getReleaseUpdateStatus: () => releaseStatus() }));
vi.mock("../src/lib/updateNotices", () => ({ updateNoticeApi: { list: vi.fn(() => Promise.reject(new Error("없음"))) } }));
vi.mock("../src/lib/sharedApi", () => ({
  sharedApi: {
    sharedServerRelocate: (...args: unknown[]) => relocate(...args),
    sharedServerRelocation: vi.fn(() => Promise.resolve({
      current_url: "http://192.168.1.171:8010", proposed_url: null, revision: 0, server_name: null,
      announced_at: null, reachable: false,
      moved: { url: "http://192.168.1.171:8010", revision: 1, server_name: null, announced_at: "2026-10-02T22:43:35+09:00" },
    })),
  },
}));

const { NotificationCenter } = await import("../src/components/NotificationCenter");
const { sharedApi } = await import("../src/lib/sharedApi");

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  relocate.mockReset();
  reload.mockReset();
  releaseStatus.mockImplementation(() => Promise.reject(new Error("없음")));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };
const movedItem = () => [...document.querySelectorAll<HTMLButtonElement>(".notification-update")]
  .find((b) => b.textContent?.includes("공유 서버 주소가 바뀌었습니다: http://192.168.1.171:8010"));
const tabs = () => [...document.querySelectorAll<HTMLButtonElement>(".notification-tabs button")];
// 창은 '안읽음' 탭으로 열린다 — 읽음이 된 알림도 계속 보려고 '전체' 탭으로 옮긴다.
const showAll = async () => { await act(async () => { tabs()[0].click(); }); };

it("이미 새 주소인 PC 에도 '주소가 바뀌었다'가 안읽음으로 뜨고, 누르면 읽음만 된다", async () => {
  await act(async () => {
    root.render(<NotificationCenter commentUnreadCount={0} hasUnreadComments={false} onOpenComment={() => {}} onChanged={() => {}} />);
  });
  await settle();
  await act(async () => { host.querySelector("button")!.click(); }); // 종 열기
  await settle();
  expect(tabs()[1].classList.contains("on"), "처음엔 '안읽음' 탭").toBe(true);
  expect(movedItem(), "안 읽은 알림은 '안읽음' 탭에 보인다").toBeTruthy();
  await showAll();
  const item = movedItem();
  expect(item, "정보 알림이 안 보인다").toBeTruthy();
  expect(item!.textContent).toContain("이 PC 는 이미 새 주소에 연결돼 있습니다");
  expect(item!.classList.contains("unread")).toBe(true);
  await act(async () => { item!.click(); });
  await settle();
  expect(relocate).not.toHaveBeenCalled(); // 옮길 것이 없다 — 전환 요청을 보내지 않는다
  expect(movedItem()!.classList.contains("unread")).toBe(false);
  expect(window.localStorage.getItem("ch.notifications.relocationMovedRead")).toBe("moved:1:http://192.168.1.171:8010");
});

it("읽음 처리 뒤 늦게 끝난 조회가 그 알림을 다시 '안읽음'으로 덮지 않는다(Codex 리뷰 P2)", async () => {
  await act(async () => {
    root.render(<NotificationCenter commentUnreadCount={0} hasUnreadComments={false} onOpenComment={() => {}} onChanged={() => {}} />);
  });
  await settle();
  let finishSlow!: () => void;
  releaseStatus.mockImplementation(() => new Promise((_, reject) => { finishSlow = () => reject(new Error("늦음")); }));
  await act(async () => { host.querySelector("button")!.click(); }); // 종 열기 = 다시 조회 시작(한쪽 응답이 늦다)
  await settle();
  await showAll();
  await act(async () => { movedItem()!.click(); }); // 조회가 끝나기 전에 읽음
  await settle();
  expect(movedItem()!.classList.contains("unread")).toBe(false);
  await act(async () => { finishSlow(); });
  await settle();
  expect(movedItem()!.classList.contains("unread")).toBe(false);
});

it("이전 알림 화면은 HTTPS를 보이고 클릭은 저장 신원으로 전환한다", async () => {
  const identity = "http://127.0.0.1:18093";
  vi.mocked(sharedApi.sharedServerRelocation).mockResolvedValueOnce({
    current_url: "http://127.0.0.1:18091", proposed_url: identity,
    proposed_display_url: "https://127.0.0.1:18093", revision: 4,
    server_name: null, announced_at: null, reachable: true, moved: null,
  });
  await act(async () => {
    root.render(<NotificationCenter commentUnreadCount={0} hasUnreadComments={false} onOpenComment={() => {}} onChanged={() => {}} />);
  });
  await settle();
  vi.mocked(sharedApi.sharedServerRelocation).mockResolvedValueOnce({
    current_url: "http://127.0.0.1:18091", proposed_url: identity,
    proposed_display_url: "https://127.0.0.1:18093", revision: 4,
    server_name: null, announced_at: null, reachable: true, moved: null,
  });
  await act(async () => { host.querySelector("button")!.click(); });
  await settle();
  const item = [...document.querySelectorAll<HTMLButtonElement>(".notification-update")]
    .find((button) => button.textContent?.includes("https://127.0.0.1:18093"));
  expect(item).toBeTruthy();
  await act(async () => { item!.click(); });
  await settle();
  expect(relocate).toHaveBeenCalledWith(identity, 4);
  expect(reload).toHaveBeenCalledOnce();
});
