// 모아보기 — 고른 컷의 대표(없으면 가장 최근 것)를 격자 순서대로(Jay 2026-10-08).
//  [개별] = 큰 카드 + 정보(작업자·크레딧·생성일·검토). [연결] = 하나의 영상처럼 이어서 재생 — 편집 탭 뷰어의 재생 줄 모양
//  (가는 타임바·빨간 자리·처음/이전 컷/재생/다음 컷/끝/반복). 대표가 이미지인 컷(과 재생 못 하는 영상)은 3초 멈춘 화면(Jay '가').
//  재생 논리는 캔버스 View 노드의 ViewTimeline 과 같은 원리(가상 시간 = 앞 클립 길이 합 + 지금 위치)지만 그 창과는 요구가 달라
//  (반복 끔·컷 이동·길이를 다 알기 전 이동 잠금·깨진 영상) 따로 둔다 — 잘 도는 창을 고치지 않는다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { fmtReelTime, reelClips, reelLocate, reelStarts, REEL_IMAGE_SEC, type ReelClip } from "../lib/cutReel";
import { workerLabel } from "../lib/cutSummary";
import { formatCredits } from "../lib/formatCredits";
import { formatGenerationDateTime, generationListMeta } from "../lib/generationDisplay";
import { useT } from "../lib/i18n";
import { thumbOf } from "../lib/media";
import { useModelDisplayName } from "../lib/modelCatalog";
import { useEscapeClose } from "../lib/useEscapeClose";
import type { FolderCard, PreviewItem, PreviewTarget } from "../types";
import { CloseIcon } from "./common/ViewIcons";
import { MediaThumbnail } from "./MediaThumbnail";

export type ReelMode = "grid" | "linked";

