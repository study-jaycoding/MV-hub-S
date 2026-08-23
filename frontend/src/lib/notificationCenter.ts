import type { ReleaseUpdateStatus } from "./releaseUpdate";
import type { ServerRelocationInfo } from "./sharedApi";
import { STORAGE_KEYS } from "./storageKeys";

export type NotificationTab = "all" | "unread";
export type NotificationCategory = "all" | "comment" | "update";
export type ReleaseNotificationKind = "available" | "completed" | "relocation";

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

  const latest = status.latest_version.trim();
  if (status.state === "available" && latest) {
    const seenVersion = safeGet(
      storage,
      STORAGE_KEYS.notificationSeenAvailableVersion,
    ).trim();
    items.push({
      id: `update:available:${latest}`,
      kind: "available",
      version: latest,
      text: `새 버전 v${latest} 사용 가능`,
      created_at: status.updated_at || now,
      unread: seenVersion !== latest,
    });
  }

  return items.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

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
    // 평소 표기는 이름 — 이름이 없을 때만 주소를 드러낸다(주소는 확인 모달이 항상 보여준다).
    text: serverName
      ? `'${serverName}' 서버가 새 위치로 이동했습니다`
      : `공유 서버가 새 주소로 이사했습니다: ${url}`,
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
  if (item.kind === "relocation") {
    if (sessionStore) {
      safeSet(sessionStore, STORAGE_KEYS.notificationRelocationDismissed, item.id);
    }
  } else if (item.kind === "available") {
    safeSet(storage, STORAGE_KEYS.notificationSeenAvailableVersion, item.version);
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

export function filterNotificationItems<T extends { unread: boolean }>(
  items: T[],
  tab: NotificationTab,
): T[] {
  return tab === "unread" ? items.filter((item) => item.unread) : items;
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
