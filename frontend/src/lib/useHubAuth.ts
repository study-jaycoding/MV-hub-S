import { useCallback, useEffect, useMemo, useState } from "react";
import { api, getAuthToken, setAuthToken } from "../api";
import { APP_EVENTS } from "./appEvents";
import { clearPersonalSettings } from "./personalSettings";
import { loadString, saveString } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";
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

  const loadSharedSrv = useCallback(() => {
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
      .catch(() => setSharedSrv(fallbackSharedServer()));
  }, []);

  useEffect(() => {
    loadSharedSrv();
  }, [loadSharedSrv]);

  useCustomEvent(APP_EVENTS.sharedChanged, () => loadSharedSrv());

  const onProxyConnected = useCallback(async () => {
    const st = await api.sharedServerStatus().catch(() => null);
    const newEmail = st?.email || "";
    const prev = loadString(STORAGE_KEYS.activeAccount);
    if (newEmail && prev && prev !== newEmail) clearPersonalSettings();
    if (newEmail) saveString(STORAGE_KEYS.activeAccount, newEmail);
    window.location.reload();
  }, []);

  useEffect(() => {
    api
      .authConfig()
      .then((cfg) => {
        setAuthConfig(cfg);
        if (cfg.auth_enabled && getAuthToken()) {
          api
            .me()
            .then(setAccount)
            .catch(() => setAuthToken(null))
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

  useCustomEvent(APP_EVENTS.authRequired, () => {
    setAccount(null);
    if (!authConfig?.auth_enabled) loadSharedSrv();
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
    if (prev && prev !== account.email && authConfig?.auth_enabled) {
      clearPersonalSettings();
      saveString(STORAGE_KEYS.activeAccount, account.email);
      window.location.reload();
      return;
    }
    saveString(STORAGE_KEYS.activeAccount, account.email);
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
