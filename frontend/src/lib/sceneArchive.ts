// 캔버스 전체 내보내기·가져오기 — 이 브라우저의 모든 씬을 파일 하나로.
//
// 씬 하나를 파일로 주고받는 것(scenes.exportSceneText)과 다르다: 그쪽은 '새 탭으로 연다'는 공유용이고,
// 이쪽은 **백업·복원**이다 — 버킷(계정)·씬 id 를 그대로 싣고, 가져올 때 지금 것을 덮지 않고 합친다.
// 저장소가 막혔을 때 사용자가 작업을 건질 유일한 길이므로, 내보내기는 아직 확정 안 된 편집까지 싣는다.
import { getAccountNamespace } from "./accountScope";
import { readRestoreArchives, notebookRestoreGeneration, SCENE_WRITER_FEATURE, type NotebookArchive, type RestoreArchive } from "./sceneNotebook";
import { hubHasFeature, hubFeaturesKnown } from "./hubFeatures";
import { readEditRecoveryCandidates } from "./editDocBackup";
import { resumeImportedMirror, type MirrorRecovery } from "./sceneBackup";
import { downloadText } from "./download";
import { sameSceneContent, sceneBodySum, type SceneAbsorbConflict } from "./sceneAbsorb";
import { reviveCardGenerations } from "./sceneCardLinks";
import {
  dumpSceneStore,
  mergeSceneStoreDump,
  readSceneMigrationInfo,
  sceneStoreReady,
  type SceneBucketMerge,
  type SceneMigrationInfo,
  type SceneStoreDump,
} from "./sceneStore";
import { readStoredScene, listPersistedScenes, listPersistedSceneTexts, uid, variantIds, type Scene, type ScenesByProject } from "./scenes";

export const SCENE_ARCHIVE_FORMAT = "mvhub-scenes-full";
export const SCENE_ARCHIVE_VERSION = 1;
export interface StorageRecovery {
  account: string; canvases: RestoreArchive[]; mirror: MirrorRecovery | null;
  edits: ReturnType<typeof readEditRecoveryCandidates>;
  cards: { candidates: { removals: unknown[]; revives: unknown[]; backfill: unknown[] }[] } | null;
}
export const RECOVERY_ACCOUNT_CHANGED = "계정이 바뀌어 보관본을 다시 읽어야 합니다.";
export async function readStorageRecovery(expected?: string): Promise<StorageRecovery> {
  const account = getAccountNamespace();
  if (expected !== undefined && expected !== account) throw new Error(RECOVERY_ACCOUNT_CHANGED);
  const archives = await readRestoreArchives(account);
  if (account !== getAccountNamespace()) throw new Error(RECOVERY_ACCOUNT_CHANGED);
  if (!archives.ok) throw new Error(archives.stale ? RECOVERY_ACCOUNT_CHANGED : "보관본을 읽지 못했습니다.");
  const mirror = JSON.parse(localStorage.getItem(`mvhub.mirrorRecovery:${account}`) ?? "null") as StorageRecovery["mirror"];
  const cards = JSON.parse(localStorage.getItem(`mvhub.cardRecovery:${account}`) ?? "null") as StorageRecovery["cards"];
  return { account, canvases: archives.value, mirror, cards, edits: readEditRecoveryCandidates() };
}

/** 표시에서만 제외한다. 여러 세대 중 고유 원문·장부가 하나라도 있으면 보류를 유지한다. */
export function redundantMirrorHoldIds(recovery: StorageRecovery | null): Set<string> {
  const redundant = new Set<string>();
  if (!recovery?.mirror || recovery.account !== getAccountNamespace() || !sceneStoreReady() || !hubFeaturesKnown() || !hubHasFeature(SCENE_WRITER_FEATURE)) return redundant;
  const current = new Map(listPersistedScenes(null).map((scene) => [scene.id, scene]));
  const matched = new Set<string>();
  for (const id of recovery.mirror.blockedIds) if (current.has(id)) redundant.add(id);
  for (const original of recovery.mirror.originals) {
    if (!original || !Array.isArray(original.scenes) || !Array.isArray(original.ledger)) return new Set();
    for (const entry of original.ledger) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string") return new Set();
      redundant.delete(entry[0]);
    }
    for (const row of original.scenes) {
      if (!row || typeof row.id !== "string" || typeof row.text !== "string") return new Set();
      if (!redundant.has(row.id)) continue;
      try {
        const stored = JSON.parse(row.text) as Scene, now = current.get(row.id)!;
        // sameSceneContent는 실행 기록을 제외하므로 그 두 필드의 차이도 따로 지킨다.
        if (!stored || stored.id !== row.id || !sameSceneContent({ ...stored, camera: undefined }, { ...now, camera: undefined })
          || JSON.stringify(stored.comfyRuns) !== JSON.stringify(now.comfyRuns)
          || JSON.stringify(stored.comfyCardRuns) !== JSON.stringify(now.comfyCardRuns)) redundant.delete(row.id);
        else matched.add(row.id);
      } catch { redundant.delete(row.id); }
    }
  }
  for (const id of redundant) if (!matched.has(id)) redundant.delete(id);
  return redundant;
}

