import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { api } from "../api";
import type { Generation } from "../types";

interface UseCommentBadgePollArgs {
  generations: Generation[];
  setGens: Dispatch<SetStateAction<Generation[]>>;
  // 새 미확인 코멘트가 감지되면 호출 — 열린 코멘트 패널을 즉시 갱신시키는 신호(syncTick bump).
  onNewUnread?: () => void;
  intervalMs?: number;
}

// 팀 코멘트 실시간 반영: 화면에 떠 있는 '공유 카드'들의 코멘트 배지(수·미확인)만 짧은 주기로
// 다시 물어와 제자리 갱신한다. 목록 전체 reload(프록시 왕복+썸네일 재생성)를 하지 않아 가볍고
// 화면이 흔들리지 않는다. 팀 탭뿐 아니라 내작업 탭에서도 내 공유카드에 달린 코멘트를 잡는다.
export function useCommentBadgePoll({
  generations,
  setGens,
  onNewUnread,
  intervalMs = 10000,
}: UseCommentBadgePollArgs) {
  // 최신 값을 ref 로 참조해 인터벌을 매번 재설정하지 않는다.
  const gensRef = useRef(generations);
  gensRef.current = generations;
  const onNewUnreadRef = useRef(onNewUnread);
  onNewUnreadRef.current = onNewUnread;

  useEffect(() => {
    let inflight = false;
    const tick = async () => {
      // 창이 안 보이면 쉰다(복귀 시 기존 visibilitychange reload 가 목록을 채운다).
      if (inflight || document.visibilityState === "hidden") return;
      // 공유 카드(서버에 코멘트 스레드가 있는 카드)만 대상 — 로컬 전용 카드는 즉시 반영되므로 제외.
      // 스냅샷을 잡아 await 전후로 목록이 바뀌었는지 비교한다(아래 stale 방어).
      const snapshot = gensRef.current;
      const shared = snapshot.filter((g) => g.shared);
      if (shared.length === 0) return;
      inflight = true;
      try {
        const counts = await api.commentCounts(shared.map((g) => g.id));
        // await 도중 목록이 갱신됐으면(15초 전체 리로드 등) 이 폴링 결과는 낡았을 수 있으니 버린다.
        // 최신 데이터를 stale 값으로 되돌리지 않도록 — 다음 주기에 다시 맞춘다.
        if (gensRef.current !== snapshot) return;
        // 변화 여부를 스냅샷 기준으로 먼저 판정(불필요한 리렌더·잘못된 side effect 방지).
        let anyChange = false;
        let notifyPanel = false;
        for (const g of shared) {
          const c = counts[g.id];
          if (!c) continue;
          if (c.has_unread !== g.has_unread || c.comment_count !== g.comment_count) anyChange = true;
          // 새 코멘트가 온 카드(미확인 전환 또는 코멘트 수 증가) → 열린 패널을 새로고침.
          if ((c.has_unread && !g.has_unread) || c.comment_count > g.comment_count) notifyPanel = true;
        }
        if (!anyChange) return;
        setGens((prev) =>
          prev.map((g) => {
            const c = counts[g.id];
            return c ? { ...g, has_unread: c.has_unread, comment_count: c.comment_count } : g;
          }),
        );
        if (notifyPanel) onNewUnreadRef.current?.();
      } catch {
        // 비핵심 보강 — 실패는 조용히 무시하고 다음 주기에 재시도.
      } finally {
        inflight = false;
      }
    };
    const id = window.setInterval(tick, intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, setGens]);
}
