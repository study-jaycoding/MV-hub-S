import { useRef, useState } from "react";
import { api } from "../api";
import { postLibraryChanged } from "./libraryBroadcast";
import { computeGradeStep, type GradeMode, type GradeStepResult } from "./gradeStep";
import type { Generation } from "../types";
import { withMirrorPendingNotice } from "./shareMirrorPending";
import { t } from "./i18n";
import { armStateGlow } from "./stateGlow";

interface Args {
  canFinalize: (g: Generation) => boolean;
  reload: () => Promise<void>;
  flash: (message: string) => void;
}

interface GradeState { shared: boolean; is_final: boolean; is_held: boolean }
const gradeOf = (g: Pick<Generation, "shared" | "is_final" | "is_held">): GradeState =>
  ({ shared: !!g.shared, is_final: !!g.is_final, is_held: !!g.is_held });
const sameGrade = (a: GradeState, b: GradeState) => a.shared === b.shared && a.is_final === b.is_final && a.is_held === b.is_held;

// 등급 S 다중선택 — 계산→인앱 확인 모달→실행. 실행은 부분 실패 허용(allSettled), 끝에 reload 1회.
export function useGradeStep({ canFinalize, reload, flash }: Args) {
  const [pending, setPending] = useState<GradeStepResult | null>(null);
  const [busy, setBusy] = useState(false);
  // 방금 바꾼 생성물의 새 상태(서버의 답). 목록을 다시 받기 전에 — 또는 받지 못했을 때 — 같은 선택으로 또 누르면, 화면이 아직 든 옛
  //  상태가 아니라 이 값으로 방향을 잡는다: 옛 상태면 방금 최종을 푼 카드에서 ↑ 가 "바꿀 수 있는 항목이 없습니다", S 더블클릭이 또
  //  '최종 해제'가 됐다(Codex 조작 점검 2026-10-14). 목록이 따라왔는지는 **등급 값**으로 본다: 목록이 든 등급이 그때(before)와 같으면
  //  아직 옛 목록이다 — 서버의 답(after)을 쓴다. 달라졌으면 목록이 새로 온 것이다 — 기록을 버리고 목록을 믿는다. 객체가 같은지로는
  //  보지 않는다: 색만 바꿔도 새 객체가 되고(등급은 옛 값 그대로), 다시 받기는 배열이 달라지면 내용이 같아도 객체를 새로 만든다
  //  (lib/stateReconciliation — 같은 점검의 3차).
  //  잠그고 기다리지 않는 까닭(2차): 다시 받기는 실패해도 조용히 끝나고(옛 목록이 남는다), 뒤따르는 통계·태그 조회가 늦으면 끝나지
  //  않는다 — 그동안 등급 단추가 까닭 없이 죽는다.
  const fresh = useRef(new Map<string, { before: GradeState; after: GradeState }>());
  const origin = useRef(new Map<string, Generation>()); // 확인 창을 띄운 선택의 원래 것(목록의 것 — 겹쳐 그린 사본이 아니다)
  const current = (g: Generation): Generation => {
    const known = fresh.current.get(g.id);
    if (!known) return g;
    if (!sameGrade(gradeOf(g), known.before)) {
      fresh.current.delete(g.id); // 목록이 새로 왔다
      return g;
    }
    return { ...g, ...known.after };
  };
  // 서버가 확정한 새 상태를 적는다. after 가 없으면(결과를 모른다 — 일부만 된 묶음 발행 등) 앞의 기록도 지운다: 확정이 아닌 것을
  //  확정처럼 계속 쓰지 않는다.
  const note = (id: string, after: GradeState | null) => {
    const from = origin.current.get(id);
    if (after && from) fresh.current.set(id, { before: gradeOf(from), after });
    else fresh.current.delete(id);
  };

  // 카드 S(단일/더블) 다중선택 트리거 → 계산 후 확인 모달 오픈. 바꿀 게 없으면 알림만.
  const requestGradeStep = (selected: Generation[], mode: GradeMode) => {
    if (!selected.length) return;
    const r = computeGradeStep(selected.map(current), mode, canFinalize);
    if (r.applied === 0) {
      flash(t("바꿀 수 있는 항목이 없습니다."));
      return;
    }
    origin.current = new Map(selected.map((g) => [g.id, g]));
    setPending(r);
  };

  const cancel = () => setPending(null);

  const confirm = async () => {
    if (!pending || busy) return;
    setBusy(true);
    armStateGlow(pending.ops.map((o) => o.gen.id)); // 단계가 바뀐 카드가 재조회 뒤 그 상태색으로 빛난다
    const { ops } = pending;
    let ok = 0;
    let fail = 0;
    let mirrorPending = false;
    // 공유(publish)는 벌크 1회 — 서버가 실제 발행한 개수(published)로 성공/생략 집계.
    const pubIds = ops.filter((o) => o.action === "publish").map((o) => o.gen.id);
    if (pubIds.length) {
      try {
        const r = await api.publishToShared(pubIds);
        const succeeded = r.mirror_pending
          ? Math.max(0, pubIds.length - (r.blocked ?? 0))
          : (r.published ?? 0);
        ok += succeeded;
        fail += pubIds.length - succeeded;
        mirrorPending ||= !!r.mirror_pending;
        // 전부 됐을 때만 '공유됨'으로 적는다 — 답에는 수만 있어, 일부만 됐으면 어느 것인지 모른다(그때는 앞의 기록도 지운다).
        //  안 적으면 방금 '공유 해제'로 적어 둔 기록이 남아, 발행한 뒤의 ↑ 가 또 발행이 된다(Codex 3차)
        const all = succeeded === pubIds.length;
        for (const id of pubIds) note(id, all ? { shared: true, is_final: false, is_held: false } : null);
      } catch {
        fail += pubIds.length;
        for (const id of pubIds) note(id, null); // 됐는지 모른다
      }
    }
    // 나머지(공유해제·최종·최종해제)는 개별 allSettled(부분 실패 허용).
    const rest = ops.filter((o) => o.action !== "publish");
    const results = await Promise.allSettled(
      rest.map((o) =>
        o.action === "unpublish"
          ? api.unpublish(o.gen.id)
          : o.action === "finalize"
            ? api.finalize(o.gen.id)
            : o.action === "unhold"
              ? api.unhold(o.gen.id)
              : api.unfinalize(o.gen.id),
      ),
    );
    ok += results.filter((x) => x.status === "fulfilled").length;
    fail += results.filter((x) => x.status === "rejected").length;
    mirrorPending ||= results.some(
      (result) => result.status === "fulfilled" && !!result.value.mirror_pending,
    );
    // 최종 해제로 보류가 되살아난 것(최종 전에 보류였던 것 — api.unfinalize, Jay 2026-10-14)은 따로 알린다: 해제했는데 카드가
    //  보류(빨강)로 보이는 까닭이다. 한 장 해제(onUnfinalize) · 편집 탭의 해제(onReviewSelection 의 release)와 같은 글.
    const reheld = results.filter((result, index) =>
      rest[index].action === "unfinalize" && result.status === "fulfilled" && !!(result.value as { is_held?: boolean }).is_held).length;
    // 서버가 답한 새 상태를 적어 둔다(위 fresh) — 공유 해제는 답의 꼴과 무관하게 '공유 아님'이다. 거절된 요청은 앞의 기록을 그대로 둔다
    //  (서버가 바꾸지 않았다 — 바꿨는데 답만 못 받았으면 다음 요청의 답이 바로잡는다).
    results.forEach((result, index) => {
      if (result.status !== "fulfilled") return;
      const { gen, action } = rest[index];
      const value = result.value as Partial<Generation>;
      note(gen.id, action === "unpublish" ? { shared: false, is_final: false, is_held: false }
        : typeof value.shared === "boolean" && typeof value.is_final === "boolean" ? gradeOf(value as Generation) : null);
    });
    setPending(null);
    setBusy(false);
    flash(
      withMirrorPendingNotice(
        (fail ? t("{count}개 적용 · {failed}개 실패/생략") : t("{count}개 적용"))
          .replace("{count}", String(ok)).replace("{failed}", String(fail))
          + (reheld ? " · " + t("원래의 보류로 {count}개").replace("{count}", String(reheld)) : ""),
        { mirror_pending: mirrorPending },
        t,
      ),
    );
    postLibraryChanged(); // 관리탭 상태(게시/완료) 즉시 재조회
    await reload();
    // 선택은 자동 해제하지 않는다 — 더블을 한 번 더 눌러 최종까지 이어갈 수 있게.
  };

  return { pending, busy, requestGradeStep, confirm, cancel };
}
