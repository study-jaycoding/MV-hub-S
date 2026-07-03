import { useState } from "react";
import { api } from "../api";
import { postLibraryChanged } from "./libraryBroadcast";
import { computeGradeStep, type GradeMode, type GradeStepResult } from "./gradeStep";
import type { Generation } from "../types";

interface Args {
  canFinalize: (g: Generation) => boolean;
  reload: () => Promise<void>;
  flash: (message: string) => void;
}

// 등급 S 다중선택 — 계산→인앱 확인 모달→실행. 실행은 부분 실패 허용(allSettled), 끝에 reload 1회.
export function useGradeStep({ canFinalize, reload, flash }: Args) {
  const [pending, setPending] = useState<GradeStepResult | null>(null);
  const [busy, setBusy] = useState(false);

  // 카드 S(단일/더블) 다중선택 트리거 → 계산 후 확인 모달 오픈. 바꿀 게 없으면 알림만.
  const requestGradeStep = (selected: Generation[], mode: GradeMode) => {
    if (!selected.length) return;
    const r = computeGradeStep(selected, mode, canFinalize);
    if (r.applied === 0) {
      flash("바꿀 수 있는 항목이 없습니다.");
      return;
    }
    setPending(r);
  };

  const cancel = () => setPending(null);

  const confirm = async () => {
    if (!pending || busy) return;
    setBusy(true);
    const { ops } = pending;
    let ok = 0;
    let fail = 0;
    // 공유(publish)는 벌크 1회 — 서버가 실제 발행한 개수(published)로 성공/생략 집계.
    const pubIds = ops.filter((o) => o.action === "publish").map((o) => o.gen.id);
    if (pubIds.length) {
      try {
        const r = await api.publishToShared(pubIds);
        ok += r.published ?? 0;
        fail += pubIds.length - (r.published ?? 0);
      } catch {
        fail += pubIds.length;
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
            : api.unfinalize(o.gen.id),
      ),
    );
    ok += results.filter((x) => x.status === "fulfilled").length;
    fail += results.filter((x) => x.status === "rejected").length;
    setPending(null);
    setBusy(false);
    flash(fail ? `${ok}개 적용 · ${fail}개 실패/생략` : `${ok}개 적용`);
    postLibraryChanged(); // 관리탭 상태(게시/완료) 즉시 재조회
    await reload();
    // 선택은 자동 해제하지 않는다 — 더블을 한 번 더 눌러 최종까지 이어갈 수 있게.
  };

  return { pending, busy, requestGradeStep, confirm, cancel };
}
