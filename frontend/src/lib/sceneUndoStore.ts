// 씬 undo/redo 히스토리를 씬 id별로 보관하는 모듈 store — SceneBoard 언마운트(탭 전환)·씬 전환에도 그 씬의
//  Ctrl+Z 가 유지되게 한다. 왜: undo/redo/lastCommit 은 SceneBoard 의 useRef 라 언마운트 시 소멸하고, 씬 전환
//  시엔 의도적으로 리셋됐다 → 탭을 오가면 되돌리기가 사라졌다(사용자 보고). genData 캐시(sceneGenDataStore)와
//  같은 '언마운트 생존' 패턴. LRU 상한 + 씬 삭제 정리로 메모리 무한 증가를 막는다.
import type { SceneCard, SceneEdge, SceneGroup } from "./scenes";

// 한 undo 엔트리에서 '앞으로' 진행하는 전이가 명시적으로 제거한 카드 소속(comfy 워크플로 교체 등).
// undo(역방향)는 이걸 부활시키고, redo(정방향)는 다시 제거한다 — "스냅샷에 있으니 부활" 추론은
// 관련 없는 undo 가 다른 브라우저의 제거까지 되살리는 오탐이라 전이 메타데이터로만 판정한다(검증 P1).
export interface SceneCardRemoval {
  cardId: string;
  genIds: string[];
}
export interface SceneSnap {
  cards: SceneCard[];
  edges: SceneEdge[];
  groups: SceneGroup[];
  // 스택 엔트리에만 실린다 — lastCommit·복원 결과는 항상 이 필드가 없는 순수 상태
  // (sameSnap 전체 지문 비교가 현재 씬 props 와 일치해야 하므로).
  removedForward?: SceneCardRemoval[];
}
export interface SceneHistory {
  undo: SceneSnap[];
  redo: SceneSnap[];
  lastCommit: SceneSnap;
}

const MAX_SCENES = 24; // 히스토리를 유지할 최대 씬 수(LRU) — 오래 안 연 씬은 밀어낸다
const store = new Map<string, SceneHistory>();
// 방금 삭제된 씬 id — 활성 씬 삭제 시 clearSceneHistory 직후 SceneBoard 언마운트 cleanup 이 뒤늦게
//  persistSceneHistory 로 그 씬을 다시 넣는 것을 1회 무시(묘비)한다.
const tombstones = new Set<string>();

export function saveSceneHistory(sceneId: string, h: SceneHistory): void {
  if (!sceneId) return;
  if (tombstones.has(sceneId)) {
    tombstones.delete(sceneId); // 삭제 직후 뒤늦은 저장 1회만 흡수(이후 같은 id 재사용 시엔 정상 저장)
    return;
  }
  store.delete(sceneId); // 재삽입으로 최근성(LRU) 갱신
  store.set(sceneId, h);
  while (store.size > MAX_SCENES) {
    const k = store.keys().next().value; // 가장 오래 안 쓰인 씬
    if (k === undefined) break;
    store.delete(k);
  }
}

export function loadSceneHistory(sceneId: string): SceneHistory | undefined {
  return store.get(sceneId);
}

export function clearSceneHistory(sceneId: string): void {
  store.delete(sceneId);
  tombstones.add(sceneId); // 뒤따르는 언마운트 저장을 1회 무시하게
}

// 씬 스냅샷의 지문 — 복원한 히스토리(lastCommit)가 현재 씬 props 와 이어지는지 판정용. 전체 스냅샷을 비교한다.
//  왜 전체인가: 정상(탭 왕복)이면 lastCommit 과 현재 씬은 항상 '같은 최신값'(persist→onChange 로 동기)이라 전체
//  비교여도 일치한다(오탐으로 히스토리를 버릴 일 없음). 반면 외부/다른 탭 편집으로 어긋나면 어떤 필드가 달라도
//  감지해 낡은 undo 스택을 폐기한다 — 지문을 좁게 잡으면 refs/comfyCfg 등 undo 로 복원되는 필드가 stale 로 튄다.
export function snapFingerprint(s: SceneSnap): string {
  return JSON.stringify(s);
}
export function sameSnap(a: SceneSnap, b: SceneSnap): boolean {
  return snapFingerprint(a) === snapFingerprint(b);
}
