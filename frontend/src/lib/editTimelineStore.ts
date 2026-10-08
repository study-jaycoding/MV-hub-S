// 편집 문서의 저장(localStorage)과 Undo 스택. 계약은 docs/EDIT_TAB.md.
// ponytail: 캔버스 씬과 달리 로컬 DB 백업이 없다 — 브라우저 프로필에만 남는다. 팀 공유·백업이 필요해지면 DB 로 옮긴다.
import { getAccountNamespace } from "./accountScope";
import { emptyEditDoc, isHexColor, MARKER_COLORS, parseEditDoc, type EditDoc } from "./editTimeline";
import { STORAGE_KEYS } from "./storageKeys";

// 서버 주소는 키에 넣지 않는다 — 서버 이사는 DB 를 통째로 옮겨 project_id·생성물 id 가 유지되므로
// 주소가 바뀌어도 같은 편집 문서가 이어져야 한다(DB 복제본 서버도 같은 문서를 본다 — 의도한 동작).
export function editDocKey(projectId: string, seq: string): string {
  return `${STORAGE_KEYS.editTimeline}:${getAccountNamespace()}:${projectId}:${seq}`;
}

export interface StoredEditDoc {
  doc: EditDoc;
  raw: string | null; // 저장돼 있던 원문(없으면 null)
  bad: boolean; // 원문이 있는데 읽지 못함 — 호출부는 그것을 빈 문서로 덮지 않는다
}

export function readEditDoc(key: string): StoredEditDoc {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    /* 저장소 접근 불가 = 저장된 것 없음으로 본다 */
  }
  if (raw === null) return { doc: emptyEditDoc(), raw, bad: false };
  let doc: EditDoc | null = null;
  try {
    doc = parseEditDoc(JSON.parse(raw));
  } catch {
    doc = null;
  }
  return doc ? { doc, raw, bad: false } : { doc: emptyEditDoc(), raw, bad: true };
}

// 저장에 성공하면 쓴 원문, 실패하면 null. keepBad 는 읽지 못한 옛 원문 — `<키>.bad` 로 옮겨 적힌 것을
// 확인한 뒤에만 원래 키를 덮는다.
export function writeEditDoc(key: string, doc: EditDoc, keepBad: string | null = null): string | null {
  const raw = JSON.stringify(doc);
  try {
    if (keepBad !== null) {
      localStorage.setItem(`${key}.bad`, keepBad);
      if (localStorage.getItem(`${key}.bad`) !== keepBad) return null;
    }
    localStorage.setItem(key, raw);
    return raw;
  } catch {
    return null;
  }
}

// Undo/Redo — 문서(키)별 메모리 스택. 탭을 오가도 남고, 새로고침하면 사라진다.
const UNDO_LIMIT = 100;
const stacks = new Map<string, { past: EditDoc[]; future: EditDoc[] }>();

export function undoStack(key: string): { past: EditDoc[]; future: EditDoc[] } {
  let stack = stacks.get(key);
  if (!stack) stacks.set(key, (stack = { past: [], future: [] }));
  return stack;
}

export function pushUndo(key: string, doc: EditDoc): void {
  const stack = undoStack(key);
  stack.past.push(doc);
  if (stack.past.length > UNDO_LIMIT) stack.past.shift();
  stack.future.length = 0;
}

export function clearUndo(key: string): void {
  stacks.delete(key);
}

// 이 창이 키마다 마지막으로 읽었거나 쓴 원문 — 자리를 비운 사이(다른 시퀀스·다른 탭) 다른 창이 저장했는지를
// 다시 열 때 가린다. 달라졌으면 옛 되돌리기 스택은 그 저장을 모르므로 비운다(되돌리기가 남의 저장을 덮지 않게).
const seenRaw = new Map<string, string | null>();

export function noteEditRaw(key: string, raw: string | null): void {
  seenRaw.set(key, raw);
}

export function editRawChanged(key: string, raw: string | null): boolean {
  return seenRaw.has(key) && seenRaw.get(key) !== raw;
}

// 저장하지 못한 문서 — 시퀀스나 탭을 옮겨도 버리지 않는다(새로고침하면 사라진다).
// base = 저장에 처음 실패했을 때 이 창이 저장소에 있다고 알던 원문. 다시 열 때 저장소가 이것과 다르면
// 그 사이 다른 창이 저장한 것이다(충돌) — 몇 번을 오가도, 두 번 렌더해도 같은 답이 나오게 여기에 묶어 둔다.
export interface UnsavedEditDoc {
  doc: EditDoc;
  base: string | null;
}
const unsaved = new Map<string, UnsavedEditDoc>();

export function unsavedEditDoc(key: string): UnsavedEditDoc | undefined {
  return unsaved.get(key);
}

export function keepUnsavedEditDoc(key: string, entry: UnsavedEditDoc | null): void {
  if (entry) unsaved.set(key, entry);
  else unsaved.delete(key);
}

