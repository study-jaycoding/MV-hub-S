import { useSyncExternalStore } from "react";
import { jsonFetch } from "./http";

export const EMBED_MODES = {
  assets: "assets",
  manage: "manage",
} as const;

type EmbedMode = (typeof EMBED_MODES)[keyof typeof EMBED_MODES];

const WINDOW_OPTIONS: Record<EmbedMode, { name: string; features: string }> = {
  assets: {
    name: "contenthub-assets",
    features: "popup=yes,width=1180,height=780,left=140,top=80",
  },
  manage: {
    name: "contenthub-manage",
    features: "popup=yes,width=1180,height=820,left=120,top=60",
  },
};

// 열어둔 창 참조를 기억 → 같은 버튼을 다시 누르면 그 창을 맨 앞으로 올린다(닫지 않음).
// 닫기는 창의 X 버튼으로. 사용자가 창을 직접 닫으면 .closed 가 true 라 다음 클릭에서 새로 연다.
const openWindows: Partial<Record<EmbedMode, Window | null>> = {};

export function openEmbedWindow(mode: EmbedMode): void {
  const existing = openWindows[mode];
  if (existing && !existing.closed) {
    try {
      existing.focus(); // 이미 떠 있으면 앞으로 가져와 바로 조작
    } catch {
      /* same-origin defensive guard */
    }
    return;
  }
  const url = `/?embed=${mode}&v=${Date.now()}`;
  const opts = WINDOW_OPTIONS[mode];
  // window.open 이 이미 url 로 내비게이션한다 — location.href 재대입은 같은 페이지를 두 번
  // 로드시켜(번들 재평가 + 부팅 API 세트 2회) 창 열기를 늦추던 원인이라 제거.
  const w = window.open(url, opts.name, opts.features);
  openWindows[mode] = w;
  if (w) followAppFocus(w);
  refreshOpen();
  try {
    w?.focus();
  } catch {
    /* same-origin defensive guard */
  }
}

// 앱(이 창·별도 창)을 떠났다가 이 창으로 돌아오면 떠 있는 별도 창을 이 창 위로 올린다 — 초점은 이 창에 그대로(Jay 2026-10-26,
// docs/status/별도창_앞으로_2026-10-26.md). 웹은 초점 없이 다른 창을 올리지 못해(opener 의 창.focus() 도 누름이 없으면 아무 일 없음 — 실측)
// 로컬 허브가 Win32 로 올린다. 앱 안에서 옮긴 것(별도 창 ↔ 이 창)에는 올리지 않는다 — 별도 창을 이 창 뒤로 보낼 수 있게.
// 앱 안인지는 '마지막으로 초점을 잃은 때(이 창·별도 창의 blur)'에서 이 창 focus 까지의 틈으로 가른다 — 창 사이를 옮기면 blur 바로 뒤에 focus 가
// 오고, 다른 프로그램에 다녀오면 길다. 타이머로 재지 않는다(가려진 창의 타이머는 크롬이 1초 단위로 늦춰, 빨리 돌아오면 놓쳤다 — 실측).
// shortcut: 별도 창을 새로 고치면 이 창이 단 blur 듣기가 없어져 그 창 → 이 창도 '다녀옴'으로 보고 올린다(창을 다시 열면 다시 단다) — 문제가 되면 별도 창이 스스로 알리게.
const INSIDE_MS = 300;
let lastBlurAt = 0;
let following = false;

function noteBlur(): void {
  lastBlurAt = Date.now();
}

function raisePopups(): void {
  if (Date.now() - lastBlurAt < INSIDE_MS) return; // 별도 창 → 이 창(앱 안)
  const titles = Object.values(openWindows).flatMap((w) => {
    try {
      return w && !w.closed && w.document.title ? [w.document.title] : [];
    } catch {
      return [];
    }
  });
  if (!titles.length) return;
  void jsonFetch("/api/app-windows/raise", { method: "POST", body: JSON.stringify({ main: document.title, titles }) })
    .catch(() => {}); // 못 올려도(허브가 옛 판·윈도우가 아님) 지금처럼 그대로
}

function followAppFocus(w: Window): void {
  try {
    w.addEventListener("blur", noteBlur);
  } catch {
    /* same-origin defensive guard */
  }
  if (following) return;
  following = true;
  window.addEventListener("blur", noteBlur);
  window.addEventListener("focus", raisePopups);
}

// 머리줄 단추가 '그 창이 떠 있는 동안' 켜져 보이게 한다(Jay 2026-10-26). 창이 닫혔다는 신호가 따로 없어,
// 창이 하나라도 떠 있고 보는 단추가 있는 동안만 0.5초마다 .closed 를 본다.
// shortcut: 메인 창을 새로 고치면 창 참조를 잃어 떠 있는 창도 꺼져 보인다(다시 누르면 켜짐) — 이어져야 하면 창이 스스로 알리는 BroadcastChannel 로.
const openListeners = new Set<() => void>();
const lastOpen: Partial<Record<EmbedMode, boolean>> = {};
let openWatch: ReturnType<typeof setInterval> | null = null;

function isEmbedWindowOpen(mode: EmbedMode): boolean {
  const w = openWindows[mode];
  return !!w && !w.closed;
}

function refreshOpen(): void {
  let changed = false;
  let anyOpen = false;
  for (const mode of Object.values(EMBED_MODES)) {
    const open = isEmbedWindowOpen(mode);
    if (open !== !!lastOpen[mode]) changed = true;
    lastOpen[mode] = open;
    if (open) anyOpen = true;
  }
  if (anyOpen && openListeners.size && !openWatch) openWatch = setInterval(refreshOpen, 500);
  if ((!anyOpen || !openListeners.size) && openWatch) {
    clearInterval(openWatch);
    openWatch = null;
  }
  if (changed) openListeners.forEach((listener) => listener());
}

function subscribeOpen(listener: () => void): () => void {
  openListeners.add(listener);
  refreshOpen();
  return () => {
    openListeners.delete(listener);
    refreshOpen();
  };
}

// 머리줄 단추를 켜진 채 다시 누르면 그 창을 닫는다(Jay 2026-10-26). 다른 자리의 '열기'는 지금처럼 앞으로 가져오기만 한다.
export function closeEmbedWindow(mode: EmbedMode): void {
  const w = openWindows[mode];
  try {
    if (w && !w.closed) w.close();
  } catch {
    /* same-origin defensive guard */
  }
  refreshOpen();
}

export function useEmbedWindowOpen(mode: EmbedMode): boolean {
  return useSyncExternalStore(subscribeOpen, () => !!lastOpen[mode]); // 확인해 둔 값 — 그리는 도중 .closed 가 바뀌어도 한 번의 그리기 안에서는 같다
}
