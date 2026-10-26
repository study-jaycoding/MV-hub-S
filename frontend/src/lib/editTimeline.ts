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
  // dur 이 그림 트랙의 프레임 수로 잰 값이다(2026-10-14 — lib/videoDuration 의 measuredExactly). 이 표가 있으면 video.duration 으로 잰
  //  값(소리까지 친 길이 — 서버가 그림 길이를 못 준 창)이 덮지 않는다. 안 그러면 두 창이 서로 고쳐 쓴다(Codex 코드 리뷰).
  durExact?: boolean;
  kind?: "video" | "image";
  // 사용자가 줄인 길이(초) — 뒤를 자른다(Jay 2026-10-13: 타임라인 클립 휠 클릭 = 길이 조절). 영상만이고 원본(dur)보다 길게는 못 한다.
  //  dur 과 따로 둔다: dur 은 실측이 오면 고쳐 적히고 되돌리기 대상이 아니다. 이것은 사용자의 편집이라 되돌리기 대상이다.
  trim?: number;
  // 앞에서 잘라 낸 길이(초, Jay 2026-10-14: 길이 조절에서 앞도 자른다) — 그 클립은 원본의 이 시각에서 시작한다. 영상만. 없으면 0.
  //  trim 은 그대로 '쓰는 길이'다(시작점부터 센다). 실제로 쓰는 값(유효 시작)은 clipHead 가 프레임에 맞춰 원본 안으로 자른다 —
  //  적힌 값은 남긴다(trim 과 같은 까닭: 실측 전의 dur 은 추정값이다).
  head?: number;
  // 재생 속도 배율(Jay 2026-10-23 — Ctrl+R 속도 조절, 다빈치 리타임). 영상만 · SPEED_MIN~SPEED_MAX · 1 이면 적지 않는다. head·trim 은 그대로
  //  **원본 초**다 — 타임라인 길이만 원본 ÷ 속도(clipLen). 영상 시각 ↔ 컷 안 시각은 mediaAt·localAt 두 함수로만 바꾼다.
  //  이 칸이 있는 문서는 v 2 다(옛 빌드가 모르는 칸을 버리고 저장하지 않게 — parseEditDoc 이 v 1 의 speed 를 거부한다).
  speed?: number;
  // 같은 컷(폴더)을 컷 사이에 한 번 더 놓은 자리(Jay 2026-10-23 ⑤) — 그 자리의 ID. cut 은 그대로 실제 폴더(생성물은 폴더로 찾는다)이고,
  //  자리의 열쇠는 slotOf = `폴더//ID` 다(배치·위치·마크·북마크·D·cutOrder·clipKey). 첫 자리(폴더 그대로)의 클립에는 없다.
  //  이 칸이 있는 문서는 v 3 이다. 그 자리의 클립을 다 빼면 자리도 없다(Jay 결정). 계약은 docs/status/편집탭_컷끼워넣기_설계_2026-10-23.md.
  slot?: string;
}

// 자리 열쇠 = 폴더 경로 + "//" + 자리 ID. "//" 는 정규화된 폴더 경로에 나올 수 없다(normalizeFolderPath 가 빈 마디를 지운다) — 실제 폴더와
//  겹치지 않는다. ID 는 소문자·숫자(호출부가 무작위로 짓는다 — 다시 쓰지 않는다: 지워진 자리의 북마크·D 가 새 자리에 붙지 않게).
const SLOT_SEP = "//";
const SLOT_ID = /^[a-z0-9]{1,16}$/;
export const isSlotId = (value: unknown): value is string => typeof value === "string" && SLOT_ID.test(value);
export const slotOf = (clip: Pick<EditClip, "cut" | "slot">) => (clip.slot ? `${clip.cut}${SLOT_SEP}${clip.slot}` : clip.cut);
export const isRepeatSlot = (key: string) => key.includes(SLOT_SEP);
export const folderOf = (key: string) => {
  const at = key.indexOf(SLOT_SEP);
  return at < 0 ? key : key.slice(0, at);
};
const slotIdOf = (key: string) => {
  const at = key.indexOf(SLOT_SEP);
  return at < 0 ? null : key.slice(at + SLOT_SEP.length);
};
// 자리 열쇠 → 클립에 적는 칸(cut = 폴더, slot = ID)
export const slotFields = (key: string): Pick<EditClip, "cut" | "slot"> => {
  const id = slotIdOf(key);
  return id ? { cut: folderOf(key), slot: id } : { cut: key };
};
// 문서에 적힌 열쇠의 글자 검사 — "//" 가 없으면 정규화된 폴더 경로, 있으면 v 3 이고 정확히 한 번이며 앞(폴더)은 정규화 일치·뒤는 ID.
//  열쇠 전체를 정규화하지 않는다(정규화가 "//" 를 지운다).
export function validSlotKey(value: unknown, v: number): value is string {
  if (typeof value !== "string" || !value) return false;
  const id = slotIdOf(value);
  if (id === null) return normalizeFolderPath(value) === value;
  const folder = folderOf(value);
  return v === 3 && !!folder && normalizeFolderPath(folder) === folder && isSlotId(id);
}

export const SPEED_MIN = 0.25;
export const SPEED_MAX = 4;
// 속도로 인정하는 값 = SPEED_MIN~SPEED_MAX 안의 유한한 수. 아니면 null.
export function validSpeed(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= SPEED_MIN - 1e-9 && value <= SPEED_MAX + 1e-9 ? value : null;
}

// 북마크(다빈치의 마커) — 자리는 (컷, 컷 안 시각). (컷, 프레임)에 하나뿐이다(markerKey).
export interface EditMarker {
  cut: string;
  local: number;
  color?: string; // "#rrggbb" — 없으면 기본색
  name?: string;
}

