// 편집 탭(다빈치식 컷 타임라인)의 순수 계산 — 컷 순서·배치·보이는 클립·문서 편집.
// React·fetch·localStorage 를 쓰지 않는다(eslint 순수 파일 목록). 계약은 docs/EDIT_TAB.md.
import type { Generation } from "../types";
import { normalizeFolderPath } from "./folderTreeModel";

export const DEFAULT_SEC = 5; // 길이를 모르는 클립·이미지·빈 컷의 자리 길이
export const EDIT_FPS = 24; // 가상 타임라인의 눈금 기준(원본 프레임 단위 정확도 보장 아님)
export const MIN_TRACKS = 3;

// 타임라인에 넣은 생성물 하나. gen 은 팀 카드 id(서버 UUID), job 은 그 id 로 못 찾을 때의 보조 열쇠.
// dur 는 넣는 순간 배치에 쓴 길이 — 목록·메타데이터를 못 받아도 배치가 변하지 않게 문서에 적어 둔다.
export interface EditClip {
  cut: string; // 렌더 루트 기준 컷 폴더 경로(시퀀스 폴더의 직계 하위)
  gen: string;
  job?: string | null;
  track: number; // 1 부터. 위 트랙이 우선 보인다
  off?: boolean;
  dur?: number;
  kind?: "video" | "image";
}

// 북마크(다빈치의 마커) — 자리는 (컷, 컷 안 시각). (컷, 프레임)에 하나뿐이다(markerKey).
export interface EditMarker {
  cut: string;
  local: number;
  color?: string; // "#rrggbb" — 없으면 기본색
  name?: string;
}

export interface EditDoc {
  v: 1;
  clips: EditClip[];
  tracksOff: number[];
  tracksLocked: number[];
  muted?: boolean;
  // 컷(폴더) 비활성 — 기본값(빈 폴더·다른 탭에서 비활성으로 둔 폴더)과 **다르게 정한 것만** 적는다(아래 cutIsOff).
  cutsOn?: string[];
  cutsOff?: string[];
  hideOff?: boolean; // 비활성 컷을 타임라인에서 숨긴다
  // 영상 트랙 줄 수 — 트랙을 더하거나 뺀 뒤에만 적는다(없으면 기본 3줄). 그리는 줄 수는 trackCount 가 정한다.
  tracks?: number;
  trackColors?: Record<number, string>; // 트랙 번호 → "#rrggbb"
  // 마크 인/아웃·북마크 — 자리는 재생헤드와 같은 좌표((컷, 컷 안 시각))라 앞 컷의 길이가 바뀌어도 그 컷 안의 자리가 유지된다.
  //  그 컷이 배치에 없거나(숨김) 그 자리보다 짧아지면 문서에는 남기고 화면에서만 뺀다(markTime).
  markIn?: EditPos;
  markOut?: EditPos;
  markers?: EditMarker[];
}

export function emptyEditDoc(): EditDoc {
  return { v: 1, clips: [], tracksOff: [], tracksLocked: [] };
}

