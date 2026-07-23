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

function fmt(t: number): string {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function ViewTimeline({ clips, onClose }: { clips: TimelineClip[]; onClose: () => void }) {
  const [durations, setDurations] = useState<number[]>(() =>
    clips.map((c) => (c.type === "image" ? IMG_DUR : 0)),
  );
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [clipTime, setClipTime] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
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

  // 다음 클립으로(마지막이면 정지, 재생헤드 끝).
  const goNext = useCallback(() => {
    if (idxRef.current + 1 < clips.length) {
      seekRef.current = 0;
      setClipTime(0);
      setIdx(idxRef.current + 1);
    } else {
      setPlaying(false);
    }
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
  }, [isVideo, playing, idx, cur, goNext]);

  // Esc 닫기 · Space 재생/정지.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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

  const playheadPct = total > 0 ? (virtual / total) * 100 : 0;

  return (
    <div className="vtl-backdrop" onMouseDown={onClose}>
      <div className="vtl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="vtl-hd">
          <span className="vtl-title">TIMELINE</span>
          <button className="vtl-close" title="닫기 (Esc)" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="vtl-stage">
          {cur ? (
            isVideo ? (
              <video
                key={idx}
                ref={videoRef}
                src={cur.url}
                onLoadedMetadata={onLoaded}
                onTimeUpdate={onTime}
                onEnded={goNext}
                playsInline
              />
            ) : (
              <img key={idx} src={cur.url} alt={cur.name || ""} draggable={false} />
            )
          ) : (
            <div className="vtl-empty">재생할 생성물이 없습니다</div>
          )}
        </div>
        <div className="vtl-controls">
          <button className="vtl-play" title="재생/정지 (Space)" onClick={() => setPlaying((p) => !p)}>
            {playing ? "❚❚" : "▶"}
          </button>
          <span className="vtl-time">
            {fmt(virtual)} <span className="vtl-time-sep">/</span> {fmt(total)}
          </span>
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
          <div className="vtl-playhead" style={{ left: `${playheadPct}%` }} />
        </div>
      </div>
    </div>
  );
}
