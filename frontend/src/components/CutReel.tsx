// 모아보기 — 고른 컷의 대표(없으면 가장 최근 것)를 격자 순서대로(Jay 2026-10-08).
//  [개별] = 큰 카드 + 정보(모델·작업자·크레딧·생성일·검토) + [폴더로](그 컷 폴더로 이동 — Jay 2026-10-13). 검토 줄은 그 폴더 안의
//  개수(공유·★ 최종·R 보류 — 사이드바 폴더 숫자와 같은 규칙·같은 색)다. [연결] = 하나의 영상처럼 이어서 재생 — 편집 탭 뷰어의 재생 줄 모양
//  (가는 타임바·빨간 자리·처음/이전 컷/재생/다음 컷/끝/반복). 대표가 이미지인 컷(과 재생 못 하는 영상)은 3초 멈춘 화면(Jay '가').
//  재생 논리는 캔버스 View 노드의 ViewTimeline 과 같은 원리(가상 시간 = 앞 클립 길이 합 + 지금 위치)지만 그 창과는 요구가 달라
//  (반복 끔·컷 이동·길이를 다 알기 전 이동 잠금·깨진 영상) 따로 둔다 — 잘 도는 창을 고치지 않는다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmtReelTime, reelClips, reelLocate, reelStarts, REEL_IMAGE_SEC, type ReelClip } from "../lib/cutReel";
import { useT } from "../lib/i18n";
import { thumbOf } from "../lib/media";
import { activationKeyOwned, useModalFocus } from "../lib/keyGate";
import { useEscapeClose } from "../lib/useEscapeClose";
import { addWindowMouseDrag, removeWindowMouseDrag } from "../lib/windowDrag";
import type { FolderCard, PreviewItem, PreviewTarget } from "../types";
import { CloseIcon } from "./common/ViewIcons";
import { CoverInfo } from "./CoverInfo";
import { MediaThumbnail } from "./MediaThumbnail";

export type ReelMode = "grid" | "linked";

// 영상 길이(초)는 주소마다 한 번만 읽는다 — 모아보기를 다시 열 때마다 모든 영상의 메타데이터를 다시 받지 않게(10-09 실측: 열고
//  닫기 5번에 영상 요청 +334). 깨진 영상은 담지 않는다(다음에 다시 시도).
const DURATION_CACHE = new Map<string, number>();
const PRELOAD_AT_ONCE = 2; // 한꺼번에 읽으면 첫 클립의 재생과 대역폭을 다툰다(10-09 실측: 28개 동시 → 첫 재생 6.2초)
// 영상 요소 둘(앞·뒤): 뒤의 것에 다음 영상을 미리 받아 두고 컷이 넘어갈 때 자리만 바꾼다 — 요소 하나에 주소만 갈면 받는 시간만큼
//  화면이 선다(10-09 실측: 컷마다 130~200ms). 넘어가기 ROLL_AHEAD 초 전부터 뒤의 것을 소리 없이 굴려 둔다 — 다 받아 둔 영상도
//  play() 뒤 첫 그림까지 시간이 든다(편집 탭 editVideoPair 와 같은 원리, Jay "끊김 없이"). 너무 멀리 굴러갔으면(ROLL_MAX) 되돌린다.
const ROLL_AHEAD = 0.3;
const ROLL_MAX = 0.4;