// 길이로 인정하는 값 = 유한한 양수(숫자·숫자 문자열). 0·음수·NaN·Infinity·빈 문자열은 길이가 아니다.
export function validSeconds(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
// 컷 순서 = 이름 자연 정렬(c2 < c10, 대소문자 무시). 같으면 글자 순으로 갈라 순서를 고정한다.
export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

const leaf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
export const clipKey = (clip: Pick<EditClip, "cut" | "gen">) => `${clip.cut}\n${clip.gen}`;

// 폴더 경로가 속한 컷(시퀀스의 직계 하위 폴더). 시퀀스 밖이거나 시퀀스 바로 아래면 null.
export function cutOf(seq: string, folderPath: string | null | undefined): string | null {
  const path = normalizeFolderPath(folderPath);
  if (!seq || !path.startsWith(`${seq}/`)) return null;
  const head = path.slice(seq.length + 1).split("/")[0];
  return head ? `${seq}/${head}` : null;
}

// 컷 목록 = 디스크·팀 개수에서 온 폴더 ∪ 문서에 남은 클립의 컷. 마지막 공유물이 사라져도 자리가 남는다.
export function cutPaths(seq: string, folderPaths: Iterable<string>, doc: EditDoc): string[] {
  const found = new Set<string>();
  for (const path of folderPaths) {
    const cut = cutOf(seq, path);
    if (cut) found.add(cut);
  }
  for (const clip of doc.clips) if (cutOf(seq, clip.cut) === clip.cut) found.add(clip.cut);
  return [...found].sort((a, b) => naturalCompare(leaf(a), leaf(b)));
}

const positiveInt = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const COLOR = /^#[0-9a-f]{6}$/i;
const validPos = (value: unknown): value is EditPos => {
  const pos = value as Partial<EditPos> | null;
  return !!pos && typeof pos === "object" && typeof pos.cut === "string" && !!pos.cut && normalizeFolderPath(pos.cut) === pos.cut &&
    typeof pos.local === "number" && Number.isFinite(pos.local) && pos.local >= 0;
};

// 저장된 값을 문서로 읽는다. 버전·모양·불변식이 어긋나면 null — 호출부는 그것을 빈 문서로 덮지 않는다.
export function parseEditDoc(value: unknown): EditDoc | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.v !== 1 || !Array.isArray(raw.clips)) return null;
  const tracks = (list: unknown): number[] | null =>
    list === undefined ? [] : Array.isArray(list) && list.every(positiveInt) ? [...new Set(list)] : null;
  const tracksOff = tracks(raw.tracksOff);
  const tracksLocked = tracks(raw.tracksLocked);
  if (!tracksOff || !tracksLocked) return null;
  if (raw.muted !== undefined && typeof raw.muted !== "boolean") return null;
  if (raw.hideOff !== undefined && typeof raw.hideOff !== "boolean") return null;
  const paths = (list: unknown): string[] | null =>
    list === undefined ? []
      : Array.isArray(list) && list.every((item) => typeof item === "string" && !!item && normalizeFolderPath(item) === item)
        ? [...new Set(list as string[])] : null;
  const cutsOn = paths(raw.cutsOn);
  const cutsOff = paths(raw.cutsOff);
  if (!cutsOn || !cutsOff || cutsOn.some((cut) => cutsOff.includes(cut))) return null; // 켬·끔에 같이 있을 수 없다
  if (raw.tracks !== undefined && !positiveInt(raw.tracks)) return null;
  const trackColors: Record<number, string> = {};
  if (raw.trackColors !== undefined) {
    if (!raw.trackColors || typeof raw.trackColors !== "object" || Array.isArray(raw.trackColors)) return null;
    for (const [track, color] of Object.entries(raw.trackColors as Record<string, unknown>)) {
      if (!positiveInt(Number(track)) || typeof color !== "string" || !COLOR.test(color)) return null;
      trackColors[Number(track)] = color;
    }
  }
  if ((raw.markIn !== undefined && !validPos(raw.markIn)) || (raw.markOut !== undefined && !validPos(raw.markOut))) return null;
  const markers: EditMarker[] = [];
  if (raw.markers !== undefined) {
    if (!Array.isArray(raw.markers)) return null;
    const taken = new Set<string>();
    for (const item of raw.markers as unknown[]) {
      if (!validPos(item)) return null;
      const { color, name } = item as { color?: unknown; name?: unknown };
      if (color !== undefined && (typeof color !== "string" || !COLOR.test(color))) return null;
      if (name !== undefined && typeof name !== "string") return null;
      const key = markerKey(item);
      if (taken.has(key)) return null; // (컷, 프레임)에 하나뿐
      taken.add(key);
      markers.push({ cut: item.cut, local: item.local, ...(color ? { color } : {}), ...(name ? { name } : {}) });
    }
  }
  const mark = (pos: unknown) => ({ cut: (pos as EditPos).cut, local: (pos as EditPos).local });
  const clips: EditClip[] = [];
  const seen = new Set<string>();
  for (const item of raw.clips as unknown[]) {
    if (!item || typeof item !== "object") return null;
    const c = item as Record<string, unknown>;
    if (typeof c.cut !== "string" || !c.cut || normalizeFolderPath(c.cut) !== c.cut) return null;
    if (typeof c.gen !== "string" || !c.gen || !positiveInt(c.track)) return null;
    if (c.job != null && typeof c.job !== "string") return null;
    if (c.off !== undefined && typeof c.off !== "boolean") return null;
    if (c.dur !== undefined && (typeof c.dur !== "number" || validSeconds(c.dur) === null)) return null;
    if (c.kind !== undefined && c.kind !== "video" && c.kind !== "image") return null;
    const slotKey = `${c.cut}\t${c.track}`;
    const genKey = clipKey({ cut: c.cut, gen: c.gen });
    if (seen.has(slotKey) || seen.has(genKey)) return null; // (컷, 트랙)·(컷, 생성물)은 하나뿐
    seen.add(slotKey).add(genKey);
    clips.push({
      cut: c.cut, gen: c.gen, track: c.track,
      ...(c.job ? { job: c.job as string } : {}),
      ...(c.off ? { off: true } : {}),
      ...(c.dur !== undefined ? { dur: c.dur as number } : {}),
      ...(c.kind ? { kind: c.kind as "video" | "image" } : {}),
    });
  }
  return {
    v: 1, clips, tracksOff, tracksLocked, ...(raw.muted ? { muted: true } : {}),
    ...(cutsOn.length ? { cutsOn } : {}), ...(cutsOff.length ? { cutsOff } : {}), ...(raw.hideOff ? { hideOff: true } : {}),
    ...(raw.tracks !== undefined ? { tracks: raw.tracks as number } : {}),
    ...(Object.keys(trackColors).length ? { trackColors } : {}),
    ...(raw.markIn ? { markIn: mark(raw.markIn) } : {}), ...(raw.markOut ? { markOut: mark(raw.markOut) } : {}),
    ...(markers.length ? { markers } : {}),
  };
}

// ── 컷(폴더) 비활성 ─────────────────────────────────────────────────────────────────────────────
// autoOff = 기본값. 호출부가 정한다(빈 폴더·다른 탭에서 비활성으로 둔 폴더). 문서의 켬/끔이 기본값보다 앞선다.
export function cutIsOff(doc: EditDoc, cut: string, autoOff: boolean): boolean {
  if (doc.cutsOff?.includes(cut)) return true;
  if (doc.cutsOn?.includes(cut)) return false;
  return autoOff;
}