export function downloadStorageRecovery(recovery: StorageRecovery) {
  if (recovery.account !== getAccountNamespace()) throw new Error("계정이 바뀌었습니다. 보관본을 다시 읽어 주세요.");
  const buckets: ScenesByProject = {};
  for (const archive of recovery.canvases) for (const [bucket, scenes] of Object.entries(archive.scenes)) {
    if (bucket.startsWith(`${recovery.account}::`)) buckets[bucket] = [...(buckets[bucket] ?? []), ...scenes];
  }
  const own = `${recovery.account}::_none`;
  for (const original of recovery.mirror?.originals ?? []) {
    buckets[own] = [...(buckets[own] ?? []), ...original.scenes.map((scene) => JSON.parse(scene.text) as Scene)];
  }
  downloadText("mvhub-storage-recovery.json", JSON.stringify({
    format: SCENE_ARCHIVE_FORMAT, schemaVersion: SCENE_ARCHIVE_VERSION, exportedAt: new Date().toISOString(), buckets,
    conflicts: recovery.canvases.flatMap((archive) => archive.conflicts ?? []), recovery,
  }), "application/json");
}

/** 합류 때 한 번 보관한 원본. 현재 버킷을 섞지 않으며 기존 전체 가져오기가 읽는 형식이다. */
export function downloadNotebookArchive(archive: NotebookArchive): void {
  downloadText("mvhub-canvas-before-hub.json", JSON.stringify({
    format: SCENE_ARCHIVE_FORMAT, schemaVersion: SCENE_ARCHIVE_VERSION,
    exportedAt: new Date().toISOString(), buckets: archive.scenes, conflicts: archive.conflicts ?? [],
  }), "application/json");
}

/** 지금 저장소 내용 전체를 파일 글로 만든다. */
export async function exportSceneArchiveText(): Promise<string> {
  if (!sceneStoreReady()) throw new Error("캔버스 저장소가 아직 열리지 않았습니다.");
  const dump = await dumpSceneStore();
  return JSON.stringify({
    format: SCENE_ARCHIVE_FORMAT,
    schemaVersion: SCENE_ARCHIVE_VERSION,
    exportedAt: new Date().toISOString(),
    // 옛 저장소에서 옮길 때의 진단 기록 — 파일만 받아도 그 PC 의 상태를 볼 수 있게 싣는다(가져올 때는 읽지 않는다).
    migration: await readSceneMigrationInfo(),
    buckets: dump.buckets,
    conflicts: dump.conflicts,
  });
}

/** 전체를 파일로 내려받는다. 반환 = 실은 씬 수. */
export async function downloadSceneArchive(): Promise<number> {
  const text = await exportSceneArchiveText();
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  downloadText(`mvhub-canvas-all-${stamp}.json`, text, "application/json");
  const { buckets } = JSON.parse(text) as { buckets: ScenesByProject };
  return Object.values(buckets).reduce((sum, scenes) => sum + scenes.length, 0);
}

const chars = (count: number | null): string =>
  count === null ? "확인 못 함" : count >= 10_000 ? `${Math.round(count / 10_000).toLocaleString("ko-KR")}만 글자` : `${count}글자`;
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * 옛 저장 칸에서 옮길 때의 기록을 한 줄로. 기록이 없으면 그렇게 말한다 — 지금 잰 값으로 과거를 채우지 않는다.
 * 시험 쓰기가 '됨'이어도 "여유가 있었다"고 쓰지 않는다(1KB 가 들어갔다는 뜻일 뿐이다).
 */
