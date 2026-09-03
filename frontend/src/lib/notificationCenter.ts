import type { ReleaseUpdateStatus } from "./releaseUpdate";
import type { ServerRelocationInfo } from "./sharedApi";
import type { UpdateNotice } from "./updateNotices";
import { STORAGE_KEYS } from "./storageKeys";

export type NotificationTab = "all" | "unread" | "read";
export type NotificationCategory = "all" | "comment" | "update";
// ★새 릴리스가 올라온 것만으로는 알림을 만들지 않는다(2026-09-03, Jay). 릴리스를 만들 때마다
//  전원에게 알림이 가면 업데이트 시점을 일괄로 관리할 수 없다. 알림은 관리자가 '공지'를 누른
//  것만(announcement) — 자동 감지는 설정 화면의 업데이트 표시·버튼으로 그대로 남는다.
export type ReleaseNotificationKind = "completed" | "relocation" | "announcement";

// 카테고리 드롭다운 표기 — 코멘트(생성물 코멘트)와 시스템(업데이트 등 앱 소식)으로 나눈다.
export const NOTIFICATION_CATEGORY_LABELS: Record<NotificationCategory, string> = {
  all: "전체 알림",
  comment: "코멘트",
  update: "시스템",
};

export function filterNotificationsByCategory<T extends { source: "comment" | "update" }>(
  items: T[],
  category: NotificationCategory,
): T[] {
  return category === "all" ? items : items.filter((item) => item.source === category);
}

export interface ReleaseNotification {
  id: string;
  kind: ReleaseNotificationKind;
  version: string; // relocation 에서는 공지 revision(문자열)
  text: string;
  created_at: string;
  unread: boolean;
  url?: string; // relocation 전용 — 옮겨 갈 새 공유 서버 주소
  serverName?: string; // relocation 전용 — 그 서버의 표시 이름(없으면 주소로 폴백)
  noticeId?: string; // 서버 관리 업데이트 공지 전용
  noticeRevision?: number;
}

export function mergeReleaseAnnouncementNotifications(
  localItems: ReleaseNotification[],
  notices: UpdateNotice[],
): ReleaseNotification[] {
  const local = localItems;
  const announced: ReleaseNotification[] = notices.map((item) => ({
    id: `announcement:${item.id}:${item.announcement_revision}`,
    kind: "announcement",
    version: item.version,
    text: `v${item.version} 업데이트가 등록되었습니다`,
    created_at: item.announced_at || item.released_at,
    unread: item.unread,
    noticeId: item.id,
    noticeRevision: item.announcement_revision,
  }));
  return [...announced, ...local].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
  );
}

export interface NotificationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface StoredCompletedUpdate {
  version: string;
  created_at: string;
  read: boolean;
}

function safeGet(storage: NotificationStorage, key: string): string {
  try {
    return storage.getItem(key) || "";
  } catch {
    return "";
  }
}

function safeSet(storage: NotificationStorage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    // localStorage를 막은 환경에서는 현재 세션 표시만 유지한다.
  }
}

function loadCompleted(storage: NotificationStorage): StoredCompletedUpdate | null {
  try {
    const raw = storage.getItem(STORAGE_KEYS.notificationCompletedUpdate);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredCompletedUpdate>;
    return typeof parsed.version === "string" && typeof parsed.created_at === "string"
      ? { version: parsed.version, created_at: parsed.created_at, read: parsed.read === true }
      : null;
  } catch {
    return null;
  }
}

function saveCompleted(storage: NotificationStorage, item: StoredCompletedUpdate): void {
  safeSet(storage, STORAGE_KEYS.notificationCompletedUpdate, JSON.stringify(item));
}

