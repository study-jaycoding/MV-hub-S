// 편집 탭의 비디오 클린 피드(다빈치 Video Clean Feed, Jay 2026-10-23 — 모의 그림 ④ 승인). 계약은 docs/EDIT_TAB.md.
//  · EditCleanFeedButton — 뷰어 위 줄의 싱글/듀얼 단추 왼쪽. 누르면 '사용 안 함'과 모니터 목록(크롬 창 관리 API — getScreenDetails).
//    앱 창이 있는 모니터는 고를 수 없다. 모니터를 고르는 그 click 안에서 창을 연다(팝업 차단·전체 화면 요청은 사용자 누름이 있어야 한다).
//  · EditCleanFeedWindow — 연 창에 글·단추 없이 타임라인에 지금 보이는 클립(위 트랙 우선 — visibleClip)을 타임라인 시계를 따라 보여 준다
//    (useEditFollow — '한 트랙만 보기'와 같은 부품). 소리는 없다. 그 창을 닫거나 Esc, 사용 안 함, 편집 탭을 떠나면 닫힌다.
//  · useCleanFeed — 켜 둔 동안 **이 앱에 있을 때만** 창이 뜨고(다른 프로그램으로 가면 닫고 돌아오면 다시 연다) 전체 화면으로(Jay 2026-10-23, 다빈치처럼).
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  BUFFER_LIMIT, BUFFER_STUCK_MS, FEED_CLIENT, feedSocketUrl, nextOpenSeq, nowMs, OPEN_TIMEOUT_MS, parseHubMessage, SAMPLE_GAP_MS,
  SAMPLES_PER_SECOND, STATUS_GIVE_UP_MS, STATUS_RETRY_MS,
} from "../../lib/cleanFeedProtocol";
import { clipKey, visibleClip, type CutSlot, type EditDoc, type EditLayout, type SlotClip } from "../../lib/editTimeline";
import { useVideoPair } from "../../lib/editVideoPair";
import { getAuthToken, HttpError, jsonBody, jsonFetch } from "../../lib/http";
import { useT } from "../../lib/i18n";
import { useEditFollow } from "../../lib/useEditFollow";
import type { EditSource } from "../../lib/useEditPlayback";
import { useEscapeClose } from "../../lib/useEscapeClose";
import { useOutsideMouseDown } from "../../lib/useOutsideMouseDown";

// 창 관리 API(크롬) — TS 기본 정의에 아직 없어 쓰는 칸만 적는다
type ScreenDetailed = Screen & {
  label?: string; left: number; top: number; availLeft: number; availTop: number; isPrimary?: boolean; devicePixelRatio?: number;
};
type ScreenDetails = { screens: ScreenDetailed[]; currentScreen: ScreenDetailed };
const screenDetailsApi = () => (window as unknown as { getScreenDetails?: () => Promise<ScreenDetails> }).getScreenDetails;
const screenKey = (screen: ScreenDetailed) => `${screen.left},${screen.top},${screen.width}x${screen.height}`;

export interface FeedScreen {
  key: string;
  index: number; // 1 부터 — 메뉴의 '모니터 n'
  label: string; // 크롬이 주는 모니터 이름(이 PC 는 셋 다 'Generic PnP Monitor')
  size: string; // '1440×2560'
  primary: boolean;
  here: boolean; // 앱 창이 있는 모니터 — 고를 수 없다
  screen: ScreenDetailed;
}
export interface CleanFeed {
  id: number; // 연 차례 — 같은 모니터에 다시 열어도 새 창이라 화면 부품을 새로 그린다
  screen: FeedScreen;
  win: Window;
}

type ScreenList = { state: "loading" | "ok" | "denied" | "unsupported"; screens: FeedScreen[] };

let opens = 0;
const FULL_MESSAGE = "mvhub-clean-feed-fullscreen";
// 그 창을 전체 화면으로 — 누름 권한이 있어야 된다(그 창의 누름·키, 앱 창에서 넘겨받은 권한, 또는 사이트의 '자동 전체 화면' 허용). 안 되면 조용히 둔다.
const goFull = (win: Window) => {
  if (win.closed || win.document.fullscreenElement) return;
  void win.document.documentElement.requestFullscreen?.()?.catch(() => {});
};
// 앱 창의 누름 권한을 피드 창에 넘긴다(그 창의 message 처리가 전체 화면을 부른다). 권한이 없거나 넘기기를 모르는 브라우저면 아무 일 없다.
//  창마다 한 번만 — 넘길 때마다 앱 창의 누름 권한을 써 버린다(안 되는 곳에서 누를 때마다 넘기면 뒤따르는 '창 열기' 같은 것이 막힌다).
//  그 뒤로는 피드 창을 누르면 전체 화면이 된다(사람이 Esc 로 전체 화면을 나왔을 때 다시 끌어들이지도 않는다).
const handed = new WeakSet<Window>();
const handFull = (win: Window) => {
  if (handed.has(win)) return;
  handed.add(win);
  try {
    win.postMessage(FULL_MESSAGE, { targetOrigin: window.location.origin, delegate: "fullscreen" } as WindowPostMessageOptions);
  } catch {
    // 누름 권한 없음
  }
};

