// 편집 탭의 '편집점 보기'(Jay 2026-10-08 — 다빈치 트림의 두 화면, 보기만) — 재생헤드에서 가장 가까운 편집점의 바로 앞에 보이던
//  것(왼쪽)과 바로 뒤에 보이는 것(오른쪽)을 나란히 세워 둔다. 타임라인 판의 무대를 덮는 덮개다: 엔진·시계와 무관하고,
//  재생 중에는 숨어서 밑의 엔진 영상이 이어서 보인다. 칸의 영상은 그 시각으로 보내 세워 둘 뿐 재생하지 않는다.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  EDIT_FPS, editPoints, nearestPoint, shotsAt, type EditDoc, type EditLayout, type EditShot, type SlotClip,
} from "../../lib/editTimeline";
import { useT } from "../../lib/i18n";
import type { EditSource } from "../../lib/useEditPlayback";

// 한 프레임 — 영상을 그 시각으로 보내 세워 둔다. 주소마다 새 요소다(key) — 같은 영상에서 편집점만 바뀌면 다시 보내기만 한다.
// ponytail: 못 받은 영상은 검은 칸으로 남는다(대체 그림 없음) — 거슬리면 error 에서 썸네일로 바꾼다.
function Frame({ url, time }: { url: string; time: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const go = () => {
      video.currentTime = time;
    };
    if (video.readyState) go(); // 이미 받은 영상 — 바로 보낸다
    video.addEventListener("loadedmetadata", go);
    return () => video.removeEventListener("loadedmetadata", go);
  }, [time]);
  return <video ref={ref} className="ed-media" src={url} muted playsInline preload="auto" />;
}

function Half({ shot, before, sourceOf }: {
  shot: EditShot | null; before: boolean; sourceOf: (clip: SlotClip) => EditSource;
}) {
  const t = useT();
  const clip = shot?.clip ?? null;
  const source = clip ? sourceOf(clip) : null;
  const ok = source?.state === "ok";
  const video = ok && source.type === "video" ? source.url : null;
  const still = ok && !video ? (source.type === "image" ? source.url : source.thumb) : null;
  const notice = !shot ? (before ? t("타임라인의 처음입니다.") : t("타임라인의 끝입니다."))
    : !clip ? t("비어 있음")
      : source?.state === "missing" ? t("미디어 없음 — 공유 목록에 없는 생성물입니다.")
        : source?.state === "unknown" ? t("확인 못 함 — 공유 목록을 아직 받지 못했습니다.") : null;
  const label = !shot ? "" : !clip ? shot.slot.name : [shot.slot.name, `V${clip.track}`,
    before ? t("마지막 프레임") : shot.local < 1 / EDIT_FPS ? t("첫 프레임") : t("{sec}초 지점").replace("{sec}", shot.local.toFixed(1)),
  ].join(" · ");
  return (
    <div className="ed-half">
      {video && shot && <Frame key={video} url={video} time={shot.local} />}
      {still && <img className="ed-media" src={still} alt="" draggable={false} />}
      {notice && <div className="ed-notice">{notice}</div>}
      {label && <span className={"ed-chip " + (before ? "ed-chip-l" : "ed-chip-r")}>{label}</span>}
    </div>
  );
}

export function EditPointView({ layout, doc, sourceOf, now, playing, registerPaint }: {
  layout: EditLayout;
  doc: EditDoc;
  sourceOf: (clip: SlotClip) => EditSource;
  now: () => number; // 타임라인의 지금 시각
  playing: boolean;
  registerPaint: (paint: (time: number) => void) => () => void;
}) {
  const points = useMemo(() => editPoints(layout), [layout]);
  // 보는 편집점 — 재생헤드의 시각은 React 밖에 있어서, 시계가 그릴 때마다 받아 가장 가까운 점이 바뀔 때만 다시 그린다.
  //  재생 중에는 고치지 않는다(지나가는 편집점마다 영상 둘을 받지 않게) — 멈추면 그 자리로 한 번 다시 잡는다.
  const [focus, setFocus] = useState(() => nearestPoint(points, now()));
  const live = useRef({ points, playing });
  live.current = { points, playing };
  useEffect(() => registerPaint((time) => {
    if (!live.current.playing) setFocus(nearestPoint(live.current.points, time));
  }), [registerPaint]);
  useEffect(() => {
    if (!playing) setFocus(nearestPoint(points, now()));
  }, [playing, points, now]);
  // 배치가 막 바뀐 렌더에는 focus 가 옛 목록의 점일 수 있다 — 새 목록의 가장 가까운 점으로 읽는다
  const [before, after] = shotsAt(layout, doc, points, nearestPoint(points, focus));
  return (
    <div className="ed-split" hidden={playing}>
      <Half shot={before} before sourceOf={sourceOf} />
      <Half shot={after} before={false} sourceOf={sourceOf} />
    </div>
  );
}