export function describeSceneMigration(info: SceneMigrationInfo | null): string {
  if (!info) return "옮긴 기록 없음";
  const at = new Date(info.at);
  const when = Number.isNaN(at.getTime())
    ? "때 모름"
    : `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const probe =
    info.probe === "quota" ? "시험 쓰기 실패(가득 차 있었음)" : info.probe === "ok" ? "시험 쓰기 됨" : "시험 쓰기 확인 못 함";
  return (
    `옮길 때(${when}): 캔버스 ${info.sceneCount}개 · 캔버스 자료 ${chars(info.legacyChars)}` +
    ` · 옛 저장 칸 전체 ${chars(info.storageChars)} · ${probe}`
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const DAMAGED = "파일이 손상됐습니다(읽을 수 없는 캔버스가 들어 있습니다).";
// 파일의 씬 하나 — 화면이 믿고 쓰는 모양으로 검증·정규화한다(scenes.readStoredScene). 못 읽으면 파일 전체를 거절.
function readScene(raw: unknown): Scene {
  try {
    return readStoredScene(raw);
  } catch {
    throw new Error(DAMAGED);
  }
}
// 지금 저장소의 씬을 같은 모양으로 — 파일 쪽과 견줄 때만 쓴다(정규화 차이를 '내용이 다르다'로 읽지 않게).
function normalized(scene: Scene): Scene | null {
  try {
    return readStoredScene(scene);
  } catch {
    return null; // 지금 씬이 이상하다 — 파일 쪽을 사본으로 살려 둘 이유가 된다
  }
}

/**
 * 파일 글을 검증해 저장소에 합칠 모양으로 만든다. 하나라도 이상하면 **전체를 거절**한다(부분 적용 없음) —
 * 반쯤 들어간 복원은 무엇이 빠졌는지 알 수 없어서 안 한 것보다 나쁘다.
 */
export function parseSceneArchive(text: string): SceneStoreDump {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("캔버스 전체 파일이 아닙니다(JSON 을 읽지 못했습니다).");
  }
  if (!isRecord(parsed) || parsed.format !== SCENE_ARCHIVE_FORMAT) {
    // 씬 하나짜리 파일을 여기로 가져온 경우가 가장 흔하다 — 어디로 가야 하는지 알려 준다.
    throw new Error("캔버스 전체 파일이 아닙니다. 씬 하나짜리 파일은 캔버스의 [불러오기]로 여세요.");
  }
  if (typeof parsed.schemaVersion !== "number" || parsed.schemaVersion > SCENE_ARCHIVE_VERSION) {
    throw new Error("더 새 버전의 앱에서 만든 파일입니다 — 앱을 업데이트한 뒤 가져오세요.");
  }
  if (!isRecord(parsed.buckets)) throw new Error("파일이 손상됐습니다(캔버스 목록이 없습니다).");
  const buckets: ScenesByProject = {};
  for (const [key, scenes] of Object.entries(parsed.buckets)) {
    if (!Array.isArray(scenes)) throw new Error(DAMAGED);
    buckets[key] = scenes.map(readScene);
  }
  // 충돌 기록의 씬도 같은 관문을 지난다 — 나중에 '[옛 창] 이름' 탭으로 되살아나 화면에 닿는다.
  const side = (raw: unknown): Scene | null => (raw === null || raw === undefined ? null : readScene(raw));
  const conflicts = (Array.isArray(parsed.conflicts) ? parsed.conflicts : []).map((c): SceneAbsorbConflict => {
    if (!isRecord(c) || typeof c.bucket !== "string" || typeof c.sceneId !== "string") throw new Error(DAMAGED);
    return { bucket: c.bucket, sceneId: c.sceneId, mine: side(c.mine), theirs: side(c.theirs) };
  });
  return { buckets, conflicts };
}

const copyKey = (id: string, sum: string) => `${id}\n${sum}`;

/**
 * 한 버킷을 합친다 — **덮지 않는다**.
 *  · 없는 씬은 그대로 더한다(id 보존).
 *  · 같은 id 인데 내용이 다르면 지금 것을 두고, 파일 쪽을 새 id 의 '[사본] 이름' 탭으로 따로 더한다 —
 *    지금 씬이 망가진 경우에도 파일의 내용을 건질 수 있게.
 *  · 그 사본이 이미 있으면(같은 파일을 두 번 가져옴) 또 만들지 않는다. 사본을 그 뒤 고쳤어도 같다 —
 *    표식은 만들 때의 내용 지문이다.
 */
export function mergeArchiveBucket(local: Scene[], incoming: Scene[]): SceneBucketMerge {
  const byId = new Map(local.map((scene) => [scene.id, scene]));
  const copies = new Set(
    local.flatMap((scene) => (scene.recoveredFrom ? [copyKey(scene.recoveredFrom.id, scene.recoveredFrom.sum)] : [])),
  );
  const extra: Scene[] = [];
  let added = 0;
  let recovered = 0;
  for (const original of incoming) {
    const { comfyRuns: _runs, comfyCardRuns: _owners, ...scene } = original;
    const mine = byId.get(scene.id);
    if (!mine) {
      extra.push(scene);
      byId.set(scene.id, scene); // 파일 안에 같은 id 가 두 번 있어도 한 번만
      added += 1;
      continue;
    }
    const mineNow = normalized(mine);
    if (mineNow && sameSceneContent(mineNow, scene)) continue;
    const sum = sceneBodySum(scene);
    if (copies.has(copyKey(scene.id, sum))) continue;
    copies.add(copyKey(scene.id, sum));
    // 표식은 이름 앞에 — 탭은 이름을 12자에서 잘라 보여 주므로 뒤에 붙이면 안 보인다.
    extra.push({ ...scene, id: uid(), name: `[사본] ${scene.name}`, recoveredFrom: { id: scene.id, sum } });
    recovered += 1;
  }
  return { next: extra.length ? [...local, ...extra] : local, added, recovered };
}

/**
 * 파일의 캔버스를 지금 저장소에 합친다(mergeArchiveBucket).
 * @returns added = 더한 씬 수, recovered = 사본으로 따로 둔 씬 수
 */
export async function importSceneArchiveText(text: string): Promise<{ added: number; recovered: number }> {
  if (!sceneStoreReady()) throw new Error("캔버스 저장소가 아직 열리지 않았습니다.");
  const dump = parseSceneArchive(text);
  if (!hubFeaturesKnown()) throw new Error("허브 기능을 아직 확인하지 못했습니다 — 잠시 뒤 다시 시도하세요.");
  const account = getAccountNamespace(), notebook = hubHasFeature(SCENE_WRITER_FEATURE);
  const mirrorKey = `mvhub.mirrorRecovery:${account}`;
  const mirror = notebook ? null : JSON.parse(localStorage.getItem(mirrorKey) ?? "null") as MirrorRecovery | null;
  const generation = notebook ? notebookRestoreGeneration(account) : mirror?.generation;
  // 지금 계정의 버킷에 id 그대로 되돌아온 씬(사본 아님) — 아래에서 그 결과 카드의 소속을 되살린다
  const mine = `${getAccountNamespace()}::`;
  const restored: Scene[] = [];
  const selected = new Map<string, Scene>();
  const out = await mergeSceneStoreDump(dump, (local, incoming, bucket) => {
    const merged = mergeArchiveBucket(local, incoming);
    if (bucket.startsWith(mine)) {
      const had = new Set(local.map((scene) => scene.id));
      restored.push(...merged.next.filter((scene) => !had.has(scene.id) && !scene.recoveredFrom));
      for (const scene of merged.next) {
        if (!had.has(scene.id) || incoming.some((item) => item.id === scene.id && sameSceneContent(scene, item))) selected.set(scene.id, scene);
      }
    }
    return merged;
  });
  if (!out) throw new Error("가져온 캔버스를 저장하지 못했습니다 — 잠시 뒤 다시 시도하세요.");
  if (account !== getAccountNamespace()) throw new Error("계정이 바뀌어 전송을 보류했습니다.");
  if (!notebook && generation && mirror) {
    const confirmed = listPersistedSceneTexts(null).filter((scene) => selected.has(scene.id));
    if (confirmed.length !== selected.size || confirmed.some((scene) => !sameSceneContent(selected.get(scene.id)!, JSON.parse(scene.text) as Scene))) throw new Error("가져오는 동안 문서가 바뀌어 전송을 보류했습니다.");
    await resumeImportedMirror(account, generation, new Map(confirmed.map((scene) => [scene.id, scene.text])));
  }
  // 파일로 되살린 씬의 결과 카드는 사용자가 되살린 것이다 — DB 에 남은 빼기 기록(같은 씬·카드 id)이 다시 빼지 않게 Undo 와 같은 명시적
  //  되살리기로 보낸다(Codex 43회차: 워크플로 교체로 뺀 뒤 씬을 지우고 파일에서 되살리면 그 결과가 카드에서 다시 빠졌다). 사본([사본] — 새 씬 id)과
  //  다른 계정의 버킷은 해당 없다(빼기 기록이 걸리지 않거나, 이 계정의 일이 아니다).
  for (const scene of restored) {
    for (const card of scene.cards) {
      if (card.kind === "generation" || card.kind === "comfy") reviveCardGenerations(scene.id, card.id, variantIds(card));
    }
  }
  return out;
}