// 고른 모니터에 창을 연다 — 그 모니터 자리·크기. 못 열면(팝업 차단) null.
//  전체 화면은 창을 여는 누름으로는 안 된다 — window.open 이 그 누름의 권한을 써 버린다(크롬 155 실측 2026-10-23). 'fullscreen' 창 옵션은
//  크롬의 시험 기능이었고 지금은 효과가 없다. 그래서 열 때 한 번 시도하고(사이트에 '자동 전체 화면'이 허용돼 있으면 된다), 안 되면 다음 누름에
//  권한을 넘겨받거나(useCleanFeed) 그 창을 누르면 된다.
export function openCleanFeed(screen: FeedScreen): CleanFeed | null {
  const { availLeft, availTop, availWidth, availHeight } = screen.screen;
  const win = window.open("", "", `popup,fullscreen,left=${availLeft},top=${availTop},width=${availWidth},height=${availHeight}`);
  if (!win) return null;
  win.document.title = "MV hub — Clean Feed";
  win.document.body.style.cssText = "margin:0;background:#000;overflow:hidden;";
  win.addEventListener("message", (event) => {
    if (event.data === FULL_MESSAGE && event.origin === window.location.origin) goFull(win);
  });
  win.addEventListener("pointerdown", () => goFull(win));
  win.addEventListener("keydown", () => goFull(win));
  goFull(win);
  window.focus(); // 키가 앱 창에 남게 — 크롬이 들어주지 않으면 피드 창이 키를 앱으로 넘긴다(EditCleanFeedWindow)
  return { id: ++opens, screen, win };
}

// 클린 피드를 켜 둔 동안 — 다빈치처럼 **이 앱(앱 창이나 피드 창)에 있을 때만** 고른 모니터에 창이 뜬다(Jay 2026-10-23).
//  screen = 고른 모니터(켜 둠) · feed = 지금 열린 창(앱을 떠나 있으면 null). 끄기(사용 안 함·Esc·창 닫기) = 둘 다 null.
//  · 두 창이 다 초점을 잃으면(다른 프로그램으로 감) 창을 닫는다 — 웹 창은 숨기거나 최소화할 수 없다. 창 사이를 옮길 때는 blur 다음에
//    focus 가 오므로 잠깐 뒤에 본다.
//  · 돌아오면 다시 연다 — 앱 창 focus(누름이 없어 사이트의 '팝업' 허용이 있을 때만 열린다)·누름·키(이때는 열린다).
//  · 창이 전체 화면이 아니면 다음 누름·키에서 권한을 넘긴다.
//  누름·키 때 하는 일은 그 누름의 처리(단추·메뉴·편집 키)가 **끝난 뒤**다 — 권한은 한 번 쓰면 없어져, 먼저 쓰면 그 누름이 여는 창(메뉴의
//  모니터 고르기 같은)이 막힌다.
export function useCleanFeed(onBlocked: () => void, hub?: CleanFeedHubInput) {
  const [screen, setScreen] = useState<FeedScreen | null>(null);
  const [feed, setFeed] = useState<CleanFeed | null>(null);
  const [viaHub, setViaHub] = useState(false); // 지금 고른 모니터를 허브 방식으로 띄웠다 — 팝업의 떠남/돌아옴 처리는 쉰다
  const live = useRef({ screen, feed });
  live.current = { screen, feed };
  const hubInput = useRef(hub);
  hubInput.current = hub;
  // 방식 — 메뉴를 열 때 status 를 물어 정한다(허브 = 누름 권한이 필요 없다). 아직 모르면 팝업(누른 그 순간에 열어야 한다)
  const mode = useRef<"unknown" | "hub" | "popup">("unknown");
  const fellBack = useRef(false); // 허브로 못 열었다 — 바로 다음 고르기 한 번은 팝업 방식(그 사이 메뉴를 열어도 묻지 않는다). 그 고르기가 쓰면 다시 묻는다
  const hubFeed = useRef<HubFeed | null>(null);
  if (!hubFeed.current) {
    hubFeed.current = new HubFeed({
      input: () => hubInput.current,
      shown: (next) => {
        setScreen(next);
        setViaHub(!!next);
      },
      fallback: () => {
        fellBack.current = true;
        mode.current = "popup";
      },
    });
  }
  const hubNow = hubFeed.current;
  const probe = useCallback(() => {
    if (!hubInput.current || fellBack.current) return;
    void jsonFetch<{ supported?: boolean }>("/api/clean-feed/status").then(
      (got) => { if (!fellBack.current) mode.current = got.supported ? "hub" : "popup"; },
      () => { mode.current = "popup"; },
    );
  }, []);
  const pick = (next: FeedScreen | null) => {
    if (!next) {
      hubNow.off();
      setScreen(null);
      return setFeed(null);
    }
    if (mode.current === "hub") {
      setFeed(null);
      return hubNow.pick(next);
    }
    if (live.current.feed && live.current.screen?.key === next.key) return;
    fellBack.current = false; // 실패 뒤의 한 번을 썼다 — 다음 메뉴 열기는 다시 허브에 묻는다
    const opened = openCleanFeed(next);
    if (!opened) return onBlocked();
    hubNow.off(); // 허브 쪽에 떠 있던 것은 닫는다(방식을 바꿨다)
    setScreen(next);
    setFeed(opened);
  };
  const off = useCallback(() => {
    hubNow.off();
    setScreen(null);
    setFeed(null);
  }, [hubNow]);
  useHubFeedLoop(hubNow, hub?.layout, hub?.doc, hub?.sourceOf, hub?.authKey);
  const win = feed?.win ?? null;
  useEffect(() => {
    if (!screen || viaHub) return;
    let timer = 0;
    let again = 0; // 걸어 둔 '돌아옴' — 정리할 때 같이 끈다(첫 클릭이 다른 탭으로 가면 편집 탭이 사라진 뒤에 빈 창이 열렸다 — Codex 묶음 검토 R1)
    const away = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const open = live.current.feed?.win;
        if (document.hasFocus() || (open && !open.closed && open.document.hasFocus())) return;
        setFeed(null); // 창은 EditCleanFeedWindow 가 사라지며 닫는다 — 고른 모니터는 남는다
      }, 150);
    };
    const back = () => {
      window.clearTimeout(again);
      again = window.setTimeout(retake, 0);
    };
    const retake = () => {
      const now = live.current;
      if (!now.screen || !document.hasFocus()) return;
      if (!now.feed) {
        const opened = openCleanFeed(now.screen);
        if (opened) setFeed(opened);
      } else if (!now.feed.win.closed && !now.feed.win.document.fullscreenElement && navigator.userActivation?.isActive !== false) {
        handFull(now.feed.win);
      }
      // 사람이 피드 창을 닫았으면(closed) 다시 열지 않는다 — 감시가 곧 끈다(EditCleanFeedWindow)
    };
    window.addEventListener("blur", away);
    document.addEventListener("visibilitychange", away);
    win?.addEventListener("blur", away);
    window.addEventListener("focus", back);
    window.addEventListener("pointerup", back, true);
    window.addEventListener("keydown", back, true);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(again);
      window.removeEventListener("blur", away);
      document.removeEventListener("visibilitychange", away);
      win?.removeEventListener("blur", away);
      window.removeEventListener("focus", back);
      window.removeEventListener("pointerup", back, true);
      window.removeEventListener("keydown", back, true);
    };
  }, [screen, win, viaHub]);
  return { screen, feed, pick, off, probe };
}