// 지금 상태를 뒤집는다. 기본값과 같아지면 적어 둔 것을 지운다 — 나중에 기본값이 바뀌면(공유물이 생김) 그것을 따른다.
export function toggleCutOff(doc: EditDoc, cut: string, autoOff: boolean): EditDoc {
  const turnOn = cutIsOff(doc, cut, autoOff);
  const cutsOn = (doc.cutsOn ?? []).filter((item) => item !== cut);
  const cutsOff = (doc.cutsOff ?? []).filter((item) => item !== cut);
  if (turnOn && autoOff) cutsOn.push(cut);
  if (!turnOn && !autoOff) cutsOff.push(cut);
  const next: EditDoc = { ...doc };
  delete next.cutsOn;
  delete next.cutsOff;
  if (cutsOn.length) next.cutsOn = cutsOn;
  if (cutsOff.length) next.cutsOff = cutsOff;
  return next;
}

// ── 배치 ────────────────────────────────────────────────────────────────────────────────────────

export interface SlotClip extends EditClip {
  len: number;
}
export interface CutSlot {
  path: string;
  name: string;
  start: number;
  len: number;
  clips: SlotClip[]; // 트랙 오름차순
}
export interface EditLayout {
  cuts: CutSlot[];
  total: number;
  tracks: number; // 그릴 영상 트랙 줄 수
}

export function clipLen(clip: EditClip, fallback?: unknown): number {
  return validSeconds(clip.dur) ?? validSeconds(fallback) ?? DEFAULT_SEC;
}

// 그릴 영상 트랙 줄 수 = 적어 둔 줄 수(없으면 기본 3)와 클립이 있는 가장 높은 트랙 중 큰 쪽.
export function trackCount(doc: EditDoc): number {
  return Math.max(doc.tracks ?? MIN_TRACKS, ...doc.clips.map((clip) => clip.track));
}

// 컷 길이 = 그 컷 클립들의 최대 길이(꺼진 것 포함 — 끌 때 길이가 출렁이지 않게). 빈 컷은 기본 길이.
export function buildLayout(
  cuts: string[],
  doc: EditDoc,
  fallbackOf?: (clip: EditClip) => unknown,
): EditLayout {
  let start = 0;
  const slots = cuts.map((path) => {
    const clips = doc.clips
      .filter((clip) => clip.cut === path)
      .sort((a, b) => a.track - b.track)
      .map((clip) => ({ ...clip, len: clipLen(clip, fallbackOf?.(clip)) }));
    const len = clips.length ? Math.max(...clips.map((clip) => clip.len)) : DEFAULT_SEC;
    const slot: CutSlot = { path, name: leaf(path), start, len, clips };
    start += len;
    return slot;
  });
  return { cuts: slots, total: start, tracks: trackCount(doc) };
}

// 그 순간 보이는 클립 = 꺼지지 않은 것(클립 off·트랙 off) 중 아직 안 끝난 가장 높은 트랙.
// 위 클립이 짧으면 끝난 뒤 아래 클립이 비친다. 잠금은 보이기와 무관하다.
export function visibleClip(doc: EditDoc, slot: CutSlot, local: number): SlotClip | null {
  for (let i = slot.clips.length - 1; i >= 0; i--) {
    const clip = slot.clips[i];
    if (clip.off || doc.tracksOff.includes(clip.track)) continue;
    if (local < clip.len) return clip;
  }
  return null;
}

// '한 트랙만 보기'(뷰어) — 그 순간 그 트랙에 있는 클립. 끔(클립·트랙)은 따지지 않는다: 그 트랙을 보겠다고 고른 것이다.
export function trackClip(slot: CutSlot, track: number, local: number): SlotClip | null {
  const clip = slot.clips.find((item) => item.track === track);
  return clip && local < clip.len ? clip : null;
}

// 컷 안에서 보이는 것이 바뀌는 구간들(컷 기준 시각). A1 줄과 '보이는 소스 변경' 판정에 쓴다.
export function visibleSegments(
  doc: EditDoc,
  slot: CutSlot,
): { from: number; to: number; clip: SlotClip | null }[] {
  const cuts = [...new Set([0, ...slot.clips.map((clip) => clip.len).filter((len) => len < slot.len), slot.len])]
    .sort((a, b) => a - b);
  const out: { from: number; to: number; clip: SlotClip | null }[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const clip = visibleClip(doc, slot, cuts[i]);
    const last = out[out.length - 1];
    if (last && last.clip?.gen === clip?.gen) last.to = cuts[i + 1];
    else out.push({ from: cuts[i], to: cuts[i + 1], clip });
  }
  return out;
}

// ── 위치 ────────────────────────────────────────────────────────────────────────────────────────
// 위치의 원천은 (컷 경로, 컷 안 시각)이다. 앞에 컷이 끼어들거나 앞 컷 길이가 바뀌어도 보던 자리가 유지된다.
// 전체 끝은 (마지막 컷, local = 컷 길이) — 컷 구간은 [start, end) 이고 끝은 따로 둔 정지점이다.

export interface EditPos {
  cut: string;
  local: number;
}

export function timeOf(layout: EditLayout, pos: EditPos | null): number {
  const slot = pos && layout.cuts.find((cut) => cut.path === pos.cut);
  return slot ? slot.start + Math.min(Math.max(pos!.local, 0), slot.len) : 0;
}

