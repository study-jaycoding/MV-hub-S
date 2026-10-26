// 클린 피드 전용 창의 화면(?cleanfeed=<세션>&key= — 로컬 허브가 띄운 키오스크 크롬, Jay 2026-10-23 'd') — 검은 바탕에 타임라인에 보이는 클립만.
//  글·단추·소리 없음 · 로그인·폴링·씬 저장 없음(main.tsx 가 씬 저장소 부팅 전에 가른다). 앱이 허브를 거쳐 보내는 장면·표본으로 지금 부품
//  (useEditFollow + visibleClip)을 그대로 돌린다. 시계·재동기 규칙은 lib/cleanFeedProtocol(계약 '구현에서 정한 것' 5), 키는 앱으로 넘긴다(4).
//  끈 세션의 창은 허브가 숨겨 대기 창으로 두었다가 다음 open 에 다시 쓴다(허브켜기단축 B) — 그 동안은 대기 화면, assign 을 받으면 새 세션 화면.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  asSample, feedClock, feedKey, feedKeyRoute, feedSocketUrl, isStandbyToken, newerSample, nowMs, parseHubMessage, STANDBY_PROTOCOL,
  standbySocketUrl, type FeedSyncState,
} from "../../lib/cleanFeedProtocol";
import { clipKey, visibleClip, type CutSlot, type EditDoc, type EditLayout, type SlotClip } from "../../lib/editTimeline";
import { useVideoPair } from "../../lib/editVideoPair";
import { useEditFollow } from "../../lib/useEditFollow";
import type { EditSource } from "../../lib/useEditPlayback";
import { CleanFeedPicture } from "./EditCleanFeed";

interface FeedScene {
  rev: number;
  layout: EditLayout;
  doc: EditDoc;
  sources: Map<string, EditSource>;
}

const EMPTY: EditLayout = { cuts: [], total: 0, tracks: 1 };
const NO_SOURCE: EditSource = { state: "unknown", url: null, type: null, thumb: null };
const isLayout = (value: unknown): value is EditLayout =>
  !!value && Array.isArray((value as EditLayout).cuts) && typeof (value as EditLayout).total === "number";
const isDoc = (value: unknown): value is EditDoc =>
  !!value && Array.isArray((value as EditDoc).clips) && Array.isArray((value as EditDoc).tracksOff);

type FeedTarget = { session: string; key: string } | { standby: string };

export function CleanFeedApp({ session, keyValue }: { session: string; keyValue: string }) {
  const [target, setTarget] = useState<FeedTarget>({ session, key: keyValue });
  const toStandby = useCallback((token: string) => setTarget({ standby: token }), []);
  const assign = useCallback((next: string, key: string) => {
    window.history.replaceState(null, "", `?${new URLSearchParams({ cleanfeed: next, key })}`); // 새로 고쳐도 그 세션으로
    setTarget({ session: next, key });
  }, []);
  if ("standby" in target) return <CleanFeedStandby token={target.standby} onAssign={assign} />;
  // 세션을 열쇠로 — 다시 쓴 창은 장면 rev·표본·재동기 번호·재시도·영상 둘을 전부 새로(앞 세션 것과 안 섞임)
  return <CleanFeedSession key={target.session} session={target.session} keyValue={target.key} onStandby={toStandby} />;
}

// 대기 화면 — 검은 바탕만(창은 숨겨져 있다) · 대기 WS 하나로 assign 을 기다린다 · 거절·끊김이면 다시 붙지 않는다(그 창은 허브가 끝낸다)
function CleanFeedStandby({ token, onAssign }: { token: string; onAssign: (session: string, key: string) => void }) {
  useEffect(() => {
    let done = false;
    const ws = new WebSocket(standbySocketUrl(), [STANDBY_PROTOCOL + token]);
    ws.onmessage = (event) => {
      const msg = parseHubMessage(event.data);
      if (done || msg?.t !== "assign" || typeof msg.session !== "string" || typeof msg.key !== "string") return;
      done = true;
      ws.close();
      onAssign(msg.session, msg.key);
    };
    ws.onclose = () => {
      done = true; // 거절·끊김 — 다시 붙지 않는다
    };
    return () => {
      done = true;
      ws.close();
    };
  }, [token, onAssign]);
  return null;
}

