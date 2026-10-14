// 소스 판 하나의 엔진(2026-10-14 Jay — "두개 화면 모두 소스클립이나 내가 정한 화면이 자유롭게"). 판 자리(왼쪽 0 · 오른쪽 1)마다
//  하나씩 둔다 — 두 판이 서로 다른 소스 클립을 띄운다. 소스 판은 두 방식이다(다빈치 컷 페이지의 Source Clip · Source Tape):
//   · 소스 클립("source") — 그 판이 고른 생성물 하나.
//   · 소스 테이프("tape") — 재생헤드가 있는 컷의 풀 목록 전체를 풀의 정렬 순서대로 이어 붙인 것(검색어는 따지지 않는다).
//  둘 다 생성물마다 컷 하나·클립 하나짜리 가상 시퀀스(`@src/<id>`)를 타임라인과 같은 엔진으로 튼다 — 조작·훑기·반복이 같다.
//  편집 문서에는 아무것도 쓰지 않는다. 판이 소스가 아니거나 안 보이면(mode null) 비우고 멈춘다 — 안 보이는 판이 풀의 영상 카드를
//  누를 때마다 그 영상을 끝까지 받았다(2026-10-13 격리 실측). 보던 자리는 범위(scope)가 바뀔 때 엔진이 기억해 둔다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Generation } from "../../types";
import { buildLayout, emptyEditDoc, genSeconds, type EditDoc, type SlotClip } from "../../lib/editTimeline";
import { useVideoPair } from "../../lib/editVideoPair";
import { thumbOf } from "../../lib/media";
import { useEditPlayback, type EditSource } from "../../lib/useEditPlayback";
import { knownVideoSeconds, measureVideoSeconds } from "../../lib/videoDuration";

export const SRC_CUT = "@src";
const NO_GENS: Generation[] = [];
const NO_MARKS: readonly number[] = [];
const NO_SOURCE = { doc: emptyEditDoc(), layout: buildLayout([], emptyEditDoc()), byId: new Map<string, Generation>() };

export function useSourcePane({ place, mode, gen, tape, tapeScope, loop, speed }: {
  place: 0 | 1;
  mode: "source" | "tape" | null; // null = 이 판은 소스가 아니거나 안 보인다
  gen: Generation | null; // 소스 클립 — 이 판이 고른 것
  tape: Generation[]; // 소스 테이프 — 풀의 정렬 순서
  tapeScope: string; // 테이프의 범위(프로젝트·컷) — 보던 자리를 따로 기억한다
  loop: boolean;
  speed: number;
}) {
  const video = useVideoPair(); // 소스 테이프도 클립에서 클립으로 넘어간다
  const painters = useRef(new Set<(time: number) => void>());
  const gens = useMemo(() => (!mode ? NO_GENS : mode === "tape" ? tape : gen ? [gen] : NO_GENS), [mode, tape, gen]);
  // 길이 — 실측값이 오면 고친다(타임라인에 안 넣은 영상은 적어 둔 길이가 없다 — 안 고치면 기본 5초에서 끝난다).
  //  하나씩 차례로 잰다: 길이 재기의 큐는 앱 전체가 같이 쓰고 동시에 4개라, 테이프의 영상을 한꺼번에 줄 세우면 타임라인
  //  클립이나 방금 고른 소스의 길이 재기가 그 뒤로 밀린다. 목록·방식이 바뀌거나 떠나면 더 신청하지 않는다(Codex 설계 검토).
  // ponytail: 영상이 아주 많은 컷은 끝까지 재는 데 오래 걸린다 — 안 잰 것은 그동안 적힌 길이·기본 5초로 지나간다.
  const [seconds, setSeconds] = useState<ReadonlyMap<string, number>>(new Map());
  useEffect(() => {
    let alive = true;
    void (async () => {
      for (const item of gens) {
        const asset = item.assets[0];
        if (asset?.type !== "video" || !asset.file_path || knownVideoSeconds(asset.file_path)) continue;
        const url = asset.file_path;
        const measured = await measureVideoSeconds(url);
        if (!alive) return;
        if (measured) setSeconds((prev) => new Map(prev).set(url, measured));
      }
    })();
    return () => {
      alive = false;
    };
  }, [gens]);
  const src = useMemo(() => {
    if (!gens.length) return NO_SOURCE;
    const made: EditDoc = {
      ...emptyEditDoc(),
      clips: gens.map((item) => {
        const asset = item.assets[0];
        const known = seconds.get(asset.file_path) ?? knownVideoSeconds(asset.file_path);
        return { cut: `${SRC_CUT}/${item.id}`, gen: item.id, track: 1, kind: asset.type, dur: genSeconds(item, known) };
      }),
    };
    return { doc: made, layout: buildLayout(made.clips.map((clip) => clip.cut), made), byId: new Map(gens.map((item) => [item.id, item])) };
  }, [gens, seconds]);
  const sourceOf = useCallback((clip: SlotClip): EditSource => {
    const item = src.byId.get(clip.gen);
    const asset = item?.assets[0];
    return { state: "ok", url: asset?.file_path ?? null, type: asset?.type ?? null, thumb: item ? thumbOf(item, 512) : null };
  }, [src]);
  const paint = useCallback((time: number) => painters.current.forEach((draw) => draw(time)), []);
  const play = useEditPlayback({
    // 판 자리를 범위 앞에 붙인다 — 두 판이 같은 생성물을 띄워도 보던 자리가 섞이지 않게
    scope: !mode ? `src${place}-off` : mode === "tape" ? `tape${place}\n${tapeScope}` : gen ? `src${place}\n${gen.id}` : `src${place}`,
    layout: src.layout, doc: src.doc, sourceOf, videoRef: video.pair, paint, loop, speed,
  });
  const { now, stop } = play;
  const registerPaint = useCallback((draw: (time: number) => void) => {
    painters.current.add(draw);
    draw(now());
    return () => {
      painters.current.delete(draw);
    };
  }, [now]);
  useEffect(() => {
    if (!mode) stop(); // 판을 내리면 그 소스도 멈춘다
  }, [mode, stop]);
  // 소스 테이프의 클립 경계(재생바의 얇은 줄)와, 지금 이 판에 보이는 생성물
  const starts = useMemo(() => (mode === "tape" ? src.layout.cuts.slice(1).map((item) => item.start) : NO_MARKS), [mode, src]);
  const shown = src.byId.get(play.view.clip?.gen ?? "") ?? (mode === "tape" ? null : gen);
  return { video, gens, src, play, registerPaint, starts, shown };
}