export function posAt(layout: EditLayout, time: number): EditPos | null {
  const last = layout.cuts[layout.cuts.length - 1];
  if (!last) return null;
  const t = Math.min(Math.max(Number.isFinite(time) ? time : 0, 0), layout.total);
  const slot = layout.cuts.find((cut) => t < cut.start + cut.len);
  return slot ? { cut: slot.path, local: t - slot.start } : { cut: last.path, local: last.len };
}

// 배치가 바뀐 뒤 위치를 유효한 자리로 맞춘다. moved=true 면 호출부가 재생을 멈춘다.
//  · 보던 컷이 사라짐 → 이름 순서로 그다음 컷의 처음(없으면 전체 끝)
//  · 보던 컷이 local 보다 짧아짐 → 컷 끝 직전
export function settlePos(layout: EditLayout, pos: EditPos | null): { pos: EditPos | null; moved: boolean } {
  const last = layout.cuts[layout.cuts.length - 1];
  if (!last) return { pos: null, moved: pos !== null };
  if (!pos) return { pos: { cut: layout.cuts[0].path, local: 0 }, moved: false };
  const index = layout.cuts.findIndex((cut) => cut.path === pos.cut);
  if (index < 0) {
    const next = layout.cuts.find((cut) => naturalCompare(cut.name, leaf(pos.cut)) > 0);
    return { pos: next ? { cut: next.path, local: 0 } : { cut: last.path, local: last.len }, moved: true };
  }
  const slot = layout.cuts[index];
  if (pos.local < 0) return { pos: { cut: slot.path, local: 0 }, moved: true };
  if (pos.local < slot.len || (pos.local === slot.len && slot === last)) return { pos, moved: false };
  return { pos: { cut: slot.path, local: Math.max(0, slot.len - 1 / EDIT_FPS) }, moved: true };
}

// 편집점 = 컷 경계 + 컷 안에서 끝나는 클립의 끝 + 전체 끝.
export function editPoints(layout: EditLayout): number[] {
  const points = new Set<number>([0, layout.total]);
  for (const slot of layout.cuts) {
    points.add(slot.start);
    for (const clip of slot.clips) if (clip.len < slot.len) points.add(slot.start + clip.len);
  }
  return [...points].sort((a, b) => a - b);
}

export function stepPoint(points: number[], time: number, dir: 1 | -1): number {
  const eps = 0.5 / EDIT_FPS;
  if (dir > 0) return points.find((point) => point > time + eps) ?? points[points.length - 1] ?? 0;
  for (let i = points.length - 1; i >= 0; i--) if (points[i] < time - eps) return points[i];
  return 0;
}

// ── 다이나믹 트림 모드(다빈치의 Dynamic Trim Mode, 보기만) — 편집점의 앞 | 뒤 ──
// 보는 편집점 = 재생헤드에서 가장 가까운 것(↑·↓ 가 쓰는 목록 그대로 — 처음·끝 포함).
export function nearestPoint(points: readonly number[], time: number): number {
  return points.reduce((best, point) => (Math.abs(point - time) < Math.abs(best - time) ? point : best), points[0] ?? 0);
}

export interface EditShot {
  slot: CutSlot;
  local: number; // 컷 안 시각(클립은 컷의 처음에서 시작하므로 그 영상의 시각이기도 하다)
  clip: SlotClip | null; // 그 순간 보이는 클립(위 트랙 우선·끔 반영 — 타임라인 뷰어와 같다). 없으면 빈 화면
}

// 편집점의 [바로 앞, 바로 뒤]에 보이는 것. 표본 시각은 편집점에서 1/4 프레임 떨어진 곳이되 이웃 편집점과의 한가운데를 넘지
//  않는다 — 부동소수 오차로 방금 끝난 클립이 다시 잡히지 않고, 아주 짧게 비치는 클립을 건너뛰지도 않는다(Codex 설계 검토).
//  타임라인의 처음에는 앞이, 끝에는 뒤가 없다(null).
export function shotsAt(
  layout: EditLayout, doc: EditDoc, points: readonly number[], point: number,
): [EditShot | null, EditShot | null] {
  const index = points.indexOf(point);
  const shot = (dir: 1 | -1): EditShot | null => {
    const near = index < 0 ? undefined : points[index + dir];
    const pos = near === undefined ? null : posAt(layout, point + dir * Math.min(0.25 / EDIT_FPS, Math.abs(near - point) / 2));
    const slot = pos && layout.cuts.find((cut) => cut.path === pos.cut);
    return slot ? { slot, local: pos!.local, clip: visibleClip(doc, slot, pos!.local) } : null;
  };
  return [shot(-1), shot(1)];
}

export function timecode(time: number): string {
  const frames = Math.max(0, Math.round((Number.isFinite(time) ? time : 0) * EDIT_FPS));
  const p2 = (n: number) => String(n).padStart(2, "0");
  const seconds = Math.floor(frames / EDIT_FPS);
  return `${p2(Math.floor(seconds / 3600))}:${p2(Math.floor((seconds % 3600) / 60))}:${p2(seconds % 60)}:${p2(frames % EDIT_FPS)}`;
}

