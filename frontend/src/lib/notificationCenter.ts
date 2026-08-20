import type { ReleaseUpdateStatus } from "./releaseUpdate";
import { STORAGE_KEYS } from "./storageKeys";

export type NotificationTab = "all" | "unread";
export type ReleaseNotificationKind = "available" | "completed";

export interface ReleaseNotification {
  id: string;
  kind: ReleaseNotificationKind;
  version: string;
  text: string;
  created_at: string;
  unread: boolean;
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

export function markReleaseNotificationRead(
  item: ReleaseNotification,
  storage: NotificationStorage,
): ReleaseNotification {
  if (item.kind === "available") {
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
): ReleaseNotification[] {
  return items.map((item) => markReleaseNotificationRead(item, storage));
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
