// 씬의 에셋 참조 중 **이 PC 에서 열리지 않는 것**을 서버가 찾아 준 자리로 이어 준다(Jay 2026-09-28).
//
// 왜: "어느 방식으로 가져와도 서버에 그 파일이 있다면 모두에게 똑같이 보이게". 안 열리는 이유가 둘이다.
//  · 예전에 끌어다 놓은 그림이 설치 폴더 안(imports·captures)으로 복사됐다 — 그 PC 에만 있는 사본
//  · 프로젝트 이름은 붙었지만 이 PC 가 그 프로젝트를 못 본다 — 같은 폴더를 사람마다 다른 이름·다른
//    깊이로 등록해 생긴다(`뻘뻘뻘`=…/10_ai, `뻘뻘뻘_RnD`=…/10_ai/assets)
// 그래서 **모든 에셋 참조**를 서버에 보내고, 서버가 정확히 한 곳에서만 찾혔을 때 답을 준다(assets.locate).
// 지문이 있으면 내용으로만, 지문 없는 사본은 잇지 않고, 지문 없는 프로젝트 참조는 경로 끝 두 조각 이상으로
// 찾는다 — 이름만 같은 것으로는 잇지 않는다(2026-09-29). 여기서는 받은 것만 반영한다 — 묻지 않는다.
import { api } from "../api";
import { getAccountNamespace } from "./accountScope";
import {
  confirmSceneWrite,
  listPersistedScenes,
  listScenes,
  updateScenesWith,
  type Scene,
  type SceneCard,
  type SceneRef,
} from "./scenes";
import { loadSceneHistory, sameSnap, saveSceneHistory, type SceneSnap } from "./sceneUndoStore";
import { loadJSON, saveJSON } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";
import { loadStoredWorkspaceContext } from "./workspaceContext";

// 에셋 참조 토큰 전부. 이미 잘 열리는 것은 서버가 그대로 두므로 여기서 거르지 않는다 —
// 어느 것이 안 열리는지는 폴더를 볼 수 있는 서버만 안다.
const ASSET_TOKEN = /^asset:[^|]+\|/;

/** 이 씬의 그림을 **어느 공간 폴더부터** 찾을지 — 탭에 사람이 고른 공간, 없으면 씬 파일로 받은 힌트.
 *  묻기·답 반영·서버에 없음 표시가 모두 이 하나로 열쇠를 만든다(어긋나면 표시가 엉뚱한 참조에 붙는다). */
export function sceneRefWorkspaceId(scene: Pick<Scene, "workspace" | "refWorkspaceHint">): string {
  return scene.workspace?.id || scene.refWorkspaceHint?.id || "";
}

export interface RefFingerprint {
  sha256: string;
  bytes: number;
}

/** 물어볼 참조를 **캔버스 탭의 공간별로** 묶는다 — 서버가 그 공간의 프로젝트부터 찾게(Jay 2026-09-28).
 *  참조가 든 지문(content_sha·bytes)도 함께 싣는다(2026-09-29) — 사본이 이 PC 에 없어도 내용으로 찾게.
 *  한 토큰을 쓰는 참조가 **모두 같은 지문**일 때만 싣는다. 하나라도 없거나 다르면 싣지 않는다 — 한 지문으로
 *  찾은 답이 지문 없는·다른 지문의 참조까지 덮지 않게(Codex). */
export function sceneAssetGroups(scenes: Scene[]): {
  workspaceId: string;
  tokens: string[];
  fingerprints: Record<string, RefFingerprint>;
  registryIds: Record<string, string>;
}[] {
  const byWorkspace = new Map<string, Map<string, RefFingerprint | null>>();
  // 에셋 대장 번호도 지문과 같은 규칙 — 한 토큰의 참조가 **모두 같은 번호**일 때만 싣는다(Codex P0 — 다른 번호의
  //  참조끼리 한 답을 나눠 갖지 않게). 하나라도 없거나 다르면 번호 없이 묻는다.
  const idsByWorkspace = new Map<string, Map<string, string | null>>();
  for (const scene of scenes) {
    const ws = sceneRefWorkspaceId(scene);
    for (const card of scene.cards) {
      for (const ref of card.refs || []) {
        if (!ref.file_path || !ASSET_TOKEN.test(ref.file_path)) continue;
        let bucket = byWorkspace.get(ws);
        if (!bucket) byWorkspace.set(ws, (bucket = new Map()));
        let ids = idsByWorkspace.get(ws);
        if (!ids) idsByWorkspace.set(ws, (ids = new Map()));
        const mine = ref.content_sha && ref.bytes ? { sha256: ref.content_sha, bytes: ref.bytes } : null;
        const myId = ref.registry_asset_id || null;
        if (!bucket.has(ref.file_path)) {
          bucket.set(ref.file_path, mine);
          ids.set(ref.file_path, myId);
          continue;
        }
        const seen = bucket.get(ref.file_path);
        if (seen && (!mine || seen.sha256 !== mine.sha256 || seen.bytes !== mine.bytes)) {
          bucket.set(ref.file_path, null); // 모두 같지 않다 — 이 토큰은 지문 없이 묻는다
        }
        if (ids.get(ref.file_path) !== myId) ids.set(ref.file_path, null);
      }
    }
  }
  return [...byWorkspace].map(([workspaceId, bucket]) => ({
    workspaceId,
    tokens: [...bucket.keys()],
    fingerprints: Object.fromEntries(
      [...bucket].filter((entry): entry is [string, RefFingerprint] => entry[1] !== null),
    ),
    registryIds: Object.fromEntries(
      [...(idsByWorkspace.get(workspaceId) || [])].filter((entry): entry is [string, string] => !!entry[1]),
    ),
  }));
}

export function sceneAssetTokens(scenes: Scene[]): string[] {
  const out = new Set<string>();
  for (const group of sceneAssetGroups(scenes)) group.tokens.forEach((t) => out.add(t));
  return [...out];
}

export interface RelinkTarget {
  project: string;
  path: string;
  sha256?: string;
  bytes?: number;
  // 에셋 대장 번호 — 대장이 확인한 답(fixed)이거나, 토큰은 그대로인 번호 알림(open_ids)
  registry_asset_id?: string;
}

/** 결과의 열쇠 — **공간 + 참조**. 같은 옛 참조라도 캔버스의 공간이 다르면 다른 파일로 찾힐 수 있다.
 *  참조만 열쇠로 쓰면 나중에 처리된 공간의 답이 다른 공간의 씬까지 덮는다(Codex 2026-09-28). */