// ── 허브 방식(로컬 허브가 띄우는 전용 창 — Jay 2026-10-23 'd') ─────────────────────────────────────────────
//  계약 docs/status/편집탭_클린피드_전용창_구현_2026-10-23.md('구현에서 정한 것' 2·5·8·9). 허브 = routers/clean_feed + services/clean_feed_*.
//  · 고르기 → open(DIP 자리·크기·그 화면 배율·주 모니터 · takeover · 탭 id·순번) → WS role=main 로 장면·표본·active 를 보낸다.
//  · 작업 번호: 고르기·끄기·인증 바뀜·언마운트마다 +1 — 옛 작업의 결과는 지금 상태를 못 바꾸고, 늦게 성공한 옛 open 은 그 세션만 닫는다.
//    open 은 한 번에 하나(진행 중 새 선택은 마지막 것만 들고 있다가, 보내기 직전에 작업 번호를 다시 보고 보낸다).
//  · 끊기면 즉시 다시 붙고, 핸드셰이크가 거절되면 status?session 으로 — 같은 허브의 live 면 다시 붙음 · taken·closed·로그아웃 등은 끔 ·
//    main-gone 이거나 허브가 다시 떴으면(인스턴스가 다름) takeover:false 로 다시 연다(남을 밀어내지 않는다) · 같은 허브의 unknown 은 끔.
export interface CleanFeedHubInput {
  layout: EditLayout;
  doc: EditDoc;
  sourceOf: (clip: SlotClip) => EditSource;
  now: () => number;
  playing: boolean;
  rate: number;
  limit: number; // 반복 끝·타임라인 끝 — 피드의 외삽이 넘지 않는다
  authKey: string;
  flash: (message: string) => void;
}

interface HubSession {
  session: string;
  key: string;
  instance: string;
  token: string | null; // open 때의 로그인 토큰 — 바뀌면(같은 계정의 재로그인 포함) 끈다
}

const ENDED_TEXT: Record<string, string> = {
  taken: "다른 창에서 클린 피드를 열어 여기서는 껐습니다",
  account: "계정이 바뀌어 클린 피드를 껐습니다",
  "hub-stopped": "허브가 다시 시작해 클린 피드를 껐습니다",
  unknown: "클린 피드 창을 다시 찾지 못해 껐습니다",
};
const OPEN_TEXT: Record<string, string> = {
  "profile-in-use": "클린 피드 전용 창을 다른 크롬이 쓰고 있습니다 — 다음에는 크롬 창 방식으로 엽니다",
  "profile-check-failed": "클린 피드 전용 창을 준비하지 못했습니다 — 다음에는 크롬 창 방식으로 엽니다",
  "cleanup-failed": "앞 클린 피드 창이 아직 닫히는 중입니다 — 다음에는 크롬 창 방식으로 엽니다",
  "no-monitor": "고른 모니터를 정하지 못했습니다 — 다음에는 크롬 창 방식으로 엽니다",
  "window-not-found": "클린 피드 창이 뜨지 않았습니다 — 다음에는 크롬 창 방식으로 엽니다",
  "wrong-monitor": "클린 피드 창이 고른 모니터에 뜨지 않았습니다 — 다음에는 크롬 창 방식으로 엽니다",
  busy: "다른 창에서 클린 피드를 쓰고 있어 껐습니다",
};
// open 이 답한 뒤 창 스레드가 창을 찾다가 실패하면 허브가 세션을 이 사유로 끝낸다 — open 실패처럼 다룬다(허브켜기단축 A)
const LATE_OPEN_FAIL = new Set(["window-not-found", "wrong-monitor"]);
const NO_SAMPLE = { t: Number.NaN, playing: false, rate: 1, rev: -1, sync: -1, at: 0 };
// 장면의 내용 — 배치·문서·클립마다 소스(미디어 주소는 허브가 세션 번호 주소로 바꾼다)
const sceneOf = (input: CleanFeedHubInput) => {
  const sources: Record<string, EditSource> = {};
  for (const slot of input.layout.cuts) for (const clip of slot.clips) sources[clipKey(clip)] = input.sourceOf(clip);
  return { layout: input.layout, doc: input.doc, sources };
};

