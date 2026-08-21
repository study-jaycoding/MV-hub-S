// 현재 사용자의 프로젝트 관리 역량 판정 — 관리자 창 프로젝트 탭과 동일 기준.
// AUTH off 면 백엔드가 require_global_cap 을 통과시키므로 UI 도 전부 허용.
// 단 프록시 모드(로컬 AUTH off + 공유 서버 토큰)는 예외 — 서버가 read_all 을 강제하므로
// 서버 역할로 판정해야 한다(전부 허용으로 오판하면 대시보드 API 가 403 으로 전멸).
import { useEffect, useState } from "react";
import { api } from "../api";
import { sharedApi } from "./sharedApi";
import { findCurrentMember, viewerGlobalRoles } from "./accountIdentity";
import { hasGlobalCap } from "../types";

export interface ManageCaps {
  loaded: boolean;
  authOff: boolean;
  system: boolean;
  viewerUid: string | null;
  createProject: boolean; // 생성/편집/폴더/삭제
  grantRole: boolean; // 멤버 프로젝트 역할 부여
  readAll: boolean; // 워크스페이스 전체 통계 열람 — admin/PM/PD
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

export function useManageCaps(): ManageCaps {
  const [caps, setCaps] = useState<ManageCaps>(NONE);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cfg = await api.authConfig();
        if (!cfg.auth_enabled) {
          // 프록시 모드면 서버 역할로 판정 — read_all 전용 API 를 자격 없이 부르지 않게.
          const status = await sharedApi.sharedServerStatus().catch(() => null);
          if (status?.configured && status?.has_token) {
            const roles = status.roles || [];
            const account = await api.me().catch(() => null);
            if (alive)
              setCaps({
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
          if (alive)
            setCaps({
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
        if (alive)
          setCaps({
            loaded: true,
            authOff: false,
            system: hasGlobalCap(roles, "system"),
            viewerUid: account?.creator_uid || currentMember?.uid || null,
            createProject: hasGlobalCap(roles, "create_project"),
            grantRole: hasGlobalCap(roles, "grant_project_role"),
            readAll: hasGlobalCap(roles, "read_all"),
          });
      } catch {
        if (alive)
          setCaps({
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
  }, []);
  return caps;
}
