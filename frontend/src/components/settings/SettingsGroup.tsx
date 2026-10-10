import { useEscapeClose } from "../../lib/useEscapeClose";
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
import { CloseIcon } from "../common/ViewIcons";

const FLYOUT_GAP = 8;
const FLYOUT_WIDTH = 330;
const VIEWPORT_MARGIN = 8;

// 패널은 클릭으로 열고 ✕/Esc 로만 닫는다(호버 여닫음 없음 — Jay 요청).
// 동시에 한 그룹만 열리게 모듈 수준에서 조율 — 다른 그룹이 열리는 순간 이전 패널을
// 즉시 닫아 두 패널이 겹쳐 보이던 문제를 없앤다.
let closeActiveFlyout: (() => void) | null = null;

export function SettingsGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [flyoutStyle, setFlyoutStyle] = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const flyoutRef = useRef<HTMLElement>(null);
  const contentId = useId();
  const instanceClose = useRef(() => setOpen(false));

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const width = Math.min(FLYOUT_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
    let left = rect.left - width - FLYOUT_GAP;

    // 설정 창이 화면 왼쪽에 있을 때만 반대편으로 연다.
    if (left < VIEWPORT_MARGIN) left = rect.right + FLYOUT_GAP;
    left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(left, window.innerWidth - width - VIEWPORT_MARGIN),
    );

    const availableHeight = window.innerHeight - VIEWPORT_MARGIN * 2;
    const flyout = flyoutRef.current;
    // 패널의 바깥 높이 = 내용 + 테두리. 테두리를 빼면 아래의 높이 한도가 그만큼 모자라, 다 들어가는 패널에도 스크롤바가 생긴다.
    const contentHeight = Math.min(
      flyout ? flyout.scrollHeight + flyout.offsetHeight - flyout.clientHeight : availableHeight,
      availableHeight,
    );
    const top = Math.max(
      VIEWPORT_MARGIN,
      Math.min(rect.top, window.innerHeight - contentHeight - VIEWPORT_MARGIN),
    );

    setFlyoutStyle({
      left,
      top,
      width,
      // 높이 한도는 이 자리 아래에 남은 높이다 — CSS 의 한도(화면 전체)만으로는, 열린 뒤 내용이 늘면 다음 스크롤·창 크기 변경까지
      //  아래가 화면 밖으로 잘렸다(2026-10-10 실측: 1100×700 에서 156px). 넘치는 만큼은 패널 안에서 스크롤한다(CSS overflow-y).
      maxHeight: window.innerHeight - top - VIEWPORT_MARGIN,
    });
  }, []);

  const showFlyout = useCallback(() => {
    if (closeActiveFlyout && closeActiveFlyout !== instanceClose.current) {
      closeActiveFlyout();
    }
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

  // 언마운트(설정 창 닫힘) 시 조율 등록을 정리해 닫힌 인스턴스로의 호출을 막는다.
  useEffect(
    () => () => {
      if (closeActiveFlyout === instanceClose.current) closeActiveFlyout = null;
    },
    [],
  );

  // Esc 는 옆 패널만 닫는다 — 초점이 패널 밖(설정 창의 다른 칸)에 있어도 설정 창까지 닫히지 않는다(2026-10-10 실측).
  useEscapeClose(
    () => {
      closeFlyout();
      triggerRef.current?.focus();
    },
    open,
    true,
    true,
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      showFlyout();
    }
  };

  const flyout = open && typeof document !== "undefined"
    ? createPortal(
        <aside
          ref={flyoutRef}
          className="settings-group-flyout"
          id={contentId}
          role="dialog"
          aria-label={title}
          style={flyoutStyle}
        >
          <header className="settings-group-flyout-head">
            <strong>{title}</strong>
            <button
              type="button"
              className="assets-x"
              aria-label={`${title} 닫기`}
              onClick={closeFlyout}
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
    <section className={"settings-group" + (open ? " is-open" : "")}>
      <button
        ref={triggerRef}
        type="button"
        className="settings-group-toggle"
        aria-expanded={open}
        aria-controls={contentId}
        aria-haspopup="dialog"
        onClick={showFlyout}
        onKeyDown={handleKeyDown}
      >
        <span>{title}</span>
        <span className="settings-group-chevron" aria-hidden="true">‹</span>
      </button>
      {flyout}
    </section>
  );
}
