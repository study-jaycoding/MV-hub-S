// 계정·CLI 연결 상태 훅 — 하단 상태줄(연결됨/크레딧/이메일)용. IME·에디터와 무관한 데이터 도메인.
import { useEffect, useState } from "react";
import { api } from "../api";
import { activeWorkspaceOf } from "./workspaceContext";
import type { WorkspaceContext } from "../types";

interface Account {
  connected: boolean;
  credits: number | null;
  email: string;
}

export function useAccountStatus(workspace?: WorkspaceContext) {
  // 계정(크레딧·이메일) — 하단 상태줄 클릭 시 수동 조회(PV 스타일)
  const [account, setAccount] = useState<Account | null>(null);
  const [acctLoading, setAcctLoading] = useState(false);
  const checkAccount = () => {
    if (acctLoading) return;
    setAcctLoading(true);
    // 크레딧은 '지금 앱에서 보고 있는 워크스페이스'의 잔액이어야 한다. account status 는 CLI 가
    // 물고 있는 공간 기준이라 앱 선택과 어긋날 수 있어(서버 모드에선 아예 안 따라옴), 팀을
    // 고른 동안에는 workspace list 의 그 팀 잔액을 쓴다. 개인·미확정이면 종전대로 account status.
    const teamCredits =
      workspace?.scope === "team"
        ? api
            .workspaces()
            .then((items) => activeWorkspaceOf(items, workspace)?.credits ?? null)
            .catch(() => null)
        : Promise.resolve(null);
    Promise.all([api.account(), teamCredits])
      .then(([a, wsCredits]) => {
        setAccount({ ...a, credits: wsCredits ?? a.credits });
      })
      .catch(() => setAccount({ connected: false, credits: null, email: "" }))
      .finally(() => setAcctLoading(false));
  };
  // (마운트 시 /api/health 로 cli 상태를 받아오던 effect 는 제거 — 결과를 쓰는 곳이 없었고,
  //  화면의 연결 점은 useSpotlightAgentStatus 가 담당한다.)
  // 공간을 바꾸면 이전 공간의 잔액이 남지 않게 지운다(다시 클릭하면 새 공간 기준으로 조회).
  useEffect(() => {
    setAccount((previous) => (previous ? { ...previous, credits: null } : previous));
  }, [workspace?.scope, workspace?.id]);
  return { account, acctLoading, checkAccount };
}