type HubDeps = { input: () => CleanFeedHubInput | undefined; shown: (screen: FeedScreen | null) => void; fallback: () => void };

export class HubFeed {
  op = 0;
  session: HubSession | null = null;
  screen: FeedScreen | null = null;
  private inFlight = false;
  private queued: { screen: FeedScreen; op: number; takeover: boolean } | null = null;
  private ws: WebSocket | null = null;
  private rev = 0;
  private sentRev = -1;
  private sceneText = ""; // 번호를 올린 마지막 장면의 내용
  private sceneTimer = 0;
  private sync = 0;
  private lastFrameT = Number.NaN;
  private moving = false;
  private sent = NO_SAMPLE;
  private pending: string | null = null;
  private stuckSince: number | null = null;
  private recent: number[] = []; // 지난 1초에 보낸 표본의 때 — 60개 상한
  wake = () => {}; // 연결이 열리면 — 프레임 고리를 깨운다(세션이 없을 때는 rAF 를 돌리지 않는다)

  constructor(private deps: HubDeps) {}

  pick(screen: FeedScreen) {
    this.op += 1;
    this.screen = screen;
    this.deps.shown(screen);
    this.request(screen, this.op, true);
  }

  off(notice?: string) {
    this.op += 1;
    this.queued = null;
    const had = !!this.session || !!this.screen;
    this.stopSession();
    this.screen = null;
    if (had) this.deps.shown(null);
    if (notice) this.deps.input()?.flash(notice);
  }

  dispose() {
    this.op += 1;
    this.queued = null;
    this.stopSession();
  }

  private request(screen: FeedScreen, op: number, takeover: boolean) {
    if (this.inFlight) {
      this.queued = { screen, op, takeover };
      return;
    }
    void this.openNow(screen, op, takeover);
  }

  private async openNow(screen: FeedScreen, op: number, takeover: boolean) {
    if (op !== this.op) return; // 보내기 직전 — 그사이 끄거나 다시 골랐다
    // 켜 둔 채 다른 모니터로 — 옛 세션은 먼저 닫는다. 두면 허브가 그 연결에 보내는 taken 을 받아 새 선택까지 꺼 버린다
    this.stopSession();
    this.inFlight = true;
    const abort = new AbortController();
    const timer = window.setTimeout(() => abort.abort(), OPEN_TIMEOUT_MS);
    const s = screen.screen;
    try {
      const got = await jsonFetch<{ session: string; key: string; instance: string }>("/api/clean-feed/open", {
        method: "POST", signal: abort.signal,
        body: jsonBody({
          screen: { left: s.left, top: s.top, width: s.width, height: s.height, dpr: s.devicePixelRatio || window.devicePixelRatio || 1, primary: !!s.isPrimary },
          takeover, client: FEED_CLIENT, seq: nextOpenSeq(),
        }),
      });
      if (op !== this.op) {
        void closeOnHub(got.session, got.key); // 옛 작업의 늦은 성공 — 그 세션만 정리하고 버린다
        return;
      }
      this.session = { session: got.session, key: got.key, instance: got.instance, token: getAuthToken() };
      this.connect(); // 창은 아직 찾는 중일 수 있다 — 초점을 못 돌려주면 허브가 focus-lost 글로 알린다
    } catch (error) {
      if (op !== this.op) return; // 늦은 409·실패는 무시
      const code = error instanceof HttpError ? String(error.detail ?? "") : "";
      if (!takeover && code === "busy") return this.off(OPEN_TEXT.busy); // 자동 다시 열기 — 다른 탭이 쓰고 있다(밀어내지 않는다)
      if (code !== "stale") this.deps.fallback(); // 바로 다음 고르기는 크롬 창 방식(사용 중 포함 — 계약 7판 ③)
      this.off(OPEN_TEXT[code] ?? "클린 피드 창을 열지 못했습니다 — 다음에는 크롬 창 방식으로 엽니다");
    } finally {
      window.clearTimeout(timer);
      this.inFlight = false;
      const next = this.queued;
      this.queued = null;
      if (next && next.op === this.op) void this.openNow(next.screen, next.op, next.takeover);
    }
  }

