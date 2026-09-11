// 계정·CLI 연결 상태 훅 — 하단 상태줄(연결됨/크레딧/이메일)용. IME·에디터와 무관한 데이터 도메인.
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { scopedCredits, UNKNOWN_WORKSPACE } from "./workspaceContext";
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
  // 요청 시점의 공간 키 — 전환 뒤 도착한 옛 공간의 잔액을 버린다(코덱스 레인B P2).
  const workspaceKey = `${workspace?.scope ?? ""}:${workspace?.id ?? ""}`;
  const workspaceKeyRef = useRef(workspaceKey);
  workspaceKeyRef.current = workspaceKey;
  const checkAccount = () => {
    if (acctLoading) return;
    setAcctLoading(true);
    const startedFor = workspaceKey;
    // 크레딧은 '지금 앱에서 보고 있는 워크스페이스'의 잔액이어야 한다. `account status` 는 **CLI 가
    // 물고 있는 공간** 기준인데, 허브는 이제 그 전역을 바꾸지 않는다(에이전트가 제출 직전에 맞춘다)
    // → 개인이든 팀이든 `workspace list` 에서 그 공간의 잔액을 고른다(activeWorkspaceOf 가 규칙).
    //  ★폴백을 두지 않는다. 조회 실패·항목 없음은 **미확인(null)** 으로 남긴다 — 다른 공간의 숫자를
    //   보여 주면 크레딧을 잘못 읽는다. 0 은 정상 잔액이라 `??` 로 덮으면 안 된다.
    const credits = api
      .workspaces()
      .then((items) => scopedCredits(items, workspace ?? UNKNOWN_WORKSPACE))
      .catch(() => null);
    Promise.all([api.account(), credits])
      .then(([a, wsCredits]) => {
        if (workspaceKeyRef.current !== startedFor) return; // 공간이 바뀐 뒤 도착 — 옛 공간 잔액
        setAccount({ ...a, credits: wsCredits });
      })
      .catch(() => {
        if (workspaceKeyRef.current !== startedFor) return;
        setAccount({ connected: false, credits: null, email: "" });
      })
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
