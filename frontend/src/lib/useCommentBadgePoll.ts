import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { api } from "../api";
import type { Generation } from "../types";
import {
  commentBadgeTargets,
  decideCommentBadgeUpdate,
  type PanelSeen,
} from "./commentBadgeTargets";

interface UseCommentBadgePollArgs {
  generations: Generation[];
  setGens: Dispatch<SetStateAction<Generation[]>>;
  // 새 미확인 코멘트가 감지되면 호출 — 열린 코멘트 패널을 즉시 갱신시키는 신호(syncTick bump).
  onNewUnread?: () => void;
  intervalMs?: number;
  // 라이브러리 격자가 실제로 떠 있나. 캔버스에서 '폴더 보기' 를 닫아 두면 배지를 그릴 곳이 없다.
  // ★탭으로 판단하면 안 된다 — 캔버스의 '폴더 보기' 도 같은 격자를 쓴다(코덱스 지적).
  gridVisible?: boolean;
  // 열린 코멘트 패널의 생성물. 목록에 없어도(알림에서 연 경우) 새 코멘트를 잡아야 한다.
  openCommentGenId?: string | null;
}

// 팀 코멘트 실시간 반영: 화면에 떠 있는 '공유 카드'들의 코멘트 배지(수·미확인)만 짧은 주기로
// 다시 물어와 제자리 갱신한다. 목록 전체 reload(프록시 왕복+썸네일 재생성)를 하지 않아 가볍고
// 화면이 흔들리지 않는다. 팀 탭뿐 아니라 내작업 탭에서도 내 공유카드에 달린 코멘트를 잡는다.
export function useCommentBadgePoll({
  generations,
  setGens,
  onNewUnread,
  intervalMs = 10000,
  gridVisible = true,
  openCommentGenId = null,
}: UseCommentBadgePollArgs) {
  // 최신 값을 ref 로 참조해 인터벌을 매번 재설정하지 않는다.
  const gensRef = useRef(generations);
  gensRef.current = generations;
  const onNewUnreadRef = useRef(onNewUnread);
  onNewUnreadRef.current = onNewUnread;
  const panelIdRef = useRef(openCommentGenId);
  panelIdRef.current = openCommentGenId;
  // 패널 대상의 직전 배지 값 — 목록에 없는 생성물의 변화를 이걸로 판정한다.
  const panelSeenRef = useRef<PanelSeen | null>(null);

  useEffect(() => {
    // 격자가 없으면 배지를 그릴 곳도 없다 — 물어볼 이유가 없다.
    if (!gridVisible) return;
    let inflight = false;
    const tick = async () => {
      // 창이 안 보이면 쉰다(복귀 시 기존 visibilitychange reload 가 목록을 채운다).
      if (inflight || document.visibilityState === "hidden") return;
      // 스냅샷을 잡아 await 전후로 목록이 바뀌었는지 비교한다(아래 stale 방어).
      const snapshot = gensRef.current;
      const panelId = panelIdRef.current;
      const ids = commentBadgeTargets(snapshot, panelId);
      if (ids.length === 0) return;
      inflight = true;
      try {
        const counts = await api.commentCounts(ids);
        const decision = decideCommentBadgeUpdate(
          snapshot,
          counts,
          panelId,
          panelSeenRef.current,
        );
        // 패널 판정은 목록과 무관하다 — 목록이 그사이 바뀌었어도 열린 패널은 갱신해야 한다.
        if (panelId === panelIdRef.current) panelSeenRef.current = decision.nextPanelSeen;
        if (decision.notifyPanel) onNewUnreadRef.current?.();
        // await 도중 목록이 갱신됐으면(15초 전체 리로드 등) 이 폴링 결과는 낡았을 수 있으니 버린다.
        // 최신 데이터를 stale 값으로 되돌리지 않도록 — 다음 주기에 다시 맞춘다.
        if (gensRef.current !== snapshot || !decision.anyChange) return;
        setGens((prev) =>
          prev.map((g) => {
            const c = counts[g.id];
            return c ? { ...g, has_unread: c.has_unread, comment_count: c.comment_count } : g;
          }),
        );
      } catch {
        // 비핵심 보강 — 실패는 조용히 무시하고 다음 주기에 재시도.
      } finally {
        inflight = false;
      }
    };
    const id = window.setInterval(tick, intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, setGens, gridVisible]);
}