export const relinkKey = (workspaceId: string, token: string): string => `${workspaceId}\u0000${token}`;

/** 한 씬(공간 ws)의 카드에서 찾은 참조만 갈아끼운다 — 안 바뀐 카드는 같은 객체 그대로. 썸네일은 새 주소로
 *  다시 만들게 비운다. 열린 캔버스는 이것을 **자기 메모리의 카드**에 바로 입힌다(SceneBoard applyAssetRelink). */
export function relinkCards(
  cards: SceneCard[],
  ws: string,
  found: Map<string, RelinkTarget>,
): { cards: SceneCard[]; changed: number } {
  let changed = 0;
  const next = cards.map((card) => {
    if (!card.refs?.length) return card;
    let touched = false;
    const refs = card.refs.map((ref) => {
      const hit = ref.file_path ? found.get(relinkKey(ws, ref.file_path)) : undefined;
      if (!hit) return ref;
      const nextPath = `asset:${hit.project}|${hit.path}`;
      if (nextPath === ref.file_path) {
        // 토큰은 그대로 — 대장 번호만 알려 준 답(open_ids). 이미 번호가 있으면 덮지 않는다.
        if (!hit.registry_asset_id || ref.registry_asset_id) return ref;
        touched = true;
        changed += 1;
        return { ...ref, registry_asset_id: hit.registry_asset_id };
      }
      if (ref.registry_asset_id) {
        // 대장 번호가 있는 참조는 **같은 번호의 답만** 받는다(Codex P0). 같은 번호면 논리 파일이 같으니, 넣을 때 판
        //  (content_sha)과 지금 판이 달라도 따라간다 — 고쳐 저장한 새 판을 보여 주는 것이 지금 캔버스 동작과 같다.
        if (hit.registry_asset_id !== ref.registry_asset_id) return ref;
      } else if (
        ref.content_sha &&
        (hit.sha256 !== ref.content_sha || (ref.bytes && hit.bytes && ref.bytes !== hit.bytes))
      ) {
        // 이 참조가 든 지문과 다른 답은 적용하지 않는다 — 같은 토큰을 쓰는 다른 그림이거나(PC 마다 imports 이름이
        //  겹친다), 지문 없이 경로로 찾은 답이다. 지문을 가진 참조는 내용으로만 잇는다(2026-09-29, Codex).
        return ref;
      }
      touched = true;
      changed += 1;
      return {
        ...ref,
        file_path: nextPath,
        thumb: null, // 옛 주소로 만든 썸네일은 버린다
        // 넣을 때 판은 지킨다(대장 번호로 따라간 새 판과 다를 수 있다). 없던 참조만 이번에 찾은 판을 적는다.
        content_sha: ref.content_sha ?? hit.sha256,
        bytes: ref.content_sha
          ? (ref.bytes ?? (hit.sha256 === ref.content_sha ? hit.bytes : undefined))
          : (hit.bytes ?? ref.bytes),
        ...(hit.registry_asset_id ? { registry_asset_id: hit.registry_asset_id } : {}),
      };
    });
    return touched ? { ...card, refs } : card;
  });
  return { cards: changed ? next : cards, changed };
}

/** 찾은 것만 갈아끼운 새 씬 목록과 바뀐 참조 수. 각 씬은 **자기 공간의 답만** 받는다.
 *  안 바뀐 씬은 같은 객체 그대로 — 화면이 그 씬을 다시 그리지 않게. */
export function applyRelink(
  scenes: Scene[],
  found: Map<string, RelinkTarget>,
): { scenes: Scene[]; changed: number } {
  let changed = 0;
  const next = scenes.map((scene) => {
    const relinked = relinkCards(scene.cards, sceneRefWorkspaceId(scene), found);
    changed += relinked.changed;
    return relinked.changed ? { ...scene, cards: relinked.cards } : scene;
  });
  return { scenes: changed ? next : scenes, changed };
}

// ── 서버 판정 기억(Jay 2026-09-29 "2 새 안") ────────────────────────────────────────────────────────────
// 한 번 답을 받은 참조는 앱을 다시 켜도 자동으로 다시 묻지 않는다 — 켤 때마다 모든 씬의 그림으로 NAS 를 훑던 것을 없앤다.
//  · 판정 = open(이미 열림)·fixed(원본으로 이음)·local(이 PC 에만)·missing(서버에 없음)·unresolved(끝까지 봤지만 못 이음 —
//    후보 여럿·근거 없음). 서버가 incomplete(끝까지 못 훑음)라 한 것과 오류·시간 초과·대기 중단은 저장하지 않고 있던 판정도
//    덮지 않는다 — 다음 앱 시작에 다시 묻는다. fixed 도 기억한다 — 지문이 달라 못 바꾼 옛 토큰을 시작마다 다시 훑지 않게.
//  · 계정별 맵(STORAGE_KEYS.sceneRefVerdicts) — 서버가 계정의 등록 폴더로 판정한다. 열쇠 = (공간, 토큰, 묶음 지문)의 53비트
//    해시(씬도 localStorage 에 있어 용량이 빠듯하다). 충돌하면(5,000건에 약 10억분의 1) 그 참조를 '이미 확인함'으로 잘못 알아
//    자동으로 안 묻는다 — '레퍼런스 찾기' 단추가 풀어 준다.
//  · 만료는 없다. NAS 에 나중에 올린 파일은 단추를 눌러야 안다(Jay 가 받아들인 대가).
//  · 정리: 자동 복구·단추가 끝날 때 지금 씬들이 쓰지 않는 열쇠를 버리고, 그래도 5,000건을 넘으면 오래 확인한 것부터 버린다.
//    저장 직전에 다시 읽어 다른 탭이 쓴 것과 합친다(같은 열쇠는 나중에 확인한 쪽).
// 판정은 씬 파일에 담지 않는다 — 폴더를 보는 건 서버뿐이고, 사람·PC 마다 답이 다르다.
// held = 판정 보류(못 이었고 이유가 있다 — 빨간 테두리, Jay 2026-09-30) · incomplete = 이번 실행에서 판정을 못 끝냄(회색)
export type RefServerStatus = "missing" | "local" | "held" | "incomplete";
type Verdict = "open" | "fixed" | "local" | "missing" | "unresolved";
// [판정, 확인 시각, 물을 때 실은 공간, 보류 이유] — 공간·이유는 '보류'(unresolved)에만 적는다. 보류는 어느 공간부터 찾았느냐에
//  따라 달라지고(서버는 그 공간에서 유일하면 잇는다), 서버에 없음·열림·이 PC 에만은 공간과 무관하다.
type VerdictEntry = [Verdict, number, string?, RefHeld?];
/** 판정 보류의 이유(서버 locate 의 held, 2026-09-30) — 카드가 빨간 테두리 안에 적는다. 옛 허브의 답이면 why=unknown. */
export interface RefHeld {
  why: "multiple" | "name_only" | "copy_name" | "changed" | "unknown" | string;
  count: number;
  projects: string[];
}

