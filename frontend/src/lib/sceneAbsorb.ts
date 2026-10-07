// 옛 저장소(localStorage)에 남은 변경을 새 저장소(IndexedDB)로 흡수할 때의 판정.
//
// 왜 필요한가: 씬을 IDB 로 옮긴 뒤에도 **옛 판으로 떠 있는 창**은 계속 localStorage 에 쓴다.
// 앱 업데이트가 그 창을 닫아 주지 않기 때문이다(브라우저 창은 일부러 업데이트 대상 밖에서 돈다 —
// run_agent_session.py `_spawn_app_window`). 그래서 "모든 창이 새 경로로 넘어온다"를 보장하는 대신
// **"옛 저장소에 최종적으로 남은 상태는 반드시 가져온다"**를 보장한다(Codex 합의 2026-10-07).
// 흡수 시점은 둘 — ①storage 이벤트(두 창이 같이 떠 있을 때) ②앱을 켤 때 재대조(이벤트를 놓쳐도 복구).
//
// 판정은 세 가지를 견준다. 시각(updated_at)은 쓰지 않는다 — 창마다 시계가 다르고, 늦게 쓴 쪽이
// 반드시 옳은 것도 아니다.
//   B = 지난번에 처리한 옛 저장소 내용   N = 지금 새 저장소 내용   L = 지금 옛 저장소 내용
//   · L = B  → 옛 쪽에 변화 없음. 그대로 둔다.
//   · N = B  → 옛 쪽만 바뀌었다. 그 변경을 적용한다(삭제도 변경이다).
//   · N = L  → 이미 같다.
//   · 그 밖  → 양쪽이 각자 바뀌었다. **자동으로 덮지 않고** 충돌로 보존해 사람이 고르게 한다.
//
// IDB·DOM 에 의존하지 않는 순수 계산이다(sceneDragSession 과 같은 방식) — 시험 대상.
import type { Scene, ScenesByProject } from "./scenes";

/** 자동으로 정할 수 없어 사람이 골라야 하는 한 건. mine=새 저장소, theirs=옛 저장소. null=없음(삭제). */
export interface SceneAbsorbConflict {
  bucket: string;
  sceneId: string;
  mine: Scene | null;
  theirs: Scene | null;
}

export interface SceneAbsorbPlan {
  /** 새 저장소에 확정할 내용. changed 가 false 면 current 와 같은 내용이다. */
  next: ScenesByProject;
  /** 옛 저장소에서 가져온 씬 수(새로 생긴 것 포함). */
  adopted: number;
  /** 옛 저장소에서 사라져 따라 지운 씬 수. */
  removed: number;
  conflicts: SceneAbsorbConflict[];
  changed: boolean;
}

// 한 씬의 '내용'을 글자로. 키 순서가 달라도 같은 내용이면 같은 글자가 되게 **모든 깊이에서** 키를
// 정렬한다. 직렬화 순서 차이를 변경으로 오판하면 멀쩡한 씬이 매번 충돌로 잡힌다.
// ★JSON.stringify 의 replacer 배열(허용 키 목록)로는 안 된다 — 그 목록이 중첩 객체에도 적용돼
//  cards[].text 같은 알맹이가 비교에서 통째로 빠진다. 그러면 옛 창의 카드 본문 변경을 '변화 없음'으로
//  읽어 흡수하지 않고, 서로 다른 본문 수정이 충돌로도 안 잡힌다(Codex 코드 리뷰에서 재현).
function stableText(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableText).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableText(v)}`).join(",")}}`;
}

function sceneText(scene: Scene): string {
  return stableText(scene);
}

type SceneIndex = Map<string, Map<string, { scene: Scene; text: string }>>;

function indexOf(all: ScenesByProject | null | undefined): SceneIndex {
  const index: SceneIndex = new Map();
  const source: ScenesByProject = all || {};
  for (const [bucket, scenes] of Object.entries(source)) {
    const inner = new Map<string, { scene: Scene; text: string }>();
    for (const scene of scenes || []) {
      if (scene && typeof scene.id === "string") inner.set(scene.id, { scene, text: sceneText(scene) });
    }
    index.set(bucket, inner);
  }
  return index;
}

