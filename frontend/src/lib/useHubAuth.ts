import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, getAuthToken, setAuthToken } from "../api";
import { APP_EVENTS } from "./appEvents";
import { flashMsg } from "./flash";
import { clearPersonalSettings } from "./personalSettings";
import { loadString, saveString } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";
import { setAccountScope } from "./accountScope";
import { useCustomEvent } from "./useCustomEvent";
// 계정이 바뀌는 길의 새로고침은 반드시 일어나야 한다 — 저장 못 한 편집이 있어도 그 자리에서는 묻지 않는다(머무르면 계정 범위만 바뀐
//  화면이 남는다). 묻는 것은 그 전, 로그아웃을 누른 순간이다(아래 logout).
import { reloadNow, setLeaving, unloadHeld } from "./unloadGuard";
import type { Account, AuthConfig } from "../types";
import { HttpError } from "./http";

const FINALIZE_ROLES_RETRY_MS = 30_000;
const LOGOUT_WAIT_MS = 10_000;
const TIMED_OUT = Symbol("timed out");

// 요청 하나를 제한 시간까지만 기다린다 — 넘으면 끊고 TIMED_OUT.
function within<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T | typeof TIMED_OUT> {
  const control = new AbortController();
  let timer = 0;
  const late = new Promise<typeof TIMED_OUT>((yes) => {
    timer = window.setTimeout(() => {
      control.abort();
      yes(TIMED_OUT);
    }, LOGOUT_WAIT_MS);
  });
  const run = work(control.signal);
  run.catch(() => {}); // 끊긴 뒤에 오는 거부를 떠돌게 두지 않는다
  return Promise.race([run, late]).finally(() => window.clearTimeout(timer));
}

/** 허브(AUTH-off)의 로그아웃. 돌려주는 값 = 로그아웃됐는가. 응답이 끝나지 않으면 끊고, **됐는지를 허브에 물어** 정한다 —
 *  기다리는 동안 편집이 잠겨 있어(setLeaving) 끝나지 않는 요청이 화면을 영영 묶지 않게(Codex 재검토 4회째). 묻지도 못하면 안 된 것으로
 *  본다: 그 뒤에 허브가 실제로는 로그아웃돼 있었다면 다음 요청의 401 이 로그인 화면으로 보낸다(전부터 있는 길). */
async function hubLogout(): Promise<boolean> {
  try {
    if ((await within((signal) => api.sharedServerLogout(signal))) !== TIMED_OUT) return true;
  } catch {
    return false; // 허브가 실패를 답했다
  }
  try {
    const status = await within((signal) => api.sharedServerStatus(signal));
    return status !== TIMED_OUT && !status.has_token;
  } catch {
    return false;
  }
}

