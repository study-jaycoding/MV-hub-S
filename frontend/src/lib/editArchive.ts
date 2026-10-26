import { clipKey, cutOf, folderOf, isRepeatSlot, isSlotId, parseEditDoc, validSlotKey, type EditDoc } from "./editTimeline";

export interface ArchiveTarget { projectId: string; seq: string }
export interface EditArchive extends ArchiveTarget {
  format: "mvhub-edit-doc";
  schemaVersion: 1;
  exportedAt: string;
  snapshotKind: "working" | "stored";
  unsaved: boolean;
  projectName?: string;
  docRaw: string;
}
export interface EditRecoveryArchive extends ArchiveTarget {
  format: "mvhub-edit-recovery";
  schemaVersion: 1;
  exportedAt: string;
  workingArchive: EditArchive | null;
  storedRaw: string | null;
  storedInvalid: boolean;
}

export const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
const MAX_DOC_BYTES = 1024 * 1024;
const MAX_ITEMS = 10_000;
const MAX_SECONDS = 86_400;
export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).byteLength;

export function createEditArchive(doc: EditDoc, target: ArchiveTarget, unsaved: boolean): EditArchive {
  return {
    format: "mvhub-edit-doc", schemaVersion: 1, exportedAt: new Date().toISOString(),
    projectId: target.projectId, seq: target.seq, snapshotKind: "working", unsaved, docRaw: JSON.stringify(doc),
  };
}

export function createRecoveryArchive(target: ArchiveTarget, workingArchive: EditArchive | null, storedRaw: string | null, storedInvalid: boolean): string {
  const archive: EditRecoveryArchive = {
    format: "mvhub-edit-recovery", schemaVersion: 1, exportedAt: new Date().toISOString(),
    projectId: target.projectId, seq: target.seq, workingArchive, storedRaw, storedInvalid,
  };
  return JSON.stringify(archive);
}

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => !!value && typeof value === "object" && !Array.isArray(value);
const keysFit = (value: ObjectValue, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));
const boundedString = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const track = (value: unknown) => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 128;
const timeFits = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value <= MAX_SECONDS;
const normalKeys = ["format", "schemaVersion", "exportedAt", "projectId", "seq", "snapshotKind", "unsaved", "projectName", "docRaw"];
const recoveryKeys = ["format", "schemaVersion", "exportedAt", "projectId", "seq", "workingArchive", "storedRaw", "storedInvalid"];
const docKeys = ["v", "clips", "tracksOff", "tracksLocked", "muted", "cutsOn", "cutsOff", "hideOff", "tracks", "trackColors", "markIn", "markOut", "markers", "cutOrder"];
const clipKeys = ["cut", "gen", "job", "track", "off", "dur", "durExact", "kind", "trim", "head", "speed", "slot"];
const posKeys = ["cut", "local"];

function validTimestamp(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && Number(value.slice(11, 13)) < 24;
}

function validHeader(raw: ObjectValue, target: ArchiveTarget): boolean {
  return raw.schemaVersion === 1 && validTimestamp(raw.exportedAt) &&
    boundedString(raw.projectId, 256) && raw.projectId === target.projectId &&
    boundedString(raw.seq, 2048) && raw.seq === target.seq;
}

