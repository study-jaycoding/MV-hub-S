// 씬 undo/redo 히스토리를 씬 id별로 보관하는 모듈 store — SceneBoard 언마운트(탭 전환)·씬 전환에도 그 씬의
//  Ctrl+Z 가 유지되게 한다. 왜: undo/redo/lastCommit 은 SceneBoard 의 useRef 라 언마운트 시 소멸하고, 씬 전환
//  시엔 의도적으로 리셋됐다 → 탭을 오가면 되돌리기가 사라졌다(사용자 보고). genData 캐시(sceneGenDataStore)와
//  같은 '언마운트 생존' 패턴. LRU 상한 + 씬 삭제 정리로 메모리 무한 증가를 막는다.
import type { SceneCard, SceneEdge, SceneGroup } from "./scenes";
import { canvasHandoffId, registerCanvasMemory } from "./popupWindows";
import { getAccountNamespace } from "./accountScope";
import { normalizeForUndo } from "./comfyRunState";

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
  // removedForward 의 거울짝 — 그 전이가 명시적으로 **추가한** 소속(떨어진 생성물 붙이기).
  // undo(역방향)는 이걸 제거하고, redo(정방향)는 다시 부활시킨다. 이게 없으면 undo 가
  // 과거 스냅샷을 되돌려도 ②서버 소속 병합이 방금 붙인 것을 도로 살려 되돌리기가 안 먹는다.
  addedForward?: SceneCardRemoval[];
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
  historyListeners.forEach((listener) => listener({ type: "cleared", sceneId }));
}

// 기록이 바뀐 사건 — 새로 고쳐도 남기는 저장(sceneUndoPersistence)이 듣는다. 이 모듈이 그쪽을 import 하지 않게(순환) 알림으로 잇는다.
export type SceneHistoryEvent = { type: "cleared"; sceneId: string } | { type: "handedOff"; sceneId: string; history: SceneHistory };
const historyListeners = new Set<(event: SceneHistoryEvent) => void>();
export function onSceneHistoryEvent(listener: (event: SceneHistoryEvent) => void): () => void {
  historyListeners.add(listener);
  return () => {
    historyListeners.delete(listener);
  };
}

// 열린 보드(useSceneHistory 가 등록) — flush: 지금 기록을 store 에 남긴다(보드는 언마운트할 때만 남기므로 창을 닫으며 넘길 때·받은 기록과 견줄 때 먼저 부른다).
//  adopt: 받아들인 기록으로 스택을 바꾼다 — 바꿀 수 없는 때(씬을 바꾸는 틈·끄는 중)면 false.
export interface LiveSceneHistory {
  sceneId: () => string;
  flush: () => void;
  adopt: (history: SceneHistory) => boolean;
}
const liveBoards = new Set<LiveSceneHistory>();
export function registerLiveSceneHistory(board: LiveSceneHistory): () => void {
  liveBoards.add(board);
  return () => {
    liveBoards.delete(board);
  };
}

// 이 창 안의 편집 횟수(씬별) — 받은 기록을 들일지 볼 때만 쓴다: 읽기·인계를 시작한 뒤 이 창에서 편집했으면 받지 않는다(§9.5).
//  창끼리·탭끼리 우선순위를 이 번호 크기로 정하지 않는다.
const localRevisions = new Map<string, number>();
export function noteLocalSceneEdit(sceneId: string): void {
  localRevisions.set(sceneId, localSceneRevision(sceneId) + 1);
}
export function localSceneRevision(sceneId: string): number {
  return localRevisions.get(sceneId) ?? 0;
}

// 받은 기록을 들이는 규칙(설계 §9.5·§9.8) — 부팅 복원(bootstrap)과 창 인계(handoff)를 나눈다. 공통: 계정·씬이 같고 지문(snapFp)이 지금 씬과 같다.
//  · 부팅 복원: 읽기 시작 뒤 이 창 편집이 없고, 저장본과 맞는 인계 기록이 없을 때만(그런 인계가 우선 — 늦게 끝난 읽기가 덮지 않는다). 처음 만든 빈 기록은 '채택'이 아니다.
//  · 창 인계: 지금 진행 중인 인계(popupWindows 의 인계 번호)와 맞고, 받는 창이 인계 뒤 따로 편집하지 않았으면 있던 기록도 바꾼다.
//  지문은 열린 보드가 있으면 그 보드의 지금 기록과, 없으면 target.snapFp(저장본)와 견준다 — null 이면 보드가 열릴 때 useSceneHistory 가 견준다.
//  ★보드 없이 받은 인계는 확인 전이다(창을 닫는 순간엔 그 창의 마지막 저장이 아직 저장본에 안 닿았을 수 있어 그때 견주면 맞는 인계를 버린다) —
//   그래서 인계의 우선은 그 지문이 부팅 복원의 저장본 지문과 같을 때만 준다. 다르면 부팅 복원이 바꿀 수 있다(B 독립 리뷰 P2).
export interface HistoryTarget {
  account: string;
  sceneId: string;
  snapFp: string | null;
}
export interface HistoryCandidate {
  account: string;
  sceneId: string;
  snapFp: string;
  history: SceneHistory;
}
export type HistoryAdoptionGate =
  | { kind: "bootstrap"; readEpoch: number; expectedLocalRevision: number }
  | { kind: "handoff"; handoffId: string | null; expectedLocalRevision: number };
let adoptEpoch = 0;
const handoffAdopted = new Map<string, string>(); // 씬 → 인계로 받은 기록의 지문
const bootstrapEpochs = new Map<string, number>();
/** 부팅 읽기를 시작할 때 받아 둔다 — 그 뒤 더 새 읽기가 먼저 들인 기록을 늦은 읽기가 덮지 않게. */
export const historyReadEpoch = (): number => adoptEpoch;

