import { useSyncExternalStore } from "react";
import { jsonFetch } from "./http";
import type { SceneModelCfg } from "./scenes";
import { STORAGE_KEYS } from "./storageKeys";

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
  if (mode === EMBED_MODES.canvas && !canFloatCanvas()) return;
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
  const reacquire = mode === EMBED_MODES.canvas && canvasWindowLive();
  if (mode === EMBED_MODES.canvas && !reacquire) beginCanvasHandoff(); // 열기 전에 — 새 창은 이 창의 sessionStorage 를 복사해 같은 인계 번호를 본다
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

function raiseWindows(windows: Array<Window | null | undefined>): void {
  const titles = windows.flatMap((w) => {
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

function raisePopups(): void {
  if (Date.now() - lastBlurAt < INSIDE_MS) return; // 별도 창 → 이 창(앱 안)
  raiseWindows(Object.values(openWindows));
}

/** 떠 있는 캔버스 창을 앞으로 — 이 창에서 못 하는 일을 그 창에서 하도록 안내할 때. 창 참조가 없으면(이 창을 새로 고친 뒤) 안내만 남는다. */
export function bringCanvasForward(): void {
  const w = openWindows[EMBED_MODES.canvas];
  try {
    w?.focus();
  } catch {
    /* same-origin defensive guard */
  }
  raiseWindows([w]);
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
    if (mode === EMBED_MODES.canvas && !open && lastOpen[mode]) { // 이 창이 연 캔버스 창이 닫혔다 — 'closed' 신호를 못 받았어도
      if (canvasReturnRead) waitCanvasReturn();
      else setCanvasFloating(false);
    }
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
// 캔버스 창이 평생 쥐는 잠금 — 창이 어떻게 끝나든 브라우저가 풀어 주고, 가려지거나 얼어도 풀리지 않는다(2026-10-31 실측). 창이 끝났을 수 있다는
// 신호로만 쓴다: 편집 권한을 주고받지 않는다(docs/status/캔버스_분리창_한곳쓰기_2026-10-31.md). 보안 문맥이 아닌 주소에는 API 가 없다 — 그때는 신호로만 안다.
const CANVAS_LOCK = "mvhub-canvas-window";
const canvasLocks = (): LockManager | undefined => (typeof navigator === "undefined" ? undefined : navigator.locks);

/** 이 주소에서 캔버스를 별도 창으로 띄울 수 있나 — 잠금이 없으면 창의 끝을 확인할 근거가 없다. 무응답으로 돌려받으면 얼어 있던 창이 깨어나 두 창이 함께 쓴다. */
export const canFloatCanvas = (): boolean => !!canvasLocks();

/** 잠금이 없는 주소에 남은 캔버스 창(이 규칙 전부터 떠 있던 창의 새로 고침) — 알리기 전에 물러난다. 닫지 못해도 저장소를 열지 않아 쓰지 않는다. */
export function retireCanvasWindow(): boolean {
  if (canFloatCanvas()) return false;
  window.close();
  return true;
}

export function announceCanvasWindow(): void {
  adoptOpenerCanvasMemory(); // 메인 창이 살아 있는 켜질 때 받아 둔다 — 각 저장소가 등록할 때 꺼내 간다(아래)
  void canvasLocks()?.request(CANVAS_LOCK, () => new Promise<void>(() => {})).catch(() => {});
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(CANVAS_CHANNEL);
  channel.onmessage = (event) => {
    if (event.data === "ping") channel.postMessage("open");
  };
  channel.postMessage("open");
  window.addEventListener("pagehide", (event) => {
    returnCanvasMemory(event.persisted); // 'closed' 보다 먼저 — 메인 창이 캔버스를 다시 그리기 전에 되돌리기 기록을 받아 두게
    channel.postMessage("closed");
  });
}

let canvasFloating = false;
const floatingListeners = new Set<() => void>();
let floatingChannel: BroadcastChannel | null = null;
let closedTimer: ReturnType<typeof setTimeout> | undefined;
// 떠 있던 창이 닫힌 뒤 캔버스를 돌려주기 전의 읽기(저장소 다시 읽기) — 닫는 창의 마지막 알림은 오지 않을 수 있어, 그대로 돌려주면 메인 창이 낡은 씬을
//  그리고 다음 저장이 그 글을 덮는다(2026-10-31 실측, docs/status/캔버스_닫는순간_2026-10-31.md). 떠 있는 동안은 저장본을 그대로 받으므로 풀기 전에 읽는다.
let canvasReturnRead: (() => Promise<boolean>) | null = null;
let returnTurn = 0; // 돌려주기 시도 번호 — "open"·다시 열기가 오면 바뀌어, 진행 중인 읽기가 끝나도 풀지 않는다
let returnReading = false;
const RETURN_RETRY_MS = 1_000;
const RETURN_RETRY_MAX_MS = 30_000;

/** 메인 창 — 캔버스를 돌려주기 전에 부를 읽기를 단다. 없으면(분리 창·시험) 곧바로 푼다. */
export function setCanvasReturnRead(read: () => Promise<boolean>): void {
  canvasReturnRead = read;
}

let canvasFloatStart: (() => void) | null = null;
/** 메인 창 — 캔버스가 다른 창에 떴다는 것을 안 그 자리에서 부를 일을 단다(밀린 씬 쓰기 치우기, sceneStore). 그 뒤로 미루면 큐가 밀린 사이 떠 있음이 끝나 옛 연산이 재생된다. */
export function setCanvasFloatStart(run: () => void): void {
  canvasFloatStart = run;
}

function setCanvasFloating(next: boolean): void {
  clearTimeout(closedTimer);
  closedTimer = undefined;
  returnTurn += 1;
  returnReading = false;
  if (next === canvasFloating) return;
  canvasFloating = next;
  if (next) canvasFloatStart?.();
  floatingListeners.forEach((listener) => listener());
}

// 읽기에 성공해야 푼다 — 실패한 채 풀면 낡은 보드가 열려 같은 소실이 난다. 낡은 보드를 여는 것보다 '떠 있음'이 남는 쪽이 안전하다.
// shortcut: 끝나지 않는 읽기(실패가 아니라 멈춤)는 다시 읽지 못해 떠 있음이 남는다 — 데이터는 안전하다. 실제로 겪으면 읽기에 제한 시간을 둔다.
async function returnCanvas(): Promise<void> {
  const read = canvasReturnRead;
  if (!read) return setCanvasFloating(false);
  const turn = returnTurn;
  returnReading = true;
  for (let wait = RETURN_RETRY_MS; turn === returnTurn; wait = Math.min(wait * 2, RETURN_RETRY_MAX_MS)) {
    if (await read().catch(() => false)) {
      if (turn === returnTurn) setCanvasFloating(false);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

// 닫힘 신호와 .closed 가 둘 다 와도 읽기는 한 번이다. 틈을 두는 까닭은 새로 고침과 가르고, 닫기 직전의 'saved' 가 닿을 시간을 주려는 것.
function waitCanvasReturn(): void {
  if (!canvasFloating || returnReading || closedTimer !== undefined) return;
  // 참조가 없으면(이 창을 새로 고친 뒤) 닫힌 것으로 본다 — 새로 고침이었다면 그 창이 켜지며 "open" 으로 다시 띄운다
  closedTimer = setTimeout(() => {
    closedTimer = undefined;
    void settleCanvasReturn();
  }, RELOAD_GRACE_MS);
}

// 잠금을 쥔 문서가 있으면 창은 살아 있다 — 돌려받지 않고 다시 기다린다. 새로 고친 창의 "open" 이 옛 문서의 잠금 해제보다 먼저 올 수 있어,
// 늦게 온 해제를 닫힘으로 믿으면 두 창이 함께 쓴다(2026-10-31 Codex 실측).
async function settleCanvasReturn(): Promise<void> {
  const turn = returnTurn; // 묻는 사이 "open" 이 오면 이 판단은 낡았다 — "open" 은 다시 오지 않으니 여기서 돌려받으면 두 창이 쓴다
  let held = false;
  try {
    held = !!(await canvasLocks()?.query())?.held?.some((lock) => lock.name === CANVAS_LOCK);
  } catch {
    /* 잠금을 못 읽었다 — 지금처럼 신호로 안다 */
  }
  if (turn !== returnTurn || !canvasFloating || returnReading || closedTimer !== undefined) return;
  if (held) watchCanvasWindow();
  else if (!isEmbedWindowOpen(EMBED_MODES.canvas)) void returnCanvas();
}

function onCanvasMessage(event: MessageEvent): void {
  if (event.data === "open") {
    if (openWindows[EMBED_MODES.canvas]?.closed) { // 닫힌 창의 참조 — 지금 떠 있는 창은 이 창이 연 그 창이 아니다
      openWindows[EMBED_MODES.canvas] = null;
      lastOpen[EMBED_MODES.canvas] = false; // .closed 확인이 그 창이 닫혔다고 다시 풀지 않게
    }
    setCanvasFloating(true);
    watchCanvasWindow();
  } else if (event.data === "closed") waitCanvasReturn();
}

let watchingCanvas = false;

// 창이 쥔 잠금을 기다린다 — 받으면 창이 끝났거나 새로 고침이다. 곧바로 풀고 닫힘 신호와 같은 길을 탄다(새로 고침이면 새 문서의 "open" 이 다시 건다).
function watchCanvasWindow(): void {
  const locks = canvasLocks();
  if (!locks || watchingCanvas) return;
  watchingCanvas = true;
  void locks.request(CANVAS_LOCK, () => {
    watchingCanvas = false;
    waitCanvasReturn();
  }).catch(() => {
    watchingCanvas = false;
  });
}

/** 메인 창 부팅 — 첫 그리기 전에 떠 있는 창을 안다. 모른 채 그리면 그사이 배경 작업이 씬을 쓴다. 찾지 못하면 "open" 이 곧 알린다. */
export async function findFloatingCanvas(): Promise<void> {
  try {
    const state = await canvasLocks()?.query();
    if (!state?.held?.some((lock) => lock.name === CANVAS_LOCK)) return;
    setCanvasFloating(true);
    watchCanvasWindow();
  } catch {
    /* 잠금을 못 읽었다 — 지금처럼 신호로 안다 */
  }
}

/** 떠 있는 창이 살아 있다고 볼 수 있나 — 닫혀 돌아오는 중이면 아니다(새로 여는 길로 간다). 참조가 없으면 신호로만 안다. */
export function canvasWindowLive(): boolean {
  return canvasFloating && !openWindows[EMBED_MODES.canvas]?.closed;
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

/** 지금 이 창의 캔버스가 다른 창에 떠 있나 — 화면이 아닌 배경 작업(씬 쓰기)이 쉴지 볼 때. 캔버스 창에서는 늘 거짓. */
export function isCanvasFloating(): boolean {
  return canvasFloating;
}

// 창 메모리에만 있는 캔버스 상태(되돌리기 기록·복사한 노드)를 메인 창 ↔ 캔버스 창이 주고받는다(Jay 2026-10-30 "원래 캔버스처럼",
// docs/status/캔버스_두창_함께쓰기_2026-10-30.md). 캔버스 창이 켜질 때 자기를 연 창(window.opener)의 손잡이로 받아 오고, 닫히거나 새로 고칠 때
// 돌려준다 — 여는 창이 하나로 정해져 답이 갈리지 않고, 닫는 순간에도 동기 호출이라 유실이 없다. 각 저장소가 이름을 붙여 등록한다.
export interface CanvasMemoryPart {
  save: () => unknown;
  load: (value: unknown) => boolean | void; // true = 받아서 이제 이 창의 책임이다(durable 칸)
  flush?: () => void; // 내보내기 전에 열린 화면의 값을 저장소에 남긴다(열린 보드의 되돌리기 기록)
  begin?: () => void; // 이 창이 캔버스 창을 새로 열 때(인계 시작) — 돌려받을 때 견줄 기준을 잡는다
  durable?: boolean; // 받는 창이 끝까지 써야 하는 칸 — 받는 창이 닫히는 중이거나 보내는 문서가 돌아올 수 있으면 넘기지 않는다
  accepted?: () => void; // 보낸 쪽 — 받는 창이 true 로 답했다
}
type CanvasMemoryPort = {
  save: () => Record<string, unknown>;
  load: (memory: Record<string, unknown>) => string[] | void;
  settled: () => Promise<boolean>; // 넘겨받은 쓰기까지 저장소에 확정됐나 — 새로 고친 캔버스 창이 읽기 전에 묻는다
};
const MEMORY_PORT = "__mvhubCanvasMemory";
const memoryParts = new Map<string, CanvasMemoryPart>();
let openerMemory: Record<string, unknown> | null = null;
const beforeMemoryReturn = new Set<() => void>();

/** 캔버스 창 — 값을 돌려주기 전에 부를 확정(열린 보드의 끌기·밀린 입력). pagehide 듣기는 등록 순서대로 돌아 돌려주기가 보드의 듣기보다 먼저다. */
export function onCanvasMemoryReturn(settle: () => void): () => void {
  beforeMemoryReturn.add(settle);
  return () => {
    beforeMemoryReturn.delete(settle);
  };
}

// 인계 번호 — 메인 창이 캔버스 창을 새로 열 때마다 정한다. sessionStorage 라 메인 창을 새로 고쳐도 남고, 새 창은 열 때 복사본을 받아
//  같은 번호를 본다. 돌려받은 기록은 이 번호가 맞을 때만 들인다(sceneUndoStore.adoptSceneHistory).
const HANDOFF_KEY = "mvhub.canvasMemoryHandoff";
export function canvasHandoffId(): string | null {
  try {
    return sessionStorage.getItem(HANDOFF_KEY);
  } catch {
    return null;
  }
}
function beginCanvasHandoff(): void {
  try {
    sessionStorage.setItem(HANDOFF_KEY, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  } catch {
    /* sessionStorage 를 못 쓰면 번호 없이(null) 맞춰 본다 */
  }
  memoryParts.forEach((part) => part.begin?.());
}

function deliverOpenerMemory(name: string, part: CanvasMemoryPart): void {
  if (!openerMemory || !(name in openerMemory)) return;
  const handed = openerMemory[name];
  delete openerMemory[name];
  part.load(handed);
}

export function registerCanvasMemory(name: string, part: CanvasMemoryPart): void {
  memoryParts.set(name, part);
  deliverOpenerMemory(name, part);
}

// 칸마다 따로 — 한 칸이 던져도 나머지(특히 씬 변경)는 넘어가야 한다
function eachMemoryPart(run: (part: CanvasMemoryPart, name: string) => void): void {
  memoryParts.forEach((part, name) => {
    try {
      run(part, name);
    } catch {
      /* 이 칸만 빠진다 */
    }
  });
}

function saveCanvasMemory(): Record<string, unknown> {
  eachMemoryPart((part) => part.flush?.());
  const memory: Record<string, unknown> = {};
  eachMemoryPart((part, name) => {
    memory[name] = part.save();
  });
  return memory;
}

/** 메인 창 — 캔버스 창이 window.opener 로 부를 손잡이를 단다. 받은 값은 이 창의 것으로 복제해 둔다(닫히는 창의 객체를 붙들지 않게). */
export function shareCanvasMemory(settled: () => Promise<boolean> = () => Promise.resolve(true)): void {
  let leaving = false; // 이 창도 닫히는 중 — durable 칸을 받아도 끝까지 쓰지 못한다
  window.addEventListener("pagehide", () => {
    leaving = true;
  });
  window.addEventListener("pageshow", () => {
    leaving = false;
  });
  const port: CanvasMemoryPort = {
    save: saveCanvasMemory,
    settled,
    load: (memory) => {
      const taken: string[] = [];
      const copied = structuredClone(memory);
      eachMemoryPart((part, name) => {
        if (!(name in copied) || (leaving && part.durable)) return;
        if (part.load(copied[name]) === true) taken.push(name);
      });
      return taken;
    },
  };
  (window as unknown as Record<string, CanvasMemoryPort>)[MEMORY_PORT] = port;
}

function openerPort(): CanvasMemoryPort | null {
  try {
    return (window.opener as Record<string, CanvasMemoryPort | undefined> | null)?.[MEMORY_PORT] ?? null;
  } catch {
    return null; // 연 창이 닫혔거나 다른 출처
  }
}

const OPENER_SETTLE_WAIT_MS = 12_000; // 메인 창 쪽 기다림(10초)보다 길게 — 메인 창이 답을 못 할 때만 여기서 끝난다

/**
 * 캔버스 창 — 저장소를 열기 전에 메인 창이 넘겨받은 쓰기가 끝나기를 기다린다. 새로 고친 문서가 그 저장보다 먼저 읽으면 뒤늦은 저장이 새 편집을 덮는다.
 * false = 메인 창이 끝내 확정하지 못했다(이 창이 물러나 메인 창이 돌려받는다). 메인 창이 없거나 답이 없으면 그대로 간다.
 */
export async function openerSceneWritesSettled(): Promise<boolean> {
  const port = openerPort();
  if (!port) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      port.settled(),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), OPENER_SETTLE_WAIT_MS);
      }),
    ]);
  } catch {
    return true;
  } finally {
    clearTimeout(timer);
  }
}

function adoptOpenerCanvasMemory(): void {
  try {
    const port = openerPort();
    if (port) openerMemory = structuredClone(port.save());
  } catch {
    /* 연 창이 없다 — 빈 기록으로 시작한다 */
  }
  memoryParts.forEach((part, name) => deliverOpenerMemory(name, part)); // 이미 등록한 저장소(부팅 모듈이 먼저 불러온 것)도 받는다
}

function returnCanvasMemory(persisted: boolean): void {
  beforeMemoryReturn.forEach((settle) => {
    try {
      settle();
    } catch {
      /* 확정에 실패해도 나머지는 돌려준다 */
    }
  });
  const memory = saveCanvasMemory(); // 연 창이 없어도 부른다 — 인계 칸에 다시 남기는 칸이 있다
  if (persisted) memoryParts.forEach((part, name) => {
    if (part.durable) delete memory[name]; // 문서가 돌아올 수 있다 — 넘기면 메인 창의 늦은 쓰기가 돌아온 문서의 새 편집을 덮는다
  });
  try {
    const taken = openerPort()?.load(memory);
    if (taken) for (const name of taken) memoryParts.get(name)?.accepted?.();
  } catch {
    /* 연 창이 이미 닫혔다 */
  }
}

// 창끼리 실시간으로 나누는 작은 상태(Comfy '생성중') — 창마다 자기 몫을 알리고, 닫히면(pagehide) 그 창 몫을 지운다. 새로 등록한 창은 한 번 묻는다.
// pagehide 없이 끝난 창(강제 종료)은 창마다 평생 쥐는 잠금으로 안다 — 받는 창이 그 잠금을 기다리다 얻으면 끝난 것이다. 쥔 뒤에만 알린다: 잠금 요청과
// BroadcastChannel 은 순서가 보장되지 않아, 먼저 알리면 받는 창이 먼저 잡아 살아 있는 창을 끝났다고 본다. 잠금이 없는 주소에서는 지금처럼 pagehide 로만 안다.
const LIVE_CHANNEL = "mvhub-window-live";
const newWindowId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let windowId = newWindowId();
export interface WindowLivePart {
  read: () => unknown; // 이 창의 지금 몫
  apply: (sender: string, value: unknown) => void; // 다른 창의 몫 — value 가 undefined 면 그 창이 닫혔다
}
const liveParts = new Map<string, WindowLivePart>();
let liveChannel: BroadcastChannel | null = null;
let liveHeld: Promise<void> = Promise.resolve();
let releaseLive: () => void = () => {};
const heardWindows = new Set<string>(); // 잠금을 기다리는 다른 창
const endedWindows = new Set<string>(); // 끝난 창 — 늦게 닿은 알림으로 표시가 되살아나지 않게
let watchTurn = 0; // 돌아온 문서가 감시를 새로 걸면 바뀐다 — 옛 감시의 늦은 콜백은 무시한다
const liveLock = (id: string) => `mvhub-window-live-${id}`;

function holdLiveLock(): void {
  const locks = canvasLocks();
  if (!locks) return;
  releaseLive();
  const id = windowId;
  // 못 쥐면 알리지 않는다 — 아무도 쥐지 않은 잠금은 받는 창이 곧바로 얻어 살아 있는 창을 끝났다고 본다. 돌아온 문서의 옛 요청은 얻는 대로 놓는다.
  liveHeld = new Promise((held) => {
    void locks.request(liveLock(id), () => (id !== windowId ? undefined : new Promise<void>((release) => {
      releaseLive = release;
      held();
    }))).catch(() => {});
  });
}

function endLiveWindow(sender: string): void {
  endedWindows.add(sender);
  heardWindows.delete(sender);
  liveParts.forEach((each) => each.apply(sender, undefined));
}

function watchLiveWindow(sender: string): void {
  const turn = watchTurn;
  // 요청 실패는 끝이 아니다 — 그 창은 지금처럼 pagehide 로만 안다.
  void canvasLocks()?.request(liveLock(sender), () => {
    if (turn === watchTurn && !endedWindows.has(sender)) endLiveWindow(sender);
  }).catch(() => {});
}

function postLive(name: string, value: unknown): void {
  void liveHeld.then(() => liveChannel?.postMessage({ type: "live", name, sender: windowId, value }));
}

/** 등록하고, 이 창의 몫이 바뀌었을 때 부를 알림 함수를 돌려준다. */
export function shareWindowLive(name: string, part: WindowLivePart): () => void {
  liveParts.set(name, part);
  if (!liveChannel && typeof BroadcastChannel !== "undefined") {
    liveChannel = new BroadcastChannel(LIVE_CHANNEL);
    liveChannel.onmessage = (event) => {
      const message = event.data as { type?: string; name?: string; sender?: string; value?: unknown } | null;
      if (!message?.sender || message.sender === windowId || endedWindows.has(message.sender)) return;
      if (message.type === "ask") liveParts.forEach((each, partName) => postLive(partName, each.read()));
      else if (message.type === "live" && message.name) {
        if (!heardWindows.has(message.sender)) {
          heardWindows.add(message.sender);
          watchLiveWindow(message.sender);
        }
        liveParts.get(message.name)?.apply(message.sender, message.value);
      } else if (message.type === "gone") endLiveWindow(message.sender);
    };
    holdLiveLock();
    window.addEventListener("pagehide", () => liveChannel?.postMessage({ type: "gone", sender: windowId }));
    // 뒤로 가기 저장(bfcache)에서 돌아온 문서 — 떠나며 끝났다고 알렸고 잠금과 감시도 끊겼을 수 있다(브라우저마다 다르다). 새 창으로 다시 시작한다.
    //  아는 창은 답을 기다리지 않고 다시 감시한다 — 멈춘 동안 끝난 창은 답하지 않는다.
    window.addEventListener("pageshow", (event) => {
      if (!event.persisted) return;
      windowId = newWindowId();
      holdLiveLock();
      watchTurn += 1;
      heardWindows.forEach(watchLiveWindow);
      liveChannel?.postMessage({ type: "ask", sender: windowId });
      liveParts.forEach((each, partName) => postLive(partName, each.read()));
    });
  }
  liveChannel?.postMessage({ type: "ask", sender: windowId });
  return () => postLive(name, part.read());
}

// 새로 여는 캔버스 창이 메인 창에서 보던 그대로 시작하게(Jay 2026-10-30, docs/status/캔버스_창_보던값_2026-10-30.md) — 브라우저에 저장되지
// 않는 화면 값만 여는 순간 넘긴다(도구줄·사이드바·씬 등은 이미 저장돼 같다). 캔버스 창이 처음 그릴 때 한 번 읽고 지운다.
export interface CanvasSelection {
  sceneId: string;
  cardIds: string[];
  groupIds: string[];
}
export interface CanvasPromptDraft {
  key: string; // 이 글이 놓일 묶임 — '씬 id:none'
  draft: string; // 글 조각 JSON(인라인 칩 포함), 빈 글이면 ""
}
export interface CanvasHandoff {
  promptVisible: boolean; // Ctrl+K 로 숨긴 프롬프트 창(usePromptDock)
  batchCount: number;
  prompt: SceneModelCfg | null; // 하단에 보이던 종류·모델·옵션(SpotlightPrompt.shownModel)
  promptDraft: CanvasPromptDraft | null; // 카드를 안 고른 캔버스의 프롬프트 글 — 저장되지 않는 값이라 창을 따라다닌다
  selection: CanvasSelection | null; // 고른 카드·그룹(SceneBoard 손잡이의 selection) — Jay 2026-10-30 "선택도 넘긴다"
}
const HANDOFF_TTL_MS = 60_000; // 열다 만 창의 값이 나중에 연 창에 붙지 않게
const PROMPT_TYPES = new Set(["image", "video", "audio"]);

export function leaveCanvasHandoff(handoff: CanvasHandoff): void {
  try {
    localStorage.setItem(STORAGE_KEYS.canvasHandoff, JSON.stringify({ ...handoff, at: Date.now() }));
  } catch {
    /* 저장소가 막혔다 — 새 창은 처음 값으로 뜬다 */
  }
}

function handoffPrompt(value: unknown): SceneModelCfg | null {
  if (!value || typeof value !== "object") return null;
  const { type, model, params } = value as SceneModelCfg;
  if (typeof type !== "string" || !PROMPT_TYPES.has(type) || typeof model !== "string" || !model) return null;
  const kept = Object.entries(params && typeof params === "object" ? params : {})
    .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean");
  return { type, model, params: Object.fromEntries(kept) };
}

const handoffIds = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((id) => typeof id === "string") ? (value as string[]) : null;

function handoffDraft(value: unknown): CanvasPromptDraft | null {
  if (!value || typeof value !== "object") return null;
  const { key, draft } = value as CanvasPromptDraft;
  return typeof key === "string" && key && typeof draft === "string" ? { key, draft } : null;
}

function handoffSelection(value: unknown): CanvasSelection | null {
  if (!value || typeof value !== "object") return null;
  const { sceneId, cardIds, groupIds } = value as CanvasSelection;
  const cards = handoffIds(cardIds);
  const groups = handoffIds(groupIds);
  return typeof sceneId === "string" && sceneId && cards && groups ? { sceneId, cardIds: cards, groupIds: groups } : null;
}

let handoffTaken: CanvasHandoff | null | undefined;

export function takeCanvasHandoff(): CanvasHandoff | null {
  if (handoffTaken !== undefined) return handoffTaken; // 여러 훅이 같은 값을 읽는다 — 저장소는 처음 한 번만
  handoffTaken = null;
  if (!isCanvasWindow()) return null; // 메인 창은 읽지도 지우지도 않는다
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.canvasHandoff);
    localStorage.removeItem(STORAGE_KEYS.canvasHandoff);
    const value = raw ? (JSON.parse(raw) as Partial<CanvasHandoff> & { at?: unknown }) : null;
    if (value && typeof value.at === "number" && Math.abs(Date.now() - value.at) < HANDOFF_TTL_MS
      && typeof value.promptVisible === "boolean" && Number.isInteger(value.batchCount) && (value.batchCount as number) >= 1) {
      handoffTaken = {
        promptVisible: value.promptVisible, batchCount: value.batchCount as number,
        prompt: handoffPrompt(value.prompt), promptDraft: handoffDraft(value.promptDraft), selection: handoffSelection(value.selection),
      };
    }
  } catch {
    /* 손상 — 처음 값으로 */
  }
  return handoffTaken;
}

// 넘긴 선택은 그 씬을 처음 그릴 때 한 번만 쓴다(SceneBoard) — 다른 탭에 갔다 오거나 씬을 바꿔 다시 그릴 때 옛 선택이 되살아나지 않게,
// 처음 그린 뒤 '썼다'고 표시한다. 처음 값 함수에서 바로 지우지 않는 것은 StrictMode 의 두 번 그리기가 같은 값을 받게 하려는 것.
let handoffSelectionUsed = false;

export function canvasHandoffSelection(sceneId: string): CanvasSelection | null {
  const selection = handoffSelectionUsed ? null : takeCanvasHandoff()?.selection ?? null;
  return selection?.sceneId === sceneId ? selection : null;
}

export function markCanvasHandoffSelectionUsed(): void {
  handoffSelectionUsed = true;
}
