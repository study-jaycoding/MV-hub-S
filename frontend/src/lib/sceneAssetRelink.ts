// 씬의 에셋 참조 중 **이 PC 에서 열리지 않는 것**을 서버가 찾아 준 자리로 이어 준다(Jay 2026-09-28).
//
// 왜: "어느 방식으로 가져와도 서버에 그 파일이 있다면 모두에게 똑같이 보이게". 안 열리는 이유가 둘이다.
//  · 예전에 끌어다 놓은 그림이 설치 폴더 안(imports·captures)으로 복사됐다 — 그 PC 에만 있는 사본
//  · 프로젝트 이름은 붙었지만 이 PC 가 그 프로젝트를 못 본다 — 같은 폴더를 사람마다 다른 이름·다른
//    깊이로 등록해 생긴다(`뻘뻘뻘`=…/10_ai, `뻘뻘뻘_RnD`=…/10_ai/assets)
// 그래서 **모든 에셋 참조**를 서버에 보내고, 서버가 지문·경로·이름 순으로 찾아 정확히 한 곳에서만
// 찾혔을 때 답을 준다(assets.locate). 여기서는 받은 것만 반영한다 — 묻지 않는다.
import { api } from "../api";
import { listScenes, saveScenes, type Scene } from "./scenes";

// 에셋 참조 토큰 전부. 이미 잘 열리는 것은 서버가 그대로 두므로 여기서 거르지 않는다 —
// 어느 것이 안 열리는지는 폴더를 볼 수 있는 서버만 안다.
const ASSET_TOKEN = /^asset:[^|]+\|/;

/** 이 씬의 그림을 **어느 공간 폴더부터** 찾을지 — 탭에 사람이 고른 공간, 없으면 씬 파일로 받은 힌트.
 *  묻기·답 반영·서버에 없음 표시가 모두 이 하나로 열쇠를 만든다(어긋나면 표시가 엉뚱한 참조에 붙는다). */
export function sceneRefWorkspaceId(scene: Pick<Scene, "workspace" | "refWorkspaceHint">): string {
  return scene.workspace?.id || scene.refWorkspaceHint?.id || "";
}

/** 물어볼 참조를 **캔버스 탭의 공간별로** 묶는다 — 서버가 그 공간의 프로젝트부터 찾게(Jay 2026-09-28). */
export function sceneAssetGroups(scenes: Scene[]): { workspaceId: string; tokens: string[] }[] {
  const byWorkspace = new Map<string, Set<string>>();
  for (const scene of scenes) {
    const ws = sceneRefWorkspaceId(scene);
    for (const card of scene.cards) {
      for (const ref of card.refs || []) {
        if (!ref.file_path || !ASSET_TOKEN.test(ref.file_path)) continue;
        let bucket = byWorkspace.get(ws);
        if (!bucket) byWorkspace.set(ws, (bucket = new Set()));
        bucket.add(ref.file_path);
      }
    }
  }
  return [...byWorkspace].map(([workspaceId, tokens]) => ({ workspaceId, tokens: [...tokens] }));
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
}

/** 결과의 열쇠 — **공간 + 참조**. 같은 옛 참조라도 캔버스의 공간이 다르면 다른 파일로 찾힐 수 있다.
 *  참조만 열쇠로 쓰면 나중에 처리된 공간의 답이 다른 공간의 씬까지 덮는다(Codex 2026-09-28). */
export const relinkKey = (workspaceId: string, token: string): string => `${workspaceId}\u0000${token}`;