export function adoptSceneHistory(
  target: HistoryTarget,
  candidate: HistoryCandidate,
  gate: HistoryAdoptionGate,
): "adopted" | "stale" | "mismatch" {
  const { sceneId } = target;
  if (!isHistory(candidate.history) || candidate.sceneId !== sceneId || candidate.account !== target.account
    || target.account !== getAccountNamespace()) return "mismatch";
  if (localSceneRevision(sceneId) !== gate.expectedLocalRevision) return "stale";
  const handedFp = handoffAdopted.get(sceneId);
  if (gate.kind === "handoff" ? gate.handoffId !== canvasHandoffId()
    : (handedFp !== undefined && (target.snapFp === null || handedFp === target.snapFp))
      || (bootstrapEpochs.get(sceneId) ?? -1) > gate.readEpoch) return "stale";
  const boards = [...liveBoards].filter((board) => board.sceneId() === sceneId);
  boards.forEach((board) => board.flush());
  const shown = boards.length ? store.get(sceneId)?.lastCommit : undefined;
  const fp = shown ? snapFingerprint(shown) : target.snapFp;
  if (fp !== null && fp !== candidate.snapFp) return "mismatch";
  if (!boards.every((board) => board.adopt(candidate.history))) return "stale";
  saveSceneHistory(sceneId, candidate.history);
  adoptEpoch += 1;
  if (gate.kind === "handoff") {
    handoffAdopted.set(sceneId, candidate.snapFp);
    historyListeners.forEach((listener) => listener({ type: "handedOff", sceneId, history: candidate.history }));
  } else {
    handoffAdopted.delete(sceneId); // 저장본과 맞는 부팅 복원이 확인 전 인계를 바꿨다
    bootstrapEpochs.set(sceneId, adoptEpoch);
  }
  return "adopted";
}

// 휠 클릭으로 띄운 캔버스 창과 메인 창이 되돌리기 기록을 주고받는다(lib/popupWindows — 켤 때 받고 닫을 때 돌려준다). 받는 쪽은 위 '창 인계' 규칙으로 들이고,
//  보드가 열릴 때 lastCommit 이 지금 씬과 같은지 한 번 더 본다(useSceneHistory) — 어긋나면 버린다.
const isSnap = (value: unknown): value is SceneSnap =>
  !!value && typeof value === "object" && Array.isArray((value as SceneSnap).cards) && Array.isArray((value as SceneSnap).edges);
const isHistory = (value: unknown): value is SceneHistory =>
  !!value && typeof value === "object" && Array.isArray((value as SceneHistory).undo) && Array.isArray((value as SceneHistory).redo)
  && isSnap((value as SceneHistory).lastCommit);
// 인계를 시작할 때 이 창의 편집 횟수 — 돌려받을 때 '그 뒤 이 창에서 편집했나'를 본다. 이 창을 새로 고쳤으면 비어 있고 횟수도 0 부터다.
let handoffBaseline = new Map<string, number>();
registerCanvasMemory("sceneHistories", {
  flush: () => liveBoards.forEach((board) => board.flush()),
  begin: () => {
    handoffBaseline = new Map(localRevisions);
  },
  save: () => ({ account: getAccountNamespace(), handoffId: canvasHandoffId(), entries: [...store.entries()] }),
  load: (value) => {
    // 옛 판 창이 보내는 배열은 받지 않는다 — 보낸 계정·인계 번호를 확인할 수 없다(받는 쪽 값을 붙이면 다른 계정의 기록도 통과했다, B 독립 리뷰 P1)
    const payload = Array.isArray(value) ? null : (value as { account?: unknown; handoffId?: unknown; entries?: unknown } | null);
    if (!payload || typeof payload.account !== "string" || !Array.isArray(payload.entries)) return;
    const handoffId = typeof payload.handoffId === "string" ? payload.handoffId : null;
    for (const entry of payload.entries) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || !isHistory(entry[1])) continue;
      const [sceneId, history] = entry as [string, SceneHistory];
      if (!history.undo.length && !history.redo.length) continue; // 빈 초기 기록은 인계가 아니다 — 받으면 뒤에 올 정상 복원을 막는다(B 리뷰 P2)
      adoptSceneHistory(
        { account: getAccountNamespace(), sceneId, snapFp: null },
        { account: payload.account, sceneId, snapFp: snapFingerprint(history.lastCommit), history },
        { kind: "handoff", handoffId, expectedLocalRevision: handoffBaseline.get(sceneId) ?? 0 },
      );
    }
  },
});

// 씬 스냅샷의 지문 — 복원한 히스토리(lastCommit)가 현재 씬 props 와 이어지는지 판정용. 전체 스냅샷을 비교한다.
//  왜 전체인가: 정상(탭 왕복)이면 lastCommit 과 현재 씬은 항상 '같은 최신값'(persist→onChange 로 동기)이라 전체
//  비교여도 일치한다(오탐으로 히스토리를 버릴 일 없음). 반면 외부/다른 탭 편집으로 어긋나면 어떤 필드가 달라도
//  감지해 낡은 undo 스택을 폐기한다 — 지문을 좁게 잡으면 refs/comfyCfg 등 undo 로 복원되는 필드가 stale 로 튄다.
//  단 Comfy 실행 표식(카드 status·runId·오류)은 되돌리기 밖이라 빼고 본다(normalizeForUndo — 설계 §9.1): 실행 상태만 바뀌었다고 기록을 버리지 않는다.
export function snapFingerprint(s: SceneSnap): string {
  return JSON.stringify(normalizeForUndo(s));
}
export function sameSnap(a: SceneSnap, b: SceneSnap): boolean {
  return snapFingerprint(a) === snapFingerprint(b);
}
