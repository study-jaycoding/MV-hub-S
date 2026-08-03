// 씬 생성물 캐시 — genId → 실제 생성물(Generation)을 SceneBoard 언마운트(내작업↔구성 탭 전환)에도 유지하는
//  모듈 store. 왜 필요한가: SceneBoard 는 탭 전환 시 언마운트되고, useSceneGenData 의 genData 는 컴포넌트
//  state 라 그때 사라진다. 복귀 시 빈 화면 → 서버 전량 재조회 → 결과가 다시 뜨는 '로딩 깜빡임'이 났다(사용자 보고).
//  genId 는 전역 유니크라 씬별로 나눌 필요 없이 하나의 캐시로 충분하다 — 재마운트/씬 전환 시 여기서 즉시 복원한다.
//  (sceneComfyRunningStore·sceneRecentDoneStore 와 같은 '언마운트 생존' 패턴.) 상한(FIFO)으로 무한 증가 방지.
import type { Generation } from "../types";

const CAP = 3000; // 캐시 상한 — 넘으면 가장 오래 안 쓰인 것부터 제거(장기 세션 메모리 누적 방지)
const genCache = new Map<string, Generation>(); // genId → 생성물
const parentsCache = new Map<string, string[]>(); // genId → 레퍼런스 부모(materials) id들
const missingCache = new Set<string>(); // 외부 삭제(404/410)로 사라진 것으로 확인된 id

function capMap<T>(m: Map<string, T>): void {
  while (m.size > CAP) {
    const k = m.keys().next().value; // 삽입 최고참(가장 오래된) 키
    if (k === undefined) break;
    m.delete(k);
  }
}
function capSet(s: Set<string>): void {
  while (s.size > CAP) {
    const k = s.values().next().value;
    if (k === undefined) break;
    s.delete(k);
  }
}

// 조회 성공한 생성물을 캐시에 저장(재삽입으로 최근성 갱신 후 상한 적용).
export function putGen(g: Generation): void {
  genCache.delete(g.id);
  genCache.set(g.id, g);
  capMap(genCache);
}
export function putParents(id: string, parents: string[]): void {
  parentsCache.delete(id);
  parentsCache.set(id, parents);
  capMap(parentsCache);
}
export function markGenMissing(id: string, missing: boolean): void {
  if (missing) {
    missingCache.add(id);
    capSet(missingCache);
    genCache.delete(id); // 삭제(404/410) 확정 → gen 캐시서도 제거해 stale 결과가 복원돼 '삭제됨'을 가리지 않게
  } else missingCache.delete(id); // 되살아남(복원) → 다시 표시 허용
}

// 주어진 id 들 중 캐시에 있는 것만 Record/Set 로 — 마운트 초기값·씬 전환 즉시 복원용.
export function hydrateGen(ids: string[]): Record<string, Generation> {
  const out: Record<string, Generation> = {};
  for (const id of ids) {
    if (missingCache.has(id)) continue; // 삭제 확정된 id 는 복원하지 않음(이중 안전)
    const g = genCache.get(id);
    if (g) out[id] = g;
  }
  return out;
}
export function hydrateParents(ids: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const id of ids) {
    const p = parentsCache.get(id);
    if (p) out[id] = p;
  }
  return out;
}
export function hydrateMissing(ids: string[]): Set<string> {
  const out = new Set<string>();
  for (const id of ids) if (missingCache.has(id)) out.add(id);
  return out;
}
