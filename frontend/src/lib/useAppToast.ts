import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { APP_EVENTS } from "./appEvents";
import { useCustomEvent } from "./useCustomEvent";

export function useAppToast(timeoutMs = 2500) {
  // 문자열 외에 JSX 도 허용 — 워크스페이스 전환처럼 일부만 강조(굵게)할 때.
  const [toast, setToast] = useState<ReactNode>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((message: ReactNode) => {
    setToast(message);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setToast(null), timeoutMs);
  }, [timeoutMs]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  useCustomEvent(APP_EVENTS.flash, (event) => {
    const message = (event as CustomEvent<string>).detail;
    if (message) flash(message);
  });

  return { flash, toast };
}
