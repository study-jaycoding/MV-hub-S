// 편집 탭의 다이나믹 재생 모드(Jay 2026-10-26 — 다빈치의 Dynamic Trim Mode, 보기만 · 10-08 의 두 칸을 되살림) — 나뉘어 있던 뷰어 판들이
//  한 창이 되고, **멈춰 있는 동안** 그 창에 재생헤드에서 가장 가까운 편집점의 앞(왼쪽) | 뒤(오른쪽)가 나란히 뜬다. 타임라인 판의 무대를
//  덮는 덮개다. 재생하는 동안은 가려 한 화면(밑의 엔진 화면)으로 재생한다(Jay "재생은 한 화면에서만").
//  · 타임라인을 움직이는 동안(훑기·프레임 이동·↑↓)도 가려 한 화면이 재생헤드를 따라가고, 멈추면 두 칸으로 돌아온다(Jay 2·3차 —
//    "다빈치는 타임라인 움직이면 거기에 맞춰서 움직인다" · 다빈치 화면 두 장).
//  · 칸마다 그 편집점의 프레임(앞 = 직전, 뒤 = 직후)으로 서 있는 영상 요소다 — 엔진·시계와 무관하다.
//  · 덮개는 모드 동안 떼지 않고 가리기만 한다. 가린 동안은 보는 편집점을 바꾸지 않아 칸이 새 영상을 받지 않는다 — 전에는 멈출 때마다
//    칸의 영상 둘을 새로 만들고 움직이면 떼었는데, 뗀 영상이 뒤에서 계속 받아 엔진의 탐색·재생과 다퉜다(Jay 4차 "딜레이").
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  clipKey, editPoints, mediaAt, nearestPoint, shotsAt, type EditDoc, type EditLayout, type EditShot, type SlotClip,
} from "../../lib/editTimeline";
import { fillKeys, hintOf } from "../../lib/editShortcuts";
import { useT } from "../../lib/i18n";
import type { EditSource } from "../../lib/useEditPlayback";

const MOVE_IDLE_MS = 400; // 재생헤드가 이만큼 안 움직이면 '멈춤' — 두 칸으로 돌아온다

// 한 프레임 — 영상을 그 시각으로 보내 세워 둔다. 주소마다 새 요소다(key) — 같은 영상에서 편집점만 바뀌면 다시 보내기만 한다.
//  그 프레임만 받고(preload metadata), 요소가 사라질 때(주소가 바뀜·칸이 빔·모드를 끔) 받던 것을 놓는다 — 떼기만 하면 브라우저는 계속 받는다.
//  받는 동안·못 받으면 그 클립의 썸네일(poster)이 보인다 — CDN 첫 로딩이 느려 검은 칸으로 서 있었다(Jay 5차). 덮개가 다시 보일 때(shown)
//  그 프레임으로 한 번 더 보낸다 — 가려 둔 동안 브라우저가 재생기를 내려놓았어도 다시 그리게(보험).
function Frame({ url, time, poster, shown }: { url: string; time: number; poster: string | null; shown: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video || !shown) return;
    const go = () => {
      video.currentTime = time;
    };
    if (video.readyState) go(); // 이미 받은 영상 — 바로 보낸다
    video.addEventListener("loadedmetadata", go);
    return () => video.removeEventListener("loadedmetadata", go);
  }, [time, shown]);
  useEffect(() => {
    const video = ref.current;
    return () => {
      if (!video) return;
      video.removeAttribute("src");
      video.load(); // 받던 것을 놓는다
    };
  }, []);
  return <video ref={ref} className="ed-media" src={url} muted playsInline preload="metadata" poster={poster ?? undefined} />;
}

