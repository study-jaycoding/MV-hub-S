// 계정·CLI 연결 상태 훅 — 하단 상태줄(연결됨/크레딧/이메일)용. IME·에디터와 무관한 데이터 도메인.
import { useEffect, useState } from "react";
import { api } from "../api";

interface Account {
  connected: boolean;
  credits: number | null;
  email: string;
}

export function useAccountStatus() {
  const [cli, setCli] = useState<boolean | null>(null);
  // 계정(크레딧·이메일) — 하단 상태줄 클릭 시 수동 조회(PV 스타일)
  const [account, setAccount] = useState<Account | null>(null);
  const [acctLoading, setAcctLoading] = useState(false);
  const checkAccount = () => {
    if (acctLoading) return;
    setAcctLoading(true);
    api
      .account()
      .then((a) => {
        setAccount(a);
        setCli(a.connected);
      })
      .catch(() => setAccount({ connected: false, credits: null, email: "" }))
      .finally(() => setAcctLoading(false));
  };
  // 마운트 시 CLI 연결 상태 1회 확인(상태줄 점).
  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((d) => setCli(!!d.cli_available))
      .catch(() => setCli(false));
  }, []);
  return { cli, account, acctLoading, checkAccount };
}
