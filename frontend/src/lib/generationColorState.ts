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
//  서버 사본으로 목록의 카드를 갈아 끼우는 길은 모두 이 도장을 탄다 — 목록 재조회·추가 로드(lib/useGenerationLibraryData),
//  다빈치 선택의 위치 조회(lib/useResolveLibraryFollow → revealLocated), 생성 완료 뒤 상세 조회(lib/useGenerationProgress).
export interface ColorEditLedger {
  /** 색을 칠했다(저장 예약) — 칠한 색을 적어 둔다. */
  begin(ids: string[], color: string | null): void;
  /** 그 저장이 끝났다 — 성공이든 실패든. 실패의 복구 재조회보다 먼저 불려야 서버 값으로 돌아간다. */
  end(ids: string[]): void;
  /** 조회가 출발할 때 찍는다 → 그 응답에 '지켜야 하는 카드'의 칠한 색을 덧입히는 함수. 바꿀 것이 없으면 응답 그대로 돌려준다.
   *  돌려받은 함수는 응답을 **화면에 반영할 때만** 부른다 — 지킬 것이 없어 받아들인 서버 값을 장부가 기억한다. */
  stamp(): (incoming: Generation[]) => Generation[];
}

export function createColorEditLedger(): ColorEditLedger {
  let revision = 0;
  const edited = new Map<string, number>(); // 카드 → 마지막 편집 번호. 지우지 않는다(지우면 '출발 뒤 편집' 판정에 구멍) — 세션에 칠한 카드 수만큼만 자란다
  const pending = new Map<string, number>(); // 카드 → 저장 대기 수
  // 카드 → 마지막으로 칠한 색. 덧입힐 값은 여기서 꺼낸다 — 화면 목록을 믿으면 안 된다(폴더 창을 닫을 때 먼저 그리는 본 목록 사본은
  //  창을 열기 전의 색이라, 그것을 '내 편집'으로 보고 서버 값을 덮는다 — Codex 코드 리뷰).
  //  칠한 뒤에 서버 값을 받아들이면 그 값으로 따라간다(아래 stamp).
  const painted = new Map<string, string | null>();
  return {
    begin(ids, color) {
      for (const id of ids) {
        painted.set(id, color);
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
      const keep = (id: string) => pendingAtStart.has(id) || pending.has(id) || (edited.get(id) ?? 0) > startedAt;
      return (incoming) => {
        let changed = false;
        const merged = incoming.map((generation) => {
          if (!keep(generation.id)) {
            // 지킬 것이 없다 = 내 편집이 모두 끝난 뒤에 출발한 조회다 → 그 서버 값이 이 카드의 지금 색이다. 장부도 그것으로 맞춘다.
            //  더 먼저 출발한 조회의 응답이 이 뒤에 도착할 수 있다(위치 조회·완료 뒤 상세 조회 — 목록 재조회와 달리 뒤의 조회가 앞의 것을
            //  버려 주지 않는다). 그 응답에 덧입힐 색이 옛 칠한 색이면, 저장에 실패해 되돌린 색·그사이 다른 곳에서 바뀐 색을 되살린다.
            if (painted.has(generation.id)) painted.set(generation.id, generation.color ?? null);
            return generation;
          }
          const mine = painted.get(generation.id) ?? null;
          if ((generation.color ?? null) === mine) return generation;
          changed = true;
          return { ...generation, color: mine };
        });
        return changed ? merged : incoming;
      };
    },
  };
}
