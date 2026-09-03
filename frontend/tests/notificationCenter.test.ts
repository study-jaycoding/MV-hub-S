import { describe, expect, it } from "vitest";
import {
  filterNotificationItems,
  filterNotificationsByCategory,
  markAllReleaseNotificationsRead,
  markNotificationListRead,
  mergeReleaseAnnouncementNotifications,
  notificationBadgeText,
  syncReleaseNotifications,
  unreadNotificationCount,
} from "../src/lib/notificationCenter";
import type { ReleaseUpdateStatus } from "../src/lib/releaseUpdate";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const status = (overrides: Partial<ReleaseUpdateStatus> = {}): ReleaseUpdateStatus => ({
  state: "up_to_date",
  message: "최신",
  install_mode: "release",
  current_version: "1.0.0",
  latest_version: "1.0.0",
  can_update: false,
  generation_active: 0,
  comfy_active: 0,
  resolve_active: 0,
  active_total: 0,
  updated_at: "2026-08-20T00:00:00Z",
  ...overrides,
});

describe("알림 센터 파생 상태", () => {
  // ★2026-09-03(Jay): 릴리스가 올라온 것만으로는 알림을 만들지 않는다. 릴리스마다 전원에게
  //  알림이 가면 업데이트 시점을 일괄로 관리할 수 없다. 알림은 관리자가 공지한 것만.
  it("새 버전이 있어도 관리자가 공지하기 전에는 알림을 만들지 않는다", () => {
    const storage = new MemoryStorage();
    syncReleaseNotifications(status(), storage); // 기준 버전 기록
    const items = syncReleaseNotifications(
      status({ state: "available", latest_version: "1.2.0", can_update: true }),
      storage,
    );
    expect(items).toEqual([]); // 설정 화면엔 보이지만 알림은 안 뜬다
    expect(unreadNotificationCount(0, items)).toBe(0); // 벨에도 안 잡힌다
  });

  it("관리자 공지는 알림이 되고 서버 읽음 상태를 따른다", () => {
    const merged = mergeReleaseAnnouncementNotifications([], [{
      id: "release-abc",
      version: "1.2.0",
      file: "MVHub-1.2.0.zip",
      released_at: "2026-08-24T00:00:00Z",
      pinned: false,
      announcement_revision: 1,
      announced_at: "2026-08-24T01:00:00Z",
      unread: false,
    }]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual(expect.objectContaining({
      kind: "announcement",
      version: "1.2.0",
      unread: false,
      noticeId: "release-abc",
      noticeRevision: 1,
    }));
  });

  it("코멘트나 업데이트 미확인이 있을 때만 벨 수를 표시하고 9+로 제한한다", () => {
    const storage = new MemoryStorage();
    syncReleaseNotifications(status(), storage);
    // 업데이트 알림은 '내 업데이트가 끝났다'(completed)로 생긴다 — 새 릴리스 감지로는 안 생긴다.
    const updates = syncReleaseNotifications(
      status({ current_version: "1.1.0", latest_version: "1.1.0" }),
      storage,
    );
    expect(unreadNotificationCount(0, [])).toBe(0);
    expect(unreadNotificationCount(2, updates)).toBe(3);
    expect(notificationBadgeText(3)).toBe("3");
    expect(notificationBadgeText(12)).toBe("9+");
  });

  it("카테고리 드롭다운은 코멘트/시스템(업데이트)을 source로 구분한다", () => {
    const items = [
      { id: "c", source: "comment" as const },
      { id: "u", source: "update" as const },
    ];
    expect(filterNotificationsByCategory(items, "all")).toEqual(items);
    expect(filterNotificationsByCategory(items, "comment")).toEqual([items[0]]);
    expect(filterNotificationsByCategory(items, "update")).toEqual([items[1]]);
  });

  it("전체/안읽음/읽음 탭은 unread 플래그만으로 필터한다", () => {
    const items = [{ id: "a", unread: true }, { id: "b", unread: false }];
    expect(filterNotificationItems(items, "all")).toEqual(items);
    expect(filterNotificationItems(items, "unread")).toEqual([items[0]]);
    expect(filterNotificationItems(items, "read")).toEqual([items[1]]);
  });

  it("모두 읽음 뒤에는 전체 목록은 유지되고 안읽음 탭만 빈다", () => {
    const items = [{ id: "a", unread: true }, { id: "b", unread: false }];
    const read = markNotificationListRead(items);
    expect(filterNotificationItems(read, "all")).toHaveLength(2);
    expect(filterNotificationItems(read, "unread")).toEqual([]);
  });

  it("첫 실행은 기준 버전만 기록하고 실제 버전 변화만 완료 알림으로 만든다", () => {
    const storage = new MemoryStorage();
    expect(syncReleaseNotifications(status(), storage)).toEqual([]);
    const completed = syncReleaseNotifications(
      status({ current_version: "1.1.0", latest_version: "1.1.0" }),
      storage,
      "2026-08-20T01:00:00Z",
    );
    expect(completed).toEqual([
      expect.objectContaining({ kind: "completed", version: "1.1.0", unread: true }),
    ]);
  });

  it("모두 읽음은 현재 업데이트 알림들의 localStorage 읽음 상태를 보존한다", () => {
    const storage = new MemoryStorage();
    syncReleaseNotifications(status(), storage);
    syncReleaseNotifications(status({ current_version: "1.1.0", latest_version: "1.1.0" }), storage);
    const items = syncReleaseNotifications(
      status({
        state: "available",
        current_version: "1.1.0",
        latest_version: "1.2.0",
        can_update: true,
      }),
      storage,
    );
    expect(items.every((item) => item.unread)).toBe(true);
    expect(markAllReleaseNotificationsRead(items, storage).every((item) => !item.unread)).toBe(true);
    expect(
      syncReleaseNotifications(
        status({
          state: "available",
          current_version: "1.1.0",
          latest_version: "1.2.0",
          can_update: true,
        }),
        storage,
      ).every((item) => !item.unread),
    ).toBe(true);
  });
});
