export interface LibraryMutationOrigin {
  client_id: string;
  mutation_id: string;
}

export type LibrarySyncDecision = "reload" | "wait" | "skip";

export interface LibraryReloadToken {
  id: number;
  mutationIds: ReadonlySet<string>;
}

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const COVERED_LIMIT = 2048;
const PENDING_LIMIT = 2048;

function randomPart(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

// 같은 탭에서 발생한 변경도 무조건 무시하면, 자체 reload를 하지 않는 기능이 stale 상태로 남는다.
// 따라서 서버가 되돌려준 '실제 변경 요청 id'와 그 id를 포함해 성공한 목록 reload를 함께 추적한다.
export class LibrarySyncState {
  readonly clientId: string;
  private readonly successfulPending = new Set<string>();
  private readonly covered = new Set<string>();
  private readonly inflight = new Map<number, ReadonlySet<string>>();
  private nextReloadId = 1;

  constructor(clientId = randomPart()) {
    this.clientId = clientId;
  }

  createMutationOrigin(method: string | undefined): LibraryMutationOrigin | null {
    if (!method || !MUTATION_METHODS.has(method.toUpperCase())) return null;
    return { client_id: this.clientId, mutation_id: randomPart() };
  }

  private addPending(mutationId: string): void {
    this.successfulPending.add(mutationId);
    while (this.successfulPending.size > PENDING_LIMIT) {
      const oldest = this.successfulPending.values().next().value as string | undefined;
      if (!oldest) break;
      this.successfulPending.delete(oldest); // 늦은 알림은 reload 판정으로 돌아가므로 안전하다.
    }
  }

  markMutationSucceeded(origin: LibraryMutationOrigin, echoedMutationId: string | null): void {
    // 응답 헤더가 없으면 서버 계약상 라이브러리 변경이 아니거나 구버전 서버다. 후자는 출처 없는
    // synced가 와서 안전하게 reload하므로 여기서 임의로 성공 처리하지 않는다.
    if (echoedMutationId !== origin.mutation_id) return;
    if (this.covered.has(origin.mutation_id)) return; // 알림이 HTTP 응답보다 먼저 와 이미 반영된 경합
    this.addPending(origin.mutation_id);
  }

  trackOwnSyncedForReload(origins: readonly LibraryMutationOrigin[] | null | undefined): void {
    // synced 자체가 서버 변경 성공의 증거다. 느린 프록시에서 HTTP 응답보다 알림이 먼저 도착했을 때
    // 곧 시작할 reload가 이 요청 id도 덮도록 먼저 pending에 넣는다. 다른 탭 id는 추적하지 않는다.
    for (const origin of origins || []) {
      if (origin.client_id !== this.clientId || !origin.mutation_id) continue;
      if (!this.covered.has(origin.mutation_id)) this.addPending(origin.mutation_id);
    }
  }

  beginReload(): LibraryReloadToken {
    const token: LibraryReloadToken = {
      id: this.nextReloadId++,
      mutationIds: new Set(this.successfulPending),
    };
    this.inflight.set(token.id, token.mutationIds);
    return token;
  }

  finishReload(token: LibraryReloadToken, applied: boolean): void {
    if (!this.inflight.delete(token.id) || !applied) return;
    for (const mutationId of token.mutationIds) {
      this.successfulPending.delete(mutationId);
      // Set 삽입 순서를 LRU처럼 써 긴 세션에서도 상한을 둔다.
      this.covered.delete(mutationId);
      this.covered.add(mutationId);
    }
    while (this.covered.size > COVERED_LIMIT) {
      const oldest = this.covered.values().next().value as string | undefined;
      if (!oldest) break;
      this.covered.delete(oldest);
    }
  }

  decide(origins: readonly LibraryMutationOrigin[] | null | undefined): LibrarySyncDecision {
    if (!origins?.length) return "reload"; // 출처 없는 syncer·구버전 서버·직접 fetch는 항상 반영
    const ownIds: string[] = [];
    for (const origin of origins) {
      if (!origin || origin.client_id !== this.clientId || !origin.mutation_id) return "reload";
      ownIds.push(origin.mutation_id);
    }
    const unresolved = ownIds.filter((id) => !this.covered.has(id));
    if (!unresolved.length) {
      // 요청 id는 한 알림에서만 소비한다. 같은 id를 악의적·실수로 재사용한 뒤의 변경까지 계속
      // 생략하지 않으며, 중복 알림은 안전한 reload 쪽으로 기운다.
      for (const id of ownIds) this.covered.delete(id);
      return "skip";
    }
    const isBeingCovered = (id: string) =>
      [...this.inflight.values()].some((mutationIds) => mutationIds.has(id));
    return unresolved.every(isBeingCovered) ? "wait" : "reload";
  }
}

const runtimeState = new LibrarySyncState();

export const LIBRARY_CLIENT_ID_HEADER = "X-MVHub-Client-Id";
export const LIBRARY_MUTATION_ID_HEADER = "X-MVHub-Mutation-Id";

export function createLibraryMutationOrigin(method: string | undefined): LibraryMutationOrigin | null {
  return runtimeState.createMutationOrigin(method);
}

export function markLibraryMutationSucceeded(
  origin: LibraryMutationOrigin,
  echoedMutationId: string | null,
): void {
  runtimeState.markMutationSucceeded(origin, echoedMutationId);
}

export function beginLibraryReload(): LibraryReloadToken {
  return runtimeState.beginReload();
}

export function finishLibraryReload(token: LibraryReloadToken, applied: boolean): void {
  runtimeState.finishReload(token, applied);
}

export function decideLibrarySync(
  origins: readonly LibraryMutationOrigin[] | null | undefined,
): LibrarySyncDecision {
  return runtimeState.decide(origins);
}

export function trackOwnSyncedForReload(
  origins: readonly LibraryMutationOrigin[] | null | undefined,
): void {
  runtimeState.trackOwnSyncedForReload(origins);
}
