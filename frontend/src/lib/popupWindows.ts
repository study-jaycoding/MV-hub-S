import { useSyncExternalStore } from "react";
import { jsonFetch } from "./http";

export const EMBED_MODES = {
  assets: "assets",
  manage: "manage",
  canvas: "canvas", // 앱 전체를 캔버스 탭으로 — 씬을 쓰므로 main.tsx 가 보통 앱처럼 저장소를 부팅해 띄운다
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
  canvas: {
    name: "contenthub-canvas",
    features: "popup=yes,width=1440,height=900,left=100,top=40",
  },
};

// 캔버스 탭을 휠 클릭해 연 창인가 — 창 이름은 새로 고쳐도 남는다
export function isCanvasWindow(): boolean {
  return window.name === WINDOW_OPTIONS.canvas.name;
}

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
  if (window.name === opts.name) return; // 이 창이 그 창이다 — 같은 이름으로 열면 제 창을 다시 읽는다
  // 떠 있는 캔버스 창의 참조를 잃었다(이 창을 새로 고침) — 주소를 주면 그 창을 다시 읽으니 빈 주소로 그 창만 잡는다
  const reacquire = mode === EMBED_MODES.canvas && canvasFloating;
  // window.open 이 이미 url 로 내비게이션한다 — location.href 재대입은 같은 페이지를 두 번
  // 로드시켜(번들 재평가 + 부팅 API 세트 2회) 창 열기를 늦추던 원인이라 제거.
  const w = window.open(reacquire ? "" : url, opts.name, opts.features);
  try {
    if (reacquire && w && w.location.href === "about:blank") w.location.href = url; // 사실은 닫혀 있었다 — 새 빈 창에 한 번만 싣는다
  } catch {
    /* same-origin defensive guard */
  }
  openWindows[mode] = w;
  if (mode === EMBED_MODES.canvas && w) setCanvasFloating(true); // 창이 켜져 알리기 전에도 이 창의 캔버스는 바로 비킨다
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

// 캔버스 창이 떠 있는가(Jay 2026-10-30, docs/status/캔버스_떠있는창_2026-10-30.md) — 떠 있는 동안 메인 창의 캔버스 자리는 알림만 보이고
// 탭 옆에 표시가 붙는다. 창 참조로는 메인 창을 새로 고치면 모르므로(위 shortcut) 캔버스 창이 스스로 알린다:
// 켜질 때·물으면 "open", 닫히거나 새로 고칠 때(pagehide) "closed". 메인 창은 켜질 때 한 번 묻는다.
const CANVAS_CHANNEL = "mvhub-canvas-window";
const RELOAD_GRACE_MS = 300; // "closed" 뒤 이 창이 연 창이 아직 살아 있으면 새로 고침이다 — 닫힘이 .closed 에 비치기를 기다리는 틈

export function announceCanvasWindow(): void {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(CANVAS_CHANNEL);
  channel.onmessage = (event) => {
    if (event.data === "ping") channel.postMessage("open");
  };
  channel.postMessage("open");
  window.addEventListener("pagehide", () => channel.postMessage("closed"));
}

let canvasFloating = false;
const floatingListeners = new Set<() => void>();
let floatingChannel: BroadcastChannel | null = null;
let closedTimer: ReturnType<typeof setTimeout> | undefined;

function setCanvasFloating(next: boolean): void {
  clearTimeout(closedTimer);
  if (next === canvasFloating) return;
  canvasFloating = next;
  floatingListeners.forEach((listener) => listener());
}

function onCanvasMessage(event: MessageEvent): void {
  if (event.data === "open") setCanvasFloating(true);
  else if (event.data === "closed") {
    clearTimeout(closedTimer);
    // 참조가 없으면(이 창을 새로 고친 뒤) 닫힌 것으로 본다 — 새로 고침이었다면 그 창이 켜지며 "open" 으로 다시 띄운다
    closedTimer = setTimeout(() => {
      if (!isEmbedWindowOpen(EMBED_MODES.canvas)) setCanvasFloating(false);
    }, RELOAD_GRACE_MS);
  }
}

function subscribeCanvasFloating(listener: () => void): () => void {
  floatingListeners.add(listener);
  if (!floatingChannel && typeof BroadcastChannel !== "undefined" && !isCanvasWindow()) {
    floatingChannel = new BroadcastChannel(CANVAS_CHANNEL);
    floatingChannel.onmessage = onCanvasMessage;
    floatingChannel.postMessage("ping"); // 이 창이 켜지기 전부터 떠 있던 캔버스 창
  }
  return () => {
    floatingListeners.delete(listener);
    if (floatingListeners.size || !floatingChannel) return;
    floatingChannel.close();
    floatingChannel = null;
  };
}

export function useCanvasFloating(): boolean {
  return useSyncExternalStore(subscribeCanvasFloating, () => canvasFloating);
}