  private connect() {
    const sess = this.session;
    if (!sess) return;
    const op = this.op;
    const ws = new WebSocket(feedSocketUrl(sess.session, sess.key, "main"));
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      opened = true;
      this.sentRev = -1;
      this.pending = null;
      this.stuckSince = null;
      if (!this.sendScene()) this.sendSample(true); // 장면을 보냈으면 그 표본도 같이 갔다
      this.sendActive();
      this.wake();
    };
    ws.onmessage = (event) => {
      if (this.ws === ws) this.onMessage(event.data); // 놓은 옛 연결의 늦은 글(옛 세션의 taken 등)은 지금 세션을 못 바꾼다
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (op !== this.op || this.session !== sess) return;
      if (opened) this.connect(); // 끊김 — 즉시 다시 붙는다(송신 적체로 닫은 것도)
      else void this.afterLoss(sess, op); // 핸드셰이크 거절 — 허브에 세션 상태를 묻는다
    };
  }

  // 송신이 막혔다 — 옛 연결을 떼고 바로 새로 붙는다. 막힌 소켓의 close() 는 닫기 절차가 끝나야 onclose 가 와서(쌓인 데이터 뒤) 기다리면 다시 붙기가 멈춘다
  private reconnectNow(ws: WebSocket) {
    if (this.ws !== ws) return;
    this.ws = null;
    ws.onopen = ws.onmessage = ws.onclose = null;
    try {
      ws.close();
    } catch {
      // 이미 닫힘
    }
    this.connect(); // 허브는 새 main 연결이 옛 것을 끊는다
  }

  private async afterLoss(sess: HubSession, op: number) {
    const started = nowMs();
    while (op === this.op && this.session === sess) {
      try {
        const got = await jsonFetch<{ instance: string; session: string | null; ended_reason: string | null }>(
          `/api/clean-feed/status?${new URLSearchParams({ session: sess.session })}`,
        );
        if (op !== this.op || this.session !== sess) return;
        if (got.instance !== sess.instance || got.ended_reason === "main-gone") return this.reopen(); // 허브가 다시 떴거나 main 이 3초 넘게 없었다
        if (got.session === "ended" && LATE_OPEN_FAIL.has(got.ended_reason ?? "")) return this.lateOpenFail(got.ended_reason!);
        if (got.session === "live") {
          await sleep(STATUS_RETRY_MS);
          if (op === this.op && this.session === sess) this.connect();
          return;
        }
        return this.off(got.session === "ended" ? (ENDED_TEXT[got.ended_reason ?? ""] ?? undefined) : ENDED_TEXT.unknown);
      } catch {
        if (op !== this.op || this.session !== sess) return; // 옛 세션의 늦은 실패 — 그사이 새로 고른 것을 끄지 않는다
        if (nowMs() - started > STATUS_GIVE_UP_MS) return this.off("허브에 닿지 않아 클린 피드를 껐습니다");
        await sleep(STATUS_RETRY_MS);
      }
    }
  }

  private lateOpenFail(reason: string) {
    this.deps.fallback(); // open 실패와 같게 — 바로 다음 고르기 한 번은 크롬 창 방식
    this.off(OPEN_TEXT[reason]);
  }

  private reopen() {
    this.stopSession(false);
    if (this.screen) this.request(this.screen, this.op, false); // 자동 — 다른 live 세션이 있으면 409(밀어내지 않음)
  }

  private onMessage(raw: unknown) {
    const msg = parseHubMessage(raw);
    if (!msg) return;
    if (msg.t === "resync") {
      this.sync = Number.isInteger(msg.sync) ? (msg.sync as number) : this.sync;
      if (this.sentRev === this.rev || !this.sendScene()) this.sendSample(true); // 장면을 보냈으면 그 표본(sync:n)도 같이 갔다
    } else if (msg.t === "key") {
      // 피드 창의 키 — 앱 본문에 같은 키로(편집 키는 window 에서 듣고 대상이 앱 안인지 본다)
      document.body.dispatchEvent(new KeyboardEvent("keydown", {
        key: String(msg.key), code: String(msg.code), ctrlKey: msg.ctrlKey === true, shiftKey: msg.shiftKey === true, altKey: msg.altKey === true,
        metaKey: msg.metaKey === true, repeat: msg.repeat === true, bubbles: true, cancelable: true,
      }));
    } else if (msg.t === "taken" || msg.t === "closed") {
      const reason = String(msg.reason ?? "");
      if (msg.t === "closed" && LATE_OPEN_FAIL.has(reason)) return this.lateOpenFail(reason);
      this.off(msg.t === "taken" ? ENDED_TEXT.taken : ENDED_TEXT[reason]); // taken 은 다시 열지 않는다 · 사람이 닫음·끄기는 말없이
    } else if (msg.t === "focus-lost") {
      this.deps.input()?.flash("클린 피드 창이 키보드 초점을 가져갔습니다 — 키는 앱으로 넘어갑니다");
    }
  }

  private stopSession(close = true) {
    const sess = this.session;
    this.session = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.pending = null;
    this.stuckSince = null;
    this.sent = NO_SAMPLE;
    this.sync = 0; // 재동기 번호는 세션마다 — 옛 번호를 새 세션의 표본에 실으면 피드가 그 뒤의 번호 0 표본을 버린다
    this.recent = [];
    window.clearTimeout(this.sceneTimer);
    this.sceneTimer = 0;
    if (sess && close) void closeOnHub(sess.session, sess.key);
  }

  // 장면이 바뀌었다 — 0.1초 묶어 보낸다(rev 는 바로 올린다). 내용이 같으면(목록을 다시 받아 함수·배열만 새것 — 팀 생성 알림마다) 아무것도
  //  안 한다: 번호를 올리면 피드가 그 장면을 기다리며 선다(2026-10-26 Jay "재생하는데 딜레이")
  sceneChanged() {
    const input = this.deps.input();
    const text = input ? JSON.stringify(sceneOf(input)) : "";
    if (text === this.sceneText) return;
    this.sceneText = text;
    this.rev += 1;
    window.clearTimeout(this.sceneTimer);
    this.sceneTimer = window.setTimeout(() => {
      this.sceneTimer = 0;
      this.sendScene();
    }, 100);
  }

  private open(): WebSocket | null {
    return this.ws && this.ws.readyState === WebSocket.OPEN ? this.ws : null;
  }

  // 장면을 보내고 바로 그 rev 의 표본을 — 허브가 늦게 붙은 피드에 장면 → 표본으로 준다(멈춘 화면은 그 뒤 표본이 더 없다 — 리뷰 10차). 보냈으면 true
  private sendScene(): boolean {
    const ws = this.open();
    const input = this.deps.input();
    if (!ws || !input || ws.bufferedAmount > BUFFER_LIMIT) return false; // 송신이 막혀 있다 — 줄면 frame 이 보낸다(sentRev 가 뒤처진 채)
    ws.send(JSON.stringify({ t: "scene", rev: this.rev, ...sceneOf(input) }));
    this.sentRev = this.rev;
    this.sendSample(true);
    return true;
  }

  // 표본 — 재생 중 rAF 마다(1초 60개 상한), 아니면 바뀔 때만. 송신 버퍼가 차 있으면 최신 하나만 들고 있다가, 2초 넘게 차 있으면 다시 붙는다.
  sendSample(force = false) {
    const ws = this.open();
    const input = this.deps.input();
    if (!ws || !input) return;
    const t = input.now();
    const at = nowMs();
    const state = input.playing !== this.sent.playing || input.rate !== this.sent.rate || this.rev !== this.sent.rev || this.sync !== this.sent.sync;
    const changed = state || t !== this.sent.t;
    if (!force && !(input.playing ? at - this.sent.at >= SAMPLE_GAP_MS : changed)) return;
    // 재생 중 표본은 1초 60개까지(앞 표본에서 16ms 간격만으로는 62개까지 간다) — 재생·배속·장면·재동기가 바뀐 표본과 강제(resync 응답)는 그대로
    this.recent = this.recent.filter((sent) => at - sent < 1000);
    if (!force && input.playing && !state && this.recent.length >= SAMPLES_PER_SECOND) return;
    this.recent.push(at);
    const text = JSON.stringify({ t: "clock", rev: this.rev, time: t, at, playing: input.playing, moving: input.playing && this.moving,
      rate: input.rate, limit: input.limit, sync: this.sync });
    this.sent = { t, playing: input.playing, rate: input.rate, rev: this.rev, sync: this.sync, at };
    this.push(ws, text, at);
  }

  private push(ws: WebSocket, text: string, at: number) {
    if (ws.bufferedAmount > BUFFER_LIMIT) {
      this.pending = text;
      this.stuckSince ??= at;
      if (at - this.stuckSince > BUFFER_STUCK_MS) this.reconnectNow(ws); // 다시 붙는다 — 허브가 최신 장면·표본으로 맞춘다
      return;
    }
    this.stuckSince = null;
    this.pending = null;
    ws.send(text);
  }

  sendActive() {
    const ws = this.open();
    if (ws && ws.bufferedAmount <= BUFFER_LIMIT) { // 막혀 있으면 건너뛴다 — 1초마다 다시 보낸다
      ws.send(JSON.stringify({ t: "active", active: document.hasFocus() && document.visibilityState === "visible" }));
    }
  }

  // 화면 프레임마다 — 움직임을 재고, 송신 적체를 보고(새 표본이 없어도 — 멈춘 화면에서도 2초면 다시 붙는다), 밀린 장면·표본을 보내고, 표본을 보낸다
  frame() {
    const input = this.deps.input();
    const ws = this.open();
    if (!ws || !input) return;
    const t = input.now();
    this.moving = Number.isFinite(this.lastFrameT) && Math.abs(t - this.lastFrameT) > 1e-6;
    this.lastFrameT = t;
    const now = nowMs();
    if (ws.bufferedAmount > BUFFER_LIMIT) {
      this.stuckSince ??= now;
      if (now - this.stuckSince > BUFFER_STUCK_MS) return this.reconnectNow(ws); // 다시 붙는다 — 허브가 최신 장면·표본으로 맞춘다
    } else {
      this.stuckSince = null;
      if (this.sentRev !== this.rev && !this.sceneTimer) this.sendScene(); // 막혀서 못 보낸 장면
      if (this.pending) this.push(ws, this.pending, now);
    }
    this.sendSample();
  }

  // 1초마다 — active 를 다시 알리고, 로그인 토큰이 open 때와 다르면 끈다(같은 계정의 재로그인도 — 허브는 세대값으로도 끝낸다)
  second() {
    if (!this.session) return;
    if (getAuthToken() !== this.session.token) return this.off("로그인이 바뀌어 클린 피드를 껐습니다");
    this.sendActive();
  }

  beacon() {
    const sess = this.session;
    if (!sess) return;
    try {
      navigator.sendBeacon?.("/api/clean-feed/close", new Blob([JSON.stringify({ session: sess.session, key: sess.key })], { type: "application/json" }));
    } catch {
      // 창이 닫히는 중 — 허브는 main 3초 없음으로 끝낸다
    }
  }
}