// ── 문서 편집 ───────────────────────────────────────────────────────────────────────────────────
// 전부 새 문서를 돌려준다. 바뀐 것이 없거나 거부되면 null(호출부는 저장·Undo 를 건너뛴다).
// 잠긴 트랙의 클립은 빼기·끄기·옮기기 모두 거부하고, 옮길 때는 도착 트랙의 잠금도 본다.

const isLocked = (doc: EditDoc, track: number) => doc.tracksLocked.includes(track);

// 넣을 트랙 = 그 컷의 가장 높은 클립보다 위에서 켜져 있고 안 잠긴 가장 낮은 트랙(넣자마자 보이게).
export function insertTrack(doc: EditDoc, cut: string): number {
  let track = Math.max(0, ...doc.clips.filter((clip) => clip.cut === cut).map((clip) => clip.track)) + 1;
  while (doc.tracksOff.includes(track) || isLocked(doc, track)) track++;
  return track;
}

export function insertClip(
  doc: EditDoc,
  clip: { cut: string; gen: string; job?: string | null; kind: "video" | "image"; dur: number },
): EditDoc | null {
  if (doc.clips.some((item) => item.cut === clip.cut && item.gen === clip.gen)) return null;
  const next: EditClip = {
    cut: clip.cut, gen: clip.gen, track: insertTrack(doc, clip.cut), kind: clip.kind,
    dur: validSeconds(clip.dur) ?? DEFAULT_SEC,
    ...(clip.job ? { job: clip.job } : {}),
  };
  return { ...doc, clips: [...doc.clips, next] };
}

// 빈 곳 채우기(Jay 2026-10-08) — 클립이 하나도 없는 컷에만, 컷마다 하나씩 넣는다(무엇을 넣을지는 호출부가 고른다).
//  그 사이 클립이 생긴 컷은 건너뛴다. 넣은 것이 없으면 null. 한 번이 되돌리기 한 단계다.
export function fillEmptyCuts(doc: EditDoc, picks: readonly Parameters<typeof insertClip>[1][]): EditDoc | null {
  let next = doc;
  for (const pick of picks) {
    if (!next.clips.some((clip) => clip.cut === pick.cut)) next = insertClip(next, pick) ?? next;
  }
  return next === doc ? null : next;
}

// 우클릭 메뉴 — 생성물을 지정한 트랙에 둔다. 그 자리에 다른 클립이 있으면 그것을 빼고 들어간다(교체, Jay 2026-10-08).
//  이미 이 컷에 넣은 생성물이면 새로 넣지 않고 그 클립을 옮긴다(꺼짐·길이는 그대로 — 떠난 트랙은 빈다).
//  도착 트랙이나 떠나는 트랙이 잠겨 있으면 거부한다. 이미 그 트랙에 있으면 바뀐 것이 없다(null).
export function placeClip(
  doc: EditDoc,
  clip: { cut: string; gen: string; job?: string | null; kind: "video" | "image"; dur: number },
  track: number,
): EditDoc | null {
  if (!positiveInt(track) || isLocked(doc, track)) return null;
  const own = doc.clips.find((item) => item.cut === clip.cut && item.gen === clip.gen);
  if (own && (own.track === track || isLocked(doc, own.track))) return null;
  const next: EditClip = own ? { ...own, track } : {
    cut: clip.cut, gen: clip.gen, track, kind: clip.kind,
    dur: validSeconds(clip.dur) ?? DEFAULT_SEC,
    ...(clip.job ? { job: clip.job } : {}),
  };
  return {
    ...doc,
    clips: [...doc.clips.filter((item) => item !== own && !(item.cut === clip.cut && item.track === track)), next],
  };
}

function pick(doc: EditDoc, keys: Iterable<string>): EditClip[] | null {
  const wanted = new Set(keys);
  const picked = doc.clips.filter((clip) => wanted.has(clipKey(clip)));
  return picked.length && !picked.some((clip) => isLocked(doc, clip.track)) ? picked : null;
}

export function removeClips(doc: EditDoc, keys: Iterable<string>): EditDoc | null {
  const picked = pick(doc, keys);
  return picked ? { ...doc, clips: doc.clips.filter((clip) => !picked.includes(clip)) } : null;
}

// 하나라도 켜져 있으면 모두 끄고, 모두 꺼져 있으면 모두 켠다.
export function toggleClipsOff(doc: EditDoc, keys: Iterable<string>): EditDoc | null {
  const picked = pick(doc, keys);
  if (!picked) return null;
  const off = picked.some((clip) => !clip.off);
  return {
    ...doc,
    clips: doc.clips.map((clip) => {
      if (!picked.includes(clip)) return clip;
      const next = { ...clip };
      delete next.off;
      if (off) next.off = true;
      return next;
    }),
  };
}

// 고른 클립들을 한 트랙 위/아래로. 도착 자리에 다른 클립이 있으면 맞바꾼다. 하나라도 못 가면 전체 거부.
export function shiftClips(doc: EditDoc, keys: Iterable<string>, delta: 1 | -1): EditDoc | null {
  const picked = pick(doc, keys);
  if (!picked) return null;
  const track = new Map(doc.clips.map((clip) => [clip, clip.track]));
  // 가는 방향의 앞쪽부터 옮겨야 고른 것끼리 부딪히지 않는다.
  for (const clip of [...picked].sort((a, b) => (b.track - a.track) * delta)) {
    const from = track.get(clip)!;
    const to = from + delta;
    if (to < 1 || isLocked(doc, to)) return null;
    const other = doc.clips.find((item) => item !== clip && item.cut === clip.cut && track.get(item) === to);
    if (other) track.set(other, from);
    track.set(clip, to);
  }
  return { ...doc, clips: doc.clips.map((clip) => (track.get(clip) === clip.track ? clip : { ...clip, track: track.get(clip)! })) };
}