/** 찾은 것만 갈아끼운 새 씬 목록과 바뀐 참조 수. 각 씬은 **자기 공간의 답만** 받는다.
 *  썸네일은 새 주소로 다시 만들게 비운다. */
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
      const ws = sceneRefWorkspaceId(scene);
      const refs = card.refs.map((ref) => {
        const hit = ref.file_path ? found.get(relinkKey(ws, ref.file_path)) : undefined;
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

// 서버가 판정한 '서버에 없는' 참조(Jay 2026-09-29) — 캔버스가 빨간 테두리로 그린다.
//  · missing = 이 PC 에서도 안 열리고 서버 어디에도 없다(받은 사람)
//  · local = 이 PC 설치 폴더 안 사본에만 있다(가진 사람)
// 씬 파일에는 담지 않는다 — 폴더를 보는 건 서버뿐이라 복구할 때마다 다시 받는다. 열쇠는 found 와 같은
// (공간, 토큰): 같은 옛 참조라도 공간마다 고쳐짐 여부가 갈릴 수 있다.
export type RefServerStatus = "missing" | "local";
const serverStatus = new Map<string, RefServerStatus>();
const statusListeners = new Set<() => void>();
let statusVersion = 0;

export function refServerStatus(workspaceId: string, token: string): RefServerStatus | undefined {
  return serverStatus.get(relinkKey(workspaceId, token));
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

/** 배치 답 하나를 반영한다 — 보낸 토큰마다 새 판정으로 덮고, 판정이 없으면(고쳐짐·열림·모름) 지운다. */
function noteServerStatus(workspaceId: string, sent: string[], missing: string[], local: string[]): void {
  const miss = new Set(missing);
  const loc = new Set(local);
  let changed = false;
  for (const token of sent) {
    const key = relinkKey(workspaceId, token);
    const next = miss.has(token) ? "missing" : loc.has(token) ? "local" : undefined;
    if (serverStatus.get(key) === next) continue;
    if (next) serverStatus.set(key, next);
    else serverStatus.delete(key);
    changed = true;
  }
  if (!changed) return;
  statusVersion += 1;
  statusListeners.forEach((cb) => cb());
}

/** 방금 이 PC 설치 폴더에 저장한 참조(끌어다 놓기·붙여넣기, 2026-09-29 옛 방식) — 서버 답이 오기 전에
 *  먼저 '이 PC에만'으로 보인다. 곧 부르는 자동 복구의 답이 그대로 덮는다(서버에 같은 내용이 있으면
 *  원본으로 이어져 표시가 사라지고, 판정할 수 없으면 지워진다). */
export function markRefsLocal(workspaceId: string, tokens: string[]): void {
  // 같은 파일을 곧바로 다시 넣으면 같은 사본 토큰이 다시 생긴다 — '물어봤다' 기록을 지워 자동 복구가
  //  다시 묻게 한다(안 지우면 2분 동안 원본으로 못 잇고 '이 PC에만'으로 남는다, Codex 2026-09-29).
  tokens.forEach((token) => asked.delete(relinkKey(workspaceId, token)));
  noteServerStatus(workspaceId, tokens, [], tokens);
}

// 이미 물어본 토큰 → 물어본 시각. 곧바로 다시 묻지 않되 **영원히 포기하지는 않는다** —
// NAS 가 잠깐 끊겼거나 폴더를 그 사이 등록했을 수 있다(Codex 2026-09-28). 실패한 호출은 담지 않는다.
const asked = new Map<string, number>();
const ASK_AGAIN_AFTER = 120_000; // 2분
const LOCATE_BATCH = 200; // 서버가 한 번에 받는 상한과 같게 — 넘치면 나눠 보낸다
let inFlight: Promise<number> | null = null;
// 도는 중에 또 불렸다 — 끝나면 한 번 더 돈다. 마지막 바퀴를 확인한 뒤에 들어온 참조(방금 끌어다 놓은
// 로컬 파일 등)를 다음 기회까지 놓치지 않게(Codex 2026-09-29).
let rerun = false;

function newScanId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * 옛 참조를 찾아 고친다. 앱 시작 때는 물론, **씬 파일을 나중에 열었을 때도** 다시 부른다
 * (남이 준 씬을 여는 것이 바로 이 기능이 필요한 자리다 — Codex 2026-09-28).
 * flushPending 은 호출부가 넘긴다 — 저장 직전에 캔버스의 디바운스 편집을 확정시켜 덮어쓰지 않게.
 */
export async function relinkSceneAssetRefs(flushPending?: () => void): Promise<number> {
  if (inFlight) {
    rerun = true; // 겹쳐 부르면 합친다 — 폴더 스캔은 겹치지 않고, 끝난 뒤 한 번 더 확인한다
    return inFlight;
  }
  const pending = (): { workspaceId: string; tokens: string[] }[] => {
    const now = Date.now();
    const fresh = (workspaceId: string) => (token: string) => {
      const at = asked.get(relinkKey(workspaceId, token));
      return at === undefined || now - at > ASK_AGAIN_AFTER;
    };
    return sceneAssetGroups(listScenes(null))
      .map((g) => ({ workspaceId: g.workspaceId, tokens: g.tokens.filter(fresh(g.workspaceId)) }))
      .filter((g) => g.tokens.length > 0);
  };
  const run = async (): Promise<number> => {
    let changedTotal = 0;
    // 이번 복구 한 번의 id — 200개씩 여러 번 묻는 동안 서버가 같은 NAS 폴더를 매번 다시 훑지
    // 않게 한다. 다음 복구는 새 id 라 서버가 새로 훑는다(방금 추가된 파일을 놓치지 않게).
    const scanId = newScanId();
    // 씬을 새로 열면 토큰이 늘어난다 — 도는 동안 생긴 것까지 한 번 더 받아 준다(최대 5바퀴).
    for (let round = 0; round < 5; round += 1) {
      const groups = pending();
      if (!groups.length) break;
      const found = new Map<string, RelinkTarget>();
      for (const group of groups) {
        for (let at = 0; at < group.tokens.length; at += LOCATE_BATCH) {
          const batch = group.tokens.slice(at, at + LOCATE_BATCH); // 상한을 넘기면 뒤가 조용히 잘린다
          const ws = group.workspaceId;
          const reply = await api.locateAssets(batch, ws, scanId);
          // 실제로 보낸 것만 '물어봤다' — 공간별로 따로 센다(같은 참조라도 공간마다 답이 다르다).
          batch.forEach((token) => asked.set(relinkKey(ws, token), Date.now()));
          noteServerStatus(ws, batch, reply.missing, reply.local);
          reply.fixed.forEach((item) => {
            found.set(relinkKey(ws, item.token), item);
            // 서버가 방금 찾아준 자리다 — 새 토큰까지 '물어봤다'로 쳐서 같은 요청을 한 번 더
            // 보내지 않는다(요청마다 프로젝트 폴더를 새로 훑으므로 값싼 일이 아니다).
            asked.set(relinkKey(ws, `asset:${item.project}|${item.path}`), Date.now());
          });
        }
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
  inFlight = (async () => {
    try {
      let total = 0;
      do {
        rerun = false;
        total += await run();
      } while (rerun); // 확인과 비우기(finally) 사이에 틈이 없다 — 겹친 호출을 흘리지 않는다
      return total;
    } catch {
      return 0; // 서버가 옛 버전이거나 폴더를 못 읽어도 화면은 지금까지처럼 동작한다
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
