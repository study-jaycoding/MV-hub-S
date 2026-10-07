// 씬 저장소 부팅 — 옛 저장소(localStorage)와 새 저장소(IndexedDB)를 잇는 자리.
//
// scenes.ts(데이터 계층)는 새 저장소만 알고, sceneStore 는 옛 저장소를 모른다. 둘을 아는 곳은
// 여기 하나뿐이다 — 이관이 끝나고 옛 저장소를 지우는 날, 이 파일만 지우면 된다.
import {
  LEGACY_GENERATION_KEY,
  absorbLegacyScenes,
  flushSceneStoreNow,
  initSceneStore,
  type LegacyDiagnosis,
  type LegacyMark,
  type SceneStoreInit,
} from "./sceneStore";
import { adoptLegacyBucket, type ScenesByProject } from "./scenes";
import { loadJSON, loadString, saveString } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";

const readLegacy = (): ScenesByProject | null =>
  loadJSON<ScenesByProject>(STORAGE_KEYS.scenes) ?? null;

/** 옛 저장소의 씬 **원문 그대로**(파싱·이관 없이). 앱이 못 뜰 때 사용자가 파일로 건질 수 있게. */
export function readLegacyScenesRaw(): string {
  return loadString(STORAGE_KEYS.scenes);
}

// ── 바깥 이관 표식 ───────────────────────────────────────────────────────────────
// 표식은 옛 저장소(localStorage)와 **쿠키** 두 곳에 적는다.
// ★쿠키가 필요한 까닭: 이 작업의 출발점이 "localStorage 가 꽉 찬 PC"다. 그 PC 에서는 표식 한 줄도
//  localStorage 에 못 쓴다 — 그러면 이관 자체를 시작하지 못해 앱이 안 뜬다(Codex). 쿠키는 할당량이
//  따로라 꽉 찬 PC 에서도 써지고, IndexedDB 만 사라지는 경우에도 남는다.
// 쿠키는 포트를 가리지 않고 같은 호스트에 공유되므로 이름에 포트를 넣는다(개발 5173 과 앱 8010 이
// 서로의 표식을 읽지 않게).
const COOKIE_NAME = `mvhub_scene_mig_${typeof location !== "undefined" ? location.port || "default" : "none"}`;

function parseMark(raw: string | null | undefined): LegacyMark | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LegacyMark>;
    if (parsed?.state === "pending" || parsed?.state === "committed") {
      return { state: parsed.state, generation: String(parsed.generation || "") };
    }
  } catch {
    // JSON 이 아니다 — 아래에서 '상태.세대' 모양(쿠키)인지 본다.
  }
  const dot = raw.indexOf(".");
  const state = dot > 0 ? raw.slice(0, dot) : "";
  if (state === "pending" || state === "committed") return { state, generation: raw.slice(dot + 1) };
  return null;
}

function readCookieMark(): LegacyMark | null {
  if (typeof document === "undefined") return null;
  const hit = document.cookie.split("; ").find((part) => part.startsWith(`${COOKIE_NAME}=`));
  return hit ? parseMark(decodeURIComponent(hit.slice(COOKIE_NAME.length + 1))) : null;
}

function writeCookieMark(mark: LegacyMark): boolean {
  if (typeof document === "undefined") return false;
  const value = encodeURIComponent(`${mark.state}.${mark.generation}`);
  document.cookie = `${COOKIE_NAME}=${value}; path=/; max-age=31536000; SameSite=Lax`;
  const back = readCookieMark(); // 쿠키도 차단될 수 있다 — 적혔는지 되읽어 확인한다
  return back?.state === mark.state && back.generation === mark.generation;
}

// 두 곳을 모두 읽어 합친다. ★'localStorage 먼저, 없으면 쿠키'로 읽으면 안 된다 — pending 은
// localStorage 에 적혔는데 committed 는 (그사이 꽉 차서) 쿠키에만 적힌 경우, 낡은 pending 을 읽어
// 끝난 이관을 다시 한다(Codex). 같은 세대면 committed 가 이긴다.
function readLegacyMark(): LegacyMark | null {
  const local = parseMark(loadString(LEGACY_GENERATION_KEY));
  const cookie = readCookieMark();
  if (!local || !cookie) return local ?? cookie;
  if (local.state === cookie.state) return local;
  return local.state === "committed" ? local : cookie;
}

// ★반환으로 성공을 알린다. saveString 은 실패를 삼키는데, 표식이 조용히 안 남으면 다음 실행이
//  '처음 이관'으로 보고 그 사이의 작업을 옛 내용으로 덮는다(Codex 코드 리뷰에서 재현).
//  두 곳 중 **한 곳이라도** 적혔으면 성공이다.
function writeLegacyMark(mark: LegacyMark): boolean {
  const text = JSON.stringify(mark);
  saveString(LEGACY_GENERATION_KEY, text);
  const inLocal = loadString(LEGACY_GENERATION_KEY) === text;
  const inCookie = writeCookieMark(mark);
  return inLocal || inCookie;
}

