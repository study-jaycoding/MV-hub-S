import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { fmtWhen, timestampMs } from "../lib/format";
import { isRouteMissing } from "../lib/http";
import { displayThumb, hideBrokenImg, showLoadedImg } from "../lib/media";
import {
  filterNotificationItems,
  filterNotificationsByCategory,
  markAllReleaseNotificationsRead,
  markNotificationListRead,
  markReleaseNotificationRead,
  notificationBadgeText,
  NOTIFICATION_CATEGORY_LABELS,
  syncReleaseNotifications,
  unreadNotificationCount,
  type NotificationCategory,
  type NotificationTab,
  type ReleaseNotification,
} from "../lib/notificationCenter";
import {
  getReleaseUpdateStatus,
  isReleaseUpdateRunning,
  releaseUpdateMessage,
  startReleaseUpdate,
} from "../lib/releaseUpdate";
import { useEscapeClose } from "../lib/useEscapeClose";
import { useOutsideMouseDown } from "../lib/useOutsideMouseDown";
import type { NotificationComment } from "../types";

type CenterItem =
  | ({ source: "comment" } & NotificationComment)
  | ({ source: "update" } & ReleaseNotification);

const CATEGORY_ORDER: NotificationCategory[] = ["all", "comment", "update"];

export function NotificationCenter({
  commentUnreadCount,
  hasUnreadComments,
  onOpenComment,
  onChanged,
}: {
  commentUnreadCount?: number;
  hasUnreadComments: boolean;
  onOpenComment: (genId: string) => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<NotificationTab>("all");
  const [category, setCategory] = useState<NotificationCategory>("all");
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [comments, setComments] = useState<NotificationComment[]>([]);
  const [releaseItems, setReleaseItems] = useState<ReleaseNotification[]>([]);
  const [unreadComments, setUnreadComments] = useState(
    commentUnreadCount ?? (hasUnreadComments ? 1 : 0),
  );
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 업데이트 실행 확인창(항목별)과 실행 진행 상태 — 패널을 닫아도 진행 문구는 유지된다.
  const [confirmUpdateId, setConfirmUpdateId] = useState<string | null>(null);
  const [updateRun, setUpdateRun] = useState<{ active: boolean; message: string } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const commentsSupportedRef = useRef(true);
  const commentsLoadSeqRef = useRef(0);
  const updatePollRef = useRef<number | null>(null);

  const stopUpdatePoll = useCallback(() => {
    if (updatePollRef.current !== null) {
      window.clearInterval(updatePollRef.current);
      updatePollRef.current = null;
    }
  }, []);
  useEffect(() => stopUpdatePoll, [stopUpdatePoll]);

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

  const close = useCallback(() => {
    setOpen(false);
    setCategoryOpen(false);
    setConfirmUpdateId(null);
  }, []);
  useOutsideMouseDown(ref, close, open);
  useEscapeClose(close, open, true, true);

  const allItems = useMemo<CenterItem[]>(() => {
    const mixed: CenterItem[] = [
      ...comments.map((item) => ({ ...item, source: "comment" as const })),
      ...releaseItems.map((item) => ({ ...item, source: "update" as const })),
    ];
    return mixed.sort((a, b) => timestampMs(b.created_at) - timestampMs(a.created_at));
  }, [comments, releaseItems]);
  const visibleItems = useMemo(
    () => filterNotificationItems(filterNotificationsByCategory(allItems, category), tab),
    [allItems, category, tab],
  );
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
    // "새 버전 사용 가능"은 그 자리에서 업데이트 여부를 묻는다(설정 이동 없이 즉시 실행 흐름).
    if (item.kind === "available" && !updateRun?.active) {
      setConfirmUpdateId((current) => (current === item.id ? null : item.id));
    }
  };

  const runUpdate = async (item: ReleaseNotification) => {
    setConfirmUpdateId(null);
    setUpdateRun({ active: true, message: "업데이트 실행기를 준비하는 중…" });
    try {
      await startReleaseUpdate();
    } catch (startError) {
      setUpdateRun({
        active: false,
        message: `업데이트를 시작하지 못했습니다: ${String((startError as Error)?.message || startError)}`,
      });
      return;
    }
    const startedAt = Date.now();
    stopUpdatePoll();
    updatePollRef.current = window.setInterval(() => {
      if (Date.now() - startedAt > 15 * 60_000) {
        stopUpdatePoll();
        setUpdateRun({ active: false, message: "업데이트 확인이 오래 걸립니다 — 설정의 업데이트 섹션에서 상태를 확인하세요." });
        return;
      }
      getReleaseUpdateStatus()
        .then((status) => {
          if (isReleaseUpdateRunning(status.state)) {
            setUpdateRun({ active: true, message: releaseUpdateMessage(status) });
            return;
          }
          stopUpdatePoll();
          setUpdateRun({
            active: false,
            message:
              status.state === "complete"
                ? `v${item.version} 업데이트가 완료됐습니다. 새 버전으로 다시 시작됩니다.`
                : releaseUpdateMessage(status) || "업데이트 상태를 확인하세요.",
          });
        })
        .catch(() => {
          // 재시작 구간에는 서버가 잠시 응답하지 않는 게 정상 — 직전 문구를 유지하고 계속 확인한다.
        });
    }, 2000);
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
            {/* 카테고리 드롭다운 — 전체 알림 / 코멘트 / 시스템(업데이트) */}
            <div className="notification-cat">
              <button
                type="button"
                className={"notification-cat-btn" + (categoryOpen ? " on" : "")}
                aria-expanded={categoryOpen}
                onClick={() => setCategoryOpen((value) => !value)}
              >
                {NOTIFICATION_CATEGORY_LABELS[category]} <i aria-hidden="true">{categoryOpen ? "▴" : "▾"}</i>
              </button>
              {categoryOpen && (
                <div className="notification-cat-menu" role="menu">
                  {CATEGORY_ORDER.map((value) => (
                    <button
                      type="button"
                      key={value}
                      role="menuitemradio"
                      aria-checked={category === value}
                      onClick={() => {
                        setCategory(value);
                        setCategoryOpen(false);
                      }}
                    >
                      {NOTIFICATION_CATEGORY_LABELS[value]}
                      {category === value && <span aria-hidden="true">✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
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
                      {item.author_name || "팀원"} · {fmtWhen(item.created_at)}
                    </span>
                  </span>
                  {item.unread && <span className="notification-unread-dot" aria-label="안읽음" />}
                </button>
              ) : (
                <div key={item.id} className="notification-update-block">
                  <button
                    type="button"
                    className={"notification-item notification-update" + (item.unread ? " unread" : "")}
                    onClick={() => openRelease(item)}
                  >
                    <span className="notification-thumb notification-update-icon" aria-hidden="true">↻</span>
                    <span className="notification-copy">
                      <span className="notification-text">{item.text}</span>
                      <span className="notification-meta">시스템 · {fmtWhen(item.created_at)}</span>
                    </span>
                    {item.unread && <span className="notification-unread-dot" aria-label="안읽음" />}
                  </button>
                  {confirmUpdateId === item.id && (
                    <div className="notification-confirm" role="alertdialog" aria-label="업데이트 확인">
                      <span>v{item.version}(으)로 업데이트하시겠습니까?</span>
                      <span className="notification-confirm-actions">
                        <button type="button" className="yes" onClick={() => void runUpdate(item)}>
                          예, 업데이트
                        </button>
                        <button type="button" onClick={() => setConfirmUpdateId(null)}>나중에</button>
                      </span>
                    </div>
                  )}
                </div>
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
          {updateRun && (
            <div className="notification-progress" role="status">
              {updateRun.active && <span className="notification-progress-spin" aria-hidden="true" />}
              {updateRun.message}
            </div>
          )}
          {error && <div className="notification-error" role="status">{error}</div>}
        </section>
      )}
    </div>
  );
}
