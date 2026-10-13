// 편집 탭의 다이나믹 트림 모드(Jay 2026-10-08 — 다빈치의 Dynamic Trim Mode, 보기만) — 나뉘어 있던 뷰어 판들이 한 창이 되고,
//  그 창에 재생헤드에서 가장 가까운 편집점의 앞(왼쪽) | 뒤(오른쪽)가 나란히 뜬다. 타임라인 판의 무대를 덮는 덮개다.
//  · 재생헤드가 있는 쪽 칸에는 엔진의 화면(무대의 .ed-media)이 올라온다(CSS — data-side). 그래서 재생은 한 번이다: 앞 컷이
//    왼쪽에서 재생되다가 편집점을 넘으면 뒤 컷이 오른쪽에서 이어진다. 훑기·프레임 이동도 그 칸에서 보인다.
//  · 반대쪽 칸은 그 편집점의 프레임(앞 = 마지막 프레임, 뒤 = 첫 프레임)으로 서 있다 — 엔진·시계와 무관한 영상 요소다.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  clipKey, editPoints, nearestPoint, shotsAt, type EditDoc, type EditLayout, type EditShot, type SlotClip,
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

function Half({ shot, before, sourceOf, failedKey }: {
  shot: EditShot | null; before: boolean; sourceOf: (clip: SlotClip) => EditSource; failedKey: string;
}) {
  const t = useT();
  const clip = shot?.clip ?? null;
  const source = clip ? sourceOf(clip) : null;
  const ok = source?.state === "ok";
  // 엔진이 재생하지 못한 클립 — 이 칸도 영상을 다시 받지 않고 썸네일로 두고 알린다(엔진의 안내는 이 모드에서 숨는다)
  const failed = !!clip && clipKey(clip) === failedKey;
  const video = ok && source.type === "video" && !failed ? source.url : null;
  const still = ok && !video ? (source.type === "image" ? source.url : source.thumb) : null;
  const notice = !shot ? (before ? t("타임라인의 처음입니다.") : t("타임라인의 끝입니다."))
    : !clip ? t("비어 있음")
      : source?.state === "missing" ? t("미디어 없음 — 공유 목록에 없는 생성물입니다.")
        : source?.state === "unknown" ? t("확인 못 함 — 공유 목록을 아직 받지 못했습니다.")
          : failed ? t("이 영상을 재생하지 못했습니다.") : null;
  return (
    <div className="ed-half">
      {video && shot && <Frame key={video} url={video} time={shot.local} />}
      {still && <img className="ed-media" src={still} alt="" draggable={false} />}
      {notice && <div className="ed-notice">{notice}</div>}
      {shot && <span className="ed-chip ed-chip-r">{clip ? `${shot.slot.name} · V${clip.track}` : shot.slot.name}</span>}
    </div>
  );
}

export function EditTrimView({ layout, doc, sourceOf, failedKey, now, registerPaint, onClose }: {
  layout: EditLayout;
  doc: EditDoc;
  sourceOf: (clip: SlotClip) => EditSource;
  failedKey: string; // 엔진이 재생하지 못한 클립의 열쇠(없으면 빈 문자열)
  now: () => number; // 타임라인의 지금 시각
  registerPaint: (paint: (time: number) => void) => () => void;
  onClose: () => void;
}) {
  const t = useT();
  const points = useMemo(() => editPoints(layout), [layout]);
  // 보는 편집점 = 재생헤드에서 가장 가까운 것. 재생헤드의 시각은 React 밖에 있어서 시계가 그릴 때마다 받는다 — 가장 가까운 점이
  //  바뀔 때만 다시 그리고(재생 중에도 따라간다), 재생헤드가 편집점의 어느 쪽에 있는지는 React 를 거치지 않고 적는다(data-side).
  const [focus, setFocus] = useState(() => nearestPoint(points, now()));
  const rootRef = useRef<HTMLDivElement>(null);
  const live = useRef(points);
  live.current = points;
  useEffect(() => registerPaint((time) => {
    const point = nearestPoint(live.current, time);
    setFocus(point);
    const side = time < point ? "l" : "r";
    const root = rootRef.current;
    if (root && root.dataset.side !== side) root.dataset.side = side;
  }), [registerPaint]);
  // 배치가 막 바뀐 렌더에는 focus 가 옛 목록의 점일 수 있다 — 새 목록의 가장 가까운 점으로 읽는다
  const [before, after] = shotsAt(layout, doc, points, nearestPoint(points, focus));
  return (
    <div className="ed-split" ref={rootRef}>
      <Half shot={before} before sourceOf={sourceOf} failedKey={failedKey} />
      <Half shot={after} before={false} sourceOf={sourceOf} failedKey={failedKey} />
      <button type="button" className="ed-split-close" title={t("다이나믹 트림 모드 끄기 (W)")} aria-label={t("다이나믹 트림 모드 끄기 (W)")}
        onMouseDown={(event) => event.preventDefault()} onClick={onClose}>
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7.5" /><path d="M6.2 6.2l5.6 5.6M11.8 6.2l-5.6 5.6" /></svg>
      </button>
    </div>
  );
}
