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
const CLOSE_DELAY_MS = 250;

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
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentId = useId();

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimerRef.current = setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, CLOSE_DELAY_MS);
  }, [cancelClose]);

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
    cancelClose();
    updatePosition();
    setOpen(true);
  }, [cancelClose, updatePosition]);

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

  useEffect(() => () => cancelClose(), [cancelClose]);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") {
      cancelClose();
      setOpen(false);
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
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            cancelClose();
            setOpen(false);
            triggerRef.current?.focus();
          }}
        >
          <header className="settings-group-flyout-head">
            <strong>{title}</strong>
            <button
              type="button"
              className="assets-x"
              aria-label={`${title} 닫기`}
              onClick={() => setOpen(false)}
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
    <section
      className={"settings-group" + (open ? " is-open" : "")}
      onMouseEnter={showFlyout}
      onMouseLeave={scheduleClose}
    >
      <button
        ref={triggerRef}
        type="button"
        className="settings-group-toggle"
        aria-expanded={open}
        aria-controls={contentId}
        aria-haspopup="dialog"
        onFocus={showFlyout}
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