/** 보류 안내 문구(Jay 2026-09-30 시안 — 연결 안 된 레퍼런스는 빨간 테두리 + 이유). detail = 무엇이 문제인지(늘 보임),
 *  fix = 푸는 법(한 줄), more = 마우스 설명에만 붙는 긴 안내, copy = 사본 아이콘. 레퍼런스 카드 폭(약 150px 고정)에 들어가게 짧게. */
export function heldText(h: RefHeld): { title: string; detail: string; fix: string; more?: string; copy: boolean } {
  const where = h.projects.join(" · ");
  switch (h.why) {
    case "multiple":
      return {
        title: `연결 안 됨 · 후보 ${h.count}곳`,
        detail: where ? `${where} 에 같은 파일` : "같은 파일이 여러 곳에 있음",
        fix: "워크스페이스를 고르면 이어짐",
        copy: false,
      };
    case "copy_name":
      // A안(Jay 2026-09-30) — 글로만 알린다. 이름만 같은 파일은 자동으로 잇지 않는다(download.jpg 사고)
      return {
        title: "사본 · 서버에 같은 이름",
        detail: "같은 그림인지 확인 못 함",
        fix: "에셋에서 끌어와 바꾸기",
        more: "이 사본이 있는 원래 PC 에서 레퍼런스 찾기를 누르면 내용으로 이어집니다",
        copy: true,
      };
    case "name_only":
      return {
        title: "연결 안 됨 · 이름만 같음",
        detail: where ? `${where} 의 다른 폴더에 있음` : "다른 폴더에 같은 이름이 있음",
        fix: "에셋에서 끌어와 바꾸기",
        copy: false,
      };
    case "changed":
      return { title: "연결 안 됨 · 내용이 다름", detail: "같은 이름 파일이 넣은 뒤 바뀜", fix: "에셋에서 끌어와 바꾸기", copy: false };
    default:
      return { title: "연결 안 됨", detail: "", fix: "레퍼런스 찾기로 다시 확인", copy: false };
  }
}
type Verdicts = Record<string, VerdictEntry>;
const VERDICT_CAP = 5000;
let verdictCache: Verdicts | null = null;
let verdictCacheNs: string | null = null;
const statusListeners = new Set<() => void>();
let statusVersion = 0;
// 이번 실행에서 판정을 못 끝낸 열쇠(NAS 끊김 등) — 저장하지 않는다(다음 시작에 다시 묻는다). 표시(회색 '확인 못 함')에만 쓴다.
const incompleteNow = new Set<string>();

// 53비트 문자열 해시(cyrb53, 공개 도메인) — 짧은 열쇠로 localStorage 용량을 아낀다.
function cyrb53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// 대장 번호가 있으면 열쇠에 넣는다(Codex P0 — 같은 토큰이라도 번호가 다르면 다른 참조). 번호가 없으면 예전과 똑같은
//  열쇠 — 저장된 판정이 한꺼번에 무효가 되어 앱 시작에 모든 그림으로 NAS 를 다시 훑는 일이 없게.
const verdictKey = (workspaceId: string, token: string, fp?: RefFingerprint | null, registryId?: string | null): string =>
  cyrb53(
    JSON.stringify(
      registryId
        ? [workspaceId, token, fp?.sha256 ?? "", fp?.bytes ?? 0, registryId]
        : [workspaceId, token, fp?.sha256 ?? "", fp?.bytes ?? 0],
    ),
  );

function loadVerdicts(): Verdicts {
  const ns = getAccountNamespace();
  if (verdictCache && verdictCacheNs === ns) return verdictCache;
  const mine = loadJSON<Record<string, Verdicts>>(STORAGE_KEYS.sceneRefVerdicts)?.[ns];
  verdictCache = mine && typeof mine === "object" ? { ...mine } : {};
  verdictCacheNs = ns;
  return verdictCache;
}

function verdictOf(key: string): Verdict | undefined {
  const entry = loadVerdicts()[key];
  return Array.isArray(entry) ? entry[0] : undefined;
}

/** 서버에 실어 보낼 공간 — 탭 공간, 없으면 지금 선택된 팀 워크스페이스(Jay 2026-09-30). 개인·미정이면 "". */
function askWorkspaceOf(ws: string): string {
  if (ws) return ws;
  const selected = loadStoredWorkspaceContext();
  return selected?.scope === "team" ? selected.id || "" : "";
}

/** 자동 복구가 다시 묻지 않아도 되는 판정인가 — '보류'는 그때 실은 공간이 지금과 같을 때만(Codex P2: 선택 공간을 바꾸면
 *  그 공간에서 유일하게 찾힐 수 있다. 단추는 판정과 무관하게 늘 다시 묻는다). */
function settled(key: string, askWs: string): boolean {
  const entry = loadVerdicts()[key];
  if (!Array.isArray(entry)) return false;
  return entry[0] !== "unresolved" || (entry[2] ?? "") === askWs;
}

function notifyStatus(): void {
  statusVersion += 1;
  statusListeners.forEach((cb) => cb());
}

/** 저장 — 다른 탭이 그 사이 쓴 것과 합치고(같은 열쇠는 나중에 확인한 쪽), keep 이 있으면 그 밖의 열쇠를 버린 뒤 상한을 지킨다.
 *  drop = 이번에 지운 열쇠 — 합치기가 디스크의 옛 판정을 도로 살리지 않게 합친 뒤에 다시 지운다.
 *  다른 계정의 칸은 건드리지 않는다. 저장 실패(용량)는 삼킨다 — 기억은 속도를 위한 것이라 없어도 동작은 같다. */
function saveVerdicts(keep?: Set<string>, drop?: Set<string>): void {
  const ns = getAccountNamespace();
  const mine = loadVerdicts();
  const all = loadJSON<Record<string, Verdicts>>(STORAGE_KEYS.sceneRefVerdicts) || {};
  const disk = all[ns];
  if (disk && typeof disk === "object") {
    for (const [key, entry] of Object.entries(disk)) {
      const cur = mine[key];
      if (Array.isArray(entry) && (!Array.isArray(cur) || cur[1] < entry[1])) mine[key] = entry;
    }
  }
  if (drop) for (const key of drop) delete mine[key];
  if (keep) for (const key of Object.keys(mine)) if (!keep.has(key)) delete mine[key];
  const keys = Object.keys(mine);
  if (keys.length > VERDICT_CAP) {
    keys.sort((a, b) => mine[a][1] - mine[b][1]);
    for (const key of keys.slice(0, keys.length - VERDICT_CAP)) delete mine[key];
  }
  all[ns] = mine;
  saveJSON(STORAGE_KEYS.sceneRefVerdicts, all);
}

