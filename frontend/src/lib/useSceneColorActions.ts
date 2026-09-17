import { useRef } from "react";
import type { MutableRefObject } from "react";
import { api } from "../api";
import type { Generation } from "../types";
import { ColorSaveError, ColorScopeChangedError, nextGenerationSelectionColor } from "./generationColorState";
import { createMutationQueue } from "./mutationQueue";
import { flashMsg } from "./flash";
import { t } from "./i18n";
import type { SceneColorLedger, SceneColorTicket } from "./useSceneGenData";

// SceneBoard 한 인스턴스의 색 저장만 직렬화한다. 라이브러리 큐와의 전역 순서는 보장하지 않는다.
export function useSceneColorActions(colors: SceneColorLedger, genDataRef: MutableRefObject<Record<string, Generation>>) {
  const latest = useRef(colors);
  latest.current = colors;
  const queue = useRef<ReturnType<typeof createMutationQueue> | null>(null);
  if (!queue.current) queue.current = createMutationQueue(async errors => {
    const ledger = latest.current;
    const liveIds = new Set(ledger.currentIds());
    const failures = errors.flatMap(error => {
      if (!(error instanceof ColorSaveError) || !error.detail) return [];
      return [error.detail as SceneColorTicket];
    });
    const tickets = failures.flatMap(ticket => {
      // 복구 쓰기는 현재 세대만. 같은 계정 옛 씬의 실패 고지는 아래에서 따로 집계한다.
      if (!ledger.isLive(ticket, true)) return [];
      const ids = ticket.ids.filter(id => liveIds.has(id) && !!genDataRef.current[id]
        && ticket.gen.revisions.get(id) === ticket.revisions[id]);
      return ids.length ? [{ ...ticket, ids }] : [];
    });
    const ids = [...new Set(tickets.flatMap(ticket => ticket.ids))];
    const applied = new Set<string>();
    let uncertain = false;
    if (ids.length) {
      const assertCurrent = () => {
        if (!tickets.some(ticket => ledger.isLive(ticket, true))) throw new ColorScopeChangedError();
      };
      try {
        const batch = await api.getGenerationsBatch(ids, assertCurrent);
        assertCurrent();
        const recovered = Object.fromEntries(ids.filter(id => !!batch.items[id])
          .map(id => [id, batch.items[id].color ?? null]));
        for (const ticket of tickets) {
          for (const id of ledger.applyRecovered(ticket,
            Object.fromEntries(ticket.ids.filter(id => id in recovered).map(id => [id, recovered[id]])))) applied.add(id);
        }
      } catch {
        // 씬 전환으로 복구만 중단돼도 확인된 저장 실패는 남는다. 계정 전환 고지는 아래서 제외한다.
        uncertain = true;
      }
    }
    // 더 큰 revision은 '새 의도 접수'이지 저장 성공 증거가 아니다. 새 작업의 실패는 자기 배수에서 고지한다.
    const failed = new Set(failures.flatMap(ticket => !ledger.isLive(ticket) ? [] : ticket.ids.filter(id =>
      (ticket.gen.revisions.get(id) ?? ticket.revisions[id]) <= ticket.revisions[id])));
    if (!failed.size) return;
    flashMsg((uncertain
      ? t("컬러 저장 {failed}건 실패 — 서버 상태를 확인하지 못했습니다")
      : t("컬러 저장 {failed}건 실패 — 서버 상태 반영 {restored}건"))
      .replace("{failed}", String(failed.size)).replace("{restored}", String(applied.size)));
  });

  return {
    applyColorToGids(gids: string[], color: string): void {
      const liveIds = new Set(colors.currentIds());
      const ids = [...new Set(gids)].filter(id => liveIds.has(id) && !!genDataRef.current[id]);
      if (!ids.length) return;
      // 계산용 id만 요청 키로 정규화한다. 실제 Generation.id와 API 저장 키는 바꾸지 않는다.
      const views = ids.map(id => ({ ...genDataRef.current[id], id }));
      const next = nextGenerationSelectionColor(views, ids, color);
      const ticket = colors.begin(ids, next);
      if (!ticket) return;
      void queue.current!.enqueue(async () => {
        const assertCurrent = () => { if (!colors.isLive(ticket)) throw new ColorScopeChangedError(); };
        try {
          assertCurrent(); // 같은 계정의 씬 전환은 저장을 취소하지 않는다.
          const failed = (await api.setColorsBatch(ticket.ids, next, assertCurrent)).failed;
          assertCurrent();
          if (failed.length) throw new ColorSaveError(failed.length, { ...ticket, ids: failed });
        } catch (error) {
          if (error instanceof ColorScopeChangedError) return;
          throw error instanceof ColorSaveError ? error : new ColorSaveError(ticket.ids.length, ticket);
        } finally {
          colors.end(ticket); // 성공/실패/계정 변경 모두 자기 세대의 카운트만 해제
        }
      });
    },
  };
}
