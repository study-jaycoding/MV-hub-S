import { useEffect, useState } from "react";
import { api } from "../../api";

export function useAssetViewerIdentity() {
  const [myId, setMyId] = useState("me");

  useEffect(() => {
    // 독립 창이라 자체 조회. 로그인 직후 프록시가 아직 정착 전이면 몇 번 재시도한다.
    let cancelled = false;
    const fetchId = (tries: number) => {
      api
        .me()
        .then((account) => {
          if (!cancelled) setMyId(account?.creator_uid || "me");
        })
        .catch(() => {
          if (!cancelled && tries > 0) window.setTimeout(() => fetchId(tries - 1), 1500);
        });
    };
    fetchId(3);
    return () => {
      cancelled = true;
    };
  }, []);

  return myId;
}