/** 지금 씬들이 쓰는 열쇠만 남긴다 — 지운 씬·원본으로 이어져 사라진 옛 토큰의 판정이 쌓이지 않게. */
function pruneVerdicts(): void {
  const keep = new Set<string>();
  for (const group of sceneAssetGroups(listScenes(null))) {
    for (const token of group.tokens) {
      keep.add(verdictKey(group.workspaceId, token, group.fingerprints[token], group.registryIds[token]));
    }
  }
  saveVerdicts(keep);
}

// 다른 탭이 판정을 바꾸면 다시 읽고 표시도 다시 그린다(key null = 다른 탭의 전체 비우기).
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== STORAGE_KEYS.sceneRefVerdicts) return;
    verdictCache = null;
    notifyStatus();
  });
}

/** 이 참조의 서버 판정 중 캔버스가 그리는 것(서버에 없음·이 PC 에만). 참조의 지문 열쇠가 먼저, 없으면 지문 없는 열쇠 —
 *  한 토큰의 참조들이 지문이 달라 묶음 지문 없이 물었을 때는 그 열쇠에 저장된다(sceneAssetGroups). */
type RefKeyed = Pick<SceneRef, "file_path" | "content_sha" | "bytes" | "registry_asset_id">;

/** 이 참조에 저장된 판정(없으면 undefined)과, 이번 실행에서 판정을 못 끝냈는가. 열쇠 순서는 아래 refServerStatus 설명대로. */
function refEntry(workspaceId: string, ref: RefKeyed): { entry?: VerdictEntry; incomplete: boolean } {
  const store = loadVerdicts();
  let incomplete = false;
  for (const key of refReadKeys(workspaceId, ref)) {
    const entry = store[key];
    if (Array.isArray(entry)) return { entry, incomplete: false };
    incomplete ||= incompleteNow.has(key);
  }
  return { incomplete };
}

/** 이 참조의 판정을 읽는 열쇠들(읽는 순서). 번호가 붙은 참조는 번호 열쇠가 먼저(묶음이 번호를 실어 물었을 때), 없으면 번호
 *  없는 열쇠(번호가 서로 달라 뺐을 때). 지문도 같은 규칙. 표시(refEntry)와 '판정 못 끝냄'의 지우기가 같은 목록을 쓴다. */
function refReadKeys(workspaceId: string, ref: RefKeyed): string[] {
  if (!ref.file_path) return [];
  const own = ref.content_sha && ref.bytes ? { sha256: ref.content_sha, bytes: ref.bytes } : null;
  const ids = ref.registry_asset_id ? [ref.registry_asset_id, null] : [null];
  return ids.flatMap((id) =>
    own
      ? [verdictKey(workspaceId, ref.file_path, own, id), verdictKey(workspaceId, ref.file_path, null, id)]
      : [verdictKey(workspaceId, ref.file_path, null, id)],
  );
}

export function refServerStatus(workspaceId: string, ref: RefKeyed): RefServerStatus | undefined {
  const { entry, incomplete } = refEntry(workspaceId, ref);
  const verdict = entry?.[0];
  if (verdict === "missing" || verdict === "local") return verdict;
  if (verdict === "unresolved") return "held";
  return !entry && incomplete ? "incomplete" : undefined;
}

/** 판정 보류의 이유(held 일 때만). 옛 허브의 답으로 저장된 보류는 why=unknown. */
export function refHeldInfo(workspaceId: string, ref: RefKeyed): RefHeld | undefined {
  const { entry } = refEntry(workspaceId, ref);
  return entry?.[0] === "unresolved" ? (entry[3] ?? { why: "unknown", count: 0, projects: [] }) : undefined;
}

/** 서버가 이 참조를 한 번이라도 판정했는가(열림·연결·보류·없음 등) — 아니면 썸네일이 안 뜰 때 '확인 중'으로 그린다. */
export function refJudged(workspaceId: string, ref: RefKeyed): boolean {
  const { entry, incomplete } = refEntry(workspaceId, ref);
  return !!entry || incomplete;
}

export function subscribeRefServerStatus(cb: () => void): () => void {
  statusListeners.add(cb);
  return () => {
    statusListeners.delete(cb);
  };
}

// useSyncExternalStore 용 — 판정이 바뀔 때만 올라가는 버전.
export function getRefServerStatusVersion(): number {
  return statusVersion;
}

// 이 세션에 답을 받은 참조(공간+실은 공간+토큰) — 세션 동안 자동으로 다시 묻지 않는다(판정을 못 끝낸 것도 — 다음 앱 시작에 다시).
// 실패한 요청은 담지 않는다 — 다음 계기에 다시 묻는다. 실은 공간(askWs)까지 넣어야 탭에 공간이 없는 씬이 위에서 고른
// 워크스페이스를 바꿨을 때 새 공간으로 한 번 묻는다 — 늦게 온 옛 공간의 답이 새 공간 질문을 막지도 않는다(2026-10-01 점검 R2-2).
const asked = new Set<string>();
const askedKey = (workspaceId: string, askWs: string, token: string): string =>
  relinkKey(workspaceId, relinkKey(askWs, token));
// 저장된 판정과 무관하게 한 번 물을 참조(공간+토큰) — 답을 받으면 뺀다.
const forced = new Set<string>();

/** 이 참조들은 저장된 판정과 무관하게 다음 자동 복구에서 한 번 묻는다 — 방금 끌어다 놓은 파일(같은 파일을 다시 넣으면
 *  같은 사본 토큰이 되는데, 저장된 판정으로 건너뛰면 원본으로 못 잇는다). ★서버 답 전에 '이 PC에만'을 먼저 켜지 않는다
 *  — 판정은 서버가 한다(Jay 규칙). 예전에는 NAS 에 있는 파일도 답이 올 때까지 빨갛게 보였다(2026-09-29). */
export function forceRefsAsk(workspaceId: string, tokens: string[]): void {
  tokens.forEach((token) => forced.add(relinkKey(workspaceId, token)));
}

// 이 세션에 '그림이 안 떠' 다시 물은 참조(공간+토큰) — 한 번만(파일 자체가 깨져 늘 안 뜨는 참조가 되풀이해 묻지 않게).
const rechecked = new Set<string>();