function CleanFeedSession({ session, keyValue, onStandby }: { session: string; keyValue: string; onStandby: (token: string) => void }) {
  useEffect(() => {
    document.title = `MV hub Clean Feed ${session}`; // 허브가 이 제목으로 창을 찾는다(clean_feed_window.TITLE_PREFIX)
    document.body.style.cssText = "margin:0;background:#000;overflow:hidden;cursor:none;";
  }, [session]);
  const [scene, setScene] = useState<FeedScene | null>(null);
  const state = useRef<FeedSyncState>({ visibleSync: 0, hidden: document.visibilityState === "hidden", best: null });
  const sceneRev = useRef(-1);
  const held = useRef(0); // 마지막으로 보여 준 시각 — 장면이 아직 안 온 새 rev 의 표본 동안 그대로
  const [play, setPlay] = useState({ playing: false, rate: 1 });
  const socket = useRef<WebSocket | null>(null);
  const { pair, front, spare } = useVideoPair();

  const now = useCallback(() => {
    const clock = feedClock(state.current, nowMs(), sceneRev.current, held.current);
    held.current = clock.time;
    return clock.time;
  }, []);
  // 추종기의 재생 여부는 상태로 — 표본·보임·숨김이 바뀔 때, 그리고 0.05초마다(표본이 HOLD_MS 넘게 끊기면 멈춘다)
  const refresh = useCallback(() => {
    const clock = feedClock(state.current, nowMs(), sceneRev.current, held.current);
    setPlay((prev) => (prev.playing === clock.playing && prev.rate === clock.rate ? prev : { playing: clock.playing, rate: clock.rate }));
  }, []);
  useEffect(() => {
    const timer = window.setInterval(refresh, 50);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    let stop = false;
    let retry = 0;
    let joined = false; // 허브가 한 번이라도 받았다
    const started = nowMs();
    const connect = () => {
      const ws = new WebSocket(feedSocketUrl(session, keyValue, "feed"));
      socket.current = ws;
      ws.onopen = () => {
        joined = true;
        ws.send(JSON.stringify({ t: "ready" }));
      };
      ws.onmessage = (event) => {
        const msg = parseHubMessage(event.data);
        if (!msg || stop || socket.current !== ws) return; // 버린 연결의 늦은 글
        if (msg.t === "scene") {
          const rev = msg.rev;
          if (!Number.isInteger(rev) || !isLayout(msg.layout) || !isDoc(msg.doc) || !msg.sources || typeof msg.sources !== "object") return;
          sceneRev.current = rev as number;
          setScene({ rev: rev as number, layout: msg.layout, doc: msg.doc, sources: new Map(Object.entries(msg.sources as Record<string, EditSource>)) });
          refresh();
        } else if (msg.t === "clock") {
          const sample = asSample(msg);
          if (sample && newerSample(state.current.best, sample)) { // 낮은 번호·옛 표본은 최신을 덮지 않는다 · 숨김 중에도 받되 재생은 재동기 뒤
            state.current = { ...state.current, best: sample };
            refresh();
          }
        } else if (msg.t === "visible") {
          const sync = Number.isInteger(msg.sync) ? (msg.sync as number) : 0;
          state.current = { ...state.current, visibleSync: Math.max(state.current.visibleSync, sync), hidden: false };
          refresh();
        } else if (msg.t === "closed" || msg.t === "taken") {
          stop = true;
          ws.close();
          if (isStandbyToken(msg.standby)) { // 허브가 이 창을 숨겨 대기 창으로 둔다 — 영상 받기를 멈추고 대기 화면으로
            for (const video of [front.current, spare.current]) {
              video?.pause();
              video?.removeAttribute("src");
              video?.load();
            }
            onStandby(msg.standby);
          }
        }
      };
      // 처음 붙기 전의 거절은 짧게 다시 — 허브는 이 창의 제목을 찾은 뒤에야 세션을 받는데 이 화면은 그보다 먼저 뜬다(0.5초를 기다리면 켜기가
      //  그만큼 늦었다 — 2026-10-26 실측). 5초가 지나도록 못 붙었거나 한 번 붙은 뒤의 끊김은 0.5초.
      ws.onclose = () => {
        if (!stop) retry = window.setTimeout(connect, !joined && nowMs() - started < 5000 ? 50 : 500);
      };
    };
    connect();
    return () => {
      stop = true;
      window.clearTimeout(retry);
      socket.current?.close();
    };
  }, [session, keyValue, refresh, onStandby, front, spare]);

  // 숨김 — 재동기 안 됨(숨은 동안의 표본은 받되 재생은 허브의 visible 과 그 번호 이상의 표본 뒤에)
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      state.current = { ...state.current, hidden: true };
      refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refresh]);

  // 키 — 막고 앱으로 넘긴다 · Esc·F11 은 막기만 · Alt+F4·Alt+Tab·Win 은 OS 몫(Alt+F4 = 이 창 닫힘 → 허브가 보고 끈다)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const route = feedKeyRoute(event);
      if (route === "os") return;
      event.preventDefault();
      const ws = socket.current;
      if (route === "forward" && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "key", ...feedKey(event) }));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const sources = scene?.sources;
  const sourceOf = useCallback((clip: SlotClip): EditSource => sources?.get(clipKey(clip)) ?? NO_SOURCE, [sources]);
  const doc = scene?.doc;
  const pick = useCallback((slot: CutSlot, local: number) => (doc ? visibleClip(doc, slot, local) : null), [doc]);
  const { clip, source, failed } = useEditFollow({
    videoRef: pair, layout: scene?.layout ?? EMPTY, pick, sourceOf, now, playing: play.playing, rate: play.rate, catchUp: true,
  });
  return <CleanFeedPicture front={front} spare={spare} clip={clip} source={source} failed={failed} />;
}
