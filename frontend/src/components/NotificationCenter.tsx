import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { fmtRelativeWhen, timestampMs } from "../lib/format";
import { isRouteMissing } from "../lib/http";
import { displayThumb, hideBrokenImg, showLoadedImg } from "../lib/media";
import {
  filterNotificationItems,
  markAllReleaseNotificationsRead,
  markNotificationListRead,
  markReleaseNotificationRead,
  notificationBadgeText,
  syncReleaseNotifications,
  unreadNotificationCount,
  type NotificationTab,
  type ReleaseNotification,
} from "../lib/notificationCenter";
import { getReleaseUpdateStatus } from "../lib/releaseUpdate";
import { useEscapeClose } from "../lib/useEscapeClose";
import { useOutsideMouseDown } from "../lib/useOutsideMouseDown";
import type { NotificationComment } from "../types";

type CenterItem =
  | ({ source: "comment" } & NotificationComment)
  | ({ source: "update" } & ReleaseNotification);

export function NotificationCenter({
  commentUnreadCount,
  hasUnreadComments,
  onOpenComment,
  onOpenUpdateSettings,
  onChanged,
}: {
  commentUnreadCount?: number;
  hasUnreadComments: boolean;
  onOpenComment: (genId: string) => void;
  onOpenUpdateSettings: () => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<NotificationTab>("all");
  const [comments, setComments] = useState<NotificationComment[]>([]);
  const [releaseItems, setReleaseItems] = useState<ReleaseNotification[]>([]);
  const [unreadComments, setUnreadComments] = useState(
    commentUnreadCount ?? (hasUnreadComments ? 1 : 0),
  );
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const commentsSupportedRef = useRef(true);
  const commentsLoadSeqRef = useRef(0);

  useEffect(() => {
    setUnreadComments(commentUnreadCount ?? (hasUnreadComments ? 1 : 0));
  }, [commentUnreadCount, hasUnreadComments]);

  const loadComments = useCallback(async (showLoading = false) => {
    if (!commentsSupportedRef.current) {
      if (showLoading) setError("알림 목록은 백엔드 업데이트 후 사용할 수 있습니다.");
      return;
    }
    const seq = ++commentsLoadSeqRef.current;
    if (showLoading) setLoading(true);
    try {
      const items = await api.notificationComments();
      if (seq !== commentsLoadSeqRef.current) return;
      setComments(items);
      const listedUnread = items.filter((item) => item.unread).length;
      setUnreadComments(Math.max(listedUnread, commentUnreadCount ?? 0));
      setError("");
    } catch (loadError) {
      if (seq !== commentsLoadSeqRef.current) return;
      if (isRouteMissing(loadError)) commentsSupportedRef.current = false;
      if (showLoading) setError("코멘트 알림을 불러오지 못했습니다.");
    } finally {
      if (seq === commentsLoadSeqRef.current) setLoading(false);
    }
  }, [commentUnreadCount]);

  // 기존 stats 갱신 흐름의 안전망: 메인 창이 보일 때만 60초마다 작은 목록 API를 확인한다.
  useEffect(() => {
    void loadComments(false);
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void loadComments(false);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [loadComments]);

  useEffect(() => {
    let alive = true;
    getReleaseUpdateStatus(true)
      .then((status) => {
        if (alive) setReleaseItems(syncReleaseNotifications(status, window.localStorage));
      })
      .catch(() => {
        // 공유 서버 직결·개발 설치본처럼 로컬 업데이트 API를 쓸 수 없는 화면은 조용히 제외한다.
      });
    return () => { alive = false; };
  }, []);

  const close = useCallback(() => setOpen(false), []);
  useOutsideMouseDown(ref, close, open);
  useEscapeClose(close, open, true, true);

  const allItems = useMemo<CenterItem[]>(() => {
    const mixed: CenterItem[] = [
      ...comments.map((item) => ({ ...item, source: "comment" as const })),
      ...releaseItems.map((item) => ({ ...item, source: "update" as const })),
    ];
    return mixed.sort((a, b) => timestampMs(b.created_at) - timestampMs(a.created_at));
  }, [comments, releaseItems]);
  const visibleItems = useMemo(() => filterNotificationItems(allItems, tab), [allItems, tab]);
  const unreadTotal = unreadNotificationCount(unreadComments, releaseItems);
  const hiddenUnreadComments = Math.max(
    0,
    unreadComments - comments.filter((item) => item.unread).length,
  );

  const openPanel = () => {
    setOpen((value) => {
      if (!value) void loadComments(true);
      return !value;
    });
  };

  const openComment = (item: NotificationComment) => {
    const wasUnread = item.unread;
    close();
    if (!wasUnread) {
      onOpenComment(item.gen_id);
      return;
    }
    commentsLoadSeqRef.current += 1; // 진행 중인 옛 목록 응답이 낙관적 읽음을 되돌리지 못하게 한다.
    setLoading(false);
    setComments((current) =>
      current.map((comment) => comment.id === item.id ? { ...comment, unread: false } : comment),
    );
    setUnreadComments((count) => Math.max(0, count - 1));
    // seen 저장 뒤 패널을 열어, 패널의 즉시 재조회가 같은 코멘트를 다시 NEW로 그리는 경쟁을 막는다.
    api.markGenCommentSeen(item.id)
      .then(onChanged)
      .catch(() => {
        setComments((current) =>
          current.map((comment) => comment.id === item.id ? { ...comment, unread: true } : comment),
        );
        setUnreadComments((count) => count + 1);
      })
      .finally(() => onOpenComment(item.gen_id));
  };

  const openRelease = (item: ReleaseNotification) => {
    setReleaseItems((current) =>
      current.map((candidate) =>
        candidate.id === item.id
          ? markReleaseNotificationRead(candidate, window.localStorage)
          : candidate,
      ),
    );
    if (item.kind === "available") {
      close();
      onOpenUpdateSettings();
    }
  };

  const markAllRead = async () => {
    if (!unreadTotal || busy) return;
    setBusy(true);
    setError("");
    setReleaseItems((current) =>
      markAllReleaseNotificationsRead(current, window.localStorage),
    );
    const hasUnreadCommentItems = unreadComments > 0 || comments.some((item) => item.unread);
    if (hasUnreadCommentItems) {
      try {
        commentsLoadSeqRef.current += 1;
        setLoading(false);
        await api.markAllNotificationCommentsSeen();
        setComments((current) => markNotificationListRead(current));
        setUnreadComments(0);
        onChanged();
      } catch {
        setError("코멘트 알림을 모두 읽음 처리하지 못했습니다.");
      }
    }
    setBusy(false);
  };

  return (
    <div className="notification-center" ref={ref}>
      <button
        type="button"
        className={"notification-bell" + (open ? " on" : "")}
        onClick={openPanel}
        aria-label={unreadTotal ? `알림 ${unreadTotal}개` : "알림"}
        aria-expanded={open}
        title="알림 센터"
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z" />
          <path d="M10 21h4" />
        </svg>
        {unreadTotal > 0 && (
          <span className="notification-badge">{notificationBadgeText(unreadTotal)}</span>
        )}
      </button>

      {open && (
        <section className="notification-panel" aria-label="알림 센터">
          <header className="notification-head">
            <strong>알림</strong>
            <button
              type="button"
              className="notification-read-all"
              disabled={!unreadTotal || busy}
              onClick={() => void markAllRead()}
            >
              {busy ? "처리 중…" : "모두 읽음"}
            </button>
          </header>
          <div className="notification-tabs" role="tablist">
            <button className={tab === "all" ? "on" : ""} onClick={() => setTab("all")}>전체</button>
            <button className={tab === "unread" ? "on" : ""} onClick={() => setTab("unread")}>
              안읽음 {unreadTotal}
            </button>
          </div>
          <div className="notification-list">
            {loading && !allItems.length ? (
              <div className="notification-empty">알림을 불러오는 중…</div>
            ) : visibleItems.length ? (
              visibleItems.map((item) => item.source === "comment" ? (
                <button
                  type="button"
                  key={`comment:${item.id}`}
                  className={"notification-item" + (item.unread ? " unread" : "")}
                  onClick={() => openComment(item)}
                >
                  <span className="notification-thumb">
                    {item.thumbnail_url && displayThumb(item.thumbnail_url, 96) ? (
                      <img
                        src={displayThumb(item.thumbnail_url, 96) || undefined}
                        alt=""
                        onLoad={showLoadedImg}
                        onError={hideBrokenImg}
                      />
                    ) : <span aria-hidden="true">▧</span>}
                  </span>
                  <span className="notification-copy">
                    <span className="notification-text">{item.text}</span>
                    <span className="notification-meta">
                      {item.author_name || "팀원"} · {fmtRelativeWhen(item.created_at)}
                    </span>
                  </span>
                  {item.unread && <span className="notification-unread-dot" aria-label="안읽음" />}
                </button>
              ) : (
                <button
                  type="button"
                  key={item.id}
                  className={"notification-item notification-update" + (item.unread ? " unread" : "")}
                  onClick={() => openRelease(item)}
                >
                  <span className="notification-thumb notification-update-icon" aria-hidden="true">↻</span>
                  <span className="notification-copy">
                    <span className="notification-text">{item.text}</span>
                    <span className="notification-meta">앱 업데이트 · {fmtRelativeWhen(item.created_at)}</span>
                  </span>
                  {item.unread && <span className="notification-unread-dot" aria-label="안읽음" />}
                </button>
              ))
            ) : (
              <div className="notification-empty">
                {tab === "unread" ? "새 알림이 없습니다." : "최근 알림이 없습니다."}
              </div>
            )}
          </div>
          {hiddenUnreadComments > 0 && (
            <div className="notification-range-hint">
              목록 범위 밖 미확인 코멘트 {hiddenUnreadComments}개 · 모두 읽음으로 정리할 수 있습니다.
            </div>
          )}
          {error && <div className="notification-error" role="status">{error}</div>}
        </section>
      )}
    </div>
  );
}
