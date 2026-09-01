// 부분 수정 호스트 — App 에 1개 mount. InfoPopup 이 쏘는 partialEdit 이벤트(detail={genId})를
// 받아 최신 Generation 을 조회한 뒤 모달을 연다(이벤트에 전체 객체를 싣지 않는 관례 준수).
// 이미 열려 있으면 새 이벤트는 무시한다 — 그리던 마스크·진행 중 감시를 잃지 않게.
import { useRef, useState } from "react";
import { api } from "../../api";
import { APP_EVENTS } from "../../lib/appEvents";
import { flashMsg } from "../../lib/flash";
import { useCustomEvent } from "../../lib/useCustomEvent";
import { PartialEditModal } from "./PartialEditModal";
import type { Generation, WorkspaceContext } from "../../types";

export function PartialEditHost({
  workspace,
  onQueued,
}: {
  workspace: WorkspaceContext;
  onQueued: (g: Generation) => void; // 생성 카드가 만들어짐 — App 목록 merge + 갱신 알림
}) {
  const [gen, setGen] = useState<Generation | null>(null);
  const fetchingRef = useRef(false); // 조회 진행 중 표식 — 연타 이벤트가 늦은 응답으로
  // 열린 모달의 gen 을 다른 생성물로 바꿔치기하는 경합 차단(코덱스 리뷰)
  useCustomEvent(APP_EVENTS.partialEdit, (e) => {
    const genId = (e as CustomEvent<{ genId?: unknown }>).detail?.genId;
    if (typeof genId !== "string" || !genId) return;
    if (gen || fetchingRef.current) {
      flashMsg("부분 수정이 이미 열려 있습니다 — 닫은 뒤 다시 시도하세요.");
      return;
    }
    fetchingRef.current = true;
    api
      .getGeneration(genId)
      .then(setGen)
      .catch(() => flashMsg("부분 수정: 생성물 정보를 불러오지 못했습니다."))
      .finally(() => {
        fetchingRef.current = false;
      });
  });
  if (!gen) return null;
  return (
    <PartialEditModal
      gen={gen}
      workspace={workspace}
      onQueued={onQueued}
      onClose={() => setGen(null)}
    />
  );
}
