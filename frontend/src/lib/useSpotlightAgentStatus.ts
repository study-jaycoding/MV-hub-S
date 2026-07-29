import { useEffect, useState } from "react";
import { api } from "../api";

export function useSpotlightAgentStatus() {
  const [agentOn, setAgentOn] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    const check = () => {
      if (document.visibilityState === "hidden") return; // 숨은 탭에선 폴링 쉼(복귀 시 아래 리스너가 1회 갱신)
      api
        .agentStatus()
        .then((status) => alive && setAgentOn(status.connected))
        .catch(() => alive && setAgentOn(null));
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
  }, []);

  return agentOn;
}