/** 판정을 받은 참조의 그림이 안 뜬다 — 그사이 NAS 에서 이름이 바뀌었거나 옮겨졌을 수 있다(2026-09-30 실측: 저장된
 *  '열림' 은 자동 복구가 다시 묻지 않아 아무 말 없는 빗금으로 남았다). 그 판정을 지워 '확인 중'으로 그리고, 다음 자동 복구에서
 *  한 번 묻게 한다 — 번호가 있으면 대장이 폴더를 훑지 않고 새 자리를 준다. 세션마다 한 번. 물을 것이 생겼으면 true. */
export function recheckBrokenRef(workspaceId: string, ref: RefKeyed): boolean {
  if (!ref.file_path.startsWith("asset:")) return false;
  const at = relinkKey(workspaceId, ref.file_path);
  if (rechecked.has(at) || !refJudged(workspaceId, ref)) return false;
  rechecked.add(at);
  const store = loadVerdicts();
  const dropped = new Set<string>();
  for (const key of refReadKeys(workspaceId, ref)) {
    if (!store[key]) continue;
    delete store[key];
    dropped.add(key);
  }
  saveVerdicts(undefined, dropped);
  forced.add(at);
  notifyStatus();
  return true;
}

/** 씬 파일·DB 백업으로 방금 들어온 씬의 참조를 forceRefsAsk — 남이 준 씬은 열 때 그 씬만 한 번 확인한다. */
export function forceSceneRefsAsk(scenes: Scene[]): void {
  for (const group of sceneAssetGroups(scenes)) forceRefsAsk(group.workspaceId, group.tokens);
}

const LOCATE_BATCH = 200; // 서버가 한 번에 받는 상한과 같게 — 넘치면 나눠 보낸다
// 요청 하나를 기다리는 한도 — 정상 요청도 등록 폴더 수 × 2~3초라 1분대가 될 수 있어 넉넉히 둔다(짧으면 큰
// 구성에서 매번 끊기고 새 작업 id 로 처음부터 다시 훑는다). 멈춘 NAS 가 자동 복구를 새로고침 전까지 막지
// 않게 하는 것이 목적이다 — 풀리는 것은 브라우저 쪽뿐이고, NAS 에 묶인 서버 스레드는 끊지 못한다(2026-09-29).
const LOCATE_TIMEOUT_MS = 300_000;
let inFlight: Promise<number> | null = null;
// 도는 중에 또 불렸다 — 끝나면 한 번 더 돈다. 마지막 바퀴를 확인한 뒤에 들어온 참조(방금 끌어다 놓은
// 로컬 파일 등)를 다음 기회까지 놓치지 않게(Codex 2026-09-29).
let rerun = false;
// 자동 복구와 '레퍼런스 찾기'는 한 줄로 선다 — 동시에 돌면 늦게 온 답이 새 답을 덮을 수 있다(Codex 2026-09-29).
let queue: Promise<unknown> = Promise.resolve();
// 도는 자동 복구를 끊는 손잡이 — '레퍼런스 찾기'는 끊고 앞선다(Codex P1 2026-09-30: NAS 가 멈추면 깨진 그림이 부른 자동
//  복구가 단추를 최대 5분 줄 세웠다). 끊긴 배치의 답은 받지 않는다(브라우저만 멈추고 서버는 하던 확인을 끝낸다).
let autoAbort: AbortController | null = null;

function exclusive<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}

function newScanId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** 복구 답을 화면에 맞추는 두 관문 — 호출부(useSceneCoordination)가 넘긴다. 둘 다 답을 받은 **같은 동기
 *  구간**에서 불린다(그 사이 사용자 입력이 끼지 않는다). */
export interface RelinkHooks {
  /** 열린 캔버스(활성 씬)의 **메모리 카드**에 답을 바로 입히고 바꾼 참조 수를 준다. 캔버스가 안 열렸으면 null. */
  applyToBoard?: (found: Map<string, RelinkTarget>) => number | null;
  /** 나머지 씬에 입힌 직후(화면 값에 반영됨 — 저장소 확정은 뒤따른다) — 화면 목록을 이 값으로 맞춘다.
   *  boardApplied 면 활성 씬은 캔버스가 준 값을 지킨다. */
  onSaved?: (next: Scene[], boardApplied: boolean) => void;
}

type LocateReply = Awaited<ReturnType<typeof api.locateAssets>>;
type RefGroup = ReturnType<typeof sceneAssetGroups>[number];
type Answer = Verdict | "incomplete";
/** 답 종류별 토큰 수. */
export type FindCounts = Record<Answer, number>;

const emptyCounts = (): FindCounts => ({ open: 0, fixed: 0, local: 0, missing: 0, unresolved: 0, incomplete: 0 });

/** 한 배치의 답을 판정 기억에 싣고 토큰마다 답 종류를 센다. 보낸 토큰은 이 세션에 '물어봤다'로 치되(같은 복구 안에서
 *  되풀이해 묻지 않게), 판정은 답에 든 토큰만 기억한다. */