// 끌어서 옮기기 — 클립 하나를 지정한 트랙으로(찬 자리면 맞바꿈).
export function moveClipToTrack(doc: EditDoc, key: string, to: number): EditDoc | null {
  const clip = doc.clips.find((item) => clipKey(item) === key);
  if (!clip || !positiveInt(to) || to === clip.track || isLocked(doc, clip.track) || isLocked(doc, to)) return null;
  return {
    ...doc,
    clips: doc.clips.map((item) =>
      item === clip ? { ...item, track: to }
        : item.cut === clip.cut && item.track === to ? { ...item, track: clip.track } : item),
  };
}

export function toggleTrack(doc: EditDoc, list: "tracksOff" | "tracksLocked", track: number): EditDoc {
  const has = doc[list].includes(track);
  return { ...doc, [list]: has ? doc[list].filter((item) => item !== track) : [...doc[list], track] };
}

// ── 트랙 더하기·빼기·옮기기(트랙 머리 우클릭 메뉴, Jay 2026-10-08) ────────────────────────────────
// 트랙 번호를 통째로 다시 매긴다 — 클립·끔·잠금·색이 같이 따라간다. to 가 null 을 주면 그 트랙은 사라진다(클립도 빠진다).
function renumberTracks(doc: EditDoc, to: (track: number) => number | null): EditDoc {
  const list = (tracks: number[]) => tracks.flatMap((track) => to(track) ?? []);
  const colors = Object.entries(doc.trackColors ?? {}).flatMap(([track, color]) => {
    const next = to(Number(track));
    return next === null ? [] : [[next, color] as const];
  });
  const next: EditDoc = {
    ...doc,
    clips: doc.clips.flatMap((clip) => {
      const track = to(clip.track);
      return track === null ? [] : [track === clip.track ? clip : { ...clip, track }];
    }),
    tracksOff: list(doc.tracksOff),
    tracksLocked: list(doc.tracksLocked),
  };
  delete next.trackColors;
  if (colors.length) next.trackColors = Object.fromEntries(colors);
  return next;
}

// 이 트랙 바로 위에 빈 트랙 하나 — 그 위의 트랙들이 한 줄씩 올라간다.
export function addTrack(doc: EditDoc, above: number): EditDoc | null {
  const count = trackCount(doc);
  if (!positiveInt(above) || above > count) return null;
  return { ...renumberTracks(doc, (track) => (track > above ? track + 1 : track)), tracks: count + 1 };
}

// 트랙을 통째로 한 줄 위/아래로 — 옆 트랙과 자리를 바꾼다. 둘 중 하나라도 잠겨 있으면 거부한다(클립이 옮겨지는 일이다).
// 줄 수는 그대로 적어 둔다 — 안 적으면 맨 위 줄의 클립을 내렸을 때 빈 줄이 된 맨 위 줄이 사라진다(Codex 코드 리뷰).
export function moveTrack(doc: EditDoc, track: number, delta: 1 | -1): EditDoc | null {
  const other = track + delta;
  const count = trackCount(doc);
  if (!positiveInt(track) || track > count || other < 1 || other > count || isLocked(doc, track) || isLocked(doc, other)) return null;
  return { ...renumberTracks(doc, (item) => (item === track ? other : item === other ? track : item)), tracks: count };
}

// 트랙을 지운다 — 그 트랙의 클립도 빠지고 위의 트랙들이 한 줄씩 내려온다. 잠긴 트랙과 마지막 한 줄은 거부한다.
export function deleteTrack(doc: EditDoc, track: number): EditDoc | null {
  const count = trackCount(doc);
  if (!positiveInt(track) || track > count || count < 2 || isLocked(doc, track)) return null;
  return { ...renumberTracks(doc, (item) => (item === track ? null : item > track ? item - 1 : item)), tracks: count - 1 };
}

// 클립이 하나도 없는 트랙을 모두 지운다(숨긴 컷의 클립도 있는 것으로 센다). 한 줄은 남긴다. 지울 것이 없으면 null.
export function deleteEmptyTracks(doc: EditDoc): EditDoc | null {
  const used = [...new Set(doc.clips.map((clip) => clip.track))].sort((a, b) => a - b);
  const keep = used.length ? used : [1];
  if (keep.length === trackCount(doc)) return null;
  return { ...renumberTracks(doc, (track) => (keep.includes(track) ? keep.indexOf(track) + 1 : null)), tracks: keep.length };
}

// 트랙 색(null = 없앰). 바뀐 것이 없으면 null.
export function setTrackColor(doc: EditDoc, track: number, color: string | null): EditDoc | null {
  if (!positiveInt(track) || (doc.trackColors?.[track] ?? null) === color) return null;
  const colors = { ...doc.trackColors };
  if (color) colors[track] = color;
  else delete colors[track];
  const next: EditDoc = { ...doc };
  delete next.trackColors;
  if (Object.keys(colors).length) next.trackColors = colors;
  return next;
}

