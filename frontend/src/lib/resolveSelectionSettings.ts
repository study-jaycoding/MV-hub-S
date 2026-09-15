import { useSyncExternalStore } from "react";
import { APP_EVENTS, dispatchAppEvent } from "./appEvents";
import { STORAGE_KEYS } from "./storageKeys";

let unsavedValue: boolean | undefined;

export function loadResolveSelectionFollow(): boolean {
  if (unsavedValue !== undefined) return unsavedValue;
  try {
    return localStorage.getItem(STORAGE_KEYS.resolveSelectionFollow) !== "0";
  } catch {
    return true;
  }
}

export function saveResolveSelectionFollow(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEYS.resolveSelectionFollow, enabled ? "1" : "0");
    unsavedValue = undefined;
  } catch {
    // 저장이 차단돼도 현재 창에서는 설정을 즉시 적용한다.
    unsavedValue = enabled;
  }
  dispatchAppEvent(APP_EVENTS.resolveSelectionSettingsChanged);
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === STORAGE_KEYS.resolveSelectionFollow) {
      unsavedValue = undefined;
      onChange();
    }
  };
  window.addEventListener(APP_EVENTS.resolveSelectionSettingsChanged, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(APP_EVENTS.resolveSelectionSettingsChanged, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function useResolveSelectionFollow(): boolean {
  return useSyncExternalStore(subscribe, loadResolveSelectionFollow, () => true);
}
