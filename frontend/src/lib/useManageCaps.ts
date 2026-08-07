// 현재 사용자의 프로젝트 관리 역량 판정 — 관리자 창 프로젝트 탭과 동일 기준.
// AUTH off 면 백엔드가 require_global_cap 을 통과시키므로 UI 도 전부 허용.
import { useEffect, useState } from "react";
import { api } from "../api";
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
