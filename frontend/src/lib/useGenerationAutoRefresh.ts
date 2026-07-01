import { useEffect } from "react";
import { hasActiveGenerationJob } from "./generationDisplay";
import type { Filters, Generation } from "../types";

interface UseGenerationAutoRefreshArgs {
  generations: Generation[];
  tab: Filters["tab"];
  reload: (silent?: boolean, light?: boolean) => void | Promise<void>;
}

export function useGenerationAutoRefresh({
  generations,
  tab,
  reload,
}: UseGenerationAutoRefreshArgs) {
  const hasActiveJob = hasActiveGenerationJob(generations);

  useEffect(() => {
    if (!hasActiveJob && tab !== "team") return;
    const id = setInterval(() => void reload(true, true), 3000);
    return () => clearInterval(id);
  }, [hasActiveJob, reload, tab]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void reload(true, true);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [reload]);
}