function closeOnHub(session: string, key: string) {
  return jsonFetch("/api/clean-feed/close", { method: "POST", keepalive: true, body: jsonBody({ session, key }) }).catch(() => {});
}

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

// 허브 방식의 시계·active·인증 감시 — 프레임마다 표본, 1초마다 active·토큰, focus·blur·보임 바뀜에 active, 창을 닫으면 beacon
function useHubFeedLoop(hubFeed: HubFeed, layout?: EditLayout, doc?: EditDoc, sourceOf?: (clip: SlotClip) => EditSource, authKey?: string) {
  useEffect(() => {
    if (layout) hubFeed.sceneChanged();
  }, [hubFeed, layout, doc, sourceOf]);
  const firstAuth = useRef(authKey);
  useEffect(() => {
    if (authKey === firstAuth.current) return;
    firstAuth.current = authKey;
    if (hubFeed.session || hubFeed.screen) hubFeed.off("로그인이 바뀌어 클린 피드를 껐습니다");
  }, [hubFeed, authKey]);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = 0;
      if (!hubFeed.session) return; // 쓰지 않을 때 매 프레임 깨우지 않는다(가만히 둔 탭의 CPU) — 다시 열리면 wake
      hubFeed.frame();
      raf = requestAnimationFrame(loop);
    };
    hubFeed.wake = () => {
      if (!raf) raf = requestAnimationFrame(loop);
    };
    const timer = window.setInterval(() => hubFeed.second(), 1000);
    const active = () => hubFeed.sendActive();
    const gone = () => hubFeed.beacon();
    window.addEventListener("focus", active);
    window.addEventListener("blur", active);
    document.addEventListener("visibilitychange", active);
    window.addEventListener("pagehide", gone);
    return () => {
      cancelAnimationFrame(raf);
      hubFeed.wake = () => {};
      window.clearInterval(timer);
      window.removeEventListener("focus", active);
      window.removeEventListener("blur", active);
      document.removeEventListener("visibilitychange", active);
      window.removeEventListener("pagehide", gone);
      hubFeed.dispose(); // 편집 탭이 사라진다 — 그 세션을 닫는다
    };
  }, [hubFeed]);
}

