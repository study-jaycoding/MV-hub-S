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
    const contentHeight = Math.min(
      flyoutRef.current?.scrollHeight ?? availableHeight,
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

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") {
      closeFlyout();
      return;
    }
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
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            closeFlyout();
            triggerRef.current?.focus();
          }}
        >
          <header className="settings-group-flyout-head">
            <strong>{title}</strong>
            <button
              type="button"
              className="assets-x"
              aria-label={`${title} 닫기`}
              onClick={closeFlyout}
            >
              ✕
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