export interface SharedServerState {
  configured: boolean;
  has_token: boolean;
  url: string | null;
  // 관리자가 등록한 '서버' 표시 이름 — 작업자 화면은 주소 대신 이걸 보여준다(없으면 주소).
  // 아래 name 은 로그인한 '사람' 이름이다(다른 값).
  server_name: string | null;
  // 예전에 쓰던 공유 서버 주소(최신순) — 로그인 화면에서 주소를 되돌릴 때 쓴다.
  url_history: string[];
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
  return {
    configured: false,
    has_token: false,
    url: null,
    server_name: null,
    url_history: [],
    email: null,
    name: null,
    roles: [],
  };
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
          server_name: s.server_name || null,
          url_history: s.url_history || [],
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
    reloadNow();
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
      reloadNow();
      return;
    }
    saveString(STORAGE_KEYS.activeAccount, account.email);
    // 첫 로그인처럼 이전 activeAccount 가 없던 경우에도 App 의 씬 상태는 이미 local 범위로
    // 초기화됐을 수 있다. 인증 범위가 달라졌다면 한 번만 다시 열어 정확한 계정 버킷을 읽는다.
    if (accountScopeChanged) reloadNow();
  }, [account?.email, authConfig?.auth_enabled]);

  useEffect(() => {
    if (!authConfig) return; // 설정을 받기 전에는 최종 권한을 묻지 않는다(받은 뒤 한 번 — S1)
    if (authConfig.auth_enabled && !account) {
      setFinalizeProjects(new Set());
      return;
    }
    let ignore = false;
    let retry: number | undefined;
    const load = () => {
      api
        .myFinalizeRoles()
        .then((r) => {
          if (!ignore) setFinalizeProjects(new Set(r.project_ids));
        })
        .catch((error) => {
          if (ignore) return;
          setFinalizeProjects(new Set());
          // 서버가 잠깐 안 될 때의 실패가 새로고침 전까지 '권한 없음'으로 굳지 않게 30초 뒤 다시 묻는다
          // (2026-10-03). 확정 거부(401·403)는 다시 묻지 않는다.
          if (error instanceof HttpError && (error.status === 401 || error.status === 403)) return;
          retry = window.setTimeout(load, FINALIZE_ROLES_RETRY_MS);
        });
    };
    load();
    return () => {
      ignore = true;
      if (retry !== undefined) window.clearTimeout(retry);
    };
  }, [account, authConfig?.auth_enabled]);

  const loggingOut = useRef<Promise<boolean> | null>(null); // 진행 중인 허브 로그아웃(하나뿐)
  /** 로그아웃한다. 돌려주는 값 = 로그아웃됐는가(부르는 쪽이 먼저 비운 화면을 실패 때 되살린다). */
  const logout = useCallback(async (): Promise<boolean> => {
    // 이미 로그아웃하는 중이면 그 요청의 결과를 같이 기다린다 — 요청은 하나뿐이다. 둘이 따로 돌면 하나의 실패가 편집 잠금을 풀고,
    //  아직 기다리던 다른 하나의 성공이 그사이의 편집을 새로고침으로 지운다(Codex 재검토 4회째).
    if (loggingOut.current) return loggingOut.current;
    // 저장하지 못한 편집이 있으면 먼저 묻는다 — 로그아웃(그리고 이어지는 계정 전환)은 새로고침으로 끝나 메모리에만 남은 그 편집이 사라진다.
    //  계정·서버의 상태를 바꾸기 **전에** 묻는다: 바꾼 뒤에 새로고침만 막으면 화면이 옛 계정의 것으로 남는다(Codex 배포 전 재검토).
    if (unloadHeld() && !window.confirm("편집 탭에 저장하지 못한 변경이 있습니다. 로그아웃하면 그 변경은 사라집니다. 계속할까요?")) return false;
    if (!authConfig?.auth_enabled) {
      // 응답을 기다리는 동안의 편집은 받지 않는다 — 위의 확인 뒤에 '저장 안 됨'이 새로 생기면 묻지 못한 채 아래 새로고침에 사라진다.
      setLeaving(true);
      const done = await (loggingOut.current = hubLogout());
      loggingOut.current = null;
      if (!done) {
        // 실패했으면 새로 고치지 않고 알린다(조작 규칙 41) — 전엔 실패를 삼키고 새로 고쳐, 허브에 세션이 남아 있어 로그인 화면 없이
        //  같은 계정으로 말없이 돌아왔다(로그아웃된 줄 안다).
        setLeaving(false);
        flashMsg("로그아웃하지 못했습니다 — 잠시 뒤 다시 시도하세요.");
        return false;
      }
      reloadNow();
      return true;
    }
    api.logout().catch(() => {});
    setAuthToken(null);
    setAccount(null);
    return true;
  }, [authConfig?.auth_enabled]);

  // 설정을 받기 전에는 준비 안 됨 — 전에는 그때도 참이라 목록(3.38MB 급)·통계·패싯·프로젝트를 한 번 먼저 받았다가 계정이 정해지면
  // 버리고 다시 받았다(2026-10-03 점검 S1, 새로고침마다). AUTH-off 는 화면 게이트와 같은 시점(공유 서버 상태를 받은 뒤 — 실패해도
  // 폴백 상태가 들어오고, 설정·상태 모두 10초 워치독이 있다).
  const authReady = !!authConfig && (authConfig.auth_enabled ? !!account : sharedSrv !== null);
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
