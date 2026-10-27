import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { getAccountScope } from "../../lib/accountScope";
import * as timeline from "../../lib/editTimeline";
import { useEditDoc, type EditOptions } from "../../lib/useEditDoc";

// 실행 함수를 공개하지 않는다. 호출자는 의도와 인자만 주며 Undo 정책은 문서가 결정한다.
const changes = {
  placeClip: timeline.placeClip, moveCut: timeline.moveCut, setTrackColor: timeline.setTrackColor,
  addTrack: timeline.addTrack, moveTrack: timeline.moveTrack, deleteTrack: timeline.deleteTrack,
  deleteEmptyTracks: timeline.deleteEmptyTracks, toggleCutOff: timeline.toggleCutOff,
  fillEmptyCuts: timeline.fillEmptyCuts, setMark: timeline.setMark, addMarker: timeline.addMarker,
  removeMarker: timeline.removeMarker, shiftClips: timeline.shiftClips, removeClips: timeline.removeClips,
  toggleClipsOff: timeline.toggleClipsOff, moveClipToTrack: timeline.moveClipToTrack,
  toggleTrack: timeline.toggleTrack, resetCutOrder: timeline.resetCutOrder,
  insertSlot: timeline.insertSlot, moveClipToSlot: timeline.moveClipToSlot, moveClipIntoSlot: timeline.moveClipIntoSlot,
  setClipRange: timeline.setClipRange, setClipSpeed: timeline.setClipSpeed, patchMarker: timeline.patchMarker, clearMarkers: timeline.clearMarkers,
  recordDurations: timeline.setClipDurs,
  toggleHideOff: (doc: timeline.EditDoc) => {
    const next = { ...doc };
    if (doc.hideOff) delete next.hideOff; else next.hideOff = true;
    return next;
  },
  toggleMute: (doc: timeline.EditDoc) => ({ ...doc, muted: !doc.muted }),
  clearMarks: (doc: timeline.EditDoc, layout: timeline.EditLayout, keys: readonly ("markIn" | "markOut")[]) =>
    keys.reduce((next, key) => timeline.setMark(next, layout, key, null) ?? next, doc),
};
type Tail<T extends unknown[]> = T extends [unknown, ...infer Rest] ? Rest : never;
export type TimelineCommand = {
  [Kind in keyof typeof changes]: { readonly type: Kind; readonly args: Tail<Parameters<(typeof changes)[Kind]>> }
}[keyof typeof changes];
export type TimelineCommandOptions = Pick<EditOptions, "rev" | "group">;
export const MEASURE_SAVE_MS = 500;

export function changeTimeline(doc: timeline.EditDoc, command: TimelineCommand): timeline.EditDoc | null {
  // 분기 표는 위 mapped union이 인자 종류를 검사한 뒤에만 실행한다.
  const change = changes[command.type] as (value: timeline.EditDoc, ...args: unknown[]) => timeline.EditDoc | null;
  return change(doc, ...command.args);
}

export function useTimelineSession(...args: Parameters<typeof useEditDoc>) {
  const engine = useEditDoc(...args);
  const { applyEdit, ...document } = engine;
  const target = useMemo(() => Object.freeze({ key: args[0], account: getAccountScope(), openEpoch: engine.rev }), [args[0], engine.rev]);
  const live = useRef(target); live.current = target;
  const mounted = useRef(true);
  const durationBatches = useRef(new Set<{ dispose: () => void }>());
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      // 이미 받은 측정값은 문서가 닫히기 전에 확정한다. 이후 도착한 callback은 current()가 거절한다.
      for (const batch of [...durationBatches.current]) batch.dispose();
      mounted.current = false;
    };
  }, []);
  const current = useCallback(() => mounted.current && live.current === target && target.account === getAccountScope(), [target]);
  const commit = useCallback((command: TimelineCommand, options: TimelineCommandOptions = {}) => {
    if (!current()) return "none" as const;
    return applyEdit(doc => changeTimeline(doc, command), { ...options, undo: command.type !== "recordDurations" });
  }, [applyEdit, current]);
  const collectDurations = useCallback(() => {
    let closed = false, timer = 0;
    const measured = new Map<string, number>(), exact = new Set<string>();
    const flush = () => {
      window.clearTimeout(timer); timer = 0;
      if (current() && measured.size) commit({ type: "recordDurations", args: [new Map(measured), new Set(exact)] }, { rev: target.openEpoch });
      measured.clear(); exact.clear();
    };
    const batch = {
      add(key: string, seconds: number, sure: boolean) {
        if (closed || !current()) return;
        measured.set(key, seconds); if (sure) exact.add(key);
        timer ||= window.setTimeout(flush, MEASURE_SAVE_MS);
      },
      dispose() {
        if (closed) return;
        flush(); closed = true; durationBatches.current.delete(batch);
      },
    };
    durationBatches.current.add(batch);
    return batch;
  }, [commit, current, target]);
  // 타임라인 저장은 동기 localStorage다. 계정/키/열기 rev·CAS·보관본 검사는 기존 엔진이 소유한다.
  return { ...document, target, commit, collectDurations,
    undo: useCallback(() => { if (current()) engine.undo(); }, [current, engine.undo]),
    redo: useCallback(() => { if (current()) engine.redo(); }, [current, engine.redo]),
  };
}

export type TimelineSession = ReturnType<typeof useTimelineSession>;
