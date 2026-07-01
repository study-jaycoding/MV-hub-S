import { useCallback, useEffect, useRef, useState } from "react";
import { APP_EVENTS } from "./appEvents";
import { useCustomEvent } from "./useCustomEvent";

export function useAppToast(timeoutMs = 2500) {
  const [toast, setToast] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((message: string) => {
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
