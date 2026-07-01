import { useEffect, useState } from "react";
import { api } from "../api";

export function useSpotlightAgentStatus() {
  const [agentOn, setAgentOn] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    const check = () =>
      api
        .agentStatus()
        .then((status) => alive && setAgentOn(status.connected))
        .catch(() => alive && setAgentOn(null));
    check();
    const id = window.setInterval(check, 12000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  return agentOn;
}
