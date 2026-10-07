// 씬 저장소 부팅 — 옛 저장소(localStorage)와 새 저장소(IndexedDB)를 잇는 자리.
//
// scenes.ts(데이터 계층)는 새 저장소만 알고, sceneStore 는 옛 저장소를 모른다. 둘을 아는 곳은
// 여기 하나뿐이다 — 이관이 끝나고 옛 저장소를 지우는 날, 이 파일만 지우면 된다.
import {
  LEGACY_GENERATION_KEY,
  absorbLegacyScenes,
  initSceneStore,
  type LegacyMark,
  type SceneStoreInit,
} from "./sceneStore";
import type { ScenesByProject } from "./scenes";
import { loadJSON, loadString, saveString } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";

const readLegacy = (): ScenesByProject | null =>
  loadJSON<ScenesByProject>(STORAGE_KEYS.scenes) ?? null;

function readLegacyMark(): LegacyMark | null {
  const raw = loadString(LEGACY_GENERATION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LegacyMark>;
    if (parsed?.state === "pending" || parsed?.state === "committed") {
      return { state: parsed.state, generation: String(parsed.generation || "") };
    }
  } catch {
    // 옛 형식(세대 글자만) — 끝난 이관으로 읽는다. 그 판은 확정 뒤에만 표식을 남겼다.
  }
  return { state: "committed", generation: raw };
}

// ★반환으로 성공을 알린다. saveString 은 실패를 삼키는데, 표식이 조용히 안 남으면 다음 실행이
//  '처음 이관'으로 보고 그 사이의 작업을 옛 내용으로 덮는다(Codex 코드 리뷰에서 재현).
function writeLegacyMark(mark: LegacyMark): boolean {
  const text = JSON.stringify(mark);
  saveString(LEGACY_GENERATION_KEY, text);
  return loadString(LEGACY_GENERATION_KEY) === text;
}

/**
 * 저장소를 열고(필요하면 옛 저장소에서 1회 이관), 그 뒤 옛 저장소의 변경을 지켜본다.
 *
 * ★옛 저장소는 지우지 않는다. 앱 업데이트가 캔버스 창을 닫아 주지 않으므로(브라우저 창은 일부러
 *  업데이트 대상 밖에서 돈다 — run_agent_session.py `_spawn_app_window`), 지우면 살아남은 옛 판
 *  창이 그대로 깨진다. 대신 그 창이 쓴 것을 흡수한다(2026-10-07 Codex 합의).
 */
export async function bootSceneStore(): Promise<SceneStoreInit> {
  const result = await initSceneStore(readLegacy, readLegacyMark(), writeLegacyMark);
  if (result.kind === "ready") watchLegacyWrites();
  return result;
}

let watching = false;

// 옛 판 창이 localStorage 에 쓰면 이 창에 storage 이벤트가 온다(같은 창의 쓰기에는 안 온다).
// 흡수를 못 하거나 놓쳐도 다음 부팅의 재대조가 따라잡으므로, 여기서는 최선 노력이면 된다.
function watchLegacyWrites(): void {
  if (watching || typeof window === "undefined") return;
  watching = true;
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEYS.scenes) return;
    const legacy = readLegacy();
    if (legacy) void absorbLegacyScenes(legacy);
  });
}
