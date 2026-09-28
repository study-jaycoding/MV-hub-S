// 옛 씬의 '이 PC 안 사본' 참조를 프로젝트 폴더의 원본으로 되돌린다(Jay 2026-09-28).
//
// 왜: 예전에는 캔버스·프롬프트에 끌어다 놓거나 붙여넣은 그림이 설치 폴더 안(imports·captures)에
// 복사됐다. 그 사본은 그 PC 에만 있어 씬을 남에게 주면 빈칸이 됐다. 원본은 대개 NAS(프로젝트 폴더)에
// 그대로 있으므로, 사본의 **내용 지문**으로 원본을 찾아 주소만 바꾼다. 서버가 정확히 한 프로젝트에서
// 찾았을 때만 바꿔 주므로(assets.locate) 여기서는 받은 것만 반영한다 — 묻지 않는다.
import { api } from "../api";
import { listScenes, saveScenes, type Scene } from "./scenes";

// 이 PC 안 내장 폴더를 가리키는 옛 토큰(imports·captures·합본).
const LEGACY_TOKEN = /^asset:(?:imports|captures|imp\/cap)\|/;

export function legacyAssetTokens(scenes: Scene[]): string[] {
  const out = new Set<string>();
  for (const scene of scenes) {
    for (const card of scene.cards) {
      for (const ref of card.refs || []) {
        if (ref.file_path && LEGACY_TOKEN.test(ref.file_path)) out.add(ref.file_path);
      }
    }
  }
  return [...out];
}

export interface RelinkTarget {
  project: string;
  path: string;
  sha256?: string;
  bytes?: number;
}

/** 찾은 것만 갈아끼운 새 씬 목록과 바뀐 참조 수. 썸네일은 새 주소로 다시 만들게 비운다. */
export function applyRelink(
  scenes: Scene[],
  found: Map<string, RelinkTarget>,
): { scenes: Scene[]; changed: number } {
  let changed = 0;
  const next = scenes.map((scene) => ({
    ...scene,
    cards: scene.cards.map((card) => {
      if (!card.refs?.length) return card;
      let touched = false;
      const refs = card.refs.map((ref) => {
        const hit = ref.file_path ? found.get(ref.file_path) : undefined;
        if (!hit) return ref;
        touched = true;
        changed += 1;
        return {
          ...ref,
          file_path: `asset:${hit.project}|${hit.path}`,
          thumb: null, // 옛 주소로 만든 썸네일은 버린다
          content_sha: hit.sha256 ?? ref.content_sha,
          bytes: hit.bytes ?? ref.bytes,
        };
      });
      return touched ? { ...card, refs } : card;
    }),
  }));
  return { scenes: changed ? next : scenes, changed };
}

// 이미 물어본 토큰 → 물어본 시각. 곧바로 다시 묻지 않되 **영원히 포기하지는 않는다** —
// NAS 가 잠깐 끊겼거나 폴더를 그 사이 등록했을 수 있다(Codex 2026-09-28). 실패한 호출은 담지 않는다.
const asked = new Map<string, number>();
const ASK_AGAIN_AFTER = 120_000; // 2분
const LOCATE_BATCH = 200; // 서버가 한 번에 받는 상한과 같게 — 넘치면 나눠 보낸다
let inFlight: Promise<number> | null = null;

/**
 * 옛 참조를 찾아 고친다. 앱 시작 때는 물론, **씬 파일을 나중에 열었을 때도** 다시 부른다
 * (남이 준 씬을 여는 것이 바로 이 기능이 필요한 자리다 — Codex 2026-09-28).
 * flushPending 은 호출부가 넘긴다 — 저장 직전에 캔버스의 디바운스 편집을 확정시켜 덮어쓰지 않게.
 */
export async function relinkLegacyAssetRefs(flushPending?: () => void): Promise<number> {
  if (inFlight) return inFlight; // 겹쳐 부르면 한 번만 — 폴더 스캔이 중복되지 않게
  const pending = (): string[] => {
    const now = Date.now();
    return legacyAssetTokens(listScenes(null)).filter((token) => {
      const at = asked.get(token);
      return at === undefined || now - at > ASK_AGAIN_AFTER;
    });
  };
  const run = async (): Promise<number> => {
    let changedTotal = 0;
    // 씬을 새로 열면 토큰이 늘어난다 — 도는 동안 생긴 것까지 한 번 더 받아 준다(최대 5바퀴).
    for (let round = 0; round < 5; round += 1) {
      const tokens = pending();
      if (!tokens.length) break;
      const found = new Map<string, RelinkTarget>();
      for (let at = 0; at < tokens.length; at += LOCATE_BATCH) {
        const batch = tokens.slice(at, at + LOCATE_BATCH); // 서버 상한을 넘기면 뒤가 조용히 잘린다
        const reply = await api.locateAssets(batch);
        batch.forEach((token) => asked.set(token, Date.now())); // 실제로 보낸 것만 '물어봤다'
        reply.fixed.forEach((item) => found.set(item.token, item));
      }
      if (!found.size) continue;
      flushPending?.(); // 캔버스가 아직 저장하지 않은 편집을 먼저 확정(안 하면 되돌려 덮는다)
      const latest = listScenes(null); // 저장 직전에 다시 읽는다 — 그 사이 다른 탭 변경을 덮지 않게
      const { scenes: next, changed } = applyRelink(latest, found);
      if (changed) saveScenes(null, next);
      changedTotal += changed;
    }
    return changedTotal;
  };
  inFlight = run()
    .catch(() => 0) // 서버가 옛 버전이거나 폴더를 못 읽어도 화면은 지금까지처럼 동작한다
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
