import { describe, expect, it } from "vitest";
import {
  markAllReleaseNotificationsRead,
  markReleaseNotificationRead,
  releaseNotificationAction,
  serverRelocationNotification,
  unreadNotificationCount,
} from "../src/lib/notificationCenter";
import { STORAGE_KEYS } from "../src/lib/storageKeys";
import type { ServerRelocationInfo } from "../src/lib/sharedApi";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const info = (overrides: Partial<ServerRelocationInfo> = {}): ServerRelocationInfo => ({
  current_url: "http://192.168.1.199:8010",
  proposed_url: "http://192.168.1.50:8010",
  revision: 2,
  server_name: "MV 팀 서버",
  announced_at: "2026-08-23T10:00:00Z",
  reachable: true,
  ...overrides,
});

describe("공유 서버 이사 알림", () => {
  it("제안이 있고 새 주소가 응답할 때만 알림을 만든다", () => {
    const session = new MemoryStorage();
    expect(serverRelocationNotification(info(), session)).toEqual(
      expect.objectContaining({
        kind: "relocation",
        url: "http://192.168.1.50:8010",
        version: "2",
        unread: true,
      }),
    );
    // 제안 없음 / 닿지 않는 주소 / 잘못된 revision 은 알림을 만들지 않는다 —
    // 응답하지 않는 주소로 전환하면 로그아웃만 되고 더 깊이 갇힌다.
    expect(serverRelocationNotification(null, session)).toBeNull();
    expect(serverRelocationNotification(info({ proposed_url: null }), session)).toBeNull();
    expect(serverRelocationNotification(info({ proposed_url: "  " }), session)).toBeNull();
    expect(serverRelocationNotification(info({ reachable: false }), session)).toBeNull();
    expect(serverRelocationNotification(info({ revision: 0 }), session)).toBeNull();
  });

  it("이름이 있으면 이름만 보이고, 없을 때만 주소를 드러낸다", () => {
    const session = new MemoryStorage();
    const named = serverRelocationNotification(info(), session)!;
    expect(named.serverName).toBe("MV 팀 서버");
    expect(named.text).toBe(
      "'MV 팀 서버' 서버가 새 위치로 이동했습니다. 누르면 전환되고 다시 로그인합니다.",
    );
    expect(named.text).not.toContain("192.168.1.50");

    for (const blank of [null, "", "   "]) {
      const plain = serverRelocationNotification(info({ server_name: blank }), session)!;
      expect(plain.serverName).toBe("");
      expect(plain.text).toBe(
        "공유 서버가 새 주소로 이사했습니다: http://192.168.1.50:8010. 누르면 전환되고 다시 로그인합니다.",
      );
    }
    // 이름이 있어도 전환 대상 주소는 항상 들고 다닌다(클릭 즉시 이 주소로 전환한다).
    expect(named.url).toBe("http://192.168.1.50:8010");
  });

  it("확인창이 없으므로 본문이 '누르면 전환된다'는 결과를 반드시 말한다", () => {
    const session = new MemoryStorage();
    for (const name of ["MV 팀 서버", ""]) {
      const item = serverRelocationNotification(info({ server_name: name }), session)!;
      expect(item.text).toContain("누르면 전환되고 다시 로그인합니다.");
    }
  });

  it("이사 알림 클릭은 확인창 없이 곧바로 전환한다(업데이트만 한 번 더 묻는다)", () => {
    expect(releaseNotificationAction("relocation", false)).toBe("relocate");
    // 업데이트 알림은 관리자 공지(announcement)뿐이다 — 자동 감지는 알림을 만들지 않는다.
    expect(releaseNotificationAction("announcement", false)).toBe("confirm");
    expect(releaseNotificationAction("completed", false)).toBe("none");
    // 이미 전환·업데이트가 돌고 있으면 같은 클릭이 두 번 실행되지 않는다.
    for (const kind of ["relocation", "announcement", "completed"] as const) {
      expect(releaseNotificationAction(kind, true)).toBe("none");
    }
  });

  it("revision·주소가 알림 id 를 이룬다(새 공지는 새 알림)", () => {
    const session = new MemoryStorage();
    const first = serverRelocationNotification(info(), session)!;
    const next = serverRelocationNotification(info({ revision: 3 }), session)!;
    expect(first.id).not.toBe(next.id);
    expect(first.id).toBe("relocation:2:http://192.168.1.50:8010");
  });

  it("'나중에'로 닫으면 이 세션에서만 조용해지고 다음 기동엔 다시 뜬다", () => {
    const session = new MemoryStorage();
    const item = serverRelocationNotification(info(), session)!;
    expect(unreadNotificationCount(0, [item])).toBe(1);

    const dismissed = markReleaseNotificationRead(item, new MemoryStorage(), session);
    expect(dismissed.unread).toBe(false);
    expect(session.values.get(STORAGE_KEYS.notificationRelocationDismissed)).toBe(item.id);
    // 같은 세션이면 다시 조회해도 읽음 상태 그대로.
    expect(serverRelocationNotification(info(), session)!.unread).toBe(false);
    // 새 세션(빈 sessionStorage)=앱을 다시 켠 것 → 다시 안읽음으로 눈에 띈다.
    expect(serverRelocationNotification(info(), new MemoryStorage())!.unread).toBe(true);
  });

  it("숨김 표식은 localStorage 가 아니라 전달된 세션 저장소에만 쓴다", () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const item = serverRelocationNotification(info(), session)!;
    markReleaseNotificationRead(item, local, session);
    expect(local.values.size).toBe(0);
    // 세션 저장소를 주지 않으면 아무것도 영속하지 않는다(업데이트 알림 키도 오염 없음).
    markReleaseNotificationRead(item, local);
    expect(local.values.size).toBe(0);
  });

  it("'모두 읽음'은 이사 알림도 함께 정리한다", () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const items = [serverRelocationNotification(info(), session)!];
    const read = markAllReleaseNotificationsRead(items, local, session);
    expect(read.every((item) => !item.unread)).toBe(true);
    expect(session.values.get(STORAGE_KEYS.notificationRelocationDismissed)).toBe(items[0].id);
  });

  it("공지 시각이 없으면 현재 시각을 쓴다", () => {
    const session = new MemoryStorage();
    const item = serverRelocationNotification(
      info({ announced_at: null }),
      session,
      "2026-08-23T12:00:00Z",
    )!;
    expect(item.created_at).toBe("2026-08-23T12:00:00Z");
  });
});
