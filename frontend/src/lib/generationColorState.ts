import type { Generation } from "../types";

export class ColorSaveError<T = unknown> extends Error {
  constructor(readonly failed: number, readonly detail?: T) {
    super("generation color save failed");
  }
}

// 계정/씬 수명이 바뀐 작업은 네트워크 실패와 구분해 조용히 폐기한다.
export class ColorScopeChangedError extends Error {
  constructor() { super("generation color scope changed"); }
}

export function nextGenerationSelectionColor(
  generations: Generation[],
  ids: string[],
  color: string,
): string | null {
  const selectedIds = new Set(ids);
  const selected = generations.filter((generation) => selectedIds.has(generation.id));
  return selected.length > 0 && selected.every((generation) => generation.color === color)
    ? null
    : color;
}

export function applyGenerationColor(
  generations: Generation[],
  ids: string[],
  color: string | null,
): Generation[] {
  const selectedIds = new Set(ids);
  return generations.map((generation) =>
    selectedIds.has(generation.id) ? { ...generation, color } : generation,
  );
}

// ── 색 편집 장부 ──
//  목록 재조회의 응답은 '출발할 때의 서버 값'이다. 그사이 칠한 색을 그 응답이 덮으면 화면이 직전 색으로 돌아가고, 다음 색 키는 그 낡은
//  값을 기준으로 토글을 계산해 **틀린 색을 저장**한다. 2026-10-10 실측: 색 키를 0.4초 간격으로 이으면 80번 중 11번 직전 색으로 돌아갔다
//  (색 저장의 통보가 약 0.8초 뒤 자기 창의 목록 재조회를 부르고, 그것이 두 번 뒤 키와 겹친다). g×9 직후 r g b r g 의 끝은 '색 없음'으로
//  **저장**됐다.
//  규칙(캔버스의 색 장부와 같다 — lib/useSceneGenData): 조회가 출발할 때 그 카드의 색 저장이 대기 중이었거나, 적용할 때 대기 중이거나,
//  출발 뒤에 색을 편집했으면 → 화면의 색을 지키고 나머지 필드는 응답대로 받는다. '대기 중인 것만'으로 줄이면 안 된다 — 덮는 응답은
//  저장이 끝난 **뒤에** 도착하는 것이 보통이다(출발이 저장보다 앞섰다).
export interface ColorEditLedger {
  /** 색을 칠했다(저장 예약). */
  begin(ids: string[]): void;
  /** 그 저장이 끝났다 — 성공이든 실패든. 실패의 복구 재조회보다 먼저 불려야 서버 값으로 돌아간다. */
  end(ids: string[]): void;
  /** 조회가 출발할 때 찍는다 → 그 응답을 적용할 때 '이 카드는 화면의 색을 지켜야 하나'. */
  stamp(): (id: string) => boolean;
}

export function createColorEditLedger(): ColorEditLedger {
  let revision = 0;
  const edited = new Map<string, number>(); // 카드 → 마지막 편집 번호. 지우지 않는다(지우면 '출발 뒤 편집' 판정에 구멍) — 세션에 칠한 카드 수만큼만 자란다
  const pending = new Map<string, number>(); // 카드 → 저장 대기 수
  return {
    begin(ids) {
      for (const id of ids) {
        edited.set(id, ++revision);
        pending.set(id, (pending.get(id) ?? 0) + 1);
      }
    },
    end(ids) {
      for (const id of ids) {
        const left = (pending.get(id) ?? 0) - 1;
        if (left > 0) pending.set(id, left);
        else pending.delete(id);
      }
    },
    stamp() {
      const startedAt = revision;
      const pendingAtStart = new Set(pending.keys());
      return (id) => pendingAtStart.has(id) || pending.has(id) || (edited.get(id) ?? 0) > startedAt;
    },
  };
}

/** 응답(incoming)에 화면(local)의 색을 덧입힌다 — keep 이 참인 카드만. 바꿀 것이 없으면 incoming 그대로 돌려준다. */
export function keepLocalColors(local: Generation[], incoming: Generation[], keep: (id: string) => boolean): Generation[] {
  const shown = new Map(local.map((generation) => [generation.id, generation] as const));
  let changed = false;
  const merged = incoming.map((generation) => {
    const mine = shown.get(generation.id);
    if (!mine || !keep(generation.id) || (mine.color ?? null) === (generation.color ?? null)) return generation;
    changed = true;
    return { ...generation, color: mine.color ?? null };
  });
  return changed ? merged : incoming;
}
