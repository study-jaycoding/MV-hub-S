// 현재 사용자의 프로젝트 관리 역량 판정 — 관리자 창 프로젝트 탭과 동일 기준.
// AUTH off 면 백엔드가 require_global_cap 을 통과시키므로 UI 도 전부 허용.
// 단 프록시 모드(로컬 AUTH off + 공유 서버 토큰)는 예외 — 서버가 read_all 을 강제하므로
// 서버 역할로 판정해야 한다(전부 허용으로 오판하면 대시보드 API 가 403 으로 전멸).
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { sharedApi } from "./sharedApi";
import { findCurrentMember, viewerGlobalRoles } from "./accountIdentity";
import { hasGlobalCap } from "../types";
import { APP_EVENTS } from "./appEvents";
import { getAuthToken, setAuthToken } from "./http";
import { loadString } from "./storage";
import { STORAGE_KEYS } from "./storageKeys";

export interface ManageCaps {
  loaded: boolean;
  authOff: boolean;
  system: boolean;
  viewerUid: string | null;
  createProject: boolean; // 생성/편집/폴더/삭제
  grantRole: boolean; // 멤버 프로젝트 역할 부여
  readAll: boolean; // 워크스페이스 전체 통계 열람 — admin/PM/PD
  contextKey?: string; // 계정/권한 변경 시 관리 화면의 이전 미리보기와 요청을 폐기하는 키
}

const NONE: ManageCaps = {
  loaded: false,
  authOff: false,
  system: false,
  viewerUid: null,
  createProject: false,
  grantRole: false,
  readAll: false,
};

export function useManageCaps(reloadSignal = 0): ManageCaps {
  const [caps, setCaps] = useState<ManageCaps>(NONE);
  const [accountRevision, setAccountRevision] = useState(0);
  const sequence = useRef(0);
  useEffect(() => {
    const invalidate = () => {
      sequence.current += 1;
      setCaps(NONE);
      setAccountRevision((revision) => revision + 1);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== STORAGE_KEYS.authToken &&
          event.key !== STORAGE_KEYS.activeAccount) return;
      // 별도 관리 창에는 메인 App의 인증 훅이 없다. 저장된 새 자격으로 다시 확인한다.
      setAuthToken(loadString(STORAGE_KEYS.authToken) || null);
      invalidate();
    };
    const onAuthRequired = () => {
      sequence.current += 1;
      setCaps(NONE);
      // 실패한 권한 조회가 다시 401을 내면서 즉시 재시도 루프를 만들지 않는다.
      // 새 로그인/기존 관리 갱신 신호가 도착할 때만 다시 확인한다.
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(APP_EVENTS.accountUpdated, invalidate);
    window.addEventListener(APP_EVENTS.authRequired, onAuthRequired);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(APP_EVENTS.accountUpdated, invalidate);
      window.removeEventListener(APP_EVENTS.authRequired, onAuthRequired);
    };
  }, []);
  useEffect(() => {
    let alive = true;
    const request = ++sequence.current;
    const token = getAuthToken();
    const account = loadString(STORAGE_KEYS.activeAccount);
    const current = () => alive && request === sequence.current && token === getAuthToken() &&
      account === loadString(STORAGE_KEYS.activeAccount);
    const accept = (next: ManageCaps) => {
      if (!current()) return;
      const contextKey = JSON.stringify([accountRevision, next.viewerUid, next.authOff,
        next.system, next.readAll, next.createProject, next.grantRole]);
      setCaps((previous) => previous.contextKey === contextKey && previous.loaded
        ? previous : { ...next, contextKey });
    };
    (async () => {
      try {
        const cfg = await api.authConfig();
        if (!cfg.auth_enabled) {
          // 프록시 모드면 서버 역할로 판정 — read_all 전용 API 를 자격 없이 부르지 않게.
          const status = await sharedApi.sharedServerStatus();
          if (status.configured && !status.has_token) {
            accept({ ...NONE, loaded: true });
            return;
          }
          if (status?.configured && status?.has_token) {
            const roles = status.roles || [];
            const account = await api.me().catch(() => null);
            if (current())
              accept({
                loaded: true,
                authOff: false,
                system: hasGlobalCap(roles, "system"),
                viewerUid: account?.creator_uid || null,
                createProject: hasGlobalCap(roles, "create_project"),
                grantRole: hasGlobalCap(roles, "grant_project_role"),
                readAll: hasGlobalCap(roles, "read_all"),
              });
            return;
          }
          // 인증 off — 단독/로컬 모드는 누구나(백엔드도 통과).
          if (current())
            accept({
              loaded: true,
              authOff: true,
              system: true,
              viewerUid: null,
              createProject: true,
              grantRole: true,
              readAll: true,
            });
          return;
        }
        const [account, members] = await Promise.all([
          api.me().catch(() => null),
          api.members().catch(() => []),
        ]);
        const roles = viewerGlobalRoles(account, members);
        const currentMember = findCurrentMember(account, members);
        if (current())
          accept({
            loaded: true,
            authOff: false,
            system: hasGlobalCap(roles, "system"),
            viewerUid: account?.creator_uid || currentMember?.uid || null,
            createProject: hasGlobalCap(roles, "create_project"),
            grantRole: hasGlobalCap(roles, "grant_project_role"),
            readAll: hasGlobalCap(roles, "read_all"),
          });
      } catch {
        if (current())
          accept({
            loaded: true,
            authOff: false,
            system: false,
            viewerUid: null,
            createProject: false,
            grantRole: false,
            readAll: false,
          });
      }
    })();
    return () => {
      alive = false;
    };
  }, [reloadSignal, accountRevision]);
  return caps;
}