function noteReply(
  ws: string,
  askWs: string,
  batch: string[],
  fingerprints: Record<string, RefFingerprint>,
  registryIds: Record<string, string>,
  reply: LocateReply,
  counts: FindCounts,
): void {
  const answer = new Map<string, Answer>();
  reply.unresolved.forEach((token) => answer.set(token, "unresolved"));
  (reply.open ?? []).forEach((token) => answer.set(token, "open"));
  (reply.incomplete ?? []).forEach((token) => answer.set(token, "incomplete"));
  (reply.local ?? []).forEach((token) => answer.set(token, "local"));
  (reply.missing ?? []).forEach((token) => answer.set(token, "missing"));
  reply.fixed.forEach((item) => answer.set(item.token, "fixed"));
  const store = loadVerdicts();
  const now = Date.now();
  const dropped = new Set<string>();
  let scenesNow: Scene[] | undefined; // '판정 못 끝냄'이 왔을 때만 읽는다(같은 토큰의 참조 찾기)
  let changed = false;
  for (const token of batch) {
    const at = relinkKey(ws, token);
    asked.add(askedKey(ws, askWs, token));
    forced.delete(at);
    const got = answer.get(token);
    if (!got) continue;
    counts[got] += 1;
    const key = verdictKey(ws, token, fingerprints[token], registryIds[token]);
    if (got === "incomplete" ? !incompleteNow.has(key) : incompleteNow.has(key)) changed = true;
    if (got === "incomplete") incompleteNow.add(key);
    else incompleteNow.delete(key);
    if (got === "incomplete") {
      // 판정 못 끝냄 — 기억하지 않는다(이번 실행 화면에만 회색 '확인 못 함'). 다시 물었는데 확인을 못 했으면 옛 판정도
      //  지워 다음 시작에 다시 묻게 한다 — 안 그러면 NAS 가 끊긴 동안 옛 '서버에 없음'이 굳는다(Codex 2026-09-29·30:
      //  강제로 다시 물은 참조뿐 아니라 '레퍼런스 찾기' 단추도. 자동 복구는 저장된 판정을 묻지 않으므로 같은 규칙이 맞다).
      //  이 공간에서 **같은 토큰을 쓰는 모든 참조**가 읽는 열쇠를 지운다 — 참조마다 지문·번호가 달라 묶음이 그것 없이
      //  물었을 때도 각자의 옛 판정이 남으면 옛 빨강이 그대로 보인다(Codex P1 두 번).
      const keys = new Set(
        refReadKeys(ws, {
          file_path: token,
          content_sha: fingerprints[token]?.sha256,
          bytes: fingerprints[token]?.bytes,
          registry_asset_id: registryIds[token],
        }),
      );
      for (const scene of (scenesNow ??= listScenes(null))) {
        if (sceneRefWorkspaceId(scene) !== ws) continue;
        for (const card of scene.cards) {
          for (const r of card.refs || []) if (r.file_path === token) refReadKeys(ws, r).forEach((k) => keys.add(k));
        }
      }
      for (const k of keys) {
        if (!store[k]) continue;
        changed = true;
        delete store[k];
        dropped.add(k);
      }
      continue;
    }
    if (got === "fixed") continue; // 씬에 입혀 저장한 뒤에 기억한다(rememberFixed)
    // 번호가 온 '열림'은 번호를 씬에 저장한 뒤에만 번호 열쇠로 기억한다(attachOpenIds, Codex P1) — 여기서 먼저 기억하면
    //  저장이 실패했을 때 번호 없는 채로 굳어 다시 묻지 않는다(나중에 원본이 옮겨져도 번호로 못 따라간다).
    if (got === "open" && reply.open_ids?.[token]) continue;
    if (verdictOf(key) !== got || got === "unresolved") changed = true;
    store[key] =
      got === "unresolved"
        ? [got, now, askWs, reply.held?.[token] ?? { why: "unknown", count: 0, projects: [] }]
        : [got, now];
  }
  saveVerdicts(undefined, dropped);
  if (changed) notifyStatus();
}

/** 원본으로 이은 참조를 기억한다 — 씬에 입혀 **저장한 뒤에만**(저장이 실패해 옛 토큰이 남았는데 fixed 로 기억하면 다시 안
 *  묻는다, Codex). 이은 새 토큰은 '열림'으로 기억한다 — 다음 실행에 다시 묻지 않게(새 토큰 참조의 지문 = 답의 지문). */
function rememberFixed(
  ws: string,
  askWs: string,
  fixed: LocateReply["fixed"],
  fingerprints: Record<string, RefFingerprint>,
  registryIds: Record<string, string>,
): void {
  if (!fixed.length) return;
  const store = loadVerdicts();
  const now = Date.now();
  for (const item of fixed) {
    store[verdictKey(ws, item.token, fingerprints[item.token], registryIds[item.token])] = ["fixed", now];
    const token = `asset:${item.project}|${item.path}`;
    asked.add(askedKey(ws, askWs, token));
    // 새 토큰 참조의 지문 = 넣을 때 판이 있으면 그것(relinkCards 가 지킨다), 없으면 답의 판. 번호도 같은 규칙.
    const fp = fingerprints[item.token] ?? (item.sha256 && item.bytes ? { sha256: item.sha256, bytes: item.bytes } : null);
    store[verdictKey(ws, token, fp, item.registry_asset_id ?? registryIds[item.token])] = ["open", now];
  }
  saveVerdicts();
}

/** 열리는 참조에 서버가 알려 준 대장 번호(open_ids)를 적는다 — 토큰은 그대로, 번호만. 저장한 뒤에만 번호 열쇠로 '열림'을
 *  기억한다(번호가 붙으면 열쇠가 바뀌어 다음 시작에 다시 묻지 않게). 바꾼 수는 '원본으로 이음' 알림에 넣지 않는다. */
async function attachOpenIds(
  ws: string,
  openIds: Record<string, string> | undefined,
  fingerprints: Record<string, RefFingerprint>,
  hooks: RelinkHooks,
): Promise<void> {
  const found = new Map<string, RelinkTarget>();
  for (const [token, id] of Object.entries(openIds ?? {})) {
    const head = token.split("|", 1)[0];
    if (!id || !head.startsWith("asset:")) continue;
    found.set(relinkKey(ws, token), { project: head.slice("asset:".length), path: token.slice(head.length + 1), registry_asset_id: id });
  }
  if (!found.size || !(await applyFound(found, hooks)).saved) return;
  const store = loadVerdicts();
  const now = Date.now();
  for (const [token, id] of Object.entries(openIds ?? {})) store[verdictKey(ws, token, fingerprints[token], id)] = ["open", now];
  saveVerdicts();
}

/** 찾은 것을 화면·저장소에 입힌다. ① 열린 캔버스는 자기 메모리 카드에 참조만 바꿔 끼운다(저장본으로 갈아끼우지 않는다 —
 *  그 사이 친 글·옮긴 카드가 남게). ② 나머지 씬은 저장 직전에 다시 읽어 고친다(다른 탭 변경을 덮지 않게).
 *  같은 (공간, 토큰)을 쓰는 씬은 모두 받는다 — 판정도 씬이 아니라 (공간, 토큰, 지문)으로 기억하기 때문이다.
 *  바꾼 수(화면 값 기준)와 저장소 확정 여부를 준다(확정 실패면 fixed 를 기억하지 않는다). */