export interface EditDoc {
  // 2 = 속도(speed)를 쓴 문서 · 3 = 반복 자리(EditClip.slot · 자리 열쇠)를 쓴 문서 — 한 번 오르면 저장본은 계속 그 판(writeEditDoc 이 max 로 지킨다)
  v: 1 | 2 | 3;
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
  // 사용자가 정한 컷(폴더) 순서(Jay 2026-10-13: 타임라인의 폴더 순서를 내가 바꾼다) — 컷 경로. 없으면 이름순(cutPaths).
  //  이름순과 같아지면 지운다. 목록에 없는 컷(나중에 생긴 폴더)이 설 자리는 cutPaths 가 정한다.
  cutOrder?: string[];
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

// 이름 = 폴더의 마지막 마디(반복 자리도 그 폴더 이름 — 번호는 slotLabels 가 붙인다)
const leaf = (path: string) => {
  const folder = folderOf(path);
  return folder.slice(folder.lastIndexOf("/") + 1);
};
export const clipKey = (clip: Pick<EditClip, "cut" | "gen" | "slot">) => `${slotOf(clip)}\n${clip.gen}`;

// 폴더 경로가 속한 컷(시퀀스의 직계 하위 폴더). 시퀀스 밖이거나 시퀀스 바로 아래면 null.
export function cutOf(seq: string, folderPath: string | null | undefined): string | null {
  const path = normalizeFolderPath(folderPath);
  if (!seq || !path.startsWith(`${seq}/`)) return null;
  const head = path.slice(seq.length + 1).split("/")[0];
  return head ? `${seq}/${head}` : null;
}

// 이름순 — 폴더 이름 → 같은 폴더면 첫 자리(폴더 그대로)가 앞 → 반복 자리끼리는 열쇠 글자 순(ID 가 무작위라 만든 순서는 아니지만 늘 같다)
const byName = (a: string, b: string) =>
  naturalCompare(leaf(a), leaf(b)) || Number(isRepeatSlot(a)) - Number(isRepeatSlot(b)) || naturalCompare(a, b);

// 사용자가 정한 순서(saved — 지금 없는 컷이 섞여 있을 수 있다)로 이름순의 지금 컷들(natural)을 다시 세운다.
//  · 목록에 있고 지금 있는 컷 = 목록 순서.
//  · 목록에 없는 컷(순서를 정한 뒤에 생긴 폴더) = **이름순에서 자기 바로 앞인 컷의 뒤**(앞선 컷이 하나도 없으면 맨 앞). 이름순으로
//    하나씩 끼우므로 같은 자리에 여럿이 끼어도 그들끼리는 이름순이다 — 같은 입력이면 언제나 같은 순서다.
//  · 목록에만 있고 지금 없는 컷 = 건너뛴다(목록에는 남는다 — moveCut. 그 폴더가 다시 나타나면 제자리).
//  경로는 글자 그대로 본다(대소문자만 다른 폴더는 다른 컷이다 — naturalCompare 의 동률 가르기까지 쓴다).
export function orderCuts(natural: readonly string[], saved?: readonly string[]): string[] {
  if (!saved?.length) return [...natural];
  const present = new Set(natural);
  const out = saved.filter((path) => present.has(path));
  const placed = new Set(out);
  natural.forEach((path, index) => {
    if (placed.has(path)) return;
    let at = 0;
    for (let before = index - 1; before >= 0; before--) {
      const found = out.indexOf(natural[before]);
      if (found >= 0) {
        at = found + 1;
        break;
      }
    }
    out.splice(at, 0, path);
    placed.add(path);
  });
  return out;
}

// 컷 목록 = 디스크·팀 개수에서 온 폴더 ∪ 문서에 남은 클립의 컷. 마지막 공유물이 사라져도 자리가 남는다.
//  순서 = 이름 자연 정렬, 사용자가 순서를 정했으면(doc.cutOrder) 그 순서(orderCuts).
export function cutPaths(seq: string, folderPaths: Iterable<string>, doc: EditDoc): string[] {
  const found = new Set<string>();
  for (const path of folderPaths) {
    const cut = cutOf(seq, path);
    if (cut) found.add(cut);
  }
  const firstUsed = new Set<string>();
  const repeated = new Set<string>();
  for (const clip of doc.clips) {
    if (cutOf(seq, clip.cut) !== clip.cut) continue;
    found.add(clip.cut);
    if (clip.slot) {
      found.add(slotOf(clip));
      repeated.add(clip.cut);
    } else firstUsed.add(clip.cut);
  }
  // 빈 첫 자리는 보이지 않는다(Jay 2026-10-26 — "비어있는 부분을 없앨수도 없네"): 폴더의 첫 자리(폴더 그대로)에 클립이 없고 그 폴더에 살아 있는
  //  반복 자리가 있으면 첫 자리를 뺀다 — 그 폴더의 클립은 다 반복 자리에 있다. 반복 자리가 다 없어지면 돌아온다. 순서·D·북마크 기록은 그대로다.
  for (const folder of repeated) if (!firstUsed.has(folder)) found.delete(folder);
  return orderCuts([...found].sort(byName), doc.cutOrder);
}

// 폴더 → 그 폴더의 보이는 자리(Jay 2026-10-26) — 배치에 폴더 열쇠(첫 자리)가 있으면 그것, 없으면(빈 첫 자리가 숨었다) 순서에서 그 폴더의 첫 보이는
//  자리, 그것도 없으면 null. 왼쪽 폴더 고르기가 쓴다.
export function slotOfFolder(layout: EditLayout, folder: string): string | null {
  return (layout.cuts.find((slot) => slot.path === folder) ?? layout.cuts.find((slot) => folderOf(slot.path) === folder))?.path ?? null;
}

// 자리 이름(Jay 2026-10-23 ⑤) — 같은 폴더의 자리가 둘 이상이면 전체 순서(숨긴 자리 포함)대로 'C0050 ①'·'C0050 ②'…, 하나면 폴더 이름 그대로.
//  번호는 표시일 뿐 열쇠가 아니다. all = cutPaths.
const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
export function slotLabels(all: readonly string[]): Map<string, string> {
  const total = new Map<string, number>();
  for (const key of all) total.set(folderOf(key), (total.get(folderOf(key)) ?? 0) + 1);
  const seen = new Map<string, number>();
  const out = new Map<string, string>();
  for (const key of all) {
    const folder = folderOf(key);
    const n = (seen.get(folder) ?? 0) + 1;
    seen.set(folder, n);
    out.set(key, total.get(folder)! > 1 ? `${leaf(key)} ${n <= CIRCLED.length ? CIRCLED[n - 1] : `(${n})`}` : leaf(key));
  }
  return out;
}

// 자리의 긴 이름(툴팁·창 제목) — 폴더 경로의 마지막 마디를 자리 이름으로(무작위 ID 는 보이지 않는다)
export function slotTitle(slot: Pick<CutSlot, "path" | "name">): string {
  const folder = folderOf(slot.path);
  return folder.slice(0, folder.lastIndexOf("/") + 1) + slot.name;
}

// 컷(폴더) 하나를 before 앞으로 옮긴다(before = null 이면 맨 뒤). all = 지금의 전체 순서(cutPaths — 숨긴 컷 포함).
//  적는 것은 옮긴 결과 **전체**다. 저장돼 있던 순서의 '지금 없는 컷'은 제자리에 남긴다(그 폴더가 돌아오면 그 자리) — 지금 컷만
//  적으면 그 자리가 지워진다(Codex 설계 검토). 결과가 이름순과 같으면 칸을 지운다. 바뀐 것이 없으면 null.
//  순서가 바뀌어 마크 인이 아웃보다 뒤에 놓여도 여기서는 건드리지 않는다 — 그릴 때·찍을 때 바로잡는다(straightMarks).
export function moveCut(doc: EditDoc, all: readonly string[], path: string, before: string | null): EditDoc | null {
  if (!all.includes(path) || before === path || (before !== null && !all.includes(before))) return null;
  // 지금 순서에서 제자리면 바뀐 것이 없다 — 아래의 전체 목록으로만 견주면, 바로 뒤 컷 앞에 놓은 것(제자리)이 그 사이의 '지금 없는 컷'을
  //  넘어간 것으로 적혀 그 폴더의 돌아올 자리가 바뀐다(Codex 코드 리뷰 2026-10-13).
  if (slotStays(all, path, before)) return null;
  return writeOrder(doc, all, path, before);
}

// 전체 순서(all — 숨긴 자리 포함)에서 key 를 before 앞에 놓아도 제자리인가 — 컷 순서 끌기·자리째 옮기기(moveClipToSlot)와 화면의 놓기 전
//  거르기가 같이 쓴다(보이는 배치로 보면 숨긴 컷이 사이에 있을 때 트랙에 따라 결과가 갈렸다 — Codex 설계 4차). all 에 없으면 아니다.
export function slotStays(all: readonly string[], key: string, before: string | null): boolean {
  const index = all.indexOf(key);
  return index >= 0 && (before === key || before === (all[index + 1] ?? null));
}

// path 를 before 앞에 둔 순서를 적는다 — path 가 all 에 없으면(새 자리) 새로 끼운다. 바뀐 것이 없으면 null.
function writeOrder(doc: EditDoc, all: readonly string[], path: string, before: string | null): EditDoc | null {
  // 저장된 순서(없는 컷 포함)에 아직 안 적힌 지금 컷을, 화면의 바로 앞 컷 뒤에 끼워 넣어 전체 목록을 만든다.
  const full = [...(doc.cutOrder ?? [])];
  all.forEach((cut, index) => {
    if (full.includes(cut)) return;
    full.splice(index ? full.indexOf(all[index - 1]) + 1 : 0, 0, cut);
  });
  const moved = full.filter((cut) => cut !== path);
  moved.splice(before === null ? moved.length : moved.indexOf(before), 0, path);
  if (moved.length === full.length && moved.every((cut, index) => cut === full[index])) return null;
  return withOrder(doc, moved);
}

// 순서를 새로 적는다 — 이름순과 같으면 칸을 지운다. 그때 **클립 없는 반복 자리의 열쇠**를 순서·D·북마크에서 뺀다(그 자리는 없고 ID 를 다시
//  쓰지 않으므로 돌아오지 않는다 — 되돌리기 말고는. 안 빼면 쌓인다). 자리를 없애는 명령(빼기·트랙 지우기)은 순서를 건드리지 않는다 — 재생헤드는
//  재생 쪽이 기억한 직전 순서로 그 자리의 다음을 찾는다(settlePos 의 previous). **인/아웃은 남긴다**: 한쪽만 지우면 구간이 말없이 넓어진다 —
//  사라진 자리의 인/아웃은 안 보이고 구간은 꺼진다(markRange). 숨겨진(배치에 없는) 살아 있는 자리는 클립이 있어 남는다.
function withOrder(doc: EditDoc, order: readonly string[]): EditDoc {
  const live = new Set(doc.clips.map(slotOf));
  const keep = (key: string) => !isRepeatSlot(key) || live.has(key);
  const list = order.filter(keep);
  const next: EditDoc = { ...doc };
  delete next.cutOrder;
  if (list.some((cut, index) => index > 0 && byName(list[index - 1], cut) > 0)) next.cutOrder = list;
  for (const field of ["cutsOn", "cutsOff"] as const) {
    const kept = doc[field]?.filter(keep);
    delete next[field];
    if (kept?.length) next[field] = kept;
  }
  const markers = doc.markers?.filter((marker) => keep(marker.cut));
  delete next.markers;
  if (markers?.length) next.markers = markers;
  return next;
}

// 폴더끼리의 순서(각 폴더가 처음 나오는 순서)가 이름순과 다른가 — 반복 자리를 컷 사이에 끼운 것만으로는 아니다. 막대의 순서 알약이
//  '내 순서 ↺'(되돌리기)와 '폴더순'(표시만) 중 무엇을 보일지 정한다(Jay 2026-10-26 "폴더순으로 되는건데 내순서라고 적혀있어서 헷갈린다").
export function foldersReordered(order: readonly string[]): boolean {
  const folders = [...new Set(order.map(folderOf))];
  return folders.some((folder, index) => index > 0 && byName(folders[index - 1], folder) > 0);
}

// 이름순으로 되돌린다 — 반복 자리는 자기 폴더의 첫 자리 바로 뒤로 모인다(이름순의 뜻). 정한 순서가 없으면 null.
export function resetCutOrder(doc: EditDoc): EditDoc | null {
  if (!doc.cutOrder?.length) return null;
  return withOrder(doc, []);
}

const positiveInt = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const COLOR = /^#[0-9a-f]{6}$/i;
const validPos = (value: unknown, v: number): value is EditPos => {
  const pos = value as Partial<EditPos> | null;
  return !!pos && typeof pos === "object" && validSlotKey(pos.cut, v) &&
    typeof pos.local === "number" && Number.isFinite(pos.local) && pos.local >= 0;
};

// 저장된 값을 문서로 읽는다. 버전·모양·불변식이 어긋나면 null — 호출부는 그것을 빈 문서로 덮지 않는다.
export function parseEditDoc(value: unknown): EditDoc | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if ((raw.v !== 1 && raw.v !== 2 && raw.v !== 3) || !Array.isArray(raw.clips)) return null;
  const v = raw.v;
  const tracks = (list: unknown): number[] | null =>
    list === undefined ? [] : Array.isArray(list) && list.every(positiveInt) ? [...new Set(list)] : null;
  const tracksOff = tracks(raw.tracksOff);
  const tracksLocked = tracks(raw.tracksLocked);
  if (!tracksOff || !tracksLocked) return null;
  if (raw.muted !== undefined && typeof raw.muted !== "boolean") return null;
  if (raw.hideOff !== undefined && typeof raw.hideOff !== "boolean") return null;
  const paths = (list: unknown): string[] | null =>
    list === undefined ? []
      : Array.isArray(list) && list.every((item) => validSlotKey(item, v)) ? [...new Set(list as string[])] : null;
  const cutsOn = paths(raw.cutsOn);
  const cutsOff = paths(raw.cutsOff);
  if (!cutsOn || !cutsOff || cutsOn.some((cut) => cutsOff.includes(cut))) return null; // 켬·끔에 같이 있을 수 없다
  const cutOrder = paths(raw.cutOrder);
  if (!cutOrder) return null;
  if (raw.tracks !== undefined && !positiveInt(raw.tracks)) return null;
  const trackColors: Record<number, string> = {};
  if (raw.trackColors !== undefined) {
    if (!raw.trackColors || typeof raw.trackColors !== "object" || Array.isArray(raw.trackColors)) return null;
    for (const [track, color] of Object.entries(raw.trackColors as Record<string, unknown>)) {
      if (!positiveInt(Number(track)) || typeof color !== "string" || !COLOR.test(color)) return null;
      trackColors[Number(track)] = color;
    }
  }
  if ((raw.markIn !== undefined && !validPos(raw.markIn, v)) || (raw.markOut !== undefined && !validPos(raw.markOut, v))) return null;
  const markers: EditMarker[] = [];
  if (raw.markers !== undefined) {
    if (!Array.isArray(raw.markers)) return null;
    const taken = new Set<string>();
    for (const item of raw.markers as unknown[]) {
      if (!validPos(item, v)) return null;
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
    if (c.durExact !== undefined && typeof c.durExact !== "boolean") return null;
    if (c.kind !== undefined && c.kind !== "video" && c.kind !== "image") return null;
    if (c.trim !== undefined && (typeof c.trim !== "number" || validSeconds(c.trim) === null)) return null;
    if (c.head !== undefined && (typeof c.head !== "number" || validSeconds(c.head) === null)) return null;
    // 속도는 v 2 이상 문서의 영상 클립에만 — v 1 에 있으면 그 문서를 읽지 않는다(옛 판이 모르는 칸을 버린 문서와 섞이지 않게)
    if (c.speed !== undefined && (v === 1 || c.kind === "image" || validSpeed(c.speed) === null)) return null;
    if (c.slot !== undefined && (v !== 3 || !isSlotId(c.slot))) return null; // 반복 자리는 v 3 문서에만
    const slot = slotOf({ cut: c.cut, slot: c.slot as string | undefined });
    const trackKey = `${slot}\t${c.track}`;
    const genKey = `${slot}\n${c.gen}`;
    if (seen.has(trackKey) || seen.has(genKey)) return null; // (자리, 트랙)·(자리, 생성물)은 하나뿐
    seen.add(trackKey).add(genKey);
    clips.push({
      cut: c.cut, gen: c.gen, track: c.track,
      ...(c.slot !== undefined ? { slot: c.slot as string } : {}),
      ...(c.job ? { job: c.job as string } : {}),
      ...(c.off ? { off: true } : {}),
      ...(c.dur !== undefined ? { dur: c.dur as number } : {}),
      ...(c.dur !== undefined && c.durExact ? { durExact: true } : {}),
      ...(c.kind ? { kind: c.kind as "video" | "image" } : {}),
      ...(c.trim !== undefined ? { trim: c.trim as number } : {}),
      ...(c.head !== undefined ? { head: c.head as number } : {}),
      ...(c.speed !== undefined && c.speed !== 1 ? { speed: c.speed as number } : {}),
    });
  }
  return {
    v, clips, tracksOff, tracksLocked, ...(raw.muted ? { muted: true } : {}),
    ...(cutsOn.length ? { cutsOn } : {}), ...(cutsOff.length ? { cutsOff } : {}), ...(raw.hideOff ? { hideOff: true } : {}),
    ...(raw.tracks !== undefined ? { tracks: raw.tracks as number } : {}),
    ...(Object.keys(trackColors).length ? { trackColors } : {}),
    ...(raw.markIn ? { markIn: mark(raw.markIn) } : {}), ...(raw.markOut ? { markOut: mark(raw.markOut) } : {}),
    ...(markers.length ? { markers } : {}),
    ...(cutOrder.length ? { cutOrder } : {}),
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
  len: number; // 쓰는 길이 — 사용자가 줄였으면(trim·head) 그 길이
  full: number; // 줄이기 전의 길이(원본) — 화면이 '3.0s / 5.0s' 처럼 둘 다 보여 준다
  // 유효 시작(초) — 그 클립이 원본의 어디에서 시작하는가(clipHead). 문서에 적힌 값(EditClip.head)이 아니라 프레임에 맞추고 원본
  //  안으로 자른 값이다. **영상 시각 = 이 값 + 컷 안 시각 × 속도**(mediaAt — 재생·다이나믹 트림 모드·길이 조절 창·Resolve 계획이 같이 쓴다).
  head: number;
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

// 줄이기 전의 길이 — 문서에 적힌 길이(dur), 없으면 호출부가 아는 값, 그것도 없으면 기본 길이.
export function clipFull(clip: EditClip, fallback?: unknown): number {
  return validSeconds(clip.dur) ?? validSeconds(fallback) ?? DEFAULT_SEC;
}

// 원본을 넘지 않는 가장 긴 프레임 수 — 길이 조절의 눈금 끝. **내림**한다: 올리면 3.02초 영상이 73프레임(3.0417초)으로 잡혀 원본을 넘는다.
export function clipFrames(full: number): number {
  return Math.floor(full * EDIT_FPS + 1e-6);
}

// 유효 시작(초) — 앞에서 잘라 낸 길이(head)를 프레임에 맞추고, 원본에 한 프레임은 남게 자른 값. 그림은 0 이다.
//  한 프레임도 안 되는 영상은 자를 수 없다(0). 창·재생·그리기·Resolve 계획이 전부 이 값을 쓴다 — 초로만 자르면(full − 1/24)
//  프레임 사이의 시각이 나와, 브라우저는 그 시각을 틀고 창과 Resolve 의 정수 프레임은 그것을 적지 못한다(Codex 설계 검토).
export function clipHead(clip: EditClip, fallback?: unknown): number {
  const head = clip.kind === "image" ? null : validSeconds(clip.head);
  if (head === null) return 0;
  const top = clipFrames(clipFull(clip, fallback));
  return top < 1 ? 0 : Math.min(Math.round(head * EDIT_FPS), top - 1) / EDIT_FPS;
}

// 쓰는 길이 — 사용자가 줄였으면(trim) 그 길이, 앞을 잘랐으면(head) 시작점부터 남은 만큼까지. 영상만이고 원본 밖으로는 안 된다
//  (재생 엔진이 영상의 실제 끝에서 건너뛴다). trim 이 없으면 원본 끝까지다.
//  영상은 **프레임 수로 내린다**(2026-10-14) — 프레임에 못 미치는 나머지가 있으면 컷 경계가 프레임 사이에 서고, Resolve 계획이 시작과
//  끝을 따로 반올림하며 같은 클립이 98·99프레임으로 갈렸다(99 = 원본보다 길어 막힘, 98 = 1프레임 빈칸). 한 프레임도 안 되면 그대로.
//  그림은 줄이지 않는다: Resolve 가 스틸을 준 길이와 무관하게 5초로 놓아, 줄이면 다음 컷과 겹친다. kind 가 없는 옛 클립은 영상으로 본다.
//  속도가 있으면(2026-10-23) 타임라인 길이 = 쓰는 원본 구간(clipSource) ÷ 속도를 프레임으로 내린 것 — 원본의 마지막 한 프레임이 안 보일 수
//  있다(Resolve 도 같은 내림 — 실측 46.99 → 46). 식은 백엔드의 계획 검사(floor(src × 24 ÷ speed + 1e-6))와 같은 순서로 센다.
//  속도 클립은 **한 프레임보다 짧아지지 않는다** — 0프레임이 되는 속도는 고를 수 없지만(setClipSpeed), 정한 뒤에 원본 길이가 짧게 다시 재어지면
//  생길 수 있다. 그때 문서를 '읽지 못함'으로 버리지 않고(길이 재기가 적은 값 때문에 편집이 통째로 .bad 가 된다) 한 프레임으로 둔다 — Resolve 계획도
//  최소 한 프레임이라 앱과 보내는 길이가 같다(Codex 독립 리뷰 2026-10-23). 속도가 없는 클립은 전과 같다(한 프레임도 안 되면 그 길이 그대로).
export function clipLen(clip: EditClip, fallback?: unknown): number {
  const full = clipFull(clip, fallback);
  if (clip.kind === "image") return full;
  const used = clipSource(clip, fallback);
  const speed = clipSpeed(clip);
  const frames = Math.floor(used * EDIT_FPS / speed + 1e-6);
  return speed !== 1 ? Math.max(1, frames) / EDIT_FPS : frames / EDIT_FPS || used;
}

// 쓰는 원본 구간(원본 초) = min(trim, 원본 − 유효 시작). 속도와 무관하다 — 속도를 바꿔도 이 값은 그대로다(len × speed 로 되돌리지 않는다).
export function clipSource(clip: EditClip, fallback?: unknown): number {
  const rest = clipFull(clip, fallback) - clipHead(clip, fallback);
  const trim = validSeconds(clip.trim);
  return trim === null ? rest : Math.min(trim, rest);
}

// 클립의 재생 속도 배율 — 그림·없는 값·범위 밖은 1.
export function clipSpeed(clip: Pick<EditClip, "speed" | "kind">): number {
  return clip.kind === "image" ? 1 : validSpeed(clip.speed) ?? 1;
}

// 컷 안 시각 ↔ 영상(원본) 시각. 재생·미리 굴리기·한 트랙 보기·Resolve 계획이 이 두 함수로만 바꾼다(SlotClip.head = 유효 시작).
export function mediaAt(clip: Pick<SlotClip, "head" | "speed" | "kind">, local: number): number {
  return clip.head + local * clipSpeed(clip);
}
export function localAt(clip: Pick<SlotClip, "head" | "speed" | "kind">, media: number): number {
  return (media - clip.head) / clipSpeed(clip);
}

// 이 문서를 적는 데 필요한 판 — 반복 자리(slot·자리 열쇠)가 있으면 3, 속도를 쓴 클립이 있으면 2. 문서의 판보다 낮게 돌려주지 않는다.
//  저장 층은 max(저장된 판, 이 값)으로 적는다(한 번 오르면 저장본은 계속 그 판).
export function editDocVersion(doc: EditDoc): 1 | 2 | 3 {
  const keys = [doc.markIn?.cut, doc.markOut?.cut, ...(doc.markers ?? []).map((marker) => marker.cut),
    ...(doc.cutOrder ?? []), ...(doc.cutsOn ?? []), ...(doc.cutsOff ?? [])];
  if (doc.v === 3 || doc.clips.some((clip) => clip.slot) || keys.some((key) => !!key && isRepeatSlot(key))) return 3;
  return doc.v === 2 || doc.clips.some((clip) => clip.speed !== undefined) ? 2 : 1;
}

// 켜져 있는 클립인가 — 클립을 껐거나 그 트랙을 껐으면 아니다. 보이는 것(visibleClip)과 컷 길이(buildLayout)가 같은 기준을 쓴다.
export function clipIsOn(doc: EditDoc, clip: Pick<EditClip, "off" | "track">): boolean {
  return !clip.off && !doc.tracksOff.includes(clip.track);
}

// 그릴 영상 트랙 줄 수 = 적어 둔 줄 수(없으면 기본 3)와 클립이 있는 가장 높은 트랙 중 큰 쪽.
export function trackCount(doc: EditDoc): number {
  return Math.max(doc.tracks ?? MIN_TRACKS, ...doc.clips.map((clip) => clip.track));
}

// 컷 길이 = 그 컷의 **켜진** 클립 중 가장 긴 것(Jay 2026-10-13: "v1 트랙이 꺼져 있다면 그 폴더는 3초만 재생된다"). 켜진 클립이
//  없으면(빈 컷, 또는 넣은 것을 전부 껐다) 기본 길이다 — 꺼진 것은 없는 것으로 친다. 처음엔 꺼진 것까지 넣었다("끌 때 길이가
//  출렁이지 않게") — 그러면 위 트랙이 끝난 뒤 꺼진 아래 트랙의 길이만큼 빈 화면이 나왔다.
//  그래서 **꺼진 클립은 컷보다 길 수 있다**(clip.len > slot.len): 그리기·Resolve 계획은 컷의 끝에서 자른다.
//  cuts = 자리 열쇠들(보이는 것만) · labels = 자리 이름(slotLabels — 숨기기 전 전체 순서로 센 번호). 없으면 폴더 이름.
export function buildLayout(
  cuts: string[],
  doc: EditDoc,
  fallbackOf?: (clip: EditClip) => unknown,
  labels?: ReadonlyMap<string, string>,
): EditLayout {
  let start = 0;
  const slots = cuts.map((path) => {
    const clips = doc.clips
      .filter((clip) => slotOf(clip) === path)
      .sort((a, b) => a.track - b.track)
      .map((clip) => {
        const fallback = fallbackOf?.(clip);
        return { ...clip, len: clipLen(clip, fallback), full: clipFull(clip, fallback), head: clipHead(clip, fallback) };
      });
    const on = clips.filter((clip) => clipIsOn(doc, clip));
    const len = on.length ? Math.max(...on.map((clip) => clip.len)) : DEFAULT_SEC;
    const slot: CutSlot = { path, name: labels?.get(path) ?? leaf(path), start, len, clips };
    start += len;
    return slot;
  });
  return { cuts: slots, total: start, tracks: trackCount(doc) };
}

// 컷 순서 끌기의 끼울 자리(초) — before 컷의 앞, 없으면(null·사라짐) 맨 뒤
export function cutDropTime(layout: EditLayout, before: string | null): number {
  return layout.cuts.find((slot) => slot.path === before)?.start ?? layout.total;
}

// 끄는 동안 포인터 옆에 적는 잡은 것의 이름표(Jay 2026-10-15 11A) — '컷 이름 · 길이'. key 가 있으면 그 클립의 쓰는 길이(클립에 적힌
//  길이와 같다), 없으면 컷 길이. 그 컷·클립이 배치에 없으면 null.
export function grabLabel(layout: EditLayout, cut: string, key?: string): string | null {
  const slot = layout.cuts.find((item) => item.path === cut);
  const held = key === undefined ? slot : slot?.clips.find((clip) => clipKey(clip) === key);
  return slot && held ? `${slot.name} · ${held.len.toFixed(1)}s` : null;
}

// 그 순간 보이는 클립 = 꺼지지 않은 것(클립 off·트랙 off) 중 아직 안 끝난 가장 높은 트랙.
// 위 클립이 짧으면 끝난 뒤 아래 클립이 비친다. 잠금은 보이기와 무관하다.
export function visibleClip(doc: EditDoc, slot: CutSlot, local: number): SlotClip | null {
  for (let i = slot.clips.length - 1; i >= 0; i--) {
    const clip = slot.clips[i];
    if (!clipIsOn(doc, clip)) continue;
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

// 컷 경계에 끼워 넣기(Jay 2026-10-23 ⑤) — x(줄 기준 px)에서 가장 가까운 컷 경계. 경계 = 각 컷의 시작 + 전체 끝.
//  판정 반폭 = min(12px, 양옆 컷 폭의 25%) — 맨 앞·맨 뒤는 있는 쪽 컷만. 각 컷 몸통이 절반 이상 남아 판정 칸이 겹치지 않는다(같은 거리면 앞).
//  null = 경계 밖 · before = 그 경계 뒤의 컷(null = 맨 끝).
export const BOUNDARY_PX = 12;
export function boundaryAt(layout: EditLayout, x: number, zoom: number): { before: string | null } | null {
  let best: { before: string | null; gap: number } | null = null;
  for (let index = 0; index <= layout.cuts.length; index++) {
    const left = layout.cuts[index - 1];
    const right = layout.cuts[index];
    if (!left && !right) continue;
    const half = Math.min(BOUNDARY_PX, ...[left, right].flatMap((slot) => (slot ? [slot.len * zoom * 0.25] : [])));
    const gap = Math.abs(x - (right ? right.start : layout.total) * zoom);
    if (gap <= half && (!best || gap < best.gap)) best = { before: right?.path ?? null, gap };
  }
  return best && { before: best.before };
}

// 풀 카드·타임라인 클립 끌기의 놓을 곳(Jay 2026-10-23 ⑤ 후속 — "중간에 끼워넣기는 … 더 원할하게", 클립도 같게 · 10-26 "본래 그 클립이 있던 곳에는 다시
//  클립위에 쌓을수 있어야한다"). own = 카드면 끌기 시작 때 풀이 보여 주던 자리 · 클립이면 그 클립의 자리.
//  · 경계 띠(boundaryAt) 안 → edge(끼워 넣기·옮기기)
//  · **같은 폴더의 자리**(자기 자리 포함) 몸통 위 → slot(그 자리에 넣기·쌓기 — 클립은 자기 자리면 트랙만)
//  · 다른 폴더의 자리 몸통·맨 뒤 밖 → 거리와 상관없이 가장 가까운 경계(같은 거리면 앞 — 다른 컷의 가운데를 넘으면 오른쪽, 맨 뒤 밖이면 맨 끝)
//  자리가 하나도 없으면 null.
export type DropTarget = { kind: "edge"; before: string | null } | { kind: "slot"; path: string };
export function dropTargetAt(layout: EditLayout, x: number, zoom: number, own: string): DropTarget | null {
  const edge = boundaryAt(layout, x, zoom);
  if (edge) return { kind: "edge", before: edge.before };
  const body = layout.cuts.find((slot) => x >= slot.start * zoom && x < (slot.start + slot.len) * zoom);
  if (body && folderOf(body.path) === folderOf(own)) return { kind: "slot", path: body.path };
  if (!layout.cuts.length) return null;
  let best: { before: string | null; gap: number } = { before: null, gap: Infinity };
  for (let index = 0; index <= layout.cuts.length; index++) {
    const right = layout.cuts[index];
    const gap = Math.abs(x - (right ? right.start : layout.total) * zoom);
    if (gap < best.gap) best = { before: right?.path ?? null, gap };
  }
  return { kind: "edge", before: best.before };
}

// 배치가 바뀐 뒤 위치를 유효한 자리로 맞춘다. moved=true 면 호출부가 재생을 멈춘다.
//  · 보던 컷이 배치에서 빠짐(숨김·폴더가 사라짐) → **컷 순서에서** 그다음 컷의 처음(없으면 전체 끝)
//  · 보던 컷이 local 보다 짧아짐 → 컷 끝 직전
//  order = 타임라인의 전체 컷 순서(숨긴 컷 포함 — cutPaths) · saved = 사용자가 정한 순서(doc.cutOrder — 사라진 폴더의 자리가 남아 있다).
//  안 주면 배치의 순서로 본다(소스 판처럼 순서를 따로 정하지 않는 문서 — 타임라인의 순서를 넘기지 않는다).
//  폴더가 사라져 order 에도 없는 컷은 서 있던 자리를 다시 찾는다: 정한 순서에 적혀 있으면 그 자리, 아니면 새 컷이 서는 규칙
//  (이름순으로 바로 앞인 컷의 뒤 — orderCuts). 순서를 정하지 않았으면 전과 같이 '이름순으로 그다음 컷'이다.
export function settlePos(
  layout: EditLayout,
  pos: EditPos | null,
  order?: readonly string[],
  saved?: readonly string[],
  previous?: readonly string[],
): { pos: EditPos | null; moved: boolean } {
  const last = layout.cuts[layout.cuts.length - 1];
  if (!last) return { pos: null, moved: pos !== null };
  if (!pos) return { pos: { cut: layout.cuts[0].path, local: 0 }, moved: false };
  const index = layout.cuts.findIndex((cut) => cut.path === pos.cut);
  if (index < 0) {
    // 실제로 사라진 자리(지금 전체 순서에 없다 — 반복 자리의 마지막 클립을 뺐다·그 자리 만들기를 되돌렸다·다른 창이 그렇게 한 최종 문서만 받았다)는
    //  재생 쪽이 기억한 직전 순서(previous)에서 그 뒤의 첫 '지금 배치에 있는' 자리, 없으면 전체 끝. 숨겨진 자리(지금 순서에 있다)는 아래
    //  지금 규칙 — 직전 순서를 먼저 쓰면 다른 창이 순서를 바꾸고 숨긴 것을 옛 순서로 보낸다(Codex 설계 4차).
    if (order && !order.includes(pos.cut) && previous?.includes(pos.cut)) {
      const shown = new Set(layout.cuts.map((cut) => cut.path));
      const next = previous.slice(previous.indexOf(pos.cut) + 1).find((path) => shown.has(path));
      return { pos: next ? { cut: next, local: 0 } : { cut: last.path, local: last.len }, moved: true };
    }
    let all = order ?? layout.cuts.map((cut) => cut.path);
    if (!all.includes(pos.cut)) all = orderCuts([...all, pos.cut].sort(byName), saved?.includes(pos.cut) ? saved : all);
    const shown = new Set(layout.cuts.map((cut) => cut.path));
    const next = all.slice(all.indexOf(pos.cut) + 1).find((path) => shown.has(path));
    return { pos: next ? { cut: next, local: 0 } : { cut: last.path, local: last.len }, moved: true };
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

// ── 다이나믹 재생 모드(다빈치의 Dynamic Trim Mode, 보기만 — 2026-10-26 되살림) — 편집점의 앞 | 뒤 ──
// 보는 편집점 = 재생헤드에서 가장 가까운 것(↑·↓ 가 쓰는 목록 그대로 — 처음·끝 포함, 같은 거리면 앞).
export function nearestPoint(points: readonly number[], time: number): number {
  return points.reduce((best, point) => (Math.abs(point - time) < Math.abs(best - time) ? point : best), points[0] ?? 0);
}

export interface EditShot {
  slot: CutSlot;
  local: number; // 컷 안 시각 — 그 영상의 시각은 mediaAt(clip, local)
  clip: SlotClip | null; // 그 순간 보이는 클립(위 트랙 우선·끔 반영 — 타임라인 뷰어와 같다). 없으면 빈 화면
}

// 편집점의 [바로 앞, 바로 뒤]에 보이는 것. 표본 시각은 편집점에서 1/4 프레임 떨어진 곳이되 이웃 편집점과의 한가운데를 넘지
//  않는다 — 부동소수 오차로 방금 끝난 클립이 다시 잡히지 않고, 아주 짧게 비치는 클립을 건너뛰지도 않는다(Codex 설계 검토 10-08).
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

// 클립이 하나도 없는 반복 자리의 열쇠 — 그 자리는 없다. 넣기로 되살리지 않는다(사라진 자리의 북마크·D 가 다시 붙는다). 폴더 자리(첫 자리)는
//  비어 있어도 있다 — 첫 클립 넣기·빈 곳 채우기는 된다.
const deadSlot = (doc: EditDoc, key: string) => isRepeatSlot(key) && !doc.clips.some((clip) => slotOf(clip) === key);

// 넣을 트랙 = 그 자리의 가장 높은 클립보다 위에서 켜져 있고 안 잠긴 가장 낮은 트랙(넣자마자 보이게). cut = 자리 열쇠.
export function insertTrack(doc: EditDoc, cut: string): number {
  let track = Math.max(0, ...doc.clips.filter((clip) => slotOf(clip) === cut).map((clip) => clip.track)) + 1;
  while (doc.tracksOff.includes(track) || isLocked(doc, track)) track++;
  return track;
}

// cut = 자리 열쇠(반복 자리면 cut·slot 두 칸으로 적는다)
export function insertClip(
  doc: EditDoc,
  clip: { cut: string; gen: string; job?: string | null; kind: "video" | "image"; dur: number },
): EditDoc | null {
  if (deadSlot(doc, clip.cut) || doc.clips.some((item) => slotOf(item) === clip.cut && item.gen === clip.gen)) return null;
  const next: EditClip = {
    ...slotFields(clip.cut), gen: clip.gen, track: insertTrack(doc, clip.cut), kind: clip.kind,
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
    if (!next.clips.some((clip) => slotOf(clip) === pick.cut)) next = insertClip(next, pick) ?? next;
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
  if (!positiveInt(track) || isLocked(doc, track) || deadSlot(doc, clip.cut)) return null;
  const own = doc.clips.find((item) => slotOf(item) === clip.cut && item.gen === clip.gen);
  if (own && (own.track === track || isLocked(doc, own.track))) return null;
  const next: EditClip = own ? { ...own, track } : {
    ...slotFields(clip.cut), gen: clip.gen, track, kind: clip.kind,
    dur: validSeconds(clip.dur) ?? DEFAULT_SEC,
    ...(clip.job ? { job: clip.job } : {}),
  };
  return {
    ...doc,
    clips: [...doc.clips.filter((item) => item !== own && !(slotOf(item) === clip.cut && item.track === track)), next],
  };
}

// 미디어 풀의 카드를 컷 경계에 놓았다(Jay 2026-10-23 ⑤) — 그 카드 폴더의 새 자리를 before 앞에 만들고 그 트랙에 넣는다. 한 명령(되돌리기 한 번).
//  all = 전체 순서(cutPaths) · card.cut = 폴더(그 시퀀스의 자리여야 한다) · id = 호출부가 지은 새 자리 ID(이 문서의 어느 열쇠에도 없어야 한다).
//  잠긴 트랙·잘못된 before·쓰인 ID 는 null.
export function insertSlot(
  doc: EditDoc,
  all: readonly string[],
  card: Parameters<typeof placeClip>[1],
  before: string | null,
  track: number,
  id: string,
): EditDoc | null {
  // 폴더는 그 시퀀스의 자리여야 한다 — 첫 자리가 숨어 있어도(빈 첫 자리, 2026-10-26) 그 폴더의 반복 자리가 있으면 된다
  if (!positiveInt(track) || isLocked(doc, track) || isRepeatSlot(card.cut) || !all.some((key) => folderOf(key) === card.cut)) return null;
  if ((before !== null && !all.includes(before)) || !slotIdFree(doc, id)) return null;
  const clip: EditClip = {
    cut: card.cut, slot: id, gen: card.gen, track, kind: card.kind, dur: validSeconds(card.dur) ?? DEFAULT_SEC,
    ...(card.job ? { job: card.job } : {}),
  };
  return writeOrder({ ...doc, v: 3, clips: [...doc.clips, clip] }, all, slotOf(clip), before);
}

// 그 반복 자리의 유일한 클립인가 — 옮기면 자리째 옮긴다(ID·북마크·D 가 따라간다). 화면의 놓기 전 거르기와 moveClipToSlot 이 같이 쓴다.
export function soleRepeatClip(doc: EditDoc, key: string): boolean {
  const clip = doc.clips.find((item) => clipKey(item) === key);
  return !!clip?.slot && !doc.clips.some((item) => item !== clip && slotOf(item) === slotOf(clip));
}

// 타임라인의 클립을 가로로 끌어 컷 경계에 놓았다(Jay 2026-10-23 ⑤ — '옮기기'). 한 명령(되돌리기 한 번), 하나라도 안 되면 아무것도 바꾸지 않는다(null).
//  ① 그 클립·떠나는/도착 트랙의 잠금·양수 트랙·before(null 이거나 all 에 있음)를 먼저 본다.
//  ② 반복 자리의 유일한 클립이면 그 자리를 before 앞으로(제자리면 순서 그대로) + 트랙이 다르면 트랙만 — 하나라도 바뀌면 성공, 둘 다 그대로면 null.
//  ③ 아니면 클립을 복사해 slot 만 새 ID(head·trim·speed·off·dur·durExact·kind·job 그대로)·트랙 = 놓은 줄로 before 앞에 새 자리를 만들고 원래 클립을
//    뺀다(원래 자리가 첫 자리면 비고 — 그 폴더에 반복 자리가 있으니 자리 목록에서 숨는다(cutPaths) — 반복 자리면 다른 클립이 남아 있다). id 는 ③ 에서만 본다.
export function moveClipToSlot(
  doc: EditDoc,
  all: readonly string[],
  key: string,
  before: string | null,
  track: number,
  id: string,
): EditDoc | null {
  const clip = doc.clips.find((item) => clipKey(item) === key);
  if (!clip || !positiveInt(track) || isLocked(doc, clip.track) || isLocked(doc, track)) return null;
  if (before !== null && !all.includes(before)) return null;
  if (soleRepeatClip(doc, key)) {
    const moved = track === clip.track ? doc : { ...doc, clips: doc.clips.map((item) => (item === clip ? { ...item, track } : item)) };
    const ordered = slotStays(all, slotOf(clip), before) ? null : writeOrder(moved, all, slotOf(clip), before);
    return ordered ?? (moved === doc ? null : moved);
  }
  if (!slotIdFree(doc, id)) return null;
  const copy: EditClip = { ...clip, slot: id, track };
  return writeOrder({ ...doc, v: 3, clips: doc.clips.map((item) => (item === clip ? copy : item)) }, all, slotOf(copy), before);
}

// 타임라인의 클립을 가로로 끌어 같은 폴더의 다른 자리 몸통에 놓았다(Jay 2026-10-26 — "본래 그 클립이 있던 곳에는 다시 클립위에 쌓을수 있어야한다").
//  그 자리의 그 트랙으로 옮긴다 — 찬 칸이면 맞바꿈(그 칸의 클립은 떠난 자리의 떠난 트랙으로). 한 명령(되돌리기 한 번), 순서는 안 건드린다(떠난 반복
//  자리가 비면 사라지고 재생헤드는 settlePos 의 previous). 거부(null): 클립 없음 · 양의 안전 정수가 아닌 트랙 · 떠나는/도착 트랙 잠김 · 자기 자리 ·
//  다른 폴더 · 사라진 반복 자리 · 도착 자리에 같은 생성물(그 칸의 상대가 그 생성물이어도 — 자르기·속도가 섞이지 않게) · 맞바꿀 상대의 생성물이 떠난
//  자리에 (이 클립 말고) 있음. 다른 칸(head·trim·speed·off·dur·durExact·kind·job)은 그대로다.
export function moveClipIntoSlot(doc: EditDoc, key: string, target: string, track: number): EditDoc | null {
  const clip = doc.clips.find((item) => clipKey(item) === key);
  if (!clip || !positiveInt(track) || isLocked(doc, clip.track) || isLocked(doc, track)) return null;
  const from = slotOf(clip);
  if (target === from || folderOf(target) !== clip.cut || deadSlot(doc, target)) return null;
  if (doc.clips.some((item) => item !== clip && slotOf(item) === target && item.gen === clip.gen)) return null;
  const other = doc.clips.find((item) => slotOf(item) === target && item.track === track);
  if (other && doc.clips.some((item) => item !== clip && item !== other && slotOf(item) === from && item.gen === other.gen)) return null;
  // 자리를 바꿔 적는다 — 첫 자리(폴더 그대로)로 가면 slot 칸을 지운다(덮어쓰기로는 안 지워진다)
  const put = (item: EditClip, slot: string, at: number): EditClip => {
    const next: EditClip = { ...item, ...slotFields(slot), track: at };
    if (!isRepeatSlot(slot)) delete next.slot;
    return next;
  };
  return { ...doc, clips: doc.clips.map((item) => (item === clip ? put(clip, target, track) : item === other ? put(other, from, clip.track) : item)) };
}

// 새 자리 ID 로 쓸 수 있는가 — 글자 규칙 + 이 문서의 어느 열쇠(클립·순서·D·인/아웃·북마크)에도 없음. 무작위 ID 가 다시 나올 확률은 무시한다
//  (shortcut: 문서 안 중복만 막는다 — 자리를 기기 간에 합치게 되면 UUID 로).
function slotIdFree(doc: EditDoc, id: string): boolean {
  if (!isSlotId(id)) return false;
  const keys = [doc.markIn?.cut, doc.markOut?.cut, ...(doc.markers ?? []).map((marker) => marker.cut),
    ...(doc.cutOrder ?? []), ...(doc.cutsOn ?? []), ...(doc.cutsOff ?? [])];
  return !doc.clips.some((clip) => clip.slot === id) && !keys.some((key) => !!key && slotIdOf(key) === id);
}

// 그 컷의 그 트랙에 이 카드를 놓으면 무슨 일이 일어나는가 — 휠 클릭 메뉴의 줄과 끌어 넣기의 강조가 같이 쓴다(둘이 어긋나지 않게).
//  own = 그 카드가 이 컷에 이미 넣어져 있으면 그 클립(job 으로 이은 것 포함 — 호출부가 찾는다).
//  here = 이미 거기 있다(아무 일도 없다) · locked = 잠겨서 못 놓는다(도착 트랙, 또는 지금 있는 트랙) · taken = 다른 클립이 있다(놓으면
//  교체) · empty = 빈 자리. placeClip 의 거부 조건과 같은 판정이다.
export type PlaceState = "empty" | "taken" | "here" | "locked";
export function placeState(doc: EditDoc, cut: string, own: Pick<EditClip, "track"> | null | undefined, track: number): PlaceState {
  if (own?.track === track) return "here";
  if (isLocked(doc, track) || (!!own && isLocked(doc, own.track))) return "locked";
  return doc.clips.some((clip) => slotOf(clip) === cut && clip.track === track) ? "taken" : "empty";
}

// 클립이 쓰는 구간을 정한다(Jay 2026-10-13 뒤를 자른다 · 10-14 앞도 자른다). head = 앞에서 잘라 내는 길이(초, 0 = 원본의 처음부터),
//  trim = 쓰는 길이(초, null = 원본 끝까지). 영상만이다 — 그림과 잠긴 트랙의 클립은 거부한다. 바뀐 것이 없으면 null.
//  값은 호출부(길이 조절 창)가 프레임에 맞춰 준다.
//  원본보다 긴 값도 그대로 적는다 — 쓰는 값은 clipHead·clipLen 이 원본에서 자른다. 원본 길이를 아직 모를 때(실측 전의 dur 은 추정값이다)
//  정한 값을 '원본 이상'이라고 지우면, 실측이 온 뒤 사용자가 정한 길이가 원본 길이로 늘어난다(Codex 설계 검토).
export function setClipRange(doc: EditDoc, key: string, range: { head: number; trim: number | null }): EditDoc | null {
  const clip = doc.clips.find((item) => clipKey(item) === key);
  if (!clip || clip.kind === "image" || isLocked(doc, clip.track)) return null;
  if (!Number.isFinite(range.head) || range.head < 0) return null;
  const head = range.head > 0 ? range.head : undefined;
  const trim = range.trim === null ? undefined : validSeconds(range.trim) ?? undefined;
  if ((range.trim !== null && trim === undefined) || (trim === clip.trim && head === clip.head)) return null;
  const next = { ...clip };
  delete next.trim;
  delete next.head;
  if (trim !== undefined) next.trim = trim;
  if (head !== undefined) next.head = head;
  if (next.speed !== undefined && speedFrames(next) < 1) return null; // 속도를 친 길이가 한 프레임도 안 되는 구간
  return { ...doc, clips: doc.clips.map((item) => (item === clip ? next : item)) };
}

// 속도를 친 타임라인 프레임 수(clipLen 의 내림 전 값) — 0 이면 그 속도·구간은 고를 수 없다.
function speedFrames(clip: EditClip, fallback?: unknown): number {
  return Math.floor(clipSource(clip, fallback) * EDIT_FPS / clipSpeed(clip) + 1e-6);
}

// 속도를 정한다(Jay 2026-10-23 Ctrl+R). 쓰는 원본 구간(head·trim)은 그대로 — 타임라인 길이만 바뀐다. 1 이면 칸을 지운다.
//  영상만 · SPEED_MIN~SPEED_MAX · 타임라인 길이가 한 프레임도 안 되는 속도·그림·잠긴 트랙은 거부한다. 속도를 적는 순간 문서는 v 2 다
//  (지워도 2 로 남는다 — 강등하지 않는다). fallback = 원본 길이를 문서가 모를 때 호출부가 아는 값(clipLen 과 같다). 바뀐 것이 없으면 null.
export function setClipSpeed(doc: EditDoc, key: string, speed: number, fallback?: unknown): EditDoc | null {
  const clip = doc.clips.find((item) => clipKey(item) === key);
  const value = validSpeed(speed);
  if (!clip || clip.kind === "image" || isLocked(doc, clip.track) || value === null) return null;
  const next: EditClip = { ...clip };
  delete next.speed;
  if (Math.abs(value - 1) > 1e-9) next.speed = value;
  if (next.speed === clip.speed) return null;
  if (next.speed !== undefined && speedFrames(next, fallback) < 1) return null; // 1 로 되돌리기는 언제나 된다
  // 판을 내리지 않는다 — v 3 문서에 속도를 적어도 3(Codex 설계 2차)
  return { ...doc, v: next.speed !== undefined && doc.v === 1 ? 2 : doc.v, clips: doc.clips.map((item) => (item === clip ? next : item)) };
}

// 초 → 프레임에 맞춘 초(길이 조절 창의 값). 최소 1프레임, 상한(max — 원본 길이)을 넘지 않는 가장 긴 프레임 수까지.
//  상한은 **내림**한다: 가장 가까운 프레임으로 올리면 3.02초짜리 영상이 3.0417초로 잡혀 원본을 넘는다.
//  한 프레임도 안 되는 영상이면 null(줄일 수 없다).
export function snapTrim(seconds: number, max: number): number | null {
  const top = Math.floor(max * EDIT_FPS + 1e-6);
  if (!(top >= 1) || !Number.isFinite(seconds)) return null; // 상한이 숫자가 아니어도(NaN) null
  return Math.min(Math.max(Math.round(seconds * EDIT_FPS), 1), top) / EDIT_FPS;
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
    const other = doc.clips.find((item) => item !== clip && slotOf(item) === slotOf(clip) && track.get(item) === to);
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
        : slotOf(item) === slotOf(clip) && item.track === to ? { ...item, track: clip.track } : item),
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

// 클립이 하나도 없는 트랙을 모두 지운다(숨긴 컷의 클립도 있는 것으로 센다). 잠긴 트랙은 비어 있어도 남긴다 — 트랙 삭제(deleteTrack)와
// 같은 규칙이다(Codex 배포 전 검토 2026-10-13: 하나씩은 못 지우는데 한꺼번에는 지워졌다). 한 줄은 남긴다. 지울 것이 없으면 null.
export function deleteEmptyTracks(doc: EditDoc): EditDoc | null {
  const count = trackCount(doc);
  const locked = doc.tracksLocked.filter((track) => track <= count); // 없는 번호의 잠금은 줄을 만들지 않는다
  const used = [...new Set([...doc.clips.map((clip) => clip.track), ...locked])].sort((a, b) => a - b);
  const keep = used.length ? used : [1];
  if (keep.length === count) return null;
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

// 두 표시가 **다 보이는데** 인이 아웃보다 뒤면 맞바꾼 문서를 돌려준다(아니면 그대로). 컷 순서를 바꾸거나, 숨겼던 컷·사라졌던 폴더가
//  돌아오면 문서의 인/아웃이 뒤집혀 있을 수 있다. 순서를 바꾸는 순간에 미리 맞바꾸는 것으로는 다 막지 못한다 — 없는 폴더 가운데 일부만
//  돌아오면 그때 예측한 자리와 달라진다(Codex 코드 리뷰 2회째 2026-10-13). 그래서 **그리는 쪽(marksOf·markRange)과 찍는 쪽(setMark)이 같은
//  눈으로 본다**: 화면의 '인'이 문서의 markOut 인 채로 인 지우기(Alt+I)를 누르면 엉뚱한 쪽이 지워진다. 문서는 다음에 표시를 찍거나
//  지울 때 바로잡힌 모양으로 저장된다. 전에는 뒤집힌 구간이 말없이 사라졌다(길이가 음수라 구간이 아니었다).
function straightMarks(layout: EditLayout, doc: EditDoc): EditDoc {
  const from = markTime(layout, doc.markIn);
  const to = markTime(layout, doc.markOut);
  return from !== null && to !== null && from > to ? { ...doc, markIn: doc.markOut, markOut: doc.markIn } : doc;
}

// 인(또는 아웃)을 그 자리에 찍는다(pos = null 이면 지운다). 인을 '보이는' 아웃과 같거나 뒤에 찍으면 아웃을 지우고, 아웃을
// 인과 같거나 앞에 찍으면 인을 지운다(다빈치). 안 보이는 쪽은 건드리지 않는다. 바뀐 것이 없으면 null.
// '인'·'아웃'은 화면에 보이는 것 기준이다(straightMarks).
export function setMark(given: EditDoc, layout: EditLayout, which: "markIn" | "markOut", pos: EditPos | null): EditDoc | null {
  const doc = straightMarks(layout, given);
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

// 인/아웃 구간(표시의 띠·반복 재생) — 찍어 둔 표시가 다 보이고 두 프레임 이상일 때만. **한쪽만 찍었으면** 전체의 처음/끝까지다.
// 찍어 둔 표시가 지금 안 보이면(그 컷을 숨겼다 · 컷이 그 자리보다 짧아졌다 — 트랙을 꺼서·길이를 줄여서) 구간이 아니다: 안 보이는 쪽을
// 전체의 처음/끝으로 치면 구간이 말없이 넓어진다(아웃이 가려지는 순간 구간 반복이 전체 끝까지 돈다 — Codex 설계 검토 2026-10-13).
// 표시는 문서에 남아 있어 다시 보이면 구간도 돌아온다.
// 두 프레임보다 짧으면 구간으로 치지 않는다: 재생 엔진은 0.04초 안의 차이는 영상을 다시 보내지 않아, 되돌아가도 영상은 그대로 간다.
export function markRange(layout: EditLayout, given: EditDoc): { from: number; to: number } | null {
  const doc = straightMarks(layout, given);
  const from = markTime(layout, doc.markIn);
  const to = markTime(layout, doc.markOut);
  if ((doc.markIn && from === null) || (doc.markOut && to === null)) return null;
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

export function marksOf(layout: EditLayout, given: EditDoc): EditMarks {
  const doc = straightMarks(layout, given);
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

// 확정된 길이를 문서에 적는다(Undo 단계 아님). exact = 그 가운데 그림 트랙으로 잰 것(durExact 를 단다 — 없는 것은 뗀다).
//  바뀐 것이 없으면 null.
export function setClipDurs(doc: EditDoc, durs: ReadonlyMap<string, number>, exact?: ReadonlySet<string>): EditDoc | null {
  let changed = false;
  const clips = doc.clips.map((clip) => {
    const key = clipKey(clip);
    const dur = validSeconds(durs.get(key));
    const sure = !!exact?.has(key);
    if (dur === null || (dur === clip.dur && sure === !!clip.durExact)) return clip;
    changed = true;
    const { durExact: _was, ...rest } = clip;
    return sure ? { ...rest, dur, durExact: true } : { ...rest, dur };
  });
  return changed ? { ...doc, clips } : null;
}

// 되돌리기·다시 하기로 옛 문서를 되살릴 때, 그 사이 확정된 길이는 지금 것을 따른다(길이는 되돌리기 대상이 아니다 — 표 durExact 도).
export function keepClipDurs(doc: EditDoc, from: EditDoc): EditDoc {
  const durs = new Map(from.clips.filter((clip) => clip.dur !== undefined).map((clip) => [clipKey(clip), clip.dur!]));
  const exact = new Set(from.clips.filter((clip) => clip.durExact).map(clipKey));
  return setClipDurs(doc, durs, exact) ?? doc;
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