// ── 마크 인/아웃·북마크(Jay 2026-10-08) ─────────────────────────────────────────────────────────
// 화면에 보일 시각. 그 컷이 배치에 없거나(숨김·사라짐) 그 자리보다 짧아졌으면 null — 문서에는 남고 화면에서만 빠진다.
//  끝으로 자르지 않는다: 자르면 서로 다른 표시가 한 자리에 겹치고, 길이가 돌아와도 제자리로 못 간다.
export function markTime(layout: EditLayout, pos: EditPos | null | undefined): number | null {
  const slot = pos ? layout.cuts.find((cut) => cut.path === pos.cut) : undefined;
  return slot && pos!.local <= slot.len ? slot.start + pos!.local : null;
}

// 인(또는 아웃)을 그 자리에 찍는다(pos = null 이면 지운다). 인을 '보이는' 아웃과 같거나 뒤에 찍으면 아웃을 지우고, 아웃을
// 인과 같거나 앞에 찍으면 인을 지운다(다빈치). 안 보이는 쪽은 건드리지 않는다. 바뀐 것이 없으면 null.
export function setMark(doc: EditDoc, layout: EditLayout, which: "markIn" | "markOut", pos: EditPos | null): EditDoc | null {
  const old = doc[which];
  if (pos ? old?.cut === pos.cut && old.local === pos.local : !old) return null;
  const next: EditDoc = { ...doc };
  delete next[which];
  if (!pos) return next;
  next[which] = { cut: pos.cut, local: pos.local };
  const other = which === "markIn" ? "markOut" : "markIn";
  const at = markTime(layout, pos);
  const otherAt = markTime(layout, doc[other]);
  if (at !== null && otherAt !== null && (which === "markIn" ? otherAt <= at : otherAt >= at)) delete next[other];
  return next;
}

// 인/아웃 구간(표시의 띠·반복 재생) — 하나라도 보이고 두 프레임 이상일 때만. 한쪽만 있으면 전체의 처음/끝까지다.
// 그보다 짧으면 구간으로 치지 않는다: 재생 엔진은 0.04초 안의 차이는 영상을 다시 보내지 않아, 되돌아가도 영상은 그대로 간다.
export function markRange(layout: EditLayout, doc: EditDoc): { from: number; to: number } | null {
  const from = markTime(layout, doc.markIn);
  const to = markTime(layout, doc.markOut);
  if (from === null && to === null) return null;
  const range = { from: from ?? 0, to: to ?? layout.total };
  return range.to - range.from > 1.5 / EDIT_FPS ? range : null;
}

// 화면에 그릴 인/아웃 — 보이는 시각(안 보이면 null)과 구간.
export interface EditMarks {
  in: number | null;
  out: number | null;
  band: { from: number; to: number } | null;
}

export function marksOf(layout: EditLayout, doc: EditDoc): EditMarks {
  return { in: markTime(layout, doc.markIn), out: markTime(layout, doc.markOut), band: markRange(layout, doc) };
}

// 북마크 색 — 다빈치의 마커 색 16가지(같은 순서). 첫 번째가 기본색이다. 이름은 화면에서 t() 로 옮긴다.
export const MARKER_COLORS = [
  { name: "파랑", color: "#1287ff" }, { name: "청록", color: "#00ced0" }, { name: "초록", color: "#00ad2f" },
  { name: "노랑", color: "#f09d00" }, { name: "빨강", color: "#e12401" }, { name: "분홍", color: "#ff44c8" },
  { name: "보라", color: "#9013fe" }, { name: "자홍", color: "#c02e6f" }, { name: "장미", color: "#ffa1b9" },
  { name: "라벤더", color: "#a193c8" }, { name: "하늘", color: "#92e2fd" }, { name: "민트", color: "#72db00" },
  { name: "레몬", color: "#dce95a" }, { name: "모래", color: "#c4915e" }, { name: "코코아", color: "#6e5143" },
  { name: "크림", color: "#f5ebe1" },
] as const;

export const isHexColor = (value: unknown): value is string => typeof value === "string" && COLOR.test(value);

export const markerKey = (marker: EditPos) => `${marker.cut}\n${Math.round(marker.local * EDIT_FPS)}`;

// 그 프레임에 이미 북마크가 있으면 null(보이지 않는 것이어도 — 길이가 돌아오면 다시 보인다).
export function addMarker(doc: EditDoc, pos: EditPos, color?: string): EditDoc | null {
  const key = markerKey(pos);
  if (doc.markers?.some((marker) => markerKey(marker) === key)) return null;
  return { ...doc, markers: [...(doc.markers ?? []), { cut: pos.cut, local: pos.local, ...(isHexColor(color) ? { color } : {}) }] };
}

// 북마크를 모두 지운다(안 보이는 것까지). 없으면 null.
export function clearMarkers(doc: EditDoc): EditDoc | null {
  if (!doc.markers?.length) return null;
  const next: EditDoc = { ...doc };
  delete next.markers;
  return next;
}

export function removeMarker(doc: EditDoc, key: string): EditDoc | null {
  const markers = (doc.markers ?? []).filter((marker) => markerKey(marker) !== key);
  if (markers.length === (doc.markers?.length ?? 0)) return null;
  const next: EditDoc = { ...doc };
  delete next.markers;
  if (markers.length) next.markers = markers;
  return next;
}