function Half({ shot, before, sourceOf, failedKey, shown }: {
  shot: EditShot | null; before: boolean; sourceOf: (clip: SlotClip) => EditSource; failedKey: string; shown: boolean;
}) {
  const t = useT();
  const clip = shot?.clip ?? null;
  const source = clip ? sourceOf(clip) : null;
  const ok = source?.state === "ok";
  // 엔진이 재생하지 못한 클립 — 이 칸도 영상을 다시 받지 않고 썸네일로 두고 알린다(무대의 안내는 덮개 밑이다)
  const failed = !!clip && clipKey(clip) === failedKey;
  const video = ok && source.type === "video" && !failed ? source.url : null;
  const still = ok && !video ? (source.type === "image" ? source.url : source.thumb) : null;
  const notice = !shot ? (before ? t("타임라인의 처음입니다.") : t("타임라인의 끝입니다."))
    : !clip ? t("비어 있음")
      : source?.state === "missing" ? t("미디어 없음 — 공유 목록에 없는 생성물입니다.")
        : source?.state === "unknown" ? t("확인 못 함 — 공유 목록을 아직 받지 못했습니다.")
          : failed ? t("이 영상을 재생하지 못했습니다.") : null;
  return (
    <div className="ed-dyn-half">
      {/* 영상 시각 = 앞 자르기 + 컷 안 시각 × 속도(mediaAt — 재생과 같은 계산) */}
      {video && shot && clip && <Frame key={video} url={video} time={mediaAt(clip, shot.local)} poster={source?.thumb ?? null} shown={shown} />}
      {still && <img className="ed-media" src={still} alt="" draggable={false} />}
      {notice && <div className="ed-notice">{notice}</div>}
      {shot && <span className="ed-chip ed-chip-r">{clip ? `${shot.slot.name} · V${clip.track}` : shot.slot.name}</span>}
    </div>
  );
}

export function EditTrimView({ layout, doc, sourceOf, failedKey, now, playing, registerPaint, onClose }: {
  layout: EditLayout;
  doc: EditDoc;
  sourceOf: (clip: SlotClip) => EditSource;
  failedKey: string; // 엔진이 재생하지 못한 클립의 열쇠(없으면 빈 문자열)
  now: () => number; // 타임라인의 지금 시각
  playing: boolean; // 타임라인의 시계가 도는 중 — 그동안은 가린다
  registerPaint: (paint: (time: number) => void) => () => void;
  onClose: () => void;
}) {
  const t = useT();
  const points = useMemo(() => editPoints(layout), [layout]);
  // 보는 편집점 = 재생헤드에서 가장 가까운 것 — 두 칸이 보일 때 정한다(켤 때·재생을 멈춘 순간·움직임이 멈춘 뒤). 재생헤드의 시각은 React 밖에
  //  있어서 시계가 그릴 때마다 받는다: 다른 시각을 그리면 '움직이는 중'이라 가리고, MOVE_IDLE_MS 동안 안 움직이면 그 자리의 편집점으로 두 칸
  //  (Jay 3차 — 다빈치 그림 1 = 멈춤 두 칸 · 그림 2 = 움직임 한 화면). 가린 동안에는 편집점을 바꾸지 않는다(칸이 새 영상을 받지 않게).
  const [focus, setFocus] = useState(() => nearestPoint(points, now()));
  const [moving, setMoving] = useState(false);
  const live = useRef(points);
  live.current = points;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  useLayoutEffect(() => {
    let last = now();
    let timer = 0;
    const unregister = registerPaint((time) => {
      if (Math.abs(time - last) < 1e-6) return; // 같은 자리를 다시 그린 것(멈춤·배치 맞춤)은 움직임이 아니다
      last = time;
      if (playingRef.current) return; // 재생 중에는 이미 가려 있다 — 멈출 때 정한다(아래)
      setMoving(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!playingRef.current) setFocus(nearestPoint(live.current, now())); // 그사이 틀었으면 멈출 때 정한다
        setMoving(false);
      }, MOVE_IDLE_MS);
    });
    return () => {
      unregister();
      window.clearTimeout(timer);
    };
  }, [registerPaint, now]);
  // 재생을 멈춘 순간 — 기다리지 않고 그 자리의 가장 가까운 편집점으로 두 칸
  useLayoutEffect(() => {
    if (playing) return;
    setFocus(nearestPoint(live.current, now()));
    setMoving(false);
  }, [playing, now]);
  // 배치가 막 바뀐 렌더에는 focus 가 옛 목록의 점일 수 있다 — 새 목록의 가장 가까운 점으로 읽는다
  const [before, after] = shotsAt(layout, doc, points, nearestPoint(points, focus));
  const closeText = fillKeys(t("다이나믹 재생 모드 끄기 ({key})"), { key: hintOf("linked") });
  const shown = !playing && !moving;
  return (
    <div className="ed-dyn" hidden={!shown}>
      <Half shot={before} before sourceOf={sourceOf} failedKey={failedKey} shown={shown} />
      <Half shot={after} before={false} sourceOf={sourceOf} failedKey={failedKey} shown={shown} />
      <button type="button" className="ed-dyn-close" title={closeText} aria-label={closeText}
        onMouseDown={(event) => event.preventDefault()} onClick={onClose}>
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7.5" /><path d="M6.2 6.2l5.6 5.6M11.8 6.2l-5.6 5.6" /></svg>
      </button>
    </div>
  );
}