// 마지막으로 연 시퀀스(프로젝트·폴더) — 탭을 다시 열 때 그 자리로 돌아간다.
export interface EditTarget {
  projectId: string;
  seq: string;
}

const lastTargetKey = () => `${STORAGE_KEYS.editTimeline}.last:${getAccountNamespace()}`;

export function loadEditTarget(): EditTarget | null {
  try {
    const value = JSON.parse(localStorage.getItem(lastTargetKey()) || "null") as Partial<EditTarget> | null;
    return value && typeof value.projectId === "string" && typeof value.seq === "string"
      ? { projectId: value.projectId, seq: value.seq } : null;
  } catch {
    return null;
  }
}

export function saveEditTarget(target: EditTarget | null): void {
  try {
    if (target) localStorage.setItem(lastTargetKey(), JSON.stringify(target));
    else localStorage.removeItem(lastTargetKey());
  } catch {
    /* 못 적어도 편집에는 지장 없다 */
  }
}

// ── 화면 설정 ── 미디어 풀의 보기 방식·썸네일 크기·정렬, 싱글/듀얼 뷰어. 편집 내용이 아니라 이 브라우저의 취향이다
//  (계정·시퀀스와 무관하게 하나, 되돌리기 대상 아님). 못 읽으면 기본값.
export type PoolView = "thumb" | "meta" | "list";
export type PoolSort = "new" | "old" | "placed";
// 뷰어 한 판이 보는 것 — 타임라인(위 트랙 우선) · 편집점 보기(편집점의 앞 | 뒤) · 소스 클립(풀에서 고른 것) · 소스 테이프(이
//  컷의 풀 목록을 이어서) · 한 트랙만(트랙 번호). 타임라인과 편집점 보기는 타임라인 판(엔진 하나)의 두 방식이고, 소스 클립과
//  소스 테이프는 소스 판의 두 방식이다 — 같은 판의 두 방식은 두 판에 같이 뜰 수 없다(viewPane).
export type ViewMode = "timeline" | "edit" | "source" | "tape" | number;
export const isSourceView = (mode: ViewMode | undefined): boolean => mode === "source" || mode === "tape";
export const viewPane = (mode: ViewMode): "timeline" | "source" | number =>
  (typeof mode === "number" ? mode : isSourceView(mode) ? "source" : "timeline");
export interface EditUi {
  view: PoolView;
  size: number; // 썸네일 폭(px)
  sort: PoolSort;
  dual: boolean; // 듀얼 뷰어(판 두 개)
  views: [ViewMode, ViewMode]; // [왼쪽 판, 오른쪽 판] — 서로 다르다. 싱글이면 오른쪽 것만 보인다
  loop: boolean; // 타임라인 반복 재생
  loopSrc: boolean; // 소스 반복 재생
  markerColor: string; // 새 북마크의 색(#rrggbb)
}
export const POOL_SIZE = { min: 56, max: 240 }; // 최소 = 다빈치 미디어 풀의 작은 썸네일쯤
const DEFAULT_UI: EditUi = {
  view: "thumb", size: 160, sort: "new", dual: false, views: ["source", "timeline"], loop: false, loopSrc: false,
  markerColor: MARKER_COLORS[0].color,
};
const viewMode = (value: unknown): ViewMode | null =>
  value === "timeline" || value === "edit" || value === "source" || value === "tape" ? value
    : Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : null;
const uiKey = `${STORAGE_KEYS.editTimeline}.ui`;

export function loadEditUi(): EditUi {
  try {
    const raw = JSON.parse(localStorage.getItem(uiKey) || "null") as Partial<EditUi> | null;
    if (!raw || typeof raw !== "object") return DEFAULT_UI;
    const pair = Array.isArray(raw.views) && raw.views.length === 2 ? [viewMode(raw.views[0]), viewMode(raw.views[1])] : [];
    const views = pair[0] != null && pair[1] != null && viewPane(pair[0]) !== viewPane(pair[1])
      ? ([pair[0], pair[1]] as [ViewMode, ViewMode]) : null;
    return {
      view: raw.view === "meta" || raw.view === "list" ? raw.view : "thumb",
      size: typeof raw.size === "number" && Number.isFinite(raw.size)
        ? Math.min(POOL_SIZE.max, Math.max(POOL_SIZE.min, raw.size)) : DEFAULT_UI.size,
      sort: raw.sort === "old" || raw.sort === "placed" ? raw.sort : "new",
      dual: raw.dual === true,
      views: views ?? DEFAULT_UI.views,
      loop: raw.loop === true,
      loopSrc: raw.loopSrc === true,
      markerColor: isHexColor(raw.markerColor) ? raw.markerColor : DEFAULT_UI.markerColor,
    };
  } catch {
    return DEFAULT_UI;
  }
}

export function saveEditUi(ui: EditUi): void {
  try {
    localStorage.setItem(uiKey, JSON.stringify(ui));
  } catch {
    /* 못 적어도 이번 화면에는 지장 없다 */
  }
}
