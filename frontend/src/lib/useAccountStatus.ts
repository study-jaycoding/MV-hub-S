// 계정·CLI 연결 상태 훅 — 하단 상태줄용.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { APP_EVENTS } from "./appEvents";
import { getAccountNamespace, getConnectionKey } from "./accountScope";
import { getAuthToken } from "./http";
import { scopedCredits, UNKNOWN_WORKSPACE } from "./workspaceContext";
import type { WorkspaceContext } from "../types";

interface Account {
  connected: boolean;
  credits: number | null;
  email: string;
}

export function useAccountStatus(workspace?: WorkspaceContext) {
  const [account, setAccount] = useState<Account | null>(null);
  const [acctLoading, setAcctLoading] = useState(false);
  const scope = `${getAccountNamespace()}\0${getConnectionKey()}\0${getAuthToken() ?? ""}`;
  const key = `${scope}\0${workspace?.scope ?? ""}:${workspace?.id ?? ""}`;
  const current = useRef(key);
  current.current = key;
  const mounted = useRef(true);
  const sequence = useRef(0);
  const requested = useRef(false);
  const refreshAgain = useRef(false);
  const refreshRef = useRef<() => void>(() => {});
  const inFlight = useRef<{ key: string; promise: Promise<void> } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; sequence.current++; };
  }, []);
  const checkAccount = useCallback(() => {
    if (scope !== `${getAccountNamespace()}\0${getConnectionKey()}\0${getAuthToken() ?? ""}`) return;
    if (inFlight.current?.key === key) return inFlight.current.promise;
    requested.current = true;
    const ticket = ++sequence.current;
    const token = getAuthToken();
    const valid = () => mounted.current && current.current === key &&
      sequence.current === ticket && getAuthToken() === token;
    setAcctLoading(true);
    const run = Promise.all([api.account(), api.workspaces()])
      .then(([result, workspaces]) => {
        if (valid()) setAccount((previous) => result.connected === false && previous
          ? { ...previous, connected: false }
          : { ...result, credits: scopedCredits(workspaces, workspace ?? UNKNOWN_WORKSPACE) });
      })
      .catch(() => {
        if (valid()) setAccount((previous) => previous ?? { connected: false, credits: null, email: "" });
      })
      .finally(() => {
        if (inFlight.current?.promise === run) inFlight.current = null;
        if (valid()) {
          setAcctLoading(false);
          if (refreshAgain.current) {
            refreshAgain.current = false;
            refreshRef.current();
          }
        }
      });
    inFlight.current = { key, promise: run };
    return run;
  }, [key, scope, workspace]);
  useEffect(() => {
    sequence.current++;
    refreshAgain.current = false;
    inFlight.current = null;
    setAccount(null);
    setAcctLoading(false);
  }, [key]);
  useEffect(() => {
    refreshRef.current = () => { void checkAccount(); };
    const refresh = () => {
      if (!requested.current) return;
      if (inFlight.current?.key === key) refreshAgain.current = true;
      else void checkAccount();
    };
    window.addEventListener(APP_EVENTS.creditsChanged, refresh);
    return () => window.removeEventListener(APP_EVENTS.creditsChanged, refresh);
  }, [checkAccount, key]);
  return { account, acctLoading, checkAccount };
}