const isQuotaError = (error: unknown): boolean =>
  error instanceof DOMException &&
  (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED" || error.code === 22);

/**
 * 옛 저장소가 지금 어떤 상태인가 — 처음 옮길 때 한 번 재서 기록해 둔다(sceneStore 의 SceneMigrationInfo).
 * 시험 쓰기는 고유한 임시 키에 1KB 를 써 보고 곧바로 지운다. 무엇이 실패해도 던지지 않는다.
 */
export function diagnoseLegacyStorage(legacyChars?: number): LegacyDiagnosis {
  // legacyChars 는 **옮기는 그 원문**의 길이를 받는다(bootSceneStore). 여기서 다시 읽으면, 원문을 읽은 뒤 옛 창이
  // 고친 내용의 길이가 적혀 '옮긴 씬 수'와 다른 시점의 값이 된다(Codex 코드 리뷰).
  const out: LegacyDiagnosis = { legacyChars: legacyChars ?? null, storageChars: null, probe: "unknown" };
  let store: Storage;
  try {
    store = window.localStorage;
    if (legacyChars === undefined) out.legacyChars = (store.getItem(STORAGE_KEYS.scenes) ?? "").length;
    let total = 0;
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key !== null) total += key.length + (store.getItem(key) ?? "").length;
    }
    out.storageChars = total;
  } catch {
    return out; // 저장소 접근 자체가 막혔다 — 확인 못 함
  }
  const probeKey = `ch.scenes.probe.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  try {
    store.setItem(probeKey, "x".repeat(1024));
    out.probe = "ok";
  } catch (error) {
    out.probe = isQuotaError(error) ? "quota" : "unknown";
  } finally {
    try {
      store.removeItem(probeKey);
    } catch {
      // 지우지 못해도 1KB 다 — 진단 때문에 부팅을 막지 않는다
    }
  }
  return out;
}

/**
 * 저장소를 열고(필요하면 옛 저장소에서 1회 이관), 그 뒤 옛 저장소의 변경을 지켜본다.
 *
 * ★옛 저장소는 지우지 않는다. 앱 업데이트가 캔버스 창을 닫아 주지 않으므로(브라우저 창은 일부러
 *  업데이트 대상 밖에서 돈다 — run_agent_session.py `_spawn_app_window`), 지우면 살아남은 옛 판
 *  창이 그대로 깨진다. 대신 그 창이 쓴 것을 흡수한다(2026-10-07 Codex 합의).
 */
export async function bootSceneStore(): Promise<SceneStoreInit> {
  // 옛 저장소의 원문은 **한 번만** 읽는다 — 옮기는 내용과 진단에 적는 글자 수가 같은 원문에서 나오게.
  const raw = readLegacyScenesRaw();
  let parsed: ScenesByProject | null = null;
  try {
    parsed = raw ? (JSON.parse(raw) as ScenesByProject) : null;
  } catch {
    parsed = null; // 못 읽는 원문 — 옮길 것이 없다(원문은 그대로 남아 있고, 오류 화면에서 내려받을 수 있다)
  }
  const result = await initSceneStore(
    () => parsed,
    readLegacyMark(),
    writeLegacyMark,
    () => diagnoseLegacyStorage(raw.length),
  );
  if (result.kind !== "ready") return result;
  // 계정 네임스페이스 도입 전의 옛 버킷이 남아 있으면, 지금 계정으로의 귀속을 **확정한 뒤에** 화면을
  // 띄운다(확정 전에는 보이지 않는다 — scenes.adoptLegacyBucket). 확정에 실패해도 앱은 띄운다:
  // 저장소가 다시 시도하고, 확정되는 대로 목록에 나타난다.
  await adoptLegacyBucket(null);
  watchLegacyWrites();
  return result;
}

let watching = false;

function watchLegacyWrites(): void {
  if (watching || typeof window === "undefined") return;
  watching = true;
  // 옛 판 창이 localStorage 에 쓰면 이 창에 storage 이벤트가 온다(같은 창의 쓰기에는 안 온다).
  // 흡수를 못 하거나 놓쳐도 다음 부팅의 재대조가 따라잡으므로, 여기서는 최선 노력이면 된다.
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEYS.scenes) return;
    const legacy = readLegacy();
    if (legacy) void absorbLegacyScenes(legacy);
  });
  // 창이 가려지거나 닫히기 시작하면, 아직 확정 안 된 변경을 곧바로 저장소로 보낸다. ★보강책일 뿐
  // 보장이 아니다 — 강제 종료에서는 이 이벤트가 안 오고, 보낸 쓰기가 끝나기 전에 창이 죽을 수 있다.
  const flush = () => flushSceneStoreNow();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  window.addEventListener("pagehide", flush);
}
