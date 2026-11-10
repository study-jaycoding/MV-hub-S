// 코멘트 창 '창 밖으로'(Jay 2026-11-10) — 크롬의 떠 있는 작은 창(Document Picture-in-Picture)에 같은 화면 부품을 옮겨 그린다.
//  브라우저 밖 어디로든 옮길 수 있고 늘 다른 창 위에 뜬다. 같은 문서라 앱 상태(고른 카드·쓰던 글)가 그대로 이어진다.
//  창은 이 문서에 하나 — 묶음(id: 생성물 "gen" · 파일 "asset")이 쥐고, Assets 처럼 패널을 새로 만들면 옛 패널이 닫기를 예약하고 새 패널이 이어받는다.
//  크롬은 안전한 주소(https·이 PC)에서만 연다 — 서버 주소 직결(LAN http) 화면은 단추를 숨긴다.
//  기록 docs/status/코멘트창_띄우기_2026-11-10.md
import { useSyncExternalStore } from "react";

interface PipApi {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}
const pipApi = (): PipApi | null =>
  typeof window !== "undefined" && window.isSecureContext
    ? (window as unknown as { documentPictureInPicture?: PipApi }).documentPictureInPicture ?? null
    : null;

export const commentPipSupported = (): boolean => !!pipApi();

// 띄워서 보기 — ✕ 로 닫아도 기억해 다음 코멘트 창도 띄운다. [앱 안으로]·띄운 창을 직접 닫으면 지운다.
const PREF_KEY = "ch.cmt.pip";
export function prefersCommentPip(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === "1";
  } catch {
    return false;
  }
}
function setPref(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? "1" : "0");
  } catch {
    /* 기억만 못 한다 */
  }
}

let win: Window | null = null;
let owner: string | null = null;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

// 앱 스타일을 떠 있는 창에 — 파일로 읽은 것은 같은 주소(절대)로, 페이지 안 스타일(개발 서버)은 규칙 글로 옮긴다.
function copyStyles(target: Document): void {
  for (const sheet of Array.from(document.styleSheets)) {
    if (sheet.href) {
      const link = target.createElement("link");
      link.rel = "stylesheet";
      link.href = sheet.href;
      if (sheet.media.mediaText) link.media = sheet.media.mediaText;
      target.head.appendChild(link);
      continue;
    }
    try {
      const style = target.createElement("style");
      style.textContent = Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n");
      target.head.appendChild(style);
    } catch {
      /* 읽을 수 없는 시트는 건너뛴다 */
    }
  }
  target.documentElement.className = document.documentElement.className; // 모션 끄기 등 앱 전체 표시
  target.body.className = document.body.className;
  target.body.style.margin = "0";
}

function drop(): void {
  win = null;
  owner = null;
  emit();
}

/** 떠 있는 창을 연다(이미 있으면 이 묶음이 가져간다). 누름 없이 부르면(다시 열 때 자동) 크롬이 거절한다 — false, 앱 안 그대로. */
export async function openCommentPip(id: string, size: { width: number; height: number }): Promise<boolean> {
  clearTimeout(releaseTimer);
  if (win && !win.closed) {
    owner = id;
    emit();
    return true;
  }
  const api = pipApi();
  if (!api) return false;
  try {
    const opened = await api.requestWindow({ width: Math.max(320, Math.round(size.width)), height: Math.max(240, Math.round(size.height)) });
    copyStyles(opened.document);
    opened.document.title = "코멘트";
    opened.addEventListener("pagehide", () => {
      if (win !== opened) return; // 앱이 닫았다 — 이미 치웠다
      setPref(false); // 사용자가 띄운 창을 닫았다(✕·탭으로 돌아가기) — 코멘트 창은 앱 안으로, 다음에도 앱 안
      drop();
    });
    win = opened;
    owner = id;
    setPref(true);
    emit();
    return true;
  } catch {
    return false;
  }
}

function closeWindow(): void {
  clearTimeout(releaseTimer);
  const w = win;
  if (!w) return;
  drop();
  try {
    w.close();
  } catch {
    /* 이미 닫혔다 */
  }
}

/** [앱 안으로] — 코멘트 창을 앱 안으로 돌리고 다음에도 앱 안에서 연다. */
export function returnCommentPip(id: string): void {
  if (owner !== id) return;
  setPref(false);
  closeWindow();
}

/** 쥔 패널이 사라진다(✕·대상마다 새 패널) — 닫기를 예약한다. 같은 묶음의 새 패널이 바로 이어받으면(claim) 닫지 않는다. '띄워서 보기'는 남는다. */
export function releaseCommentPip(id: string): void {
  if (owner !== id || !win) return;
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(closeWindow, 0);
}

/** 새로 만든 같은 묶음의 패널 — 예약된 닫기를 거두고 이어받는다. 이어받았으면 true. */
export function claimCommentPip(id: string): boolean {
  if (owner !== id || !win) return false;
  clearTimeout(releaseTimer);
  return true;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 이 묶음이 쥔 떠 있는 창(없으면 null). */
export function useCommentPipWindow(id: string | undefined): Window | null {
  return useSyncExternalStore(subscribe, () => (id && owner === id ? win : null));
}