async function applyFound(
  found: Map<string, RelinkTarget>,
  hooks: RelinkHooks,
): Promise<{ total: number; saved: boolean }> {
  if (!found.size) return { total: 0, saved: true };
  // 열린 캔버스가 자기 메모리에 먼저 입히고(동기), 나머지 씬은 저장본에 입힌다. 화면 값에는 그 틱에
  // 반영되지만, '원본으로 이었다'는 판정은 **저장소에 확정된 뒤에만** 기억해야 한다 — 확정 못 한 채
  // 기억하면, 확정 전에 창이 닫혔을 때 옛 참조가 남은 채로 다시 묻지 않아 영영 안 이어진다. 그래서
  // 화면은 바로 맞추고, 반환(saved)만 이 묶음의 확정을 기다린다.
  let onBoard: number | null = null;
  let before: Scene[] = [];
  let next: Scene[] = [];
  let changed = 0;
  const { value: applied, confirmed } = confirmSceneWrite(() => {
    onBoard = hooks.applyToBoard?.(found) ?? null;
    before = listScenes(null);
    const result = applyRelink(before, found);
    next = result.scenes;
    changed = result.changed;
    if (!changed) return true;
    // 실제 쓰기는 연산으로 넘긴다 — 저장소 내용 위에서 다시 계산되므로 다른 창이 그사이 한 변경을
    // 덮지 않는다(연산은 순수: 바깥에 적지 않는다. found 는 답을 받은 뒤 바뀌지 않는다).
    return updateScenesWith(null, (current) => {
      const again = applyRelink(current, found);
      return again.changed ? again.scenes : null;
    });
  });
  const total = (onBoard ?? 0) + (applied ? changed : 0);
  if (!applied) return { total, saved: false };
  if (changed) {
    // 화면 값은 이미 바뀌었다 — 확정을 기다리지 않고 **같은 동기 구간에서** 실행 취소 기록과 화면 목록을 맞춘다.
    //  확정 뒤로 미루면 그사이(확정이 실패하면 계속) 화면 목록이 저장소의 화면 값과 어긋난다.
    // 실행 취소 기록 — 열린 캔버스만 기록을 고쳤고(propagateAssetRelinkToHistory), 나머지 씬은 돌아갈 때 기록의 마지막 상태가
    //  씬과 달라 Ctrl+Z 가 지워졌다. 기록이 복구 전 씬과 이어질 때만(어긋난 낡은 기록은 종전대로 버려지게),
    //  전이 메타는 그대로(2026-10-03 점검 CXF-5).
    before.forEach((scene, i) => {
      const history = next[i] !== scene ? loadSceneHistory(scene.id) : undefined;
      if (!history || !sameSnap(history.lastCommit, { cards: scene.cards, edges: scene.edges, groups: scene.groups || [] })) return;
      const ws = sceneRefWorkspaceId(scene);
      const patch = (snap: SceneSnap): SceneSnap => {
        const relinked = relinkCards(snap.cards, ws, found);
        return relinked.changed ? { ...snap, cards: relinked.cards } : snap;
      };
      saveSceneHistory(scene.id, { undo: history.undo.map(patch), redo: history.redo.map(patch), lastCommit: patch(history.lastCommit) });
    });
    hooks.onSaved?.(next, onBoard !== null);
  }
  // 확정 여부는 **확정본에 실제로 들어갔는지**까지 본다. 이 묶음에 연산이 없었어도(화면 값은 앞선 시도가
  //  이미 바꿔 놓았다) 그 앞선 연산이 아직 확정 전일 수 있다 — 그때 기억하면 위와 같은 구멍이 열린다.
  const saved = (await confirmed) && !applyRelink(listPersistedScenes(null), found).changed;
  return { total, saved };
}

/** 묶음을 200개씩 물어, 답마다 곧바로 판정을 기억하고 찾은 것을 입힌다 — 중간에 실패·중단해도 이미 받은 답은 남는다
 *  (fixed 로 기억한 참조가 원본으로 안 바뀐 채 남지 않게). 바꾼 참조 수는 done.total 에 더한다(실패해도 센 만큼 남는다).
 *  묻는 사이 계정이 바뀌면 그 답은 버리고 멈춘다 — 옛 계정의 폴더로 받은 답을 새 계정의 씬·판정에 쓰지 않게(Codex). */
async function askGroups(
  groups: RefGroup[],
  opts: {
    scanId: string;
    hooks: RelinkHooks;
    counts: FindCounts;
    done: { total: number };
    includeRender?: boolean;
    signal?: AbortSignal;
  },
): Promise<void> {
  const ns = getAccountNamespace();
  for (const group of groups) {
    for (let at = 0; at < group.tokens.length; at += LOCATE_BATCH) {
      const batch = group.tokens.slice(at, at + LOCATE_BATCH); // 상한을 넘기면 뒤가 조용히 잘린다
      const ws = group.workspaceId;
      // 탭에 공간이 없으면 **지금 선택된 워크스페이스**의 프로젝트부터 찾는다(Jay 2026-09-30). 판정 열쇠·찾은 답의 열쇠는
      //  그대로 탭 기준(ws)이다 — 열쇠까지 바꾸면 워크스페이스를 바꿀 때마다 기억한 표시가 사라진다.
      const askWs = askWorkspaceOf(ws);
      const fingerprints = Object.fromEntries(
        batch.filter((token) => group.fingerprints[token]).map((token) => [token, group.fingerprints[token]]),
      );
      const registryIds = Object.fromEntries(
        batch.filter((token) => group.registryIds[token]).map((token) => [token, group.registryIds[token]]),
      );
      const timeout = AbortSignal.timeout(LOCATE_TIMEOUT_MS);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      const reply = await api.locateAssets(batch, askWs, opts.scanId, fingerprints, signal, opts.includeRender, registryIds);
      if (getAccountNamespace() !== ns) throw new Error("account changed while locating");
      noteReply(ws, askWs, batch, group.fingerprints, group.registryIds, reply, opts.counts);
      const found = new Map(reply.fixed.map((item) => [relinkKey(ws, item.token), item] as const));
      const applied = await applyFound(found, opts.hooks);
      opts.done.total += applied.total;
      if (applied.saved) rememberFixed(ws, askWs, reply.fixed, group.fingerprints, group.registryIds);
      await attachOpenIds(ws, reply.open_ids, group.fingerprints, opts.hooks);
    }
  }
}

/**
 * 자동 복구 — 앱 시작·씬 불러오기·DB 백업 가져오기·끌어다 놓기 뒤에 부른다(useSceneCoordination).
 * 묻는 것은 **판정이 저장되지 않은 참조**와 강제 목록(방금 들어온 씬·방금 놓은 파일)뿐이다 — 앱을 켤 때마다 모든 씬의
 * 그림으로 NAS 를 훑지 않는다(Jay 2026-09-29 "2 새 안"). render 폴더는 훑지 않는다(단추가 훑는다).
 * 반환 = 바꾼 참조 수(알림용). 중간에 실패해도 이미 반영한 만큼 센다.
 */