interface Props {
  folders: FolderCard[]; // 고른 컷(격자 순서) — 호출하는 쪽이 메모해 둔다
  mode: ReelMode;
  onModeChange: (mode: ReelMode) => void;
  previewOpen: boolean; // 크게 보기가 위에 떠 있으면 Esc·Space 는 그쪽 몫
  onClose: () => void;
  onPreview: (target: PreviewTarget) => void;
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

export function CutReel({ folders, mode, onModeChange, previewOpen, onClose, onPreview }: Props) {
  const t = useT();
  useEscapeClose(onClose, !previewOpen);
  const clips = useMemo(() => reelClips(folders), [folders]);
  const reps = folders.filter((folder) => folder.rep).length;
  const items: PreviewItem[] = clips.map((clip) => ({ url: clip.url, type: clip.type, name: clip.name, thumb: clip.thumb }));
  const previewAt = (index: number) => onPreview({ ...items[index], items, index });
  return (
    <div className="reel-backdrop" onMouseDown={onClose}>
      <div className="reel" role="dialog" aria-label={t("모아보기")} onMouseDown={(e) => e.stopPropagation()}>
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
              <ReelCard key={folder.path} folder={folder} order={i + 1} onPreview={() => {
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
function ReelCard({ folder, order, onPreview }: { folder: FolderCard; order: number; onPreview: () => void }) {
  const t = useT();
  const modelName = useModelDisplayName();
  const g = folder.cover;
  const asset = g.assets?.[0];
  const isVideo = asset?.type === "video";
  // undefined = 받는 중, null = 모름. 카드가 다른 표지로 바뀌면(id) 다시 받는다.
  const [credits, setCredits] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    setCredits(undefined);
    api.generationMetrics(g.id)
      .then((m) => { if (!cancelled) setCredits(m.real_credits); })
      .catch(() => { if (!cancelled) setCredits(null); });
    return () => { cancelled = true; };
  }, [g.id]);
  const duration = generationListMeta((g.params || {}) as Record<string, unknown>).duration;
  return (
    <div className="reel-card">
      <button type="button" className="reel-face" title={t("크게 보기")} onClick={onPreview}>
        <MediaThumbnail thumb={thumbOf(g, 512)} isVideo={isVideo} src={asset?.file_path} alt="" fallback={null} />
        {isVideo && <span className="play-badge">▶</span>}
        <span className="reel-order">{order}</span>
        <span className={"reel-rep" + (folder.rep ? " rep" : "")}>{folder.rep ? `★ ${t("대표")}` : t("최신 것")}</span>
      </button>
      <div className="reel-ttl"><b>{folder.name}</b><span>{modelName(g.model)}{duration ? <> · <i>{duration}</i></> : null}</span></div>
      <div className="reel-info">
        <span className="k">{t("작업자")}</span><span className="v">{workerLabel(g)}</span>
        <span className="k">{t("크레딧")}</span>
        <span className="v">{credits === undefined ? "…" : credits != null ? `${formatCredits(credits)} credits` : t("미상")}</span>
        <span className="k">{t("생성일")}</span><span className="v">{formatGenerationDateTime(g.created_at)}</span>
        <span className="k">{t("검토")}</span><span className="v">{g.is_final ? t("최종") : g.is_held ? t("보류") : t("공유")}</span>
      </div>
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
  const [durations, setDurations] = useState<number[]>(() => clips.map((clip) => (clip.type === "image" ? REEL_IMAGE_SEC : 0)));
  const [failed, setFailed] = useState<ReadonlySet<number>>(() => new Set());
  const [idx, setIdx] = useState(0);
  const [clipTime, setClipTime] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [loop, setLoop] = useState(true);
  const [cycle, setCycle] = useState(0); // 같은 클립을 처음부터 다시(단일 클립 반복 등) — video key 로 다시 올린다
  const videoRef = useRef<HTMLVideoElement>(null);
  const seekRef = useRef<number | null>(0); // 클립을 올린 뒤 맞출 위치(초)

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
  useEffect(() => {
    let cancelled = false;
    clips.forEach((clip, i) => {
      if (clip.type === "image") return;
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () => {
        if (cancelled || st.current.failed.has(i)) return;
        setDurations((d) => {
          const next = [...d];
          next[i] = isFinite(v.duration) && v.duration > 0 ? v.duration : REEL_IMAGE_SEC;
          return next;
        });
      };
      v.onerror = () => {
        if (cancelled) return;
        setFailed((f) => new Set(f).add(i));
        setDurations((d) => {
          const next = [...d];
          if (!next[i]) next[i] = REEL_IMAGE_SEC;
          return next;
        });
      };
      v.src = clip.url;
    });
    return () => { cancelled = true; };
  }, [clips]);

  const goTo = useCallback((i: number, offset = 0) => {
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
    const v = videoRef.current;
    if (!v || st.current.still) return;
    if (v.readyState >= 1) {
      v.currentTime = offset;
      seekRef.current = null;
    } else seekRef.current = offset; // 아직 안 올라온 영상 — 메타데이터가 오면 맞춘다
  }, [goTo]);
  const prevCut = useCallback(() => goTo(Math.max(0, st.current.idx - 1)), [goTo]);
  const nextCut = useCallback(() => goTo(Math.min(n - 1, st.current.idx + 1)), [n, goTo]);

  // 새 클립을 올리면 위치를 맞추고, 재생 중이면 이어서 튼다.
  const onLoaded = () => {
    const v = videoRef.current;
    if (!v) return;
    if (seekRef.current != null) {
      try { v.currentTime = seekRef.current; } catch { /* 아직 seek 못 함 — 무시 */ }
      seekRef.current = null;
    }
    if (st.current.playing) startPlay(v, () => videoRef.current, () => setPlaying(false));
  };
  // 재생 중 깨진 영상 — ended 가 오지 않아 멈춰 버린다. 3초 멈춘 화면(안내)으로 바꾸고 이어 간다(길이를 이미 알았어도 3초).
  const onVideoError = () => {
    const i = st.current.idx;
    setFailed((f) => new Set(f).add(i));
    setDurations((d) => {
      const next = [...d];
      next[i] = REEL_IMAGE_SEC;
      return next;
    });
    setClipTime(0);
  };
  // 재생/정지를 지금 영상에 반영. 맞출 위치가 남아 있으면 onLoaded 가 튼다(0초부터 잠깐 보이지 않게).
  useEffect(() => {
    const v = videoRef.current;
    if (!v || still) return;
    if (playing) {
      if (seekRef.current == null) startPlay(v, () => videoRef.current, () => setPlaying(false));
    } else v.pause();
  }, [playing, still, idx, cycle]);
  // 영상 시간 — 재생 중엔 프레임마다 읽는다(onTimeUpdate 는 4Hz 라 자리가 툭툭 뛴다).
  useEffect(() => {
    if (still || !playing) return;
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) setClipTime(v.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [still, playing, idx, cycle]);
  // 멈춘 화면(이미지·깨진 영상) — 재생 중이면 시간을 흘리고 길이를 넘기면 다음 컷.
  useEffect(() => {
    if (!still || !playing || !cur) return;
    const dur = st.current.durations[idx] || REEL_IMAGE_SEC;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
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
      if (e.key === " ") togglePlay();
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
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("blur", up);
      dragEndRef.current = null;
    };
    dragEndRef.current = up;
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("blur", up);
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
        {!cur ? (
          <div className="reel-empty">{t("재생할 생성물이 없습니다")}</div>
        ) : still ? (
          failed.has(idx)
            ? <div className="reel-broken">{t("재생할 수 없는 영상")}</div>
            : <img key={`${idx}-${cycle}`} src={cur.url} alt="" draggable={false} />
        ) : (
          <video
            key={`${idx}-${cycle}`}
            ref={videoRef}
            src={cur.url}
            poster={cur.thumb ?? undefined}
            onLoadedMetadata={onLoaded}
            onEnded={goNext}
            onError={onVideoError}
            playsInline
          />
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