interface Props {
  folders: FolderCard[]; // 고른 컷(격자 순서) — 호출하는 쪽이 메모해 둔다
  mode: ReelMode;
  onModeChange: (mode: ReelMode) => void;
  previewOpen: boolean; // 크게 보기가 위에 떠 있으면 Esc·Space 는 그쪽 몫
  onClose: () => void;
  onPreview: (target: PreviewTarget) => void;
  onEnter: (folder: FolderCard) => void; // [폴더로] — 그 컷 폴더로 이동(창을 닫는 것은 호출하는 쪽)
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

// 재생 시작. 늦게 온 거절은 무시한다 — 앞 클립을 떼며 난 AbortError·pause 로 끊긴 것이 **다음 컷**을 세우던 문제(Codex 코드 리뷰).
//  자동 재생이 막힌 것(NotAllowedError 등)만, 그것도 아직 그 영상이 화면에 있을 때만 정지로 돌린다. (jsdom 의 play() 는 Promise 가 아니다.)
function startPlay(v: HTMLVideoElement, current: () => HTMLVideoElement | null, onBlocked: () => void) {
  const pending = v.play() as Promise<void> | undefined;
  pending?.catch((e: unknown) => {
    if (current() === v && (e as { name?: string } | null)?.name !== "AbortError") onBlocked();
  });
}

export function CutReel({ folders, mode, onModeChange, previewOpen, onClose, onPreview, onEnter }: Props) {
  const t = useT();
  useEscapeClose(onClose, !previewOpen);
  const reelRef = useRef<HTMLDivElement>(null);
  useModalFocus(reelRef); // 막이 있는 창 — 초점을 창 안에 둔다(lib/keyGate '모달의 초점'). 위에 크게 보기가 뜨면 그쪽이 맨 위다
  // 카드가 다시 와서 배열 객체만 바뀐 경우(보이는 내용이 같음)엔 클립도 그대로 — 재생기가 영상 길이를 다시 읽지 않게.
  //  비교 기준은 클립에 실리는 값 전부(이름·주소·표지·작업자·대표).
  const clipsNow = reelClips(folders);
  const clipKey = JSON.stringify(clipsNow);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- clipKey 가 clipsNow 의 내용을 대신한다
  const clips = useMemo(() => clipsNow, [clipKey]);
  const reps = folders.filter((folder) => folder.rep).length;
  const items: PreviewItem[] = clips.map((clip) => ({ url: clip.url, type: clip.type, name: clip.name, thumb: clip.thumb }));
  const previewAt = (index: number) => onPreview({ ...items[index], items, index });
  return (
    <div className="reel-backdrop" onMouseDown={onClose}>
      <div ref={reelRef} className="reel" role="dialog" aria-label={t("모아보기")} onMouseDown={(e) => e.stopPropagation()}>
        <div className="reel-hd">
          <span className="reel-title">{t("모아보기")}</span>
          <span className="reel-sub">{folders.length}{t("컷")} · {t("대표")} {reps} · {t("최신")} {folders.length - reps}</span>
          <span className="reel-sp" />
          <span className="reel-seg" role="group" aria-label={t("보기 방식")}>
            <button type="button" className={mode === "grid" ? "on" : ""} aria-pressed={mode === "grid"} onClick={() => onModeChange("grid")}>▦ {t("개별")}</button>
            <button type="button" className={mode === "linked" ? "on" : ""} aria-pressed={mode === "linked"} onClick={() => onModeChange("linked")}>▶ {t("연결")}</button>
          </span>
          <button className="assets-x" onClick={onClose} title={t("닫기")}><CloseIcon /></button>
        </div>
        {mode === "grid" ? (
          <div className="reel-grid">
            {folders.map((folder, i) => (
              <ReelCard key={folder.path} folder={folder} order={i + 1} onEnter={() => onEnter(folder)} onPreview={() => {
                const index = clips.findIndex((clip) => clip.path === folder.path);
                if (index >= 0) previewAt(index);
              }} />
            ))}
          </div>
        ) : (
          // 클립이 바뀌면(대표를 바꿔 카드가 새로 오면) 처음부터 — key 로 다시 올린다.
          <ReelPlayer key={clips.map((clip) => clip.url).join("|")} clips={clips} keys={!previewOpen} />
        )}
      </div>
    </div>
  );
}

// ── 개별 — 큰 카드 + 정보 ──
function ReelCard({ folder, order, onPreview, onEnter }: { folder: FolderCard; order: number; onPreview: () => void; onEnter: () => void }) {
  const t = useT();
  const g = folder.cover;
  const asset = g.assets?.[0];
  const isVideo = asset?.type === "video";
  return (
    <div className="reel-card">
      <button type="button" className="reel-face" title={t("크게 보기")} onClick={onPreview}>
        <MediaThumbnail thumb={thumbOf(g, 512)} isVideo={isVideo} src={asset?.file_path} alt="" fallback={null} />
        {isVideo && <span className="play-badge">▶</span>}
        <span className="reel-order">{order}</span>
        <span className={"reel-rep" + (folder.rep ? " rep" : "")}>{folder.rep ? `★ ${t("대표")}` : t("최신 것")}</span>
      </button>
      <div className="reel-ttl">
        <b>{folder.name}</b>
        <button type="button" className="reel-go" title={`${folder.path} — ${t("이 폴더로 이동합니다")}`} onClick={onEnter}>{t("폴더로")} ▸</button>
      </div>
      {/* 정보 줄(모델·작업자·크레딧·생성일·검토) — 컷 카드·컷 줄과 같은 부품 */}
      <CoverInfo folder={folder} />
    </div>
  );
}

// ── 연결 — 이어서 재생 ──
interface PlayerState {
  idx: number; playing: boolean; durations: number[]; clipTime: number; loop: boolean; ready: boolean; still: boolean; atEnd: boolean;
  failed: ReadonlySet<number>;
}

export function ReelPlayer({ clips, keys = true }: { clips: ReelClip[]; keys?: boolean }) {
  const t = useT();
  const n = clips.length;
  const [durations, setDurations] = useState<number[]>(() =>
    clips.map((clip) => (clip.type === "image" ? REEL_IMAGE_SEC : DURATION_CACHE.get(clip.url) ?? 0)));
  const [failed, setFailed] = useState<ReadonlySet<number>>(() => new Set());
  const [idx, setIdx] = useState(0);
  const [clipTime, setClipTime] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [loop, setLoop] = useState(true);
  const [cycle, setCycle] = useState(0); // 같은 클립을 처음부터 다시(단일 클립 반복 등)
  const seekRef = useRef<number | null>(0); // 클립을 올린 뒤 맞출 위치(초)
  // 영상 요소 둘 — 어느 쪽이 앞(보이는 쪽)인지는 ref 가 정하고, CSS 를 위해 state 로도 둔다. 요소는 떼지 않는다(받아 둔 것을 잃지 않게).
  const vaRef = useRef<HTMLVideoElement>(null);
  const vbRef = useRef<HTMLVideoElement>(null);
  const frontRef = useRef<0 | 1>(0);
  const [front, setFront] = useState<0 | 1>(0);
  const frontEl = useCallback(() => (frontRef.current === 0 ? vaRef.current : vbRef.current), []);
  const backEl = useCallback(() => (frontRef.current === 0 ? vbRef.current : vaRef.current), []);
  const frontUrlRef = useRef(""); // 앞의 것에 올린 주소
  const backUrlRef = useRef(""); // 뒤의 것에 미리 올려 둔 주소
  const rollingRef = useRef(false); // 뒤의 것을 소리 없이 미리 굴리는 중

  const cur = clips[idx];
  const still = !cur || cur.type === "image" || failed.has(idx);
  const ready = n > 0 && durations.every((d) => d > 0); // 길이를 다 알기 전엔 전체 시간 이동을 잠근다(늦은 메타데이터가 위치의 뜻을 바꾼다)
  const total = durations.reduce((a, b) => a + b, 0);
  const starts = reelStarts(durations);
  const virtual = (starts[idx] ?? 0) + clipTime;
  const atEnd = !playing && idx === n - 1 && durations[idx] > 0 && clipTime >= durations[idx] - 0.001;
  // 최신 상태를 ref 로 — 창 전역 리스너·rAF 가 낡은 값을 잡지 않게.
  const st = useRef<PlayerState>({ idx, playing, durations, clipTime, loop, ready, still, atEnd, failed });
  st.current = { idx, playing, durations, clipTime, loop, ready, still, atEnd, failed };

  // 영상 길이 — 메타데이터만 미리 읽는다. 못 읽으면 재생도 못 하는 것으로 보고 3초 멈춘 화면.
  //  이미 깨진 것으로 판정한 클립의 늦은 메타데이터는 받지 않는다(3초를 긴 길이로 되돌리지 않게).
  //  같은 주소의 클립은 한 번만 읽고, 끝나거나 닫히면 요소의 주소를 떼고 불러오기를 멈춘다(요소가 핸들러·주소를 쥔 채 남지 않게 —
  //  Codex 코드 검토 10-09).
  //  주소마다 한 번씩 순서대로, 한 번에 둘까지만 읽는다. 이미 아는 길이(DURATION_CACHE)는 읽지 않는다.
  useEffect(() => {
    let cancelled = false;
    const active = new Set<HTMLVideoElement>();
    const byUrl = new Map<string, number[]>();
    clips.forEach((clip, i) => {
      if (clip.type === "image" || DURATION_CACHE.has(clip.url)) return;
      const same = byUrl.get(clip.url);
      if (same) same.push(i);
      else byUrl.set(clip.url, [i]);
    });
    const queue = [...byUrl];
    const release = (v: HTMLVideoElement) => {
      active.delete(v);
      v.onloadedmetadata = null;
      v.onerror = null;
      v.removeAttribute("src");
      v.load();
    };
    const startNext = () => {
      if (cancelled) return;
      const item = queue.shift();
      if (!item) return;
      const [url, indexes] = item;
      const v = document.createElement("video");
      active.add(v);
      v.preload = "metadata";
      v.onloadedmetadata = () => {
        if (cancelled) return;
        const seconds = isFinite(v.duration) && v.duration > 0 ? v.duration : REEL_IMAGE_SEC;
        DURATION_CACHE.set(url, seconds);
        setDurations((d) => {
          const next = [...d];
          for (const i of indexes) if (!st.current.failed.has(i)) next[i] = seconds;
          return next;
        });
        release(v);
        startNext();
      };
      v.onerror = () => {
        if (cancelled) return;
        setFailed((f) => { const next = new Set(f); for (const i of indexes) next.add(i); return next; });
        setDurations((d) => {
          const next = [...d];
          for (const i of indexes) if (!next[i]) next[i] = REEL_IMAGE_SEC;
          return next;
        });
        release(v);
        startNext();
      };
      v.src = url;
    };
    for (let k = 0; k < PRELOAD_AT_ONCE; k++) startNext();
    return () => {
      cancelled = true;
      [...active].forEach(release);
    };
  }, [clips]);

  // 옮길 때마다 +1 — 그 전에 예약된 시간 틱(옛 컷의 시각)이 새 자리를 덮지 않게 한다. 타임바를 **끌어서** 컷을 넘기면(mousemove 는
  //  React 가 바로 다시 그리지 않는다) 옛 영상의 틱이 한 번 더 돌아 그 시각(3초 초과)을 써 넣었고, 이미지 컷은 곧바로 '끝'으로 보고
  //  다음 컷으로 넘어갔다(2026-10-10 실측 5/5 — 클릭으로 옮기면 정상).
  const jumpRef = useRef(0);
  const goTo = useCallback((i: number, offset = 0) => {
    jumpRef.current += 1;
    seekRef.current = offset;
    setClipTime(offset);
    setCycle((c) => c + 1);
    setIdx(i);
  }, []);
  // 다음 컷. 마지막이면 반복 = 처음부터, 아니면 끝에서 멈춘다(다시 재생하면 처음부터).
  const goNext = useCallback(() => {
    const { idx: i, loop: again, durations: d } = st.current;
    if (i + 1 < n) goTo(i + 1);
    else if (again) goTo(0);
    else {
      setPlaying(false);
      setClipTime(d[i]);
    }
  }, [n, goTo]);
  const togglePlay = useCallback(() => {
    if (!st.current.playing && st.current.atEnd) goTo(0);
    setPlaying((p) => !p);
  }, [goTo]);
  const seekTo = useCallback((vt: number) => {
    if (!st.current.ready) return;
    const { index, offset } = reelLocate(st.current.durations, vt);
    if (index !== st.current.idx) {
      goTo(index, offset);
      return;
    }
    setClipTime(offset);
    const v = frontEl();
    if (!v || st.current.still) return;
    if (v.readyState >= 1) {
      v.currentTime = offset;
      seekRef.current = null;
    } else seekRef.current = offset; // 아직 안 올라온 영상 — 메타데이터가 오면 맞춘다
  }, [goTo, frontEl]);
  const prevCut = useCallback(() => goTo(Math.max(0, st.current.idx - 1)), [goTo]);
  const nextCut = useCallback(() => goTo(Math.min(n - 1, st.current.idx + 1)), [n, goTo]);

  // 영상 길이를 알게 되면(어느 요소든) 캐시와 길이 배열에 적는다 — 따로 읽을 필요가 없다.
  const learnDuration = useCallback((url: string, seconds: number) => {
    if (!url || !isFinite(seconds) || seconds <= 0 || DURATION_CACHE.has(url)) return;
    DURATION_CACHE.set(url, seconds);
    setDurations((d) => {
      const next = [...d];
      clips.forEach((clip, i) => { if (clip.url === url && !next[i]) next[i] = seconds; });
      return next;
    });
  }, [clips]);
  // 앞의 것이 올라오면 위치를 맞추고, 재생 중이면 튼다. 뒤의 것(미리 받는 중)이 내는 이벤트는 길이만 적는다.
  //  지금 컷이 영상이 아닐 때(이미지·깨진 영상) 앞의 것이 내는 늦은 이벤트도 무시한다 — 숨은 영상을 틀거나 이미지 컷을 '깨진 영상'
  //  으로 만들지 않게(Codex 코드 검토).
  const onLoaded = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    learnDuration(v === frontEl() ? frontUrlRef.current : backUrlRef.current, v.duration);
    if (v !== frontEl() || st.current.still) return;
    if (seekRef.current != null) {
      try { v.currentTime = seekRef.current; } catch { /* 아직 seek 못 함 — 무시 */ }
      seekRef.current = null;
    }
    if (st.current.playing) startPlay(v, frontEl, () => setPlaying(false));
  };
  const onEnded = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    if (e.currentTarget === frontEl() && !st.current.still) goNext();
  };
  // 재생 중 깨진 영상 — ended 가 오지 않아 멈춰 버린다. 3초 멈춘 화면(안내)으로 바꾸고 이어 간다(길이를 이미 알았어도 3초).
  //  뒤의 것이 못 받은 것은 자리 바꾸기에서 걸러진다(error) — 그때 평소 길로 다시 받는다.
  const onVideoError = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    if (e.currentTarget !== frontEl() || st.current.still) return;
    const i = st.current.idx;
    setFailed((f) => new Set(f).add(i));
    setDurations((d) => {
      const next = [...d];
      next[i] = REEL_IMAGE_SEC;
      return next;
    });
    setClipTime(0);
  };
  // 클립이 바뀌면 — 뒤의 것이 그 주소를 미리 받아 두었으면 자리만 바꾸고(받지 않는다), 아니면 앞의 것에 올린다. 그다음 영상
  //  (사이에 이미지 컷이 있어도 그 뒤의 영상)을 뒤의 것에 미리 올린다. 같은 클립을 처음부터(cycle)면 자리만 되돌린다.
  useEffect(() => {
    const clip = clips[idx];
    const fr = frontEl();
    const bk = backEl();
    if (!fr || !bk) return;
    const offset = seekRef.current ?? 0;
    if (clip && clip.type === "video" && !st.current.failed.has(idx)) {
      if (frontUrlRef.current === clip.url) {
        // 같은 영상 — 자리만(처음부터 다시 등)
        if (fr.readyState >= 1) {
          fr.currentTime = offset;
          seekRef.current = null;
        }
      } else if (backUrlRef.current === clip.url && !bk.error && offset === 0) {
        // 자리 바꾸기 — 미리 받아 둔 것을 앞으로
        const other: 0 | 1 = frontRef.current === 0 ? 1 : 0;
        frontRef.current = other;
        setFront(other);
        fr.pause();
        [frontUrlRef.current, backUrlRef.current] = [clip.url, frontUrlRef.current];
        bk.volume = 1; // 굴리느라(또는 굴리다 세워) 꺼 둔 소리를 돌려준다 — 굴리는 중이면 그대로 이어 튼다
        if (!rollingRef.current && bk.readyState >= 1) bk.currentTime = 0;
        rollingRef.current = false;
        seekRef.current = null;
        if (st.current.playing) startPlay(bk, frontEl, () => setPlaying(false));
      } else {
        // 평소 길 — 앞의 것에 올린다(올라오면 onLoaded 가 위치를 맞추고 튼다)
        frontUrlRef.current = clip.url;
        fr.src = clip.url;
        fr.load();
      }
    } else {
      fr.pause(); // 이미지·깨진 영상 — 앞의 것은 세워 둔다(주소는 그대로 — 다음에 같은 영상이면 다시 안 받는다)
      if (rollingRef.current) { // 굴리던 뒤의 것도 세우고 처음으로 — 이미지 컷 동안 혼자 가서 다음 영상의 앞을 건너뛰지 않게
        bk.pause();
        bk.currentTime = 0;
        rollingRef.current = false;
      }
    }
    // 다음 영상을 뒤의 것에 미리 — 이미지 컷은 건너뛰고, 반복이 꺼져 있으면 끝에서 멈춘다
    let nextUrl = "";
    for (let k = 1; k <= n; k++) {
      const j = idx + k;
      if (j >= n && !st.current.loop) break;
      const candidate = clips[j % n];
      if (candidate.type === "video" && !st.current.failed.has(j % n)) {
        nextUrl = candidate.url;
        break;
      }
    }
    const spare = backEl();
    if (spare && nextUrl !== backUrlRef.current) {
      if (rollingRef.current) spare.pause();
      rollingRef.current = false;
      backUrlRef.current = nextUrl;
      if (nextUrl) spare.src = nextUrl;
      else spare.removeAttribute("src");
      spare.load();
    }
  }, [idx, cycle, clips, n, frontEl, backEl]);
  // 재생/정지를 앞의 것에 반영. 맞출 위치가 남아 있으면 onLoaded 가 튼다(0초부터 잠깐 보이지 않게). 세우면(정지·이미지·깨진 영상)
  //  굴리던 뒤의 것도 세우고 처음으로 돌린다.
  useEffect(() => {
    const v = frontEl();
    const b = backEl();
    const stopRolling = () => {
      if (!b || !rollingRef.current) return;
      b.pause();
      if (b.readyState >= 1) b.currentTime = 0;
      rollingRef.current = false;
    };
    if (!v) return;
    if (still) {
      v.pause();
      stopRolling();
      return;
    }
    if (playing) {
      if (seekRef.current == null && frontUrlRef.current === cur?.url) startPlay(v, frontEl, () => setPlaying(false));
    } else {
      v.pause();
      stopRolling();
    }
  }, [playing, still, idx, cycle, cur, frontEl, backEl]);
  // 영상 시간 — 재생 중엔 프레임마다 읽는다(onTimeUpdate 는 4Hz 라 자리가 툭툭 뛴다). 끝이 가까우면 뒤의 것을 소리 없이 굴린다.
  useEffect(() => {
    if (still || !playing) return;
    let raf = 0;
    const jump = jumpRef.current;
    const tick = () => {
      if (jumpRef.current !== jump) return; // 자리를 옮겼다 — 새 컷의 틱이 이어받는다
      const v = frontEl();
      if (v) {
        setClipTime(v.currentTime);
        const remain = v.duration - v.currentTime;
        const b = backEl();
        if (b && backUrlRef.current && !b.error) {
          if (!rollingRef.current && isFinite(remain) && remain <= ROLL_AHEAD && b.readyState >= 2) {
            rollingRef.current = true;
            b.volume = 0;
            const pending = b.play() as Promise<void> | undefined;
            pending?.catch(() => { rollingRef.current = false; }); // 못 굴려도 넘어갈 때 평소 길로 간다
          } else if (rollingRef.current && b.currentTime > ROLL_MAX) {
            b.pause(); // 앞의 것이 서 있어 너무 멀리 갔다 — 제자리로
            b.currentTime = 0;
            rollingRef.current = false;
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [still, playing, idx, cycle, frontEl, backEl]);
  // 닫을 때 두 요소의 주소를 떼고 불러오기를 멈춘다. 요소는 효과를 걸 때 잡아 둔다 — 정리 시점엔 ref 가 이미 비어 있다.
  //  주소 기록도 비운다 — 개발 모드(StrictMode)의 거짓 정리 뒤 효과가 다시 돌 때 '같은 주소' 로 보고 올리지 않던 것(Codex).
  useEffect(() => {
    const elements = [vaRef.current, vbRef.current];
    return () => {
      for (const v of elements) {
        if (!v) continue;
        v.pause();
        v.removeAttribute("src");
        v.load();
      }
      frontUrlRef.current = "";
      backUrlRef.current = "";
      rollingRef.current = false;
    };
  }, []);
  // 멈춘 화면(이미지·깨진 영상) — 재생 중이면 시간을 흘리고 길이를 넘기면 다음 컷.
  useEffect(() => {
    if (!still || !playing || !cur) return;
    const dur = st.current.durations[idx] || REEL_IMAGE_SEC;
    let raf = 0;
    let last = performance.now();
    const jump = jumpRef.current;
    const tick = (now: number) => {
      if (jumpRef.current !== jump) return; // 자리를 옮겼다 — 새 컷의 틱이 이어받는다
      const nt = st.current.clipTime + (now - last) / 1000;
      last = now;
      if (nt >= dur) {
        setClipTime(dur);
        goNext();
        return;
      }
      setClipTime(nt);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [still, playing, idx, cycle, cur, goNext]);

  // 키 — Space 재생/정지 · ↑↓ 컷 이동 · Home/End. 입력칸에 초점이 있거나 크게 보기가 위에 있으면 손대지 않는다.
  useEffect(() => {
    if (!keys) return;
    const onKey = (e: KeyboardEvent) => {
      if (isEditable(e.target)) return;
      if (activationKeyOwned(e)) return; // Tab 으로 찾아간 단추(닫기·반복·음소거…)의 Space 는 그 단추를 누르는 키(lib/keyGate)
      if (e.key === " ") { if (!e.repeat) togglePlay(); } // 길게 눌린 Space 는 막기만 — 재생/정지가 반복마다 뒤집힌다(조작 규칙 38)
      else if (e.key === "ArrowUp") prevCut();
      else if (e.key === "ArrowDown") nextCut();
      else if (e.key === "Home") goTo(0);
      else if (e.key === "End") goTo(Math.max(0, n - 1));
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keys, n, togglePlay, prevCut, nextCut, goTo]);

  // 타임바 — 누르거나 끌어서 이동(길이를 다 알기 전엔 잠금).
  const trackRef = useRef<HTMLDivElement>(null);
  const seekAt = useCallback((clientX: number) => {
    const el = trackRef.current;
    const tot = st.current.durations.reduce((a, b) => a + b, 0);
    if (!el || !st.current.ready || tot <= 0) return;
    const r = el.getBoundingClientRect();
    seekTo(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * tot);
  }, [seekTo]);
  const dragEndRef = useRef<(() => void) | null>(null);
  useEffect(() => () => dragEndRef.current?.(), []);
  const onTrackDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    seekAt(e.clientX);
    const move = (ev: MouseEvent) => seekAt(ev.clientX);
    const up = () => {
      removeWindowMouseDrag(move, up);
      dragEndRef.current = null;
    };
    dragEndRef.current = up;
    addWindowMouseDrag(move, up); // 창을 떠남·단추를 뗀 채 온 움직임에도 끝난다(lib/windowDrag)
  };

  const pct = ready && total > 0 ? (virtual / total) * 100 : 0;
  // 눈금·이름 자리 — 길이를 다 알면 시간 비례, 아직이면 같은 간격.
  const startPct = (i: number) => (ready && total > 0 ? (starts[i] / total) * 100 : (i / n) * 100);
  const midPct = (i: number) => (ready && total > 0 ? ((starts[i] + durations[i] / 2) / total) * 100 : ((i + 0.5) / n) * 100);
  const tbtn = (name: string, title: string, onClick: () => void, icon: React.ReactNode, on?: boolean) => (
    <button type="button" className={`reel-tbtn reel-t-${name}` + (on ? " on" : "")} title={title} aria-label={title} aria-pressed={on} onClick={onClick}>
      {icon}
    </button>
  );
  return (
    <div className="reel-player">
      <div className="reel-screen">
        {!cur && <div className="reel-empty">{t("재생할 생성물이 없습니다")}</div>}
        {/* 영상 요소 둘 — 떼지 않는다. 보이는 쪽(앞)은 front 가 정하고 뒤의 것(.spare)은 다음 영상을 미리 받아 둔 채 가려져 있다. */}
        <video ref={vaRef} className={"reel-media" + (front === 0 ? "" : " spare")} hidden={still} playsInline preload="auto"
          onLoadedMetadata={onLoaded} onEnded={onEnded} onError={onVideoError} />
        <video ref={vbRef} className={"reel-media" + (front === 1 ? "" : " spare")} hidden={still} playsInline preload="auto"
          onLoadedMetadata={onLoaded} onEnded={onEnded} onError={onVideoError} />
        {cur && still && (
          failed.has(idx)
            ? <div className="reel-broken">{t("재생할 수 없는 영상")}</div>
            : <img key={`${idx}-${cycle}`} className="reel-media" src={cur.url} alt="" draggable={false} />
        )}
        {cur && (
          <>
            <span className="reel-chip l">{idx + 1} / {n} · {cur.name} · {cur.worker}</span>
            <span className={"reel-chip r" + (cur.rep ? " rep" : "")}>{cur.rep ? `★ ${t("대표")}` : t("최신 것")}</span>
          </>
        )}
      </div>
      <div className="reel-vbot">
        <div className={"reel-scrub" + (ready ? "" : " wait")} onMouseDown={onTrackDown} title={ready ? undefined : t("길이를 재는 중…")}>
          <div className="reel-track" ref={trackRef}>
            <div className="reel-fill" style={{ width: `${pct}%` }} />
            {clips.map((clip, i) => (i > 0 ? <i key={clip.path} style={{ left: `${startPct(i)}%` }} /> : null))}
            <div className="reel-head" style={{ left: `${pct}%` }} />
          </div>
        </div>
        <div className="reel-labels">
          {clips.map((clip, i) => (
            <button type="button" key={clip.path} className={i === idx ? "cur" : ""} style={{ left: `${midPct(i)}%` }} onClick={() => goTo(i)} title={t("이 컷으로")}>
              {clip.name}
            </button>
          ))}
        </div>
        <div className="reel-trans">
          <span className="reel-vtc">{fmtReelTime(virtual)} / {ready ? fmtReelTime(total) : "…"}</span>
          {tbtn("first", t("처음으로 (Home)"), () => goTo(0),
            <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true"><rect x="1" y="1" width="2" height="12" /><path d="M15 1v12L5 7z" /></svg>)}
          {tbtn("prev", t("이전 컷 (↑)"), prevCut,
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 10.5 7 4l5 6.5z" /></svg>)}
          <button type="button" className="reel-tbtn reel-play" title={t("재생/정지 (Space)")} aria-label={t("재생/정지 (Space)")} onClick={togglePlay}>
            {playing ? (
              <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true"><rect x="1.5" y="1" width="3.2" height="12" /><rect x="7.3" y="1" width="3.2" height="12" /></svg>
            ) : (
              <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true"><path d="M2 1v12l9-6z" /></svg>
            )}
          </button>
          {tbtn("next", t("다음 컷 (↓)"), nextCut,
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 3.5h10L7 10z" /></svg>)}
          {tbtn("last", t("끝으로 (End)"), () => goTo(Math.max(0, n - 1)),
            <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true"><rect x="13" y="1" width="2" height="12" /><path d="M1 1v12l10-6z" /></svg>)}
          {tbtn("loop", t("반복 재생"), () => setLoop((on) => !on),
            <svg className="reel-line" width="18" height="14" viewBox="0 0 18 14" aria-hidden="true"><path d="M5 3h8a4 4 0 0 1 0 8H5a4 4 0 0 1 0-8" /><path d="M8 .6 5 3l3 2.4" /></svg>, loop)}
          <span className="reel-hint">{t("↑↓ 컷 이동 · Space 재생/정지 · 이미지 컷은 3초")}</span>
        </div>
      </div>
    </div>
  );
}