export async function relinkSceneAssetRefs(hooks: RelinkHooks = {}): Promise<number> {
  if (inFlight) {
    rerun = true; // 겹쳐 부르면 합친다 — 폴더 스캔은 겹치지 않고, 끝난 뒤 한 번 더 확인한다
    return inFlight;
  }
  const pending = (): RefGroup[] =>
    sceneAssetGroups(listScenes(null))
      .map((group) => ({
        ...group,
        tokens: group.tokens.filter((token) => {
          const at = relinkKey(group.workspaceId, token);
          if (forced.has(at)) return true;
          return (
            !asked.has(askedKey(group.workspaceId, askWorkspaceOf(group.workspaceId), token)) &&
            !settled(
              verdictKey(group.workspaceId, token, group.fingerprints[token], group.registryIds[token]),
              askWorkspaceOf(group.workspaceId),
            )
          );
        }),
      }))
      .filter((group) => group.tokens.length > 0);
  const done = { total: 0 };
  const counts = emptyCounts();
  inFlight = exclusive(async () => {
    const stop = (autoAbort = new AbortController());
    const ns = getAccountNamespace();
    try {
      do {
        rerun = false;
        try {
          // 이번 복구 한 번의 id — 200개씩 여러 번 묻는 동안 서버가 같은 NAS 폴더를 매번 다시 훑지 않게 한다.
          const scanId = newScanId();
          // 씬을 새로 열면 토큰이 늘어난다 — 도는 동안 생긴 것까지 한 번 더 받아 준다(최대 5바퀴).
          for (let round = 0; round < 5; round += 1) {
            const groups = pending();
            if (!groups.length) break;
            await askGroups(groups, { scanId, hooks, counts, done, signal: stop.signal });
          }
        } catch {
          // 서버가 옛 버전이거나 폴더를 못 읽어도(시간 초과 포함) 화면은 지금까지처럼 동작한다 — 이미 받은 답은 남는다.
          //  도는 중에 또 불렸으면(예: 위에서 워크스페이스를 바꿈) 실패해도 한 번 더 돈다 — 여기서 끝내면 새 공간 질문을 잃었다
          //  (2026-10-01 Codex 코드 리뷰). [레퍼런스 찾기]가 끊었거나(끝난 뒤 단추가 다시 부른다) 계정이 바뀌었으면 멈춘다.
          if (stop.signal.aborted || getAccountNamespace() !== ns) break;
        }
      } while (rerun); // 확인과 비우기(finally) 사이에 틈이 없다 — 겹친 호출을 흘리지 않는다
    } finally {
      if (autoAbort === stop) autoAbort = null;
      pruneVerdicts();
      inFlight = null;
    }
    return done.total;
  });
  return inFlight;
}

/** '레퍼런스 찾기' 결과 — 토큰 수 기준. asked = 물으려던 참조 수, aborted = 사용자가 기다리기를 멈췄다. */
export interface FindSummary extends FindCounts {
  asked: number;
  aborted: boolean;
}

/**
 * '레퍼런스 찾기' 단추(Jay 2026-09-29) — 이 씬의 참조를 저장된 판정과 무관하게 다시 묻는다. PM 프로젝트의 render 폴더까지
 * 훑고, 새 작업 id 로 폴더를 새로 훑는다(나중에 NAS 에 올린 파일도 찾는다). 자동 복구와는 한 줄로 서서 답이 서로를
 * 덮지 않는다 — 도는 자동 복구는 끊고 앞선다(autoAbort). signal = '대기 중단' — 기다리기만 멈춘다(서버는 하던 확인을
 * 끝까지 한다). 멈춘 배치의 답은 기억하지 않는다. 서버 실패는 던진다(부르는 쪽이 알린다).
 */
export function findSceneAssetRefs(sceneId: string, hooks: RelinkHooks, signal?: AbortSignal): Promise<FindSummary> {
  const cut = autoAbort;
  cut?.abort();
  const run = exclusive(async () => {
    const counts = emptyCounts();
    const scene = listScenes(null).find((s) => s.id === sceneId);
    // 묶음 지문은 자동 복구와 같게 — 모든 씬으로 묶고 이 씬의 토큰만 남긴다(판정 열쇠가 어긋나지 않게)
    const mine = new Set(
      (scene ? sceneAssetGroups([scene]) : []).flatMap((g) => g.tokens.map((t) => relinkKey(g.workspaceId, t))),
    );
    const groups = sceneAssetGroups(listScenes(null))
      .map((group) => ({ ...group, tokens: group.tokens.filter((t) => mine.has(relinkKey(group.workspaceId, t))) }))
      .filter((group) => group.tokens.length > 0);
    const summary = (aborted: boolean): FindSummary => ({ ...counts, asked: mine.size, aborted });
    try {
      if (signal?.aborted) return summary(true);
      await askGroups(groups, {
        scanId: newScanId(),
        hooks,
        counts,
        done: { total: 0 },
        includeRender: true,
        signal,
      });
    } catch (error) {
      if (signal?.aborted) return summary(true);
      throw error;
    } finally {
      pruneVerdicts();
    }
    return summary(false);
  });
  // 끊은 자동 복구가 못 다 물은 것(도는 중 새로 들어와 다음 바퀴를 기다리던 참조 포함)은 단추 뒤에 한 번 더 돈다(Codex P1)
  if (cut) void run.finally(() => relinkSceneAssetRefs(hooks)).catch(() => undefined);
  return run;
}

/** '레퍼런스 찾기' 끝 알림 한 줄. 판정 보류 = 끝까지 봤지만 못 이음 + 끝까지 못 훑음. */
export function findSummaryText(s: FindSummary): string {
  if (s.aborted) return "레퍼런스 찾기 — 기다리기를 멈췄습니다(서버는 하던 확인을 끝까지 합니다).";
  if (!s.asked) return "이 씬에는 찾을 레퍼런스가 없습니다.";
  const held = s.unresolved + s.incomplete;
  if (!s.fixed && !s.local && !s.missing && !held) return `레퍼런스 ${s.asked}개가 모두 원본과 이어져 있습니다.`;
  return `레퍼런스 찾기 끝 — 원본 연결 ${s.fixed} · 이 PC에만 ${s.local} · 서버에 없음 ${s.missing} · 판정 보류 ${held}`;
}

/** 시험 전용 — 새 세션처럼(물어본 기록·강제 목록·판정 캐시·줄 세우기를 비운다). localStorage 는 그대로 둔다. */
export function resetRelinkSessionForTest(): void {
  asked.clear();
  forced.clear();
  rechecked.clear();
  incompleteNow.clear();
  verdictCache = null;
  verdictCacheNs = null;
  inFlight = null;
  rerun = false;
  queue = Promise.resolve();
}
