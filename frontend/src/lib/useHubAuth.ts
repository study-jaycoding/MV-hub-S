import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, getAuthToken, setAuthToken } from "../api";
import { APP_EVENTS } from "./appEvents";
import { clearPersonalSettings } from "./personalSettings";
import { loadString, saveString } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";
import { setAccountScope } from "./accountScope";
import { useCustomEvent } from "./useCustomEvent";
import type { Account, AuthConfig } from "../types";

export interface SharedServerState {
  configured: boolean;
  has_token: boolean;
  url: string | null;
  email: string | null;
  name: string | null;
  roles: string[];
}

export function shouldLoadSharedServer(authEnabled: boolean | null | undefined): boolean {
  return authEnabled === false;
}

// 부팅 인증 검증(me)의 늦은 응답을 반영해도 되는지 — 요청 시점 토큰과 현재 토큰이 같을 때만.
// 다르면 그 사이 사용자가 다른 계정으로 로그인(또는 로그아웃)한 것이므로, 늦은 성공이
// 옛 계정으로 덮거나 늦은 실패가 새 토큰을 지우면 안 된다.
export function isAuthResponseCurrent(
  tokenAtRequest: string | null,
  currentToken: string | null,
): boolean {
  return tokenAtRequest === currentToken;
}

function fallbackSharedServer(): SharedServerState {
  return { configured: false, has_token: false, url: null, email: null, name: null, roles: [] };
}

function sharedServerAccount(
  authConfig: AuthConfig | null,
  sharedSrv: SharedServerState | null,
): Account | null {
  if (authConfig?.auth_enabled || !sharedSrv?.has_token || !sharedSrv.email) return null;
  return {
    email: sharedSrv.email,
    name: sharedSrv.name,
    status: "approved",
    global_roles: sharedSrv.roles,
    creator_uid: null,
    created_at: "",
    approved_at: null,
  };
}

