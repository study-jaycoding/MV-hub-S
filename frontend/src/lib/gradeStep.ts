// 등급 기반 다중선택 S — 순수 상태머신.
// 사다리: 일반(0: !shared,!final) < 공유(1: shared,!final) < 최종(2: is_final).
// S 단일 = 공유 단계 토글, S 더블 = 최종 단계 토글. 한 칸씩만 이동(2단계 건너뛰기 없음).
// 방향은 "이번 모드에서 실제로 한 칸 움직일 수 있는(권한 통과) 카드" 기준으로 정한다.
import type { Generation } from "../types";

export type GradeAction = "publish" | "unpublish" | "finalize" | "unfinalize";
export type GradeMode = "single" | "double";

export interface GradeOp {
  gen: Generation;
  action: GradeAction;
}

export interface GradeStepResult {
  mode: GradeMode;
  direction: "up" | "down" | "none";
  ops: GradeOp[];
  total: number; // 선택 개수
  applied: number; // 실제 적용(ops) 개수
  kept: number; // 유지·권한없음(=total-applied)
}

function level(g: Generation): 0 | 1 | 2 {
  return g.is_final ? 2 : g.shared ? 1 : 0;
}

// 선택된 카드들에 mode(단일/더블)를 적용했을 때의 연산 목록을 계산(부수효과 없음).
export function computeGradeStep(
  selected: Generation[],
  mode: GradeMode,
  canFinalize: (g: Generation) => boolean,
): GradeStepResult {
  const total = selected.length;
  let ops: GradeOp[] = [];
  let direction: "up" | "down" | "none" = "none";

  if (mode === "single") {
    // 공유 단계: 올림=내 완료·일반→공유, 내림=내 공유→일반. 최종은 항상 유지(단일클릭 잠금).
    const up = selected
      .filter((g) => g.is_mine && level(g) === 0 && g.status === "done")
      .map((g) => ({ gen: g, action: "publish" as const }));
    if (up.length) {
      direction = "up";
      ops = up;
    } else if (selected.every((g) => level(g) >= 1)) {
      // 내림은 선택에 일반이 하나도 없을 때만(전부 공유↑) — 밑에 올릴 게 남았으면 안 내린다.
      const down = selected
        .filter((g) => g.is_mine && level(g) === 1)
        .map((g) => ({ gen: g, action: "unpublish" as const }));
      if (down.length) {
        direction = "down";
        ops = down;
      }
    }
  } else {
    // 최종 단계: 올림=일반→공유(한 칸, 내 완료 것)·공유→최종(권한). 전부 최종일 때만 내림=최종→공유.
    const up: GradeOp[] = [];
    for (const g of selected) {
      const lv = level(g);
      if (lv === 0 && g.is_mine && g.status === "done") up.push({ gen: g, action: "publish" }); // 일반은 공유까지만
      else if (lv === 1 && canFinalize(g)) up.push({ gen: g, action: "finalize" });
    }
    if (up.length) {
      direction = "up";
      ops = up;
    } else if (selected.every((g) => level(g) === 2)) {
      // 내림(최종 해제)은 선택이 '전부 최종'일 때만 — 최종 아닌 카드가 하나라도 있으면 최종 유지.
      const down = selected
        .filter((g) => canFinalize(g))
        .map((g) => ({ gen: g, action: "unfinalize" as const }));
      if (down.length) {
        direction = "down";
        ops = down;
      }
    }
  }

  return { mode, direction, ops, total, applied: ops.length, kept: total - ops.length };
}

// 확인 모달 문구 — 상황별로 무엇이 일어나는지 사람이 읽게.
export function describeGradeStep(r: GradeStepResult): { title: string; body: string } {
  const keptNote = r.kept > 0 ? ` (${r.kept}개는 유지·권한없음)` : "";
  if (r.applied === 0) {
    return { title: "적용할 항목 없음", body: "선택한 카드에 지금 바꿀 수 있는 항목이 없습니다." };
  }
  if (r.mode === "single") {
    return r.direction === "up"
      ? { title: "팀에 공유", body: `선택한 ${r.applied}개를 팀에 공유할까요?${keptNote}` }
      : { title: "공유 해제", body: `선택한 ${r.applied}개의 공유를 해제할까요? (→일반)${keptNote}` };
  }
  return r.direction === "up"
    ? {
        title: "한 단계 올리기",
        body: `선택한 ${r.applied}개를 한 단계 올릴까요? (일반→공유, 공유→최종) — 일반은 공유까지만 올라갑니다.${keptNote}`,
      }
    : { title: "최종 해제", body: `선택한 ${r.applied}개의 최종을 해제할까요? (→공유)${keptNote}` };
}
