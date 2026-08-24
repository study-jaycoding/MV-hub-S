import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { fmtWhen, timestampMs } from "../lib/format";
import { getLang, useT } from "../lib/i18n";
import { isRouteMissing } from "../lib/http";
import { displayThumb, hideBrokenImg, showLoadedImg } from "../lib/media";
import {
  filterNotificationItems,
  filterNotificationsByCategory,
  markAllReleaseNotificationsRead,
  markNotificationListRead,
  markReleaseNotificationRead,
  mergeReleaseAnnouncementNotifications,
  notificationBadgeText,
  NOTIFICATION_CATEGORY_LABELS,
  releaseNotificationAction,
  serverRelocationNotification,
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
import { sharedApi } from "../lib/sharedApi";
import { updateNoticeApi } from "../lib/updateNotices";
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
  const t = useT();
  // 알림 본문(코멘트 내용)은 사용자 데이터라 그대로 두고, UI 문구·날짜만 언어를 따른다.
  const dateLocale = getLang() === "en" ? "en-US" : "ko-KR";
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
  // 이사 전환은 확인창 없이 곧바로 실행되므로, 진행·실패를 그 알림 자리에 붙여 보여준다
  // (성공하면 화면이 통째로 새로고침되므로 남는 것은 실패 문구뿐이다).
  const [relocateRun, setRelocateRun] = useState<
    { id: string; busy: boolean; message: string } | null
  >(null);
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
      if (showLoading) setError(t("알림 목록은 백엔드 업데이트 후 사용할 수 있습니다."));
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
      if (showLoading) setError(t("코멘트 알림을 불러오지 못했습니다."));
    } finally {
      if (seq === commentsLoadSeqRef.current) setLoading(false);
    }
  }, [commentUnreadCount, t]);

  // 시스템(로컬 업데이트 상태 + 관리자 업데이트 공지 + 공유 서버 이사)을 함께 갱신한다.
  // 한쪽이 실패해도 다른 쪽 알림은 살린다(업데이트 실패 시엔 직전 목록을 유지).
  const loadReleaseItems = useCallback(() => {
    const updates = getReleaseUpdateStatus(true)
      .then((status) => ({ ok: true as const, value: syncReleaseNotifications(status, window.localStorage) }))
      .catch(() => ({ ok: false as const })); // 공유 서버 직결·개발 설치본은 로컬 업데이트 API가 없다 — 직전값 유지
    const relocation = sharedApi
      .sharedServerRelocation()
      .then((info) => ({ ok: true as const, value: serverRelocationNotification(info, window.sessionStorage) }))
      .catch(() => ({ ok: false as const })); // 구버전 백엔드·비 릴리스 설치본 — 직전값 유지
    const announcements = updateNoticeApi.list()
      .then((items) => ({ ok: true as const, value: items }))
      .catch(() => ({ ok: false as const })); // 구 공유 서버는 기능 미지원 — 직전값 유지
    void Promise.all([updates, relocation, announcements]).then(([localResult, moveResult, noticeResult]) => {
      setReleaseItems((current) => {
        const localItems = localResult.ok ? localResult.value : current.filter(
          (item) => item.kind !== "relocation" && item.kind !== "announcement",
        );
        const serverNotices = noticeResult.ok ? noticeResult.value : current
          .filter((item) => item.kind === "announcement")
          .map((item) => ({
            id: item.noticeId || "",
            version: item.version,
            file: "",
            released_at: item.created_at,
            pinned: false,
            announcement_revision: item.noticeRevision || 0,
            announced_at: item.created_at,
            unread: item.unread,
          }));
        const updateItems = mergeReleaseAnnouncementNotifications(localItems, serverNotices);
        const moved = moveResult.ok
          ? moveResult.value
          : current.find((item) => item.kind === "relocation") || null;
        return moved ? [moved, ...updateItems] : updateItems;
      });
    });
  }, []);

  // 릴리스(시스템) 소식 + 경량 코멘트 배지(stats)는 닫혀 있어도 60초마다 확인한다.
  // ★배지 폴링 보강(코덱스): 라이브러리 자동 리로드는 compose 탭·유휴 my 탭에선 돌지 않아
  // stats props 만으로는 벨 숫자가 무기한 낡을 수 있다. 탭과 무관한 stats 전용 API
  // (/generations-stats — 본문·썸네일 없는 집계만)로 가볍게 보강한다. 실패는 조용히 무시
  // (props·다음 주기가 폴백). 상세 목록(notificationComments)은 여전히 열림 동안만.
  useEffect(() => {
    const refreshBadge = () => {
      loadReleaseItems();
      api
        .generationStats()
        .then((stats) => {
          setUnreadComments((previous) => {
            if (typeof stats.unread_count === "number") return stats.unread_count; // 신백엔드: 정확 수
            if (stats.has_unread) return Math.max(previous, 1); // 구백엔드: 존재만 표시
            return 0;
          });
        })
        .catch(() => {});
    };
    refreshBadge();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") refreshBadge();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [loadReleaseItems]);

  // 코멘트 '상세 목록'(본문·썸네일 payload)은 패널이 열려 있을 때만 조회한다(R4 A-4).
  // 닫힌 동안의 벨 숫자는 ①stats props(라이브러리 리로드 — 단 compose·유휴 my 탭에선 안 돎)
  // ②위의 탭 무관 경량 stats 60초 폴링이 함께 담당한다(최장 60초 지연은 허용 계약 —
  // 숨은 탭 복귀 시엔 다음 주기에 갱신). 열리는 순간의 최초 로드는 openPanel 의
  // loadComments(true)가 담당하고, 이 효과는 '열린 동안'의 60초 재갱신만 맡는다.
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void loadComments(false);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [open, loadComments]);

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
      if (!value) {
        void loadComments(true);
        loadReleaseItems();
      }
      return !value;
    });
  };

  // 업데이트 알림 본문은 저장된 한국어 원문 대신 표시 시점 언어로 조립한다(버전은 치환).
  const releaseText = (item: ReleaseNotification) => {
    if (item.kind === "relocation") {
      // 이름이 등록돼 있으면 이름만 — 주소는 이름이 없을 때만 드러낸다. 확인창이 없으므로
      // '누르면 무슨 일이 일어나는지'를 이 한 줄이 반드시 담는다.
      return item.serverName
        ? t("'{name}' 서버가 새 위치로 이동했습니다. 누르면 전환되고 다시 로그인합니다.")
            .replace("{name}", item.serverName)
        : t("공유 서버가 새 주소로 이사했습니다: {url}. 누르면 전환되고 다시 로그인합니다.")
            .replace("{url}", item.url || "");
    }
    if (item.kind === "announcement") {
      return t("{v} 업데이트가 등록되었습니다").replace("{v}", `v${item.version}`);
    }
    return (item.kind === "available"
      ? t("새 버전 {v} 사용 가능")
      : t("{v}로 업데이트되었습니다")
    ).replace("{v}", `v${item.version}`);
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
          ? markReleaseNotificationRead(candidate, window.localStorage, window.sessionStorage)
          : candidate,
      ),
    );
    if (item.kind === "announcement" && item.noticeId && item.noticeRevision) {
      void updateNoticeApi.seen(item.noticeId, item.noticeRevision).catch(() => loadReleaseItems());
    }
    // 이사=클릭 즉시 전환(확인창 없음), 새 버전=그 자리에서 한 번 더 묻기. 판정은 한곳(lib).
    const action = releaseNotificationAction(
      item.kind,
      !!updateRun?.active || !!relocateRun?.busy,
    );
    if (action === "relocate") void runRelocate(item);
    else if (action === "confirm") setConfirmUpdateId((current) => (current === item.id ? null : item.id));
  };

  // 공유 서버 주소 전환 — 백엔드가 공지를 다시 읽어 재검증한 뒤 주소를 바꾸고 로그아웃시킨다.
  // 성공하면 새 주소 기준으로 다시 로그인해야 하므로 화면을 통째로 새로 연다.
  // 실패하면(공지 변경·새 주소 무응답 등) 전환은 일어나지 않는다 — 사유를 그 알림 자리에
  // 남겨, 옛 주소를 그대로 쓰고 있다는 사실이 드러나게 한다.
  const runRelocate = async (item: ReleaseNotification) => {
    if (!item.url) return;
    setRelocateRun({ id: item.id, busy: true, message: t("공유 서버 주소를 전환하는 중…") });
    try {
      await sharedApi.sharedServerRelocate(item.url, Number(item.version));
    } catch (relocateError) {
      setRelocateRun({
        id: item.id,
        busy: false,
        message: `${t("전환하지 못했습니다 — 옛 주소를 그대로 씁니다")}: ${String((relocateError as Error)?.message || relocateError)}`,
      });
      return;
    }
    window.location.reload();
  };

  const runUpdate = async (item: ReleaseNotification) => {
    setConfirmUpdateId(null);
    setUpdateRun({ active: true, message: t("업데이트 실행기를 준비하는 중…") });
    try {
      await startReleaseUpdate();
    } catch (startError) {
      setUpdateRun({
        active: false,
        message: `${t("업데이트를 시작하지 못했습니다")}: ${String((startError as Error)?.message || startError)}`,
      });
      return;
    }
    const startedAt = Date.now();
    stopUpdatePoll();
    updatePollRef.current = window.setInterval(() => {
      if (Date.now() - startedAt > 15 * 60_000) {
        stopUpdatePoll();
        setUpdateRun({
          active: false,
          message: t("업데이트 확인이 오래 걸립니다 — 설정의 업데이트 섹션에서 상태를 확인하세요."),
        });
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
                ? t("{v} 업데이트가 완료됐습니다. 새 버전으로 다시 시작됩니다.").replace(
                    "{v}",
                    `v${item.version}`,
                  )
                : releaseUpdateMessage(status) || t("업데이트 상태를 확인하세요."),
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
    const hasUnreadUpdateNotices = releaseItems.some(
      (item) => item.kind === "announcement" && item.unread,
    );
    if (hasUnreadUpdateNotices) {
      try {
        await updateNoticeApi.seenAll();
      } catch {
        setError(t("업데이트 알림을 모두 읽음 처리하지 못했습니다."));
        setBusy(false);
        return;
      }
    }
    setReleaseItems((current) =>
      markAllReleaseNotificationsRead(current, window.localStorage, window.sessionStorage),
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
        setError(t("코멘트 알림을 모두 읽음 처리하지 못했습니다."));
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
        aria-label={unreadTotal ? `${t("알림 센터")} ${unreadTotal}` : t("알림 센터")}
        aria-expanded={open}
        title={t("알림 센터")}
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
        <section className="notification-panel" aria-label={t("알림 센터")}>
          <header className="notification-head">
            {/* 카테고리 드롭다운 — 전체 알림 / 코멘트 / 시스템(업데이트) */}
            <div className="notification-cat">
              <button
                type="button"
                className={"notification-cat-btn" + (categoryOpen ? " on" : "")}
                aria-expanded={categoryOpen}
                onClick={() => setCategoryOpen((value) => !value)}
              >
                {t(NOTIFICATION_CATEGORY_LABELS[category])} <i aria-hidden="true">{categoryOpen ? "▴" : "▾"}</i>
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
                      {t(NOTIFICATION_CATEGORY_LABELS[value])}
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
              {busy ? t("처리 중…") : t("모두 읽음")}
            </button>
          </header>
          <div className="notification-tabs" role="tablist">
            <button className={tab === "all" ? "on" : ""} onClick={() => setTab("all")}>
              {t("전체")}
            </button>
            <button className={tab === "unread" ? "on" : ""} onClick={() => setTab("unread")}>
              {t("안읽음")} {unreadTotal}
            </button>
          </div>
          <div className="notification-list">
            {loading && !allItems.length ? (
              <div className="notification-empty">{t("알림을 불러오는 중…")}</div>
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
                      {item.author_name || t("팀원")} · {fmtWhen(item.created_at, dateLocale)}
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
                    <span className="notification-thumb notification-update-icon" aria-hidden="true">
                      {item.kind === "relocation" ? "⇄" : "↻"}
                    </span>
                    <span className="notification-copy">
                      <span className="notification-text">{releaseText(item)}</span>
                      <span className="notification-meta">
                        {t("시스템")} · {fmtWhen(item.created_at, dateLocale)}
                      </span>
                    </span>
                    {item.unread && <span className="notification-unread-dot" aria-label="안읽음" />}
                  </button>
                  {confirmUpdateId === item.id && (
                    <div className="notification-confirm" role="alertdialog" aria-label={t("알림 센터")}>
                      <span>
                        {t("{v}(으)로 업데이트하시겠습니까?").replace("{v}", `v${item.version}`)}
                      </span>
                      <span className="notification-confirm-actions">
                        <button type="button" className="yes" onClick={() => void runUpdate(item)}>
                          {t("예, 업데이트")}
                        </button>
                        <button type="button" onClick={() => setConfirmUpdateId(null)}>
                          {t("나중에")}
                        </button>
                      </span>
                    </div>
                  )}
                  {relocateRun?.id === item.id && (
                    <div className="notification-confirm notification-inline-status" role="status">
                      {relocateRun.busy && (
                        <span className="notification-progress-spin" aria-hidden="true" />
                      )}
                      <span>{relocateRun.message}</span>
                    </div>
                  )}
                </div>
              ))
            ) : (
              <div className="notification-empty">
                {tab === "unread" ? t("새 알림이 없습니다.") : t("최근 알림이 없습니다.")}
              </div>
            )}
          </div>
          {hiddenUnreadComments > 0 && (
            <div className="notification-range-hint">
              {t("목록 범위 밖 미확인 코멘트 {n}개 · 모두 읽음으로 정리할 수 있습니다.").replace(
                "{n}",
                String(hiddenUnreadComments),
              )}
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
