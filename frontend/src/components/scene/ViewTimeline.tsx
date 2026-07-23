// View 노드 재생 — 연결된 생성물(영상/이미지)들을 순서대로 이어 '끊김없이 연속 재생'하는 타임라인 플레이어.
//  · 별도 영상 파일을 하나로 합치지 않고, <video> 를 클립 순서대로 재생하며 '가상 타임라인'(이전 클립 길이 합
//    + 현재 위치)으로 재생헤드·스크러버를 계산한다. 이미지 클립은 IMG_DUR 초 동안 정지화면으로 재생.
//  · 편집(트리밍/클립 이동)은 범위 밖 — 재생·미리보기 중심.
import { useCallback, useEffect, useRef, useState } from "react";

export interface TimelineClip {
  url: string;
  type: "image" | "video" | "audio";
  name?: string;
  thumb?: string | null;
}

const IMG_DUR = 3; // 이미지 클립 기본 길이(초)
const FPS = 30; // 타임코드 프레임 기준(HH:MM:SS:FF)

// HH:MM:SS:FF 타임코드.
function tc(t: number): string {
  if (!isFinite(t) || t < 0) t = 0;
  const p2 = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const f = Math.floor((t - Math.floor(t)) * FPS);
  return `${p2(h)}:${p2(m)}:${p2(s)}:${p2(f)}`;
}