export function useHubAuth() {
  const [sharedSrv, setSharedSrv] = useState<SharedServerState | null>(null);
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [finalizeProjects, setFinalizeProjects] = useState<Set<string>>(new Set());
  const sharedSrvLoadingRef = useRef(false);

  const loadSharedSrv = useCallback(() => {
    if (sharedSrvLoadingRef.current) return;
    sharedSrvLoadingRef.current = true;
    api
      .sharedServerStatus()
      .then((s) =>
        setSharedSrv({
          configured: s.configured,
          has_token: s.has_token,
          url: s.url,
          email: s.email,
          name: s.name,
          roles: s.roles || [],
        }),
      )
      .catch(() => setSharedSrv(fallbackSharedServer()))
      .finally(() => {
        sharedSrvLoadingRef.current = false;
      });
  }, []);

  const onProxyConnected = useCallback(async () => {
    const st = await api.sharedServerStatus().catch(() => null);
    const newEmail = st?.email || "";
    const prev = loadString(STORAGE_KEYS.activeAccount);
    if (newEmail && prev && prev !== newEmail) clearPersonalSettings();
    if (newEmail) {
      setAccountScope(newEmail);
      saveString(STORAGE_KEYS.activeAccount, newEmail);
    }
    window.location.reload();
  }, []);

  useEffect(() => {
    api
      .authConfig()
      .then((cfg) => {
        setAuthConfig(cfg);
        if (cfg.auth_enabled && getAuthToken()) {
          // ★늦은 응답 무효화: 이 검증이 오래 걸려 부팅 워치독이 화면을 풀면 사용자가
          //  그 사이 다른 계정으로 로그인할 수 있다. 그때 뒤늦게 도착한 이 응답이
          //  성공이면 옛 계정으로 덮고, 실패면 새 토큰까지 지운다 — 요청 시점 토큰과
          //  현재 토큰이 같을 때만 결과를 반영한다.
          const tokenAtRequest = getAuthToken();
          api
            .me()
            .then((acc) => {
              if (isAuthResponseCurrent(tokenAtRequest, getAuthToken())) setAccount(acc);
            })
            .catch(() => {
              if (isAuthResponseCurrent(tokenAtRequest, getAuthToken())) setAuthToken(null);
            })
            .finally(() => setAuthChecked(true));
        } else {
          setAuthChecked(true);
        }
      })
      .catch(() => {
        setAuthConfig({ auth_enabled: false, has_accounts: false });
        setAuthChecked(true);
      });
  }, []);

  // 부팅 워치독 — 설정 조회(authConfig)나 토큰 검증(me)이 영영 settle 되지 않으면
  // (서버가 TCP 만 받고 응답을 안 주는 행 상태 등) App 이 `authPending → return null` 에
  // 갇혀 영구 백지가 된다. 10초 안에 못 끝나면 보수적 폴백으로 화면을 진행시킨다 —
  // 늦게라도 실제 응답이 오면 상태가 그대로 갱신되므로 폴백은 일시적이다.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setAuthConfig((cfg) => cfg ?? { auth_enabled: false, has_accounts: false });
      setAuthChecked(true);
    }, 10000);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (shouldLoadSharedServer(authConfig?.auth_enabled)) loadSharedSrv();
  }, [authConfig?.auth_enabled, loadSharedSrv]);

  // 같은 이유의 두 번째 관문 — 공유 서버 상태 조회가 settle 되지 않으면 App 이
  // `sharedSrv === null → return null` 에 갇힌다. 폴백(미연결)로 진행시키면 최소한
  // 서버 로그인 화면이 떠서 사용자가 상황을 보고 재시도할 수 있다.
  useEffect(() => {
    if (!shouldLoadSharedServer(authConfig?.auth_enabled) || sharedSrv !== null) return;
    const timer = window.setTimeout(() => {
      setSharedSrv((prev) => prev ?? fallbackSharedServer());
    }, 10000);
    return () => window.clearTimeout(timer);
  }, [authConfig?.auth_enabled, sharedSrv]);

  useCustomEvent(APP_EVENTS.authRequired, () => {
    setAccount(null);
    if (shouldLoadSharedServer(authConfig?.auth_enabled)) loadSharedSrv();
  });

  useCustomEvent(APP_EVENTS.accountUpdated, () => {
    api.me().then(setAccount).catch(() => {});
  });

  useEffect(() => {
    if (authConfig?.auth_enabled) return;
    if (sharedSrv?.has_token) {
      api.me().then(setAccount).catch(() => {
        setAccount(null);
        loadSharedSrv();
      });
    } else if (sharedSrv && !sharedSrv.has_token) {
      setAccount(null);
    }
  }, [authConfig?.auth_enabled, loadSharedSrv, sharedSrv?.has_token]);

  useEffect(() => {
    if (!account?.email) return;
    const prev = loadString(STORAGE_KEYS.activeAccount);
    const accountScopeChanged = setAccountScope(account.email);
    if (prev && prev !== account.email && authConfig?.auth_enabled) {
      clearPersonalSettings();
      saveString(STORAGE_KEYS.activeAccount, account.email);
      window.location.reload();
      return;
    }
    saveString(STORAGE_KEYS.activeAccount, account.email);
    // 첫 로그인처럼 이전 activeAccount 가 없던 경우에도 App 의 씬 상태는 이미 local 범위로
    // 초기화됐을 수 있다. 인증 범위가 달라졌다면 한 번만 다시 열어 정확한 계정 버킷을 읽는다.
    if (accountScopeChanged) window.location.reload();
  }, [account?.email, authConfig?.auth_enabled]);

  useEffect(() => {
    if (authConfig?.auth_enabled && !account) {
      setFinalizeProjects(new Set());
      return;
    }
    let ignore = false;
    api
      .myFinalizeRoles()
      .then((r) => {
        if (!ignore) setFinalizeProjects(new Set(r.project_ids));
      })
      .catch(() => {
        if (!ignore) setFinalizeProjects(new Set());
      });
    return () => {
      ignore = true;
    };
  }, [account, authConfig?.auth_enabled]);

  const logout = useCallback(async () => {
    if (!authConfig?.auth_enabled) {
      await api.sharedServerLogout().catch(() => {});
      window.location.reload();
      return;
    }
    api.logout().catch(() => {});
    setAuthToken(null);
    setAccount(null);
  }, [authConfig?.auth_enabled]);

  const authReady = !authConfig || !authConfig.auth_enabled || !!account;
  const authPending = !authChecked && (authConfig === null || getAuthToken());
  const hubAccount = useMemo(
    () => account || sharedServerAccount(authConfig, sharedSrv),
    [account, authConfig, sharedSrv],
  );

  return {
    account,
    authChecked,
    authConfig,
    authPending,
    authReady,
    finalizeProjects,
    hubAccount,
    logout,
    onProxyConnected,
    setAccount,
    sharedSrv,
  };
}
