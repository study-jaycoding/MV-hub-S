// 한 줄로 서는 저장 — 목록 전체를 덮어쓰는 저장(역할 PATCH)을 한 번에 하나씩, 앞의 것이 끝난 뒤에 보낸다(조작 규칙 39).
//
// 화면의 값으로 만든 요청은 화면이 낡았으면 그사이 저장된 것을 지운다: 응답 전에 역할 칩을 하나 더 누르면 낡은 목록에 그것만 더한 값이
// 나가, 먼저 준 역할이 사라졌다. 단추를 잠그는 것만으로는 닫히지 않는다 — 잠금은 화면(창·탭·패널)과 같이 사라지고, 다시 뜬 화면이
// 새로 읽은 목록은 아직 반영 전의 것일 수 있다(Codex 코드 리뷰가 그 길을 세 번 짚었다). 그래서 구조로 막는다:
//   ① 줄을 세운다 — 줄은 모듈 값이라 화면이 사라졌다 다시 떠도 이어진다.
//   ② 차례가 왔을 때 서버의 지금 값을 읽어, 화면에서 **바꾼 것만** 거기에 얹는다(`rebaseRoles` — 호출부가 읽고 얹는다).
// 화면의 잠금(`busy`)은 그 위의 안내일 뿐이다 — 풀린 틈에 누른 것도 줄을 서고, 지금 값에서 계산된다.
import { getAuthToken } from "./http";
import { loadString } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";

/** 저장을 접수한 때의 계정을 잡아 둔다 — 돌려주는 함수는 '지금도 그 계정인가'. 줄을 서 있거나 지금 값을 읽는 사이에 다른 탭에서 계정이
 *  바뀌면(저장소 이벤트로 이 창의 토큰도 바뀐다) 뒤의 요청은 새 계정의 이름으로 나간다 — 보내기 직전마다 확인하고, 바뀌었으면 보내지 않는다. */
export function accountAtRequest(): () => boolean {
  const token = getAuthToken();
  const account = loadString(STORAGE_KEYS.activeAccount);
  return () => token === getAuthToken() && account === loadString(STORAGE_KEYS.activeAccount);
}

export interface SaveQueue {
  /** 앞의 저장이 끝난 뒤에 task 를 돌린다(앞의 것이 실패해도 돈다). task 의 결과·실패를 그대로 돌려준다. */
  run<T>(task: () => Promise<T>): Promise<T>;
  /** 줄에 서 있거나 도는 저장이 있는가 — 화면의 잠금 표시용. */
  busy(): boolean;
  subscribe(watcher: () => void): () => void;
}

export function createSaveQueue(): SaveQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let waiting = 0;
  const watchers = new Set<() => void>();
  const bump = (delta: number) => {
    waiting += delta;
    watchers.forEach((watcher) => watcher());
  };
  return {
    run(task) {
      bump(1);
      const result = tail.then(task);
      tail = result.catch(() => {}); // 줄은 실패를 삼킨다 — 앞의 것이 실패해도 다음 것이 돈다(실패는 result 로 부른 쪽에 간다)
      return result.finally(() => bump(-1));
    },
    busy: () => waiting > 0,
    subscribe(watcher) {
      watchers.add(watcher);
      return () => {
        watchers.delete(watcher);
      };
    },
  };
}

/** 화면에서 바꾼 것(shown → wanted)만 서버의 지금 값(base)에 얹는다 — 뺀 것은 빼고 더한 것은 더한다. 그 밖의 역할은 base 그대로다. */
export function rebaseRoles(base: readonly string[], shown: readonly string[], wanted: readonly string[]): string[] {
  const removed = shown.filter((role) => !wanted.includes(role));
  const added = wanted.filter((role) => !shown.includes(role) && !base.includes(role));
  return [...base.filter((role) => !removed.includes(role)), ...added];
}

export const sameRoles = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((role) => b.includes(role));

/** 프로젝트 멤버를 바꾸는 저장(역할·제거·추가)의 줄 — 관리자 창의 프로젝트 탭. */
export const projectMemberSaves = createSaveQueue();
/** 전역 역할 저장의 줄 — 관리자 창의 멤버 탭. */
export const globalRoleSaves = createSaveQueue();
