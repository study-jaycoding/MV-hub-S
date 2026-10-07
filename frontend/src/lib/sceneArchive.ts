// 캔버스 전체 내보내기·가져오기 — 이 브라우저의 모든 씬을 파일 하나로.
//
// 씬 하나를 파일로 주고받는 것(scenes.exportSceneText)과 다르다: 그쪽은 '새 탭으로 연다'는 공유용이고,
// 이쪽은 **백업·복원**이다 — 버킷(계정)·씬 id 를 그대로 싣고, 가져올 때 지금 것을 덮지 않고 합친다.
// 저장소가 막혔을 때 사용자가 작업을 건질 유일한 길이므로, 내보내기는 아직 확정 안 된 편집까지 싣는다.
import { downloadText } from "./download";
import { sameSceneContent, sceneBodySum, type SceneAbsorbConflict } from "./sceneAbsorb";
import {
  dumpSceneStore,
  mergeSceneStoreDump,
  sceneStoreReady,
  type SceneBucketMerge,
  type SceneStoreDump,
} from "./sceneStore";
import { readStoredScene, uid, type Scene, type ScenesByProject } from "./scenes";

export const SCENE_ARCHIVE_FORMAT = "mvhub-scenes-full";
export const SCENE_ARCHIVE_VERSION = 1;

/** 지금 저장소 내용 전체를 파일 글로 만든다. */
export async function exportSceneArchiveText(): Promise<string> {
  if (!sceneStoreReady()) throw new Error("캔버스 저장소가 아직 열리지 않았습니다.");
  const dump = await dumpSceneStore();
  return JSON.stringify({
    format: SCENE_ARCHIVE_FORMAT,
    schemaVersion: SCENE_ARCHIVE_VERSION,
    exportedAt: new Date().toISOString(),
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
  for (const scene of incoming) {
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
  const out = await mergeSceneStoreDump(dump, mergeArchiveBucket);
  if (!out) throw new Error("가져온 캔버스를 저장하지 못했습니다 — 잠시 뒤 다시 시도하세요.");
  return out;
}