export function ViewTimeline({
  clips,
  onClose,
  onDownload,
}: {
  clips: TimelineClip[];
  onClose: () => void;
  onDownload?: (srcs: string[], name: string) => Promise<void>;
}) {
  const [durations, setDurations] = useState<number[]>(() =>
    clips.map((c) => (c.type === "image" ? IMG_DUR : 0)),
  );
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [clipTime, setClipTime] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [downloading, setDownloading] = useState(false);
  const [isFs, setIsFs] = useState(false); // 전체화면 여부
  const [cycle, setCycle] = useState(0); // 클립을 처음부터 다시 시작할 때마다 증가 — 같은 클립 재시작(단일/반복) 강제 remount 용
  const vtlRef = useRef<HTMLDivElement>(null); // 전체화면 대상 컨테이너
  const videoRef = useRef<HTMLVideoElement>(null);
  const seekRef = useRef<number | null>(null); // 클립 전환 후 적용할 seek 오프셋(초)
  const idxRef = useRef(idx);
  idxRef.current = idx;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const durationsRef = useRef(durations);
  durationsRef.current = durations;
  const clipTimeRef = useRef(clipTime);
  clipTimeRef.current = clipTime;

  const cur = clips[idx];
  const isVideo = !!cur && (cur.type === "video" || cur.type === "audio");
  const total = durations.reduce((a, b) => a + b, 0);
  const before = durations.slice(0, idx).reduce((a, b) => a + b, 0);
  const virtual = before + clipTime;

  // 비디오/오디오 길이 측정(메타데이터). 실패 시 IMG_DUR 로 폴백.
  useEffect(() => {
    let cancelled = false;
    clips.forEach((c, i) => {
      if (c.type === "image") return;
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () => {
        if (cancelled) return;
        setDurations((d) => {
          const n = [...d];
          n[i] = isFinite(v.duration) && v.duration > 0 ? v.duration : IMG_DUR;
          return n;
        });
      };
      v.onerror = () => {
        if (cancelled) return;
        setDurations((d) => {
          const n = [...d];
          if (!n[i]) n[i] = IMG_DUR;
          return n;
        });
      };
      v.src = c.url;
    });
    return () => {
      cancelled = true;
    };
  }, [clips]);

  // 다음 클립으로. 마지막이면 처음(0)으로 — 기본 반복 재생(끊김없이 순환).
  //  cycle 을 올려 video key(idx-cycle) 를 바꿔, 같은 클립으로 되돌아가는 경우(단일 클립/반복)에도 remount·재시작되게 한다.
  const goNext = useCallback(() => {
    const nextIdx = idxRef.current + 1 < clips.length ? idxRef.current + 1 : 0;
    seekRef.current = 0;
    setClipTime(0);
    setCycle((c) => c + 1);
    setIdx(nextIdx);
  }, [clips.length]);

  // 가상 시간(vt)으로 이동 — 어느 클립의 어느 오프셋인지 찾아 seek.
  const seekTo = useCallback(
    (vt: number) => {
      const d = durationsRef.current;
      const tot = d.reduce((a, b) => a + b, 0);
      if (tot <= 0) return;
      const clamped = Math.max(0, Math.min(vt, tot));
      let acc = 0;
      let target = d.length - 1;
      let off = 0;
      for (let i = 0; i < d.length; i++) {
        if (clamped < acc + d[i] || i === d.length - 1) {
          target = i;
          off = clamped - acc;
          break;
        }
        acc += d[i];
      }
      const sameClip = target === idxRef.current;
      setClipTime(off);
      if (sameClip) {
        seekRef.current = null; // 같은 클립: 즉시 seek(대기 없음)
        const v = videoRef.current;
        if (v && clips[target]?.type !== "image") {
          try {
            v.currentTime = off;
          } catch {
            /* seek 전 로드 안 됨 — 무시 */
          }
        }
      } else {
        seekRef.current = off; // 다른 클립: remount 후 onLoadedMetadata 에서 적용
        setIdx(target);
      }
    },
    [clips],
  );

  // 새 클립 로드 시 seek 오프셋 적용 + 볼륨 반영 + 재생 중이면 재생.
  const onLoaded = () => {
    const v = videoRef.current;
    if (!v) return;
    if (seekRef.current != null) {
      try {
        v.currentTime = seekRef.current;
      } catch {
        /* noop */
      }
      seekRef.current = null;
    }
    v.muted = muted;
    v.volume = volume;
    if (playingRef.current) void v.play().catch(() => {});
  };
  const onTime = () => {
    const v = videoRef.current;
    if (v) setClipTime(v.currentTime);
  };

  // play/pause 를 현재 비디오에 반영. ★대기 중인 seek(seekRef)가 있으면 play 를 미룬다 —
  //   remount 직후 onLoaded 가 currentTime 을 맞춘 뒤 재생해야 0초부터 잠깐 재생되는 문제를 막는다.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !isVideo) return;
    if (playing) {
      if (seekRef.current == null) void v.play().catch(() => {});
    } else v.pause();
  }, [playing, isVideo, idx]);

  // 볼륨/뮤트 반영.
  useEffect(() => {
    const v = videoRef.current;
    if (v) {
      v.muted = muted;
      v.volume = volume;
    }
  }, [muted, volume, idx]);

  // 비디오 클립 타이밍 — 재생 중엔 매 프레임 video.currentTime 을 읽어 부드럽게 갱신한다.
  //  (onTimeUpdate 는 ~4Hz 라 타임코드 프레임 자리가 툭툭 건너뛰어 보인다 → rAF 로 매끄럽게.)
  useEffect(() => {
    if (!isVideo || !playing) return;
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) setClipTime(v.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isVideo, playing, idx, cycle]);

  // 이미지 클립 타이밍 — 재생 중이면 실시간으로 clipTime 을 늘리고, 길이를 넘기면 다음 클립으로.
  //  ★전환(goNext)은 setClipTime updater '밖'에서 처리한다(updater 안 부수효과는 StrictMode 중복·중복전환 위험).
  //   clipTimeRef 로 최신값을 읽어 seek(같은 이미지 클립 내)도 이어서 반영한다.
  useEffect(() => {
    if (isVideo || !playing || !cur) return;
    const dur = durationsRef.current[idxRef.current] || IMG_DUR;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const nt = clipTimeRef.current + (now - last) / 1000;
      last = now;
      if (nt >= dur) {
        setClipTime(dur); // 끝으로 고정(오버슈트 방지)
        goNext(); // updater 밖에서 1회 전환 → 이 effect 는 정리되고 다음 클립용으로 재시작
        return;
      }
      setClipTime(nt);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isVideo, playing, idx, cycle, cur, goNext]); // cycle: 단일/반복 이미지 클립 재시작 시 rAF 재개

  // Esc 닫기(전체화면 중엔 브라우저가 먼저 해제 — 그땐 닫지 않음) · Space 재생/정지.
  const togglePlayRef = useRef<() => void>(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (document.fullscreenElement) return; // 전체화면 해제만
        onClose();
      } else if (e.key === " ") {
        e.preventDefault();
        togglePlayRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 전체화면 토글 — .vtl 컨테이너를 전체화면으로.
  useEffect(() => {
    const onFs = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);
  const toggleFs = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void vtlRef.current?.requestFullscreen().catch(() => {});
  };

  // 타임라인 트랙 클릭/드래그로 스크럽.
  const trackRef = useRef<HTMLDivElement>(null);
  const seekAtClientX = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      const tot = durationsRef.current.reduce((a, b) => a + b, 0);
      if (!el || tot <= 0) return;
      const r = el.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      seekTo(f * tot);
    },
    [seekTo],
  );
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanupRef.current?.(), []); // 드래그 중 언마운트되면 리스너 정리
  const onTrackDown = (e: React.MouseEvent) => {
    e.preventDefault();
    seekAtClientX(e.clientX);
    const move = (ev: MouseEvent) => seekAtClientX(ev.clientX);
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      dragCleanupRef.current = null;
    };
    dragCleanupRef.current = up;
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const togglePlay = () => setPlaying((p) => !p);
  togglePlayRef.current = togglePlay;

  // 합쳐진 영상 다운로드 — 연결된 영상들을 서버에서 하나로 병합해 내려받는다.
  const download = async () => {
    if (!onDownload || downloading) return;
    setDownloading(true);
    try {
      await onDownload(
        clips.map((c) => c.url),
        "timeline",
      );
    } catch (e) {
      console.warn("[timeline] 병합 다운로드 실패", e);
    } finally {
      setDownloading(false);
    }
  };

  const playheadPct = total > 0 ? (virtual / total) * 100 : 0;

  // 타임 눈금 — 큰 눈금(라벨)과 그 사이 작은 눈금(촘촘하게). majorStep 은 총 길이에 맞춰 정하고, 작은 눈금은 그 1/5.
  const majorStep = (() => {
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    return steps.find((s) => (total > 0 ? total / s : 0) <= 8) ?? 600;
  })();
  const minorStep = majorStep / 5;
  const rulerTicks: { t: number; major: boolean }[] = [];
  if (total > 0) {
    for (let k = 0; k * minorStep <= total + 0.001; k++) {
      rulerTicks.push({ t: k * minorStep, major: k % 5 === 0 });
    }
  }

  return (
    <div className="vtl-backdrop" onMouseDown={onClose}>
      <div className="vtl" ref={vtlRef} onMouseDown={(e) => e.stopPropagation()}>
        <div className="vtl-hd">
          <span className="vtl-title">TIMELINE</span>
          <div className="vtl-hd-actions">
            <button className="vtl-icon" title={isFs ? "창 모드" : "전체화면"} onClick={toggleFs}>
              {isFs ? "🡼" : "⛶"}
            </button>
            {onDownload && (
              <button
                className="vtl-dl"
                title="합쳐진 영상 다운로드(mp4)"
                disabled={downloading}
                onClick={download}
              >
                {downloading ? "병합 중…" : "⬇ 다운로드"}
              </button>
            )}
            <button className="vtl-close" title="닫기 (Esc)" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>
        <div className="vtl-stage">
          {cur ? (
            isVideo ? (
              <video
                key={`${idx}-${cycle}`}
                ref={videoRef}
                src={cur.url}
                onLoadedMetadata={onLoaded}
                onTimeUpdate={onTime}
                onEnded={goNext}
                playsInline
              />
            ) : (
              <img key={`${idx}-${cycle}`} src={cur.url} alt={cur.name || ""} draggable={false} />
            )
          ) : (
            <div className="vtl-empty">재생할 생성물이 없습니다</div>
          )}
        </div>
        <div className="vtl-controls">
          <div className="vtl-center">
            <span className="vtl-time cur">{tc(virtual)}</span>
            <button className="vtl-play" title="재생/정지 (Space)" onClick={togglePlay}>
              {playing ? "❚❚" : "▶"}
            </button>
            <span className="vtl-time total">{tc(total)}</span>
          </div>
          <div className="vtl-vol">
            <button className="vtl-mute" title={muted ? "음소거 해제" : "음소거"} onClick={() => setMuted((m) => !m)}>
              {muted || volume === 0 ? "🔇" : "🔊"}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => {
                const v = Number(e.target.value);
                setVolume(v);
                setMuted(v === 0);
              }}
            />
          </div>
        </div>
        <div className="vtl-timeline">
          <div className="vtl-ruler">
            {rulerTicks.map((tk, i) => {
              const pct = (tk.t / total) * 100;
              return (
                <div
                  key={i}
                  className={"vtl-ruler-tick" + (tk.major ? " major" : "") + (pct > 88 ? " end" : "")}
                  style={{ left: `${pct}%` }}
                >
                  {tk.major && <span className="vtl-ruler-label">{tc(tk.t)}</span>}
                </div>
              );
            })}
          </div>
          <div className="vtl-track" ref={trackRef} onMouseDown={onTrackDown}>
            {clips.map((c, i) => {
              const w = total > 0 ? (durations[i] / total) * 100 : 100 / Math.max(1, clips.length);
              return (
                <div
                  key={i}
                  className={"vtl-clip" + (i === idx ? " cur" : "")}
                  style={{ width: `${w}%` }}
                  title={c.name || `클립 ${i + 1}`}
                >
                  {c.thumb ? <img src={c.thumb} alt="" draggable={false} /> : <div className="vtl-clip-ph" />}
                  <span className="vtl-clip-n">{i + 1}</span>
                </div>
              );
            })}
          </div>
          {/* 재생헤드 — 줄자~트랙 전체 높이를 관통(위에 삼각형). */}
          <div className="vtl-playhead" style={{ left: `${playheadPct}%` }} />
        </div>
      </div>
    </div>
  );
}
