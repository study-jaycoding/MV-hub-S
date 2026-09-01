import { useEffect, useState } from "react";
import { api } from "../api";

// hubOk = /api/agent/status 요청 자체가 성공했나(허브 응답) · agentOn = 에이전트 롱폴 연결.
// 상태 점 색(녹/노/빨/회) 판정을 위해 '허브 다운'과 '에이전트만 꺼짐'을 구분한다.
export interface SpotlightHostStatus {
  hubOk: boolean | null; // null=아직 확인 전
  agentOn: boolean | null;
}

export function useSpotlightAgentStatus(enabled: boolean = true): SpotlightHostStatus {
  const [status, setStatus] = useState<SpotlightHostStatus>({ hubOk: null, agentOn: null });

  // enabled=false(프롬프트가 display:none 으로 숨은 동안)는 폴링을 완전히 멈춘다 —
  // 숨어 있어도 12초마다 /api/agent/status 를 계속 찌르던 것 제거. 다시 보이면
  // effect 재실행으로 즉시 1회 확인하고 주기를 재개한다. 마지막 상태값은 유지.
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const check = () => {
      if (document.visibilityState === "hidden") return; // 숨은 탭에선 폴링 쉼(복귀 시 아래 리스너가 1회 갱신)
      api
        .agentStatus()
        .then((s) => alive && setStatus({ hubOk: true, agentOn: s.connected }))
        .catch(() => alive && setStatus({ hubOk: false, agentOn: null }));
    };
    check();
    const id = window.setInterval(check, 12000);
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled]);

  return status;
}