const textAt = (index: SceneIndex, bucket: string, id: string): string | null =>
  index.get(bucket)?.get(id)?.text ?? null;
const sceneAt = (index: SceneIndex, bucket: string, id: string): Scene | null =>
  index.get(bucket)?.get(id)?.scene ?? null;

/**
 * 옛 저장소의 변경을 새 저장소에 어떻게 반영할지 계산한다.
 *
 * @param base     지난번에 처리한 옛 저장소 내용(B). 처음이면 null — 그때는 **흡수하지 않는다**.
 *                 기준이 없으면 "옛 쪽이 바뀐 것"과 "원래 그랬던 것"을 구분할 수 없어서, 이관 직후
 *                 멀쩡한 새 내용을 옛 내용으로 되돌릴 수 있다.
 * @param current  지금 새 저장소 내용(N)
 * @param incoming 지금 옛 저장소 내용(L)
 */
export function planAbsorption(
  base: ScenesByProject | null,
  current: ScenesByProject,
  incoming: ScenesByProject,
): SceneAbsorbPlan {
  const unchanged: SceneAbsorbPlan = {
    next: current,
    adopted: 0,
    removed: 0,
    conflicts: [],
    changed: false,
  };
  if (!base) return unchanged;

  const b = indexOf(base);
  const n = indexOf(current);
  const l = indexOf(incoming);
  // 세 쪽 어디에든 있는 버킷·씬을 모두 본다 — 한쪽에만 있는 것이 '새로 생김' 또는 '지워짐'이다.
  const buckets = new Set([...b.keys(), ...n.keys(), ...l.keys()]);

  const next: ScenesByProject = {};
  const conflicts: SceneAbsorbConflict[] = [];
  let adopted = 0;
  let removed = 0;

  for (const bucket of buckets) {
    const ids = new Set([
      ...(b.get(bucket)?.keys() || []),
      ...(n.get(bucket)?.keys() || []),
      ...(l.get(bucket)?.keys() || []),
    ]);
    // 새 저장소의 순서를 기준으로 삼고, 옛 저장소에만 있던 씬은 뒤에 붙인다(탭 순서 보존).
    const order = [...(n.get(bucket)?.keys() || [])];
    for (const id of l.get(bucket)?.keys() || []) if (!order.includes(id)) order.push(id);

    const kept = new Map<string, Scene>();
    for (const id of ids) {
      const bt = textAt(b, bucket, id);
      const nt = textAt(n, bucket, id);
      const lt = textAt(l, bucket, id);
      if (lt === bt) {
        // 옛 쪽에 변화 없음 — 새 저장소를 그대로 둔다.
        const mine = sceneAt(n, bucket, id);
        if (mine) kept.set(id, mine);
        continue;
      }
      if (nt === bt) {
        // 옛 쪽만 바뀌었다 — 그 변경을 적용한다. lt 가 없으면 '옛 쪽에서 지웠다'는 뜻이다.
        const theirs = sceneAt(l, bucket, id);
        if (theirs) {
          kept.set(id, theirs);
          adopted += 1;
        } else {
          removed += 1;
        }
        continue;
      }
      if (nt === lt) {
        const mine = sceneAt(n, bucket, id);
        if (mine) kept.set(id, mine);
        continue;
      }
      // 양쪽이 각자 바뀌었다 — 자동으로 못 정한다. 새 저장소 것을 유지하고 충돌로 남긴다.
      const mine = sceneAt(n, bucket, id);
      if (mine) kept.set(id, mine);
      conflicts.push({ bucket, sceneId: id, mine, theirs: sceneAt(l, bucket, id) });
    }

    // 버킷 자체가 어느 쪽에도 안 남았으면 키를 만들지 않는다 — '빈 배열 버킷'과 '버킷 없음'은
    // DB 자동복구 판정(hasSceneBucket)에서 뜻이 다르다.
    const list = order.filter((id) => kept.has(id)).map((id) => kept.get(id)!);
    const bucketExisted = n.has(bucket) || l.has(bucket);
    if (list.length || bucketExisted) next[bucket] = list;
  }

  const changed = adopted > 0 || removed > 0 || JSON.stringify(next) !== JSON.stringify(current);
  return changed ? { next, adopted, removed, conflicts, changed: true } : { ...unchanged, conflicts };
}