function boundedDoc(raw: unknown, seq: string): EditDoc | null {
  if (!object(raw) || !keysFit(raw, docKeys) || !Array.isArray(raw.clips) || raw.clips.length > MAX_ITEMS) return null;
  if (raw.tracks !== undefined && !track(raw.tracks)) return null;
  for (const field of ["tracksOff", "tracksLocked"]) {
    const list = raw[field];
    if (list !== undefined && (!Array.isArray(list) || list.length > MAX_ITEMS || !list.every(track))) return null;
  }
  if (raw.trackColors !== undefined && (!object(raw.trackColors) || !Object.keys(raw.trackColors).every((key) => String(Number(key)) === key && track(Number(key))))) return null;
  // 자리 열쇠별 길이 — 폴더 자리는 비어도 기본 5초로 그려지고, 반복 자리(폴더//ID)는 클립이 있을 때만 있다: 클립이 있으면 폴더처럼 기본 5초
  //  (길이가 안 적힌 클립도 배치는 기본 길이다 — Codex 독립 리뷰 1차), 참조만 남은 열쇠는 0초(개수 한도에는 센다). 클립을 먼저 세므로(아래 순서)
  //  live = 클립에서 온 열쇠. 판(v 3)·글자 규칙의 마지막 검사는 parseEditDoc 이 한다 — 여기는 그 시퀀스의 직계 컷인지와 한도.
  const cuts = new Map<string, number>();
  const cutFits = (value: unknown, live = false): value is string => {
    if (!boundedString(value, 2048) || !validSlotKey(value, 3)) return false;
    const folder = folderOf(value);
    if (cutOf(seq, folder) !== folder) return false;
    if (!cuts.has(value)) cuts.set(value, isRepeatSlot(value) && !live ? 0 : 5);
    return cuts.size <= MAX_ITEMS;
  };
  const posFits = (value: unknown, marker = false): boolean => object(value) &&
    keysFit(value, marker ? [...posKeys, "color", "name"] : posKeys) && cutFits(value.cut) && timeFits(value.local) &&
    (!marker || value.name === undefined || boundedString(value.name, 1024));
  for (const clip of raw.clips) {
    if (!object(clip) || !keysFit(clip, clipKeys) || isRepeatSlot(String(clip.cut)) || !cutFits(clip.cut) || !boundedString(clip.gen, 512) ||
      (clip.job != null && !boundedString(clip.job, 512)) || !track(clip.track)) return null;
    if (clip.slot !== undefined && !isSlotId(clip.slot)) return null;
    const slot = clip.slot === undefined ? clip.cut : `${clip.cut}//${clip.slot}`;
    if (!cutFits(slot, true)) return null;
    for (const field of ["dur", "trim", "head"]) if (clip[field] !== undefined && !timeFits(clip[field])) return null;
    // 속도의 값 검사는 parseEditDoc 이 한다(v 2·영상·범위) — 여기서는 느린 속도로 늘어난 타임라인 길이만 한도에 센다(자리마다 — 같은 폴더의 두 자리는 따로)
    //  길이가 안 적힌 클립은 기본 5초로 그려진다 — 그것에도 속도를 친다(느린 속도면 길어진다, Codex 독립 리뷰 2차)
    const speed = typeof clip.speed === "number" && clip.speed > 0 ? clip.speed : 1;
    cuts.set(slot, Math.max(cuts.get(slot)!, (typeof clip.dur === "number" ? clip.dur : 5) / speed));
  }
  for (const field of ["cutsOn", "cutsOff", "cutOrder"]) {
    const list = raw[field];
    if (list !== undefined && (!Array.isArray(list) || list.length > MAX_ITEMS || !list.every((item) => cutFits(item)))) return null;
  }
  for (const field of ["markIn", "markOut"]) if (raw[field] !== undefined && !posFits(raw[field])) return null;
  if (raw.markers !== undefined && (!Array.isArray(raw.markers) || raw.markers.length > MAX_ITEMS || !raw.markers.every((marker) => posFits(marker, true)))) return null;
  let total = 0;
  for (const seconds of cuts.values()) { total += seconds; if (total > MAX_SECONDS) return null; }
  return parseEditDoc(raw);
}

type ArchiveResult = { ok: true; doc: EditDoc; archive: EditArchive } | { ok: false; message: string };
const invalid = (): ArchiveResult => ({ ok: false, message: "지원하지 않는 형식·필드·대상이거나 복원 안전 한도를 넘은 파일입니다." });

export function parseEditArchive(text: string, target: ArchiveTarget): ArchiveResult {
  if (utf8Bytes(text) > MAX_ARCHIVE_BYTES) return { ok: false, message: "파일이 10 MiB 복원 한도를 넘습니다." };
  try {
    let raw: unknown = JSON.parse(text);
    if (!object(raw) || !validHeader(raw, target)) return invalid();
    if (raw.format === "mvhub-edit-recovery") {
      if (!keysFit(raw, recoveryKeys) || (raw.storedRaw !== null && typeof raw.storedRaw !== "string") || typeof raw.storedInvalid !== "boolean") return invalid();
      if (raw.workingArchive === null) return { ok: false, message: "이 파일은 원문 보존용이며 자동 복원할 작업본이 없습니다." };
      raw = raw.workingArchive;
    }
    if (!object(raw) || raw.format !== "mvhub-edit-doc" || !keysFit(raw, normalKeys) || !validHeader(raw, target) ||
      (raw.snapshotKind !== "working" && raw.snapshotKind !== "stored") || typeof raw.unsaved !== "boolean" ||
      (raw.projectName !== undefined && !boundedString(raw.projectName, 1024)) || typeof raw.docRaw !== "string" || utf8Bytes(raw.docRaw) > MAX_DOC_BYTES) return invalid();
    const doc = boundedDoc(JSON.parse(raw.docRaw), target.seq);
    return doc ? { ok: true, doc, archive: raw as unknown as EditArchive } : invalid();
  } catch { return { ok: false, message: "JSON 파일을 읽을 수 없습니다." }; }
}

export function knownDocEquals(a: EditDoc, b: EditDoc): boolean {
  const canonical = (doc: EditDoc) => {
    const parsed = parseEditDoc(doc);
    if (!parsed) return null;
    parsed.clips.sort((x, y) => clipKey(x).localeCompare(clipKey(y))); // 자리 열쇠 + 생성물 — 같은 생성물의 두 자리도 순서가 정해진다
    parsed.tracksOff.sort((x, y) => x - y);
    parsed.tracksLocked.sort((x, y) => x - y);
    parsed.cutsOn?.sort();
    parsed.cutsOff?.sort();
    parsed.markers?.sort((x, y) => x.cut.localeCompare(y.cut) || x.local - y.local);
    return JSON.stringify(parsed);
  };
  const left = canonical(a), right = canonical(b);
  return left !== null && right !== null && left === right;
}