// 이름·색 고치기 — 빈 이름·null 색은 그 값을 지운다. 그 북마크가 없거나 바뀐 것이 없으면 null.
export function patchMarker(doc: EditDoc, key: string, change: { name?: string; color?: string | null }): EditDoc | null {
  let changed = false;
  const markers = (doc.markers ?? []).map((marker) => {
    if (markerKey(marker) !== key) return marker;
    const name = change.name === undefined ? marker.name : change.name.trim() || undefined;
    const color = change.color === undefined ? marker.color : change.color ?? undefined;
    if (name === marker.name && color === marker.color) return marker;
    changed = true;
    return { cut: marker.cut, local: marker.local, ...(color ? { color } : {}), ...(name ? { name } : {}) };
  });
  return changed ? { ...doc, markers } : null;
}

// 화면에 보이는 북마크(시간순). key 는 문서의 원래 열쇠 — 고치고 지울 때는 이것만 쓴다.
export interface ShownMarker {
  key: string;
  time: number;
  marker: EditMarker;
}

export function shownMarkers(layout: EditLayout, doc: EditDoc): ShownMarker[] {
  return (doc.markers ?? [])
    .flatMap((marker) => {
      const time = markTime(layout, marker);
      return time === null ? [] : [{ key: markerKey(marker), time, marker }];
    })
    .sort((a, b) => a.time - b.time);
}

// 그 시각의 북마크 — 같은 열쇠(컷·프레임)를 먼저 찾고, 없으면 보이는 시각이 반 프레임 안인 것을 찾는다
// (컷 경계: 앞 컷의 끝에 찍은 것과 다음 컷의 처음은 같은 시각인데 열쇠가 다르다).
export function markerAt(layout: EditLayout, shown: readonly ShownMarker[], time: number): ShownMarker | null {
  const pos = posAt(layout, time);
  const key = pos ? markerKey(pos) : "";
  return shown.find((item) => item.key === key) ?? shown.find((item) => Math.abs(item.time - time) <= 0.5 / EDIT_FPS) ?? null;
}

// 확정된 길이를 문서에 적는다(Undo 단계 아님). 바뀐 것이 없으면 null.
export function setClipDurs(doc: EditDoc, durs: ReadonlyMap<string, number>): EditDoc | null {
  let changed = false;
  const clips = doc.clips.map((clip) => {
    const dur = validSeconds(durs.get(clipKey(clip)));
    if (dur === null || dur === clip.dur) return clip;
    changed = true;
    return { ...clip, dur };
  });
  return changed ? { ...doc, clips } : null;
}

// 되돌리기·다시 하기로 옛 문서를 되살릴 때, 그 사이 확정된 길이는 지금 것을 따른다(길이는 되돌리기 대상이 아니다).
export function keepClipDurs(doc: EditDoc, from: EditDoc): EditDoc {
  const durs = new Map(from.clips.filter((clip) => clip.dur !== undefined).map((clip) => [clipKey(clip), clip.dur!]));
  return setClipDurs(doc, durs) ?? doc;
}

// ── 공유 목록과 잇기 ────────────────────────────────────────────────────────────────────────────

export type EditGen = Pick<Generation, "id" | "job_id" | "status" | "assets" | "params" | "folder_path">;

// 편집에 쓸 수 있는 생성물 = 완료 + 결과 파일 있음 + 영상/이미지(오디오 제외).
export function isUsableGen(gen: EditGen): boolean {
  const type = gen.assets?.[0]?.type;
  return gen.status === "done" && (type === "video" || type === "image");
}

export function groupByCut<G extends EditGen>(seq: string, gens: G[]): Map<string, G[]> {
  const out = new Map<string, G[]>();
  for (const gen of gens) {
    const cut = cutOf(seq, gen.folder_path);
    if (!cut) continue; // 시퀀스 폴더 바로 아래에 놓인 것은 컷이 아니다
    const list = out.get(cut);
    if (list) list.push(gen);
    else out.set(cut, [gen]);
  }
  return out;
}

// ok = 그 컷의 공유 목록에 있음 · missing = 목록을 끝까지 받았는데 없음 · unknown = 실패·상한·조회 전.
// job_id 로 다시 잇는 것은 그 컷 안에서 딱 하나만 맞을 때뿐이다.
export type MediaState = "ok" | "missing" | "unknown";

export function linkClip<G extends EditGen>(
  clip: EditClip,
  gensOfCut: G[] | undefined,
  complete: boolean,
): { state: MediaState; gen: G | null } {
  const direct = gensOfCut?.find((gen) => gen.id === clip.gen);
  if (direct) return { state: "ok", gen: direct };
  if (!complete) return { state: "unknown", gen: null };
  const byJob = clip.job ? (gensOfCut ?? []).filter((gen) => gen.job_id === clip.job) : [];
  return byJob.length === 1 ? { state: "ok", gen: byJob[0] } : { state: "missing", gen: null };
}

// 넣는 순간의 길이 — 영상은 실측값 → params.duration → 기본, 이미지는 기본.
export function genSeconds(gen: EditGen, measured?: number | null): number {
  if (gen.assets?.[0]?.type !== "video") return DEFAULT_SEC;
  return validSeconds(measured) ?? validSeconds(gen.params?.duration) ?? DEFAULT_SEC;
}