export function EditCleanFeedButton({ screen: current, onPick, onOpen }: {
  screen: FeedScreen | null; onPick: (screen: FeedScreen | null) => void; onOpen?: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<ScreenList>({ state: "loading", screens: [] });
  const ref = useRef<HTMLDivElement>(null);
  useOutsideMouseDown(ref, () => setOpen(false), open, undefined, true);
  useEscapeClose(() => setOpen(false), open, true, true);
  // 열 때마다 다시 묻는다 — 모니터를 꽂고 빼거나 창을 옮겼을 수 있다. 처음 한 번 크롬이 '창 관리' 허용을 묻는다.
  useEffect(() => {
    if (!open) return;
    const api = screenDetailsApi();
    if (!api) return setList({ state: "unsupported", screens: [] });
    let live = true;
    setList((old) => ({ ...old, state: "loading" }));
    api.call(window).then((details) => {
      if (!live) return;
      const here = screenKey(details.currentScreen);
      setList({ state: "ok", screens: details.screens.map((screen, i) => ({
        key: screenKey(screen), index: i + 1, label: screen.label || "", size: `${screen.width}×${screen.height}`,
        primary: !!screen.isPrimary, here: screenKey(screen) === here, screen,
      })) });
    }, () => live && setList({ state: "denied", screens: [] }));
    return () => {
      live = false;
    };
  }, [open]);
  const title = current
    ? t("비디오 클린 피드 — 모니터 {n}").replace("{n}", String(current.index)) : t("비디오 클린 피드 — 타임라인 화면만 다른 모니터에");
  const pick = (screen: FeedScreen | null) => {
    setOpen(false);
    onPick(screen);
  };
  return (
    <div className="ed-feed" ref={ref}>
      <button type="button" className={"ed-tbtn ed-feedbtn" + (current || open ? " ed-on" : "")} aria-haspopup="menu" aria-expanded={open}
        title={title} aria-label={title} onClick={() => {
          if (!open) onOpen?.(); // 열 때 허브 방식을 쓸 수 있는지 묻는다(모니터를 고르기 전에 정해 둔다)
          setOpen(!open);
        }}>
        <svg width="20" height="14" viewBox="0 0 20 14" aria-hidden="true">
          <rect x="0.65" y="0.65" width="13" height="9" rx="1" /><path d="M5 13h4M7 9.7V13" />
          <path d="M15 5h4.3M17.3 3l2 2-2 2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="ed-pop ed-feedpop" role="menu" aria-label={t("비디오 클린 피드")}>
          <div className="ed-pop-head">{t("비디오 클린 피드")}</div>
          <button type="button" role="menuitemradio" aria-checked={!current} className={"ed-pop-item" + (!current ? " ed-on" : "")}
            onClick={() => pick(null)}>
            <b>{!current ? "✓" : ""}</b>{t("사용 안 함")}
          </button>
          <div className="ed-pop-sep" />
          {list.state === "loading" && !list.screens.length && <div className="ed-pop-note">{t("모니터를 찾는 중…")}</div>}
          {list.state === "unsupported" && <div className="ed-pop-note">{t("이 브라우저는 모니터 고르기를 지원하지 않습니다(크롬에서 됩니다).")}</div>}
          {list.state === "denied" && (
            <div className="ed-pop-note">{t("크롬의 '창 관리' 허용이 필요합니다 — 주소창 왼쪽 표시에서 허용한 뒤 다시 눌러 주세요.")}</div>
          )}
          {list.screens.map((screen) => {
            const on = current?.key === screen.key;
            return (
              <button key={screen.key} type="button" role="menuitemradio" aria-checked={on} disabled={screen.here}
                className={"ed-pop-item" + (on ? " ed-on" : "")} onClick={() => pick(screen)}>
                <b>{on ? "✓" : ""}</b>
                {t("모니터 {n}").replace("{n}", String(screen.index))}{screen.label ? ` — ${screen.label}` : ""}
                <i>{[screen.here ? t("이 창") : screen.size, screen.primary ? t("주 모니터") : ""].filter(Boolean).join(" · ")}</i>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const FILL = { position: "fixed", inset: 0, width: "100%", height: "100%", objectFit: "contain", background: "#000" } as const;

// 연 창의 화면 — 그 창 body 에 포털로 그린다. 그 창을 닫거나(0.5초마다 본다) Esc 를 누르면 onClosed. 이 부품이 사라지면(사용 안 함·편집 탭을
//  떠남) 창을 닫는다. 앱 창을 새로 고치거나 닫을 때도 닫는다(남은 창이 고아가 되지 않게).
//  닫기는 효과를 뗄 때 바로 하지 않고 **다음 틱에** 한다 — 다시 붙으면 거둔다. 개발 화면의 StrictMode 는 처음 그릴 때 '붙임 → 뗌 → 다시 붙임'을
//  한 번에 잇는데, 떼는 순간 닫으면 창이 뜨자마자 닫히고 다시 붙은 감시가 '닫힘'을 보고 껐다(Jay 2026-10-23 "뜨는거 같더니 갑자기 사라진다").
export function EditCleanFeedWindow({ feed, layout, doc, sourceOf, now, playing, rate, onClosed }: {
  feed: CleanFeed;
  layout: EditLayout;
  doc: EditDoc;
  sourceOf: (clip: SlotClip) => EditSource;
  now: () => number;
  playing: boolean;
  rate: number;
  onClosed: () => void;
}) {
  const closed = useRef(onClosed);
  closed.current = onClosed;
  const closing = useRef(0); // 걸어 둔 '다음 틱에 닫기'
  useEffect(() => {
    const { win } = feed;
    window.clearTimeout(closing.current); // 다시 붙었다(StrictMode 의 거짓 정리) — 닫지 않는다
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") return closed.current();
      // 피드 창에 초점이 가도(창을 열 때·전체 화면에 들어갈 때 크롬이 그 창으로 옮길 수 있다) 편집 키는 앱이 받는다 — 같은 키를 앱 창의
      //  본문에 다시 보낸다(편집 키는 window 에서 듣고 키의 대상이 앱 안의 요소인지 본다 — window 로 보내면 그 판정이 깨진다)
      const copy = new KeyboardEvent("keydown", {
        key: event.key, code: event.code, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey,
        repeat: event.repeat, bubbles: true, cancelable: true,
      });
      if (!document.body.dispatchEvent(copy)) event.preventDefault();
    };
    const shut = () => win.close();
    win.addEventListener("keydown", onKey);
    window.addEventListener("pagehide", shut);
    const watch = window.setInterval(() => win.closed && closed.current(), 500);
    return () => {
      window.clearInterval(watch);
      window.removeEventListener("pagehide", shut);
      if (win.closed) return;
      win.removeEventListener("keydown", onKey);
      closing.current = window.setTimeout(() => {
        if (!win.closed) win.close();
      }, 0);
    };
  }, [feed]);
  const { pair, front, spare } = useVideoPair();
  const pick = useCallback((slot: CutSlot, local: number) => visibleClip(doc, slot, local), [doc]);
  const { clip, source, failed } = useEditFollow({ videoRef: pair, layout, pick, sourceOf, now, playing, rate, catchUp: true });
  return createPortal(<CleanFeedPicture front={front} spare={spare} clip={clip} source={source} failed={failed} />, feed.win.document.body);
}

// 피드의 그림 — 영상(소리 없음)이나 정지 그림(그림 클립·못 트는 영상의 썸네일) 하나. 팝업 창과 전용 창(CleanFeedApp)이 같이 쓴다.
//  영상 요소는 둘(editVideoPair — 앞 · 다음 영상을 미리 받는 뒤). 뒤의 것(data-spare)은 자리를 차지한 채 가리기만 한다 — display:none 이면
//  프레임을 내보내지 않아 넘어가는 순간 바로 안 나온다(edit-tab.css 의 .ed-media[data-spare] 와 같다 — 피드 창에는 그 CSS 가 없다).
export function CleanFeedPicture({ front, spare, clip, source, failed }: {
  front: RefObject<HTMLVideoElement>; spare: RefObject<HTMLVideoElement>; clip: SlotClip | null; source: EditSource | null; failed: boolean;
}) {
  const isVideo = !!clip && source?.state === "ok" && source.type === "video" && !failed;
  const still = clip && source?.state === "ok" && !isVideo ? (source.type === "image" ? source.url : source.thumb) : null;
  return (
    <>
      <style>{"video[data-spare]{visibility:hidden}"}</style>
      <video ref={front} muted playsInline preload="auto" hidden={!isVideo} style={FILL} />
      <video ref={spare} muted playsInline preload="auto" hidden={!isVideo} style={FILL} />
      {still && <img src={still} alt="" draggable={false} style={FILL} />}
    </>
  );
}
