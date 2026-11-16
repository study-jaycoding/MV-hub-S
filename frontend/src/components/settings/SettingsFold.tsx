import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useEscapeClose } from "../../lib/useEscapeClose";
import { CloseIcon } from "../common/ViewIcons";

const FLYOUT_GAP = 8;
const FLYOUT_WIDTH = 330;
const VIEWPORT_MARGIN = 8;

// 한 번에 옆 창 하나 — 다른 항목을 누르는 순간 앞 옆 창을 닫아 두 창이 겹치지 않게 한다.
let closeActiveFlyout: (() => void) | null = null;

// 설정 창 묶음 목록의 한 줄(Jay 2026-11-16 '같은 창에서 목록, 항목은 옆 창') — 누르면 그 항목 칸만 담은 옆 창을 설정 창 옆에 연다.
//  제목 밑 summary 는 늘 보인다("실시간 정보는 접기 밖" 규칙, Jay 08-20).
//  옆 창은 숨긴 채 늘 붙여 둔다 — 칸들의 상태 불러오기(Resolve·Comfy·Slack 조회)와 상태 줄(onSummary)이 열기 전에도 돈다.
//  hideFirstTitle = 옆 창 제목과 같은 첫 칸의 제목(h4)을 숨긴다(ComfyUI 안의 'ComfyUI' 등).
export function SettingsFold({
  title,
  summary,
  hideFirstTitle,
  children,
}: {
  title: string;
  summary?: ReactNode;
  hideFirstTitle?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [flyoutStyle, setFlyoutStyle] = useState<CSSProperties>({});
  const headRef = useRef<HTMLButtonElement>(null);
  const flyoutRef = useRef<HTMLElement>(null);
  const panelId = useId();
  const instanceClose = useRef(() => setOpen(false));

  const updatePosition = useCallback(() => {
    const head = headRef.current;
    if (!head) return;
    // 설정 창이 있으면 그 옆·그 위 끝에 맞춘다(시안 ③). 창 밖에서 쓰이면 줄 옆에 연다.
    const anchor = head.closest<HTMLElement>(".settings-float") ?? head;
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(FLYOUT_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
    let left = rect.left - width - FLYOUT_GAP;
    // 설정 창이 화면 왼쪽에 있을 때만 반대편으로 연다.
    if (left < VIEWPORT_MARGIN) left = rect.right + FLYOUT_GAP;
    left = Math.max(VIEWPORT_MARGIN, Math.min(left, window.innerWidth - width - VIEWPORT_MARGIN));

    const availableHeight = window.innerHeight - VIEWPORT_MARGIN * 2;
    const flyout = flyoutRef.current;
    // 옆 창의 바깥 높이 = 내용 + 테두리. 테두리를 빼면 아래 높이 한도가 그만큼 모자라 다 들어가는 창에도 스크롤바가 생긴다.
    const contentHeight = Math.min(
      flyout ? flyout.scrollHeight + flyout.offsetHeight - flyout.clientHeight : availableHeight,
      availableHeight,
    );
    const top = Math.max(VIEWPORT_MARGIN, Math.min(rect.top, window.innerHeight - contentHeight - VIEWPORT_MARGIN));
    // 높이 한도는 이 자리 아래에 남은 높이다 — 열린 뒤 내용이 늘어도 아래가 화면 밖으로 잘리지 않고 창 안에서 스크롤한다(2026-10-10 실측).
    setFlyoutStyle({ left, top, width, maxHeight: window.innerHeight - top - VIEWPORT_MARGIN });
  }, []);

  const showFlyout = useCallback(() => {
    if (closeActiveFlyout && closeActiveFlyout !== instanceClose.current) closeActiveFlyout();
    closeActiveFlyout = instanceClose.current;
    updatePosition();
    setOpen(true);
  }, [updatePosition]);

  const closeFlyout = useCallback(() => {
    if (closeActiveFlyout === instanceClose.current) closeActiveFlyout = null;
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  // 언마운트(목록을 떠나거나 설정 창을 닫음) 때 조율 등록을 정리해 닫힌 줄로의 호출을 막는다.
  useEffect(() => () => {
    if (closeActiveFlyout === instanceClose.current) closeActiveFlyout = null;
  }, []);

  // Esc 는 옆 창만 닫는다 — 초점이 설정 창의 다른 칸에 있어도 설정 창까지 닫히지 않는다(2026-10-10 실측).
  useEscapeClose(() => {
    closeFlyout();
    headRef.current?.focus();
  }, open, true, true);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      showFlyout();
    }
  };

  const flyout = typeof document !== "undefined"
    ? createPortal(
        <aside
          ref={flyoutRef}
          className={"settings-group-flyout" + (hideFirstTitle ? " hide-first-title" : "")}
          id={panelId}
          role="dialog"
          aria-label={title}
          style={flyoutStyle}
          hidden={!open}
        >
          <header className="settings-group-flyout-head">
            <strong>{title}</strong>
            <button
              type="button"
              className="assets-x"
              aria-label={`${title} 닫기`}
              onClick={() => {
                closeFlyout();
                headRef.current?.focus();
              }}
            >
              <CloseIcon />
            </button>
          </header>
          <div className="settings-group-content">{children}</div>
        </aside>,
        document.body,
      )
    : null;

  return (
    <div className={"settings-fold" + (open ? " is-open" : "")}>
      <button
        ref={headRef}
        type="button"
        className="settings-fold-head"
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="dialog"
        onClick={() => (open ? closeFlyout() : showFlyout())}
        onKeyDown={handleKeyDown}
      >
        <span className="settings-fold-text">
          <span className="settings-fold-title">{title}</span>
          {summary ? <span className="settings-fold-summary">{summary}</span> : null}
        </span>
        <span className="settings-fold-chev" aria-hidden="true">›</span>
      </button>
      {flyout}
    </div>
  );
}
