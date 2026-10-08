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
  return { cuts: slots, total: start, tracks: Math.max(MIN_TRACKS, ...doc.clips.map((clip) => clip.track)) };
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