// 상태 조회 시 버전 변화를 한 번 영속화하고, 현재 표시할 업데이트 알림을 반환한다.
// 기준 버전이 없는 첫 실행은 완료 알림으로 오인하지 않고 baseline만 저장한다.
export function syncReleaseNotifications(
  status: ReleaseUpdateStatus,
  storage: NotificationStorage,
  now = new Date().toISOString(),
): ReleaseNotification[] {
  const current = status.current_version.trim();
  const previous = safeGet(storage, STORAGE_KEYS.notificationCurrentVersion).trim();
  if (current && previous && previous !== current) {
    saveCompleted(storage, {
      version: current,
      created_at: status.updated_at || now,
      read: false,
    });
  }
  if (current && previous !== current) {
    safeSet(storage, STORAGE_KEYS.notificationCurrentVersion, current);
  }

  const items: ReleaseNotification[] = [];
  const completed = loadCompleted(storage);
  if (completed && completed.version === current) {
    items.push({
      id: `update:completed:${completed.version}`,
      kind: "completed",
      version: completed.version,
      text: `v${completed.version}로 업데이트되었습니다`,
      created_at: completed.created_at,
      unread: !completed.read,
    });
  }

  // 새 버전이 올라와 있어도 여기서 알림을 만들지 않는다 — 관리자가 공지한 것만 알린다.
  // (설정 화면은 status 를 직접 읽으므로 '업데이트 있음'과 업데이트 버튼은 그대로다.)
  return items.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

// 이사 알림 본문에 붙는 행동 안내 — 클릭이 곧 전환이므로 확인창 대신 여기서 미리 알린다.
const RELOCATION_ACTION_HINT = "누르면 전환되고 다시 로그인합니다.";

// 공유 서버가 새 주소로 이사했다는 시스템 알림. 백엔드가 릴리스 폴더의 공지를 읽어
// 제안할 때만(그리고 새 주소가 실제로 응답할 때만) 만들어진다 — 닿지도 않는 주소로
// 전환을 권하면 로그아웃만 되고 더 깊이 갇힌다.
export function serverRelocationNotification(
  info: ServerRelocationInfo | null | undefined,
  sessionStore: NotificationStorage,
  now = new Date().toISOString(),
): ReleaseNotification | null {
  const url = (info?.proposed_url || "").trim();
  if (!info || !url || !info.reachable || info.revision <= 0) return null;
  const serverName = (info.server_name || "").trim();
  const id = `relocation:${info.revision}:${url}`;
  return {
    id,
    kind: "relocation",
    version: String(info.revision),
    url,
    serverName,
    // 평소 표기는 이름 — 이름이 없을 때만 주소를 드러낸다. 확인창이 없으므로(클릭=전환)
    // 무슨 일이 일어나는지는 반드시 이 한 줄에 들어 있어야 한다.
    text: serverName
      ? `'${serverName}' 서버가 새 위치로 이동했습니다. ${RELOCATION_ACTION_HINT}`
      : `공유 서버가 새 주소로 이사했습니다: ${url}. ${RELOCATION_ACTION_HINT}`,
    created_at: info.announced_at || now,
    // ★'나중에'는 이 세션 동안만 기억한다(sessionStorage). 서버의 수락 표식은 실제로
    // 전환했을 때만 기록되므로, 미루면 다음 기동에서 다시 안읽음으로 뜬다.
    unread: safeGet(sessionStore, STORAGE_KEYS.notificationRelocationDismissed) !== id,
  };
}

export function markReleaseNotificationRead(
  item: ReleaseNotification,
  storage: NotificationStorage,
  sessionStore?: NotificationStorage,
): ReleaseNotification {
  if (item.kind === "announcement") {
    // 서버 공지의 읽음은 API가 저장한다. 여기서는 낙관적 화면 갱신만 한다.
  } else if (item.kind === "relocation") {
    if (sessionStore) {
      safeSet(sessionStore, STORAGE_KEYS.notificationRelocationDismissed, item.id);
    }
  } else {
    const completed = loadCompleted(storage);
    if (completed?.version === item.version) saveCompleted(storage, { ...completed, read: true });
  }
  return item.unread ? { ...item, unread: false } : item;
}

export function markAllReleaseNotificationsRead(
  items: ReleaseNotification[],
  storage: NotificationStorage,
  sessionStore?: NotificationStorage,
): ReleaseNotification[] {
  return items.map((item) => markReleaseNotificationRead(item, storage, sessionStore));
}

export type ReleaseNotificationAction = "relocate" | "confirm" | "none";

// 시스템 알림을 눌렀을 때 무엇을 하나 — 확인창을 띄우는 조건을 한곳에 고정한다.
//  · 이사: **확인창 없이 곧바로 전환**한다. 알림 본문이 이미 "누르면 전환되고 다시
//    로그인합니다"라고 말하고 있고, 옛 주소로 남아 있으면 어차피 공유가 안 된다.
//    (안전 검증은 백엔드가 한다 — 공지 재검증·신원 프로브·원자 전환.)
//  · 업데이트: 관리자 공지를 누르면 확인창을 거쳐 즉시 실행한다(알림으로 오는 업데이트는
//    공지뿐이다 — 자동 감지는 알림을 만들지 않고 설정 화면에만 남는다).
//  · 이미 무언가 실행 중이면 아무것도 시작하지 않는다.
export function releaseNotificationAction(
  kind: ReleaseNotificationKind,
  busy: boolean,
): ReleaseNotificationAction {
  if (busy) return "none";
  if (kind === "relocation") return "relocate";
  return kind === "announcement" ? "confirm" : "none";
}

export function filterNotificationItems<T extends { unread: boolean }>(
  items: T[],
  tab: NotificationTab,
): T[] {
  if (tab === "unread") return items.filter((item) => item.unread);
  if (tab === "read") return items.filter((item) => !item.unread);
  return items;
}

export function markNotificationListRead<T extends { unread: boolean }>(items: T[]): T[] {
  return items.map((item) => item.unread ? { ...item, unread: false } : item);
}

export function unreadNotificationCount(
  commentUnreadCount: number,
  releaseItems: ReleaseNotification[],
): number {
  return Math.max(0, commentUnreadCount) + releaseItems.filter((item) => item.unread).length;
}

export function notificationBadgeText(count: number): string {
  return count > 9 ? "9+" : String(Math.max(0, count));
}
